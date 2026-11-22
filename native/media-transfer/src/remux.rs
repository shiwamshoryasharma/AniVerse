use super::{
    hls::{self, Playlist},
    invalid,
};
use crate::RpcError;
use aniverse_security::is_mp4_header;
use reqwest::{header, Client, Response, StatusCode, Url};
use std::{
    collections::HashSet,
    fmt::Write as _,
    io::{self, Read as _},
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

#[derive(Clone, Debug, Default)]
pub(super) struct Selection {
    pub direct_primary: bool,
    pub scope: Option<OwnedScope>,
    pub expected_duration: Option<f64>,
    pub playlists: Vec<Url>,
    pub observations: Vec<Url>,
    pub subtitle: Option<SubtitleChoice>,
}
#[derive(Clone, Debug)]
pub(super) struct SubtitleChoice {
    pub url: Option<Url>,
    pub language: Option<String>,
    pub label: Option<String>,
}
// Created only by the trusted owned-player path, never from a public URL action.
// Query-bearing references stay in this operation's memory and are authorized
// by exact captured roots or by a fully validated same-origin playlist.
#[derive(Clone, Debug)]
pub(super) struct OwnedScope {
    allowed: HashSet<Url>,
}
impl OwnedScope {
    pub fn from_owned_selection(
        playlists: &[Url],
        subtitle: Option<&Url>,
    ) -> Result<Self, RpcError> {
        if playlists.is_empty()
            || playlists.len() > 8
            || playlists
                .iter()
                .any(|url| !super::owned_media_url(url) || !super::has_extension(url, "m3u8"))
            || subtitle.is_some_and(|url| !super::owned_media_url(url))
        {
            return Err(invalid("The owned media selection is invalid."));
        }
        let mut allowed: HashSet<_> = playlists.iter().cloned().collect();
        allowed.extend(subtitle.cloned());
        Ok(Self { allowed })
    }
    pub fn contains(&self, url: &Url) -> bool {
        self.allowed.contains(url) && super::owned_media_url(url)
    }
    fn authorize_playlist(&mut self, playlist: &Playlist) {
        match playlist {
            Playlist::Variant(url) => {
                self.allowed.insert(url.clone());
            }
            Playlist::Master {
                variants,
                renditions,
            } => {
                self.allowed
                    .extend(variants.iter().map(|entry| entry.url.clone()));
                self.allowed
                    .extend(renditions.iter().map(|entry| entry.url.clone()));
            }
            Playlist::Media { init, segments } => {
                self.allowed.extend(init.iter().cloned());
                self.allowed
                    .extend(segments.iter().map(|(_, url)| url.clone()));
            }
        }
    }
}
async fn scoped_transport(url: &Url, scope: Option<&OwnedScope>) -> Result<Client, RpcError> {
    if let Some(scope) = scope {
        if !scope.contains(url) {
            return Err(invalid("The media URL is outside the active selection."));
        }
        super::public_transport_checked(url).await
    } else {
        super::public_transport(url).await
    }
}
pub(super) async fn selection_transport(
    url: &Url,
    selection: &Selection,
) -> Result<Client, RpcError> {
    scoped_transport(url, selection.scope.as_ref()).await
}

#[derive(Clone)]
struct Loaded {
    url: Url,
    client: Client,
    playlist: Playlist,
}

async fn load(
    url: &Url,
    loaded: &mut Vec<Loaded>,
    scope: &mut Option<OwnedScope>,
) -> Result<usize, RpcError> {
    if let Some(index) = loaded.iter().position(|entry| entry.url == *url) {
        return Ok(index);
    }
    if loaded.len() >= 48 {
        return Err(invalid("The HLS selection has too many playlists."));
    }
    let client = scoped_transport(url, scope.as_ref()).await?;
    let playlist = read_playlist(&client, url, scope.is_some()).await?;
    if let Some(scope) = scope {
        scope.authorize_playlist(&playlist);
    }
    loaded.push(Loaded {
        url: url.clone(),
        client,
        playlist,
    });
    Ok(loaded.len() - 1)
}
fn observed_rank(playlist: &Playlist, observations: &[Url]) -> Option<usize> {
    let Playlist::Media { segments, .. } = playlist else {
        return None;
    };
    observations
        .iter()
        .position(|url| segments.iter().any(|(_, segment)| segment == url))
}
fn matches_duration(playlist: &Playlist, expected: Option<f64>) -> bool {
    let Playlist::Media { segments, .. } = playlist else {
        return false;
    };
    expected.is_none_or(|expected| {
        let duration: f64 = segments.iter().map(|(seconds, _)| seconds).sum();
        (duration - expected).abs() <= (expected * 0.02).max(3.0)
    })
}
fn select_video(
    url: &Url,
    selection: &Selection,
    loaded: &[Loaded],
    masters: &[(Vec<hls::Variant>, Vec<hls::Rendition>)],
    rendition_urls: &[&Url],
) -> Option<usize> {
    let primary = loaded.iter().find(|entry| entry.url == *url)?;
    let belongs_to_primary = |candidate: &Url| match &primary.playlist {
        Playlist::Media { .. } => candidate == url,
        Playlist::Variant(child) => candidate == child,
        Playlist::Master { variants, .. } => {
            variants.iter().any(|variant| variant.url == *candidate)
        }
    };
    loaded
        .iter()
        .enumerate()
        .filter(|(_, entry)| {
            (!selection.direct_primary || belongs_to_primary(&entry.url))
                && !rendition_urls.contains(&&entry.url)
                && matches_duration(&entry.playlist, selection.expected_duration)
        })
        .filter_map(|(index, entry)| {
            observed_rank(&entry.playlist, &selection.observations).map(|rank| (rank, index))
        })
        .min_by_key(|(rank, _)| *rank)
        .map(|(_, index)| index)
        .or_else(|| {
            if !selection.observations.is_empty() {
                return None;
            }
            loaded
                .iter()
                .position(|entry| {
                    entry.url == *url
                        && matches_duration(&entry.playlist, selection.expected_duration)
                })
                .or_else(|| {
                    if masters.len() == 1 && masters[0].0.len() == 1 {
                        loaded.iter().position(|entry| {
                            entry.url == masters[0].0[0].url
                                && matches_duration(&entry.playlist, selection.expected_duration)
                        })
                    } else {
                        None
                    }
                })
        })
}
async fn select_tracks(
    url: &Url,
    selection: &Selection,
) -> Result<
    (
        Loaded,
        Option<Loaded>,
        Option<SubtitleChoice>,
        Option<OwnedScope>,
    ),
    RpcError,
> {
    let mut scope = selection.scope.clone();
    let mut loaded = Vec::new();
    let mut last_error = None;
    // A failed selected root cannot be replaced by a stale observed clear root.
    load(url, &mut loaded, &mut scope).await?;
    let mut candidates = Vec::new();
    if !selection.direct_primary {
        for candidate in &selection.playlists {
            if candidate != url && !candidates.contains(candidate) {
                candidates.push(candidate.clone());
            }
        }
    }
    for candidate in candidates {
        if let Err(error) = load(&candidate, &mut loaded, &mut scope).await {
            last_error = Some(error);
        }
    }
    let masters: Vec<_> = loaded
        .iter()
        .filter_map(|entry| match &entry.playlist {
            Playlist::Master {
                variants,
                renditions,
            } => Some((variants.clone(), renditions.clone())),
            Playlist::Variant(uri) => Some((
                vec![hls::Variant {
                    url: uri.clone(),
                    audio: None,
                    subtitles: None,
                }],
                vec![],
            )),
            _ => None,
        })
        .collect();
    for (variants, _) in &masters {
        for variant in variants {
            load(&variant.url, &mut loaded, &mut scope).await?;
        }
    }
    let rendition_urls: Vec<_> = masters
        .iter()
        .flat_map(|(_, renditions)| renditions.iter().map(|entry| &entry.url))
        .collect();
    let selected = select_video(url, selection, &loaded, &masters, &rendition_urls);
    let Some(selected) = selected else {
        return Err(last_error
            .unwrap_or_else(|| invalid("The HLS playlists do not match the media being played.")));
    };
    let video = loaded[selected].clone();
    let relation = masters.iter().find_map(|(variants, renditions)| {
        variants
            .iter()
            .find(|variant| variant.url == video.url)
            .map(|variant| (variant.clone(), renditions.clone()))
    });
    let mut audio = None;
    let mut subtitle = selection.subtitle.clone();
    if let Some((variant, renditions)) = relation {
        if let Some(group) = variant.audio {
            let tracks: Vec<_> = renditions
                .iter()
                .filter(|r| r.kind == hls::RenditionKind::Audio && r.group == group)
                .collect();
            let mut available = Vec::new();
            for track in tracks {
                if let Ok(index) = load(&track.url, &mut loaded, &mut scope).await {
                    if matches!(loaded[index].playlist, Playlist::Media { .. }) {
                        available.push((track, index));
                    }
                }
            }
            let chosen = available
                .iter()
                .filter_map(|(_, index)| {
                    observed_rank(&loaded[*index].playlist, &selection.observations)
                        .map(|rank| (rank, *index))
                })
                .min_by_key(|(rank, _)| *rank)
                .map(|(_, index)| index)
                .or_else(|| {
                    available
                        .iter()
                        .find(|(track, _)| track.default)
                        .map(|(_, index)| *index)
                })
                .or_else(|| {
                    if available.len() == 1 {
                        Some(available[0].1)
                    } else {
                        None
                    }
                });
            if !available.is_empty() {
                audio = Some(
                    loaded[chosen
                        .ok_or_else(|| invalid("The selected HLS audio track is ambiguous."))?]
                    .clone(),
                );
            } else if renditions
                .iter()
                .any(|r| r.kind == hls::RenditionKind::Audio && r.group == group)
            {
                return Err(invalid("The selected HLS audio track is unavailable."));
            }
        }
        if subtitle
            .as_ref()
            .and_then(|choice| choice.url.as_ref())
            .is_none()
        {
            if let Some(group) = variant.subtitles {
                let tracks: Vec<_> = renditions
                    .iter()
                    .filter(|r| r.kind == hls::RenditionKind::Subtitle && r.group == group)
                    .collect();
                let wanted = subtitle.as_ref();
                let chosen = wanted
                    .and_then(|choice| {
                        tracks
                            .iter()
                            .find(|track| {
                                choice.language.as_ref().is_some_and(|language| {
                                    track
                                        .language
                                        .as_ref()
                                        .is_some_and(|value| value.eq_ignore_ascii_case(language))
                                }) || choice
                                    .label
                                    .as_ref()
                                    .is_some_and(|label| track.name.eq_ignore_ascii_case(label))
                            })
                            .copied()
                    })
                    .or_else(|| tracks.iter().find(|track| track.default).copied());
                if let Some(track) = chosen {
                    subtitle = Some(SubtitleChoice {
                        url: Some(track.url.clone()),
                        language: track.language.clone(),
                        label: Some(track.name.clone()),
                    });
                } else if wanted.is_some() {
                    return Err(invalid("The selected subtitle track is unavailable."));
                }
            }
        }
    }
    if subtitle.as_ref().is_some_and(|choice| choice.url.is_none()) {
        return Err(invalid("The selected subtitle track is unavailable."));
    }
    Ok((video, audio, subtitle, scope))
}

pub(super) async fn save_selected(
    _client: &Client,
    url: &Url,
    selection: &Selection,
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
    let (video, audio, subtitle, scope) = select_tracks(url, selection).await?;
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
    let count = |entry: &Loaded| match &entry.playlist {
        Playlist::Media { segments, .. } => segments.len() as u64,
        _ => 0,
    };
    let total = count(&video) + audio.as_ref().map_or(0, count) + u64::from(subtitle.is_some()) + 1;
    let mut received = 0;
    let mut remaining = MAX_BYTES;
    progress(0, Some(total));
    stage_track(
        &video,
        staging.path(),
        "video",
        false,
        &mut remaining,
        || {
            received += 1;
            progress(received, Some(total));
        },
    )
    .await?;
    if let Some(audio) = &audio {
        stage_track(audio, staging.path(), "audio", true, &mut remaining, || {
            received += 1;
            progress(received, Some(total));
        })
        .await?;
    }
    if audio.is_some() {
        tokio::fs::write(staging.path().join("selected.m3u8"), "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"Selected\",DEFAULT=YES,AUTOSELECT=YES,URI=\"audio.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=10000000,AUDIO=\"audio\"\nvideo.m3u8\n").await.map_err(|_| disk())?;
    }
    let mut mux_subtitle = subtitle.as_ref();
    if let Some(subtitle) = &subtitle {
        let media_start = probe_media_start(ffmpeg, staging.path(), audio.is_some()).await?;
        if !stage_subtitle(
            subtitle,
            staging.path(),
            &mut remaining,
            media_start,
            scope.as_ref(),
        )
        .await?
        {
            mux_subtitle = None;
        }
        received += 1;
        progress(received, Some(total));
    }
    mux_selected(
        ffmpeg,
        staging.path(),
        audio.is_some(),
        mux_subtitle,
        &output,
    )
    .await?;
    publish_mp4(output, destination).await?;
    progress(total, Some(total));
    Ok(())
}

async fn stage_track(
    entry: &Loaded,
    directory: &Path,
    prefix: &str,
    audio: bool,
    remaining: &mut u64,
    mut progress: impl FnMut(),
) -> Result<(), RpcError> {
    let Playlist::Media { init, segments } = &entry.playlist else {
        return Err(remux_error());
    };
    let mut local = String::from("#EXTM3U\n#EXT-X-VERSION:7\n");
    let target = segments
        .iter()
        .map(|(seconds, _)| seconds.ceil() as u32)
        .max()
        .unwrap_or(1);
    let _ = writeln!(local, "#EXT-X-TARGETDURATION:{target}");
    if let Some(init) = init {
        let name = format!("{prefix}-init.mp4");
        let path = directory.join(&name);
        copy_segment(&entry.client, init, &path, remaining, MAX_INIT).await?;
        let bytes = tokio::fs::read(path).await.map_err(|_| disk())?;
        if !is_mp4_header(&bytes[..bytes.len().min(4096)]) || has_protection_box(&bytes) {
            return Err(invalid("The HLS initialization is invalid or protected."));
        }
        let _ = writeln!(local, "#EXT-X-MAP:URI=\"{name}\"");
    }
    for (index, (seconds, uri)) in segments.iter().enumerate() {
        let temporary = directory.join(format!("{prefix}-{index}.part"));
        copy_segment(&entry.client, uri, &temporary, remaining, MAX_SEGMENT).await?;
        let mut file = File::open(&temporary).await.map_err(|_| disk())?;
        let mut bytes = vec![0; 16 * 1024];
        let length = file.metadata().await.map_err(|_| disk())?.len();
        let used = file.read(&mut bytes).await.map_err(|_| disk())?;
        bytes.truncate(used);
        drop(file);
        let extension = segment_format(&bytes, length, init.is_some(), audio)
            .ok_or_else(|| invalid("A playlist segment is not clear video or audio media."))?;
        let name = format!("{prefix}-{index}.{extension}");
        tokio::fs::rename(temporary, directory.join(&name))
            .await
            .map_err(|_| disk())?;
        let _ = writeln!(local, "#EXTINF:{seconds:.6},\n{name}");
        progress();
    }
    local.push_str("#EXT-X-ENDLIST\n");
    tokio::fs::write(directory.join(format!("{prefix}.m3u8")), local)
        .await
        .map_err(|_| disk())
}

fn segment_format(
    bytes: &[u8],
    length: u64,
    fragmented: bool,
    audio: bool,
) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"RIFF")
        || bytes.starts_with(b"<")
    {
        return None;
    }
    if fragmented {
        if has_protection_box(bytes) {
            return None;
        }
        let mut offset = 0;
        let mut moof = false;
        while offset + 8 <= bytes.len() {
            let size = u32::from_be_bytes(bytes[offset..offset + 4].try_into().ok()?) as usize;
            if size < 8 || offset as u64 + size as u64 > length {
                return None;
            }
            match &bytes[offset + 4..offset + 8] {
                b"moof" => moof = true,
                b"mdat" if moof => return Some("m4s"),
                b"styp" | b"sidx" | b"emsg" | b"prft" | b"free" => {}
                _ => return None,
            }
            offset = offset.checked_add(size)?;
        }
        return None;
    }
    let start = if bytes.starts_with(b"ID3") {
        if bytes.len() < 10 || bytes[6..10].iter().any(|value| value & 128 != 0) {
            return None;
        }
        10 + bytes[6..10]
            .iter()
            .fold(0usize, |size, value| (size << 7) | usize::from(*value))
    } else {
        0
    };
    for (packet, shift) in [(188, 0), (192, 4), (204, 0)] {
        if (0..3).all(|index| bytes.get(start + shift + index * packet) == Some(&0x47)) {
            return Some("ts");
        }
    }
    if audio {
        let header = bytes.get(start..start + 7)?;
        let size = ((usize::from(header[3] & 3)) << 11)
            | (usize::from(header[4]) << 3)
            | usize::from(header[5] >> 5);
        if header[0] == 0xff
            && header[1] & 0xf6 == 0xf0
            && size >= 7
            && bytes.get(start + size) == Some(&0xff)
        {
            return Some("aac");
        }
    }
    None
}

