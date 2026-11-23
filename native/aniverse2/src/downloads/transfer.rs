use super::media::{self, Detected, MediaFormat, RequestContexts};
use crate::RpcError;
use aniverse_security::is_mp4_header;
use reqwest::{
    header::{self, HeaderValue},
    Client, Response, StatusCode, Url,
};
use std::{
    io::{self, SeekFrom},
    path::Path,
    time::{Duration, Instant},
};
use tokio::{
    fs::File,
    io::{AsyncSeekExt, AsyncWriteExt},
};

const LIMIT: u64 = 8 * 1024 * 1024 * 1024;
const HEADER_LIMIT: usize = 16 * 1024;

struct Transfer {
    format: MediaFormat,
    total: Option<u64>,
    etag: Option<HeaderValue>,
    received: u64,
    prefix: Vec<u8>,
}

#[cfg(test)]
pub(super) async fn save(
    client: &Client,
    url: &Url,
    destination: &Path,
    progress: impl FnMut(u64, Option<u64>),
) -> Result<(), RpcError> {
    save_guarded(client, url, destination, progress, &|| true).await
}

pub(super) async fn save_guarded(
    client: &Client,
    url: &Url,
    destination: &Path,
    progress: impl FnMut(u64, Option<u64>),
    owned: &(impl Fn() -> bool + Sync),
) -> Result<(), RpcError> {
    super::require_owner(owned)?;

    super::require_owner(owned)?;
    if tokio::fs::try_exists(destination)
        .await
        .map_err(|_| disk())?
    {
        return Err(already_exists());
    }
    let contexts = RequestContexts::new();
    let response = full_response(client, url, &contexts, MediaFormat::Mp4).await?;
    save_response(
        client,
        url,
        &contexts,
        MediaFormat::Mp4,
        response,
        Vec::new(),
        destination,
        progress,
        owned,
    )
    .await
}

pub(super) async fn save_detected(
    client: &Client,
    url: &Url,
    contexts: &RequestContexts,
    detected: Detected,
    destination: &Path,
    progress: impl FnMut(u64, Option<u64>),
    owned: &(impl Fn() -> bool + Sync),
) -> Result<(), RpcError> {
    save_response(
        client,
        url,
        contexts,
        detected.format,
        detected.response,
        detected.prefix,
        destination,
        progress,
        owned,
    )
    .await
}

async fn save_response(
    client: &Client,
    url: &Url,
    contexts: &RequestContexts,
    format: MediaFormat,
    mut response: Response,
    prefix: Vec<u8>,
    destination: &Path,
    mut progress: impl FnMut(u64, Option<u64>),
    owned: &(impl Fn() -> bool + Sync),
) -> Result<(), RpcError> {
    super::require_owner(owned)?;
    if tokio::fs::try_exists(destination)
        .await
        .map_err(|_| disk())?
    {
        return Err(already_exists());
    }
    let parent = destination.parent().ok_or_else(disk)?.to_owned();
    let destination = destination.to_owned();
    let staging = tauri::async_runtime::spawn_blocking(move || {
        tempfile::Builder::new()
            .prefix(".aniverse-mp4-")
            .tempfile_in(parent)
    })
    .await
    .map_err(|_| disk())?
    .map_err(|_| disk())?;
    let mut file = File::from_std(staging.reopen().map_err(|_| disk())?);
    let mut transfer = Transfer::from_response(&response, format)?;
    transfer.write_chunk(&prefix, &mut file).await?;
    let mut complete = transfer
        .append(&mut response, &mut file, &mut progress)
        .await?;
    if !complete {
        drop(response);
        // A resumed response must prove it refers to the identical representation.
        if let Some(mut response) = transfer.resume(client, url, contexts).await {
            complete = transfer
                .append(&mut response, &mut file, &mut progress)
                .await?;
        }
    }
    if !complete {
        file.set_len(0).await.map_err(|_| disk())?;
        file.seek(SeekFrom::Start(0)).await.map_err(|_| disk())?;
        let mut response = full_response(client, url, contexts, format).await?;
        transfer = Transfer::from_response(&response, format)?;
        if !transfer
            .append(&mut response, &mut file, &mut progress)
            .await?
        {
            return Err(network());
        }
    }
    if !matches_format(&transfer.prefix, format) {
        return Err(invalid_mp4());
    }
    file.sync_all().await.map_err(|_| disk())?;
    if !prefix.is_empty() {
        if format == MediaFormat::Webm {
            media::validate_clear_webm(staging.path()).await?;
        } else {
            media::validate_clear_mp4(staging.path()).await?;
        }
    }
    drop(file);
    super::require_owner(owned)?;
    tauri::async_runtime::spawn_blocking(move || {
        staging
            .persist_noclobber(destination)
            .map(|_| ())
            .map_err(|error| {
                if error.error.kind() == io::ErrorKind::AlreadyExists {
                    already_exists()
                } else {
                    disk()
                }
            })
    })
    .await
    .map_err(|_| disk())?
}

