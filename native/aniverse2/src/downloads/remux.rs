use super::{
    hls::{self, Playlist},
    invalid,
};
use crate::RpcError;
use aniverse_security::is_mp4_header;
use reqwest::{header, Client, Response, StatusCode, Url};
use std::{
    fmt::Write as _,
    io,
    os::windows::process::CommandExt,
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncWriteExt},
    time::{sleep, timeout},
};

const MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_SEGMENT: u64 = 128 * 1024 * 1024;
const MAX_INIT: u64 = 1024 * 1024;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(super) async fn save(
    client: &Client,
    url: &Url,
    observed: Option<&Url>,
    destination: &Path,
    ffmpeg: &Path,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<(), RpcError> {
    if tokio::fs::try_exists(destination)
        .await
        .map_err(|_| disk())?
    {
        return Err(exists());
    }
    let playlist = read_playlist(client, url).await?;
    let playlist = match playlist {
        Playlist::Variant(uri) => read_playlist(client, &uri).await?,
        media => media,
    };
    let Playlist::Media { init, segments } = playlist else {
        return Err(invalid("Nested HLS variant lists are not supported."));
    };
    if observed.is_some_and(|observed| !segments.iter().any(|(_, uri)| uri == observed)) {
        return Err(invalid(
            "The HLS playlist does not match the media being played.",
        ));
    }
    let parent = destination.parent().ok_or_else(disk)?;
    let staging = tempfile::Builder::new()
        .prefix(".aniverse-hls-")
        .tempdir_in(parent)
        .map_err(|_| disk())?;
    let output = tempfile::Builder::new()
        .prefix(".aniverse-mp4-")
        .tempfile_in(parent)
        .map_err(|_| disk())?
        .into_temp_path();
    let mut local = String::from("#EXTM3U\n#EXT-X-VERSION:7\n");
    let target = segments
        .iter()
        .map(|(seconds, _)| seconds.ceil() as u32)
        .max()
        .unwrap_or(1);
    let _ = writeln!(local, "#EXT-X-TARGETDURATION:{target}");
    let mut remaining = MAX_BYTES;
    let fragmented = init.is_some();
    if let Some(init) = init {
        let path = staging.path().join("init.mp4");
        copy_segment(client, &init, &path, &mut remaining, MAX_INIT).await?;
        let bytes = tokio::fs::read(path).await.map_err(|_| disk())?;
        if has_protection_box(&bytes) {
            return Err(invalid("Encrypted or protected streams cannot be saved."));
        }
        local.push_str("#EXT-X-MAP:URI=\"init.mp4\"\n");
    }
    let extension = if fragmented { "m4s" } else { "ts" };
    let total = segments.len() as u64 + 1;
    progress(0, Some(total));
    for (index, (seconds, uri)) in segments.into_iter().enumerate() {
        let name = format!("segment-{index}.{extension}");
        copy_segment(
            client,
            &uri,
            &staging.path().join(&name),
            &mut remaining,
            MAX_SEGMENT,
        )
        .await?;
        let _ = writeln!(local, "#EXTINF:{seconds:.6},\n{name}");
        progress(index as u64 + 1, Some(total));
    }
    local.push_str("#EXT-X-ENDLIST\n");
    tokio::fs::write(staging.path().join("episode.m3u8"), local)
        .await
        .map_err(|_| disk())?;
    remux(ffmpeg, staging.path(), &output).await?;
    let mut file = tokio::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&output)
        .await
        .map_err(|_| disk())?;
    let length = file.metadata().await.map_err(|_| disk())?.len();
    let mut prefix = [0; 4096];
    let count = file.read(&mut prefix).await.map_err(|_| disk())?;
    if length >= MAX_BYTES || !is_mp4_header(&prefix[..count]) {
        return Err(remux_error());
    }
    file.sync_all().await.map_err(|_| disk())?;
    drop(file);
    let destination = destination.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        output.persist_noclobber(destination).map_err(|error| {
            if error.error.kind() == io::ErrorKind::AlreadyExists {
                exists()
            } else {
                disk()
            }
        })
    })
    .await
    .map_err(|_| disk())??;
    progress(total, Some(total));
    Ok(())
}