async fn stage_subtitle(
    choice: &SubtitleChoice,
    directory: &Path,
    remaining: &mut u64,
    media_start: f64,
    scope: Option<&OwnedScope>,
) -> Result<bool, RpcError> {
    let url = choice
        .url
        .as_ref()
        .ok_or_else(|| invalid("The selected subtitle track is unavailable."))?;
    let mut scope = scope.cloned();
    let client = scoped_transport(url, scope.as_ref()).await?;
    let path = directory.join("subtitle.part");
    copy_segment(&client, url, &path, remaining, 2 * 1024 * 1024).await?;
    let first = tokio::fs::read(&path).await.map_err(|_| disk())?;
    let mut parts = Vec::new();
    if first.starts_with(b"#EXTM3U") || first.starts_with(b"\xef\xbb\xbf#EXTM3U") {
        let parse: fn(&Url, &str) -> Result<Playlist, RpcError> = if scope.is_some() {
            hls::parse_owned
        } else {
            hls::parse
        };
        let playlist = parse(
            url,
            std::str::from_utf8(&first)
                .map_err(|_| invalid("The subtitle playlist is unreadable."))?,
        )?;
        if let Some(scope) = &mut scope {
            scope.authorize_playlist(&playlist);
        }
        let Playlist::Media {
            init: None,
            segments,
        } = playlist
        else {
            return Err(invalid(
                "The selected subtitles must be a finite WebVTT playlist.",
            ));
        };
        let mut offset = 0.0;
        let mut bytes = 0usize;
        for (index, (seconds, uri)) in segments.iter().enumerate() {
            if scope.as_ref().is_some_and(|scope| !scope.contains(uri)) {
                return Err(invalid(
                    "The subtitle reference is outside the active selection.",
                ));
            }
            let path = directory.join(format!("subtitle-{index}.part"));
            copy_segment(&client, uri, &path, remaining, 2 * 1024 * 1024).await?;
            let part = tokio::fs::read(path).await.map_err(|_| disk())?;
            bytes += part.len();
            if bytes > 2 * 1024 * 1024 {
                return Err(invalid("The subtitles exceed the offline size limit."));
            }
            parts.push((offset, part));
            offset += seconds;
        }
    } else {
        parts.push((0.0, first));
    }
    let normalized = crate::vtt::normalize(&parts, media_start)?;
    if normalized.cue_count == 0 {
        return Ok(false);
    }
    tokio::fs::write(directory.join("captions.vtt"), normalized.text)
        .await
        .map_err(|_| disk())?;
    Ok(true)
}