async fn full_response(
    client: &Client,
    url: &Url,
    contexts: &RequestContexts,
    format: MediaFormat,
) -> Result<Response, RpcError> {
    let response = media::receive(client, url, contexts).await?;
    if response.status() != StatusCode::OK || !plain_media(&response, format) {
        return Err(RpcError::new(
            "invalid-input",
            "The source did not return a complete direct video file.",
        ));
    }
    Ok(response)
}

fn plain_media(response: &Response, format: MediaFormat) -> bool {
    let headers = response.headers();
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_none_or(|value| {
            let mime = value.trim();
            mime.eq_ignore_ascii_case("application/octet-stream")
                || media::format_from_mime(mime) == Some(format)
        })
        && headers
            .get(header::CONTENT_ENCODING)
            .is_none_or(|value| value.as_bytes().eq_ignore_ascii_case(b"identity"))
}

fn matches_format(bytes: &[u8], format: MediaFormat) -> bool {
    if format == MediaFormat::Mp4 {
        is_mp4_header(bytes)
    } else {
        media::sniff(bytes) == Some(format)
    }
}

impl Transfer {
    fn from_response(response: &Response, format: MediaFormat) -> Result<Self, RpcError> {
        // Detection may have consumed a chunk; use the full HTTP length.
        let total = response
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|length| length.to_str().ok())
            .and_then(|length| length.parse::<u64>().ok());
        if total.is_some_and(|length| length > LIMIT) {
            return Err(oversized());
        }
        let etag = response
            .headers()
            .get(header::ETAG)
            .filter(|value| {
                value.as_bytes().starts_with(b"\"") && value.as_bytes().ends_with(b"\"")
            })
            .cloned();
        Ok(Self {
            format,
            total,
            etag,
            received: 0,
            prefix: Vec::with_capacity(HEADER_LIMIT),
        })
    }

    async fn resume(
        &self,
        client: &Client,
        url: &Url,
        contexts: &RequestContexts,
    ) -> Option<Response> {
        let total = self.total?;
        let etag = self.etag.as_ref()?;
        if self.received == 0 || self.received >= total {
            return None;
        }
        let response = media::request(client, url, contexts)
            .header(header::RANGE, format!("bytes={}-", self.received))
            .header(header::IF_RANGE, etag.clone())
            .send()
            .await
            .ok()?;
        let expected = format!("bytes {}-{}/{total}", self.received, total - 1);
        (response.status() == StatusCode::PARTIAL_CONTENT
            && plain_media(&response, self.format)
            && response.headers().get(header::ETAG) == Some(etag)
            && response
                .headers()
                .get(header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                == Some(expected.as_str())
            && response
                .content_length()
                .is_none_or(|length| length == total - self.received))
        .then_some(response)
    }

    async fn append(
        &mut self,
        response: &mut Response,
        file: &mut File,
        progress: &mut impl FnMut(u64, Option<u64>),
    ) -> Result<bool, RpcError> {
        progress(self.received, self.total);
        let mut last = Instant::now();
        loop {
            let chunk = match response.chunk().await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => return Ok(self.total.is_none_or(|expected| self.received == expected)),
                Err(_) => return Ok(false),
            };
            self.write_chunk(&chunk, file).await?;
            if last.elapsed() >= Duration::from_millis(200) {
                last = Instant::now();
                progress(self.received, self.total);
            }
        }
    }
    async fn write_chunk(&mut self, chunk: &[u8], file: &mut File) -> Result<(), RpcError> {
        self.received += chunk.len() as u64;
        if self.received > self.total.unwrap_or(LIMIT) {
            return Err(oversized());
        }
        let prefix_bytes = (HEADER_LIMIT - self.prefix.len()).min(chunk.len());
        if prefix_bytes != 0 {
            self.prefix.extend_from_slice(&chunk[..prefix_bytes]);
            if self.prefix.len() == HEADER_LIMIT && !matches_format(&self.prefix, self.format) {
                return Err(invalid_mp4());
            }
        }
        file.write_all(chunk).await.map_err(|_| disk())
    }
}

fn already_exists() -> RpcError {
    RpcError::new("config", "That file already exists. Choose a new filename.")
}

fn invalid_mp4() -> RpcError {
    RpcError::new(
        "invalid-input",
        "The direct response no longer matches its detected video container.",
    )
}

fn disk() -> RpcError {
    RpcError::new("config", "Could not save the MP4 to that folder.")
}

fn network() -> RpcError {
    RpcError::new(
        "network",
        "The source ended the MP4 download before it completed.",
    )
}

fn oversized() -> RpcError {
    RpcError::new(
        "network",
        "The response exceeds the allowed MP4 download length.",
    )
}

#[cfg(test)]
#[path = "../../../../test/tauri-compat/mp4-download.rs"]
mod tests;