fn has_protection_box(bytes: &[u8]) -> bool {
    // Fragmented HLS usually signals encryption through playlist keys. Also
    // reject CENC sample entries and protection boxes in the bounded init file.
    bytes.windows(8).enumerate().any(|(offset, header)| {
        if !matches!(
            &header[4..],
            b"encv" | b"enca" | b"pssh" | b"tenc" | b"senc"
        ) {
            return false;
        }
        let size = u32::from_be_bytes(header[..4].try_into().expect("four-byte box size")) as usize;
        size <= 1 || (8..=bytes.len() - offset).contains(&size)
    })
}

async fn read_playlist(client: &Client, url: &Url) -> Result<Playlist, RpcError> {
    let mut response = receive(client, url).await?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| network())? {
        if bytes.len() + chunk.len() > hls::MAX_MANIFEST {
            return Err(invalid("The HLS playlist is too large."));
        }
        bytes.extend_from_slice(&chunk);
    }
    hls::parse(
        url,
        std::str::from_utf8(&bytes).map_err(|_| invalid("The HLS playlist is unreadable."))?,
    )
}

async fn copy_segment(
    client: &Client,
    url: &Url,
    path: &Path,
    remaining: &mut u64,
    max_bytes: u64,
) -> Result<(), RpcError> {
    let mut response = receive(client, url).await?;
    let limit = (*remaining).min(max_bytes);
    let expected = response.content_length();
    if expected.is_some_and(|count| count == 0 || count > limit) {
        return Err(oversized());
    }
    let mut file = File::create(path).await.map_err(|_| disk())?;
    let mut bytes = 0;
    while let Some(chunk) = response.chunk().await.map_err(|_| network())? {
        bytes += chunk.len() as u64;
        if bytes > limit {
            return Err(oversized());
        }
        file.write_all(&chunk).await.map_err(|_| disk())?;
    }
    if bytes == 0 || expected.is_some_and(|length| length != bytes) {
        return Err(network());
    }
    file.flush().await.map_err(|_| disk())?;
    *remaining -= bytes;
    Ok(())
}

async fn receive(client: &Client, url: &Url) -> Result<Response, RpcError> {
    let response = client
        .get(url.clone())
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|_| network())?;
    if response.status() != StatusCode::OK
        || response
            .headers()
            .get(header::CONTENT_ENCODING)
            .is_some_and(|value| !value.as_bytes().eq_ignore_ascii_case(b"identity"))
    {
        return Err(invalid(
            "The source did not provide publicly accessible HLS media.",
        ));
    }
    Ok(response)
}

struct RemuxChild(Child);

impl Drop for RemuxChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

async fn remux(ffmpeg: &Path, directory: &Path, output: &Path) -> Result<(), RpcError> {
    let mut child = RemuxChild(
        Command::new(ffmpeg)
            .creation_flags(CREATE_NO_WINDOW)
            .current_dir(directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .args([
                "-nostdin",
                "-y",
                "-loglevel",
                "error",
                "-xerror",
                "-protocol_whitelist",
                "file",
                "-allowed_extensions",
                "ts,m4s,mp4",
                "-f",
                "hls",
                "-i",
                "episode.m3u8",
                "-map",
                "0:v:0",
                "-map",
                "0:a",
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                "-fs",
                &MAX_BYTES.to_string(),
                "-f",
                "mp4",
            ])
            .arg(output)
            .spawn()
            .map_err(|_| invalid("AniVerse2 could not start its bundled MP4 remuxer."))?,
    );
    timeout(Duration::from_secs(10 * 60), async {
        loop {
            match child.0.try_wait().map_err(|_| remux_error())? {
                Some(status) if status.success() => return Ok(()),
                Some(_) => return Err(remux_error()),
                None => sleep(Duration::from_millis(100)).await,
            }
        }
    })
    .await
    .map_err(|_| remux_error())?
}

fn remux_error() -> RpcError {
    invalid("The stream’s video and audio could not be combined into an MP4.")
}

fn exists() -> RpcError {
    RpcError::new("config", "That file already exists. Choose a new filename.")
}
fn disk() -> RpcError {
    RpcError::new("config", "Could not save the HLS episode to that folder.")
}
fn network() -> RpcError {
    RpcError::new(
        "network",
        "The source ended the HLS download before it completed.",
    )
}
fn oversized() -> RpcError {
    RpcError::new(
        "network",
        "The HLS media exceeds the offline download size limit.",
    )
}

#[cfg(test)]
#[path = "../../../../test/tauri-compat/hls-remux.rs"]
mod tests;