async fn probe_media_start(ffmpeg: &Path, directory: &Path, audio: bool) -> Result<f64, RpcError> {
    let failed = || invalid("The selected subtitles could not be aligned with the video.");
    let probe = ffmpeg.with_file_name("ffprobe.exe");
    let mut command = Command::new(probe);
    command
        .creation_flags(CREATE_NO_WINDOW)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-allowed_extensions",
            "m3u8,ts,m4s,mp4,aac",
            "-f",
            "hls",
            "-i",
            if audio { "selected.m3u8" } else { "video.m3u8" },
            "-show_entries",
            "format=start_time",
            "-of",
            "json",
        ]);
    let mut child = RemuxChild(command.spawn().map_err(|_| failed())?);
    let stdout = child.0.stdout.take().ok_or_else(failed)?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        std::io::Read::take(stdout, 16 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    timeout(Duration::from_secs(15), async {
        loop {
            match child.0.try_wait().map_err(|_| failed())? {
                Some(status) if status.success() => return Ok(()),
                Some(_) => return Err(failed()),
                None => sleep(Duration::from_millis(50)).await,
            }
        }
    })
    .await
    .map_err(|_| failed())??;
    let bytes = reader.join().map_err(|_| failed())?.map_err(|_| failed())?;
    if bytes.len() > 16 * 1024 {
        return Err(failed());
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| failed())?;
    value["format"]["start_time"]
        .as_str()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && value.abs() <= 7.0 * 24.0 * 3600.0)
        .ok_or_else(failed)
}
async fn mux_selected(
    ffmpeg: &Path,
    directory: &Path,
    audio: bool,
    subtitle: Option<&SubtitleChoice>,
    output: &Path,
) -> Result<(), RpcError> {
    let mut command = ffmpeg_command(ffmpeg, directory);
    command.args([
        "-threads",
        "2",
        "-allowed_extensions",
        "m3u8,ts,m4s,mp4,aac",
        "-f",
        "hls",
        "-i",
        if audio { "selected.m3u8" } else { "video.m3u8" },
    ]);
    if subtitle.is_some() {
        command.args(["-f", "webvtt", "-i", "captions.vtt"]);
    }
    command.args([
        "-map", "0:v:0", "-map", "0:a", "-c:v", "copy", "-c:a", "copy",
    ]);
    if let Some(subtitle) = subtitle {
        command.args(["-map", "1:s:0", "-c:s", "mov_text"]);
        if let Some(language) = &subtitle.language {
            command
                .arg("-metadata:s:s:0")
                .arg(format!("language={language}"));
        }
        if let Some(label) = &subtitle.label {
            command.arg("-metadata:s:s:0").arg(format!("title={label}"));
        }
    }
    run_ffmpeg(finish_command(command, output)).await
}
pub(super) async fn save_container(
    client: &Client,
    url: &Url,
    format: &str,
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
    let parent = destination.parent().ok_or_else(disk)?;
    let scratch = tempfile::Builder::new()
        .prefix(".aniverse-video-")
        .tempdir_in(parent)
        .map_err(|_| disk())?;
    let output = tempfile::Builder::new()
        .prefix(".aniverse-mp4-")
        .tempfile_in(parent)
        .map_err(|_| disk())?
        .into_temp_path();
    progress(0, None);
    let mut remaining = MAX_BYTES;
    copy_segment(
        client,
        url,
        &scratch.path().join("input.video"),
        &mut remaining,
        MAX_BYTES,
    )
    .await?;
    progress(1, Some(2));

    convert_local(ffmpeg, scratch.path(), "input.video", format, &output).await?;
    publish_mp4(output, destination).await?;
    progress(2, Some(2));
    Ok(())
}

async fn publish_mp4(output: tempfile::TempPath, destination: &Path) -> Result<(), RpcError> {
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
    tokio::task::spawn_blocking(move || {
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

async fn read_playlist(client: &Client, url: &Url, owned: bool) -> Result<Playlist, RpcError> {
    let mut response = receive(client, url).await?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| network())? {
        if bytes.len() + chunk.len() > hls::MAX_MANIFEST {
            return Err(invalid("The HLS playlist is too large."));
        }
        bytes.extend_from_slice(&chunk);
    }
    let text =
        std::str::from_utf8(&bytes).map_err(|_| invalid("The HLS playlist is unreadable."))?;
    if owned {
        hls::parse_owned(url, text)
    } else {
        hls::parse(url, text)
    }
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
        return Err(invalid("The source did not provide accessible video."));
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

async fn convert_local(
    ffmpeg: &Path,
    directory: &Path,
    input: &str,
    format: &str,
    output: &Path,
) -> Result<(), RpcError> {
    let command = |codec: &[&str]| {
        let mut command = ffmpeg_command(ffmpeg, directory);
        if format == "hls" {
            command.args(["-allowed_extensions", "ts,m4s,mp4"]);
        }
        // The demuxer and files come from the worker. No external protocol is enabled.
        let audio = if format == "hls" { "0:a" } else { "0:a?" };
        command.args([
            "-threads", "2", "-f", format, "-i", input, "-map", "0:v:0", "-map", audio,
        ]);
        command.args(codec);
        finish_command(command, output)
    };
    let copy: &[&str] = if format == "hls" {
        &["-c", "copy"]
    } else {
        &["-c", "copy", "-tag:v", "avc1", "-tag:a", "mp4a"]
    };
    if run_ffmpeg(command(copy)).await.is_ok() {
        return Ok(());
    }
    run_ffmpeg(command(&[
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a",
        "aac", "-b:a", "192k", "-threads", "4",
    ]))
    .await
}

fn ffmpeg_command(ffmpeg: &Path, directory: &Path) -> Command {
    let mut command = Command::new(ffmpeg);
    command
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
        ]);
    command
}

fn finish_command(mut command: Command, output: &Path) -> Command {
    command
        .args([
            "-movflags",
            "+faststart",
            "-fs",
            &MAX_BYTES.to_string(),
            "-f",
            "mp4",
        ])
        .arg(output);
    command
}

async fn run_ffmpeg(mut command: Command) -> Result<(), RpcError> {
    let mut child = RemuxChild(
        command
            .spawn()
            .map_err(|_| invalid("AniVerse could not start its bundled video converter."))?,
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
    RpcError::new("config", "Could not save the video to that folder.")
}
fn network() -> RpcError {
    RpcError::new(
        "network",
        "The source ended the video download before it completed.",
    )
}
fn oversized() -> RpcError {
    RpcError::new("network", "The video exceeds the download size limit.")
}

#[cfg(test)]
#[path = "../../../test/native-media/hls-remux.rs"]
mod tests;
