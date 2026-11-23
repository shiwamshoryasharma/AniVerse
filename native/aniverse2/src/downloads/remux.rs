use super::{
    hls::{self, Playlist},
    invalid,
    media::{self, Detected, MediaFormat, RequestContexts},
};
use crate::RpcError;
use aniverse_security::is_mp4_header;
use reqwest::{Client, Response, Url};
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
pub(crate) struct Selection {
    pub scope: Option<OwnedScope>,
    pub direct_primary: bool,
    pub format: Option<MediaFormat>,
    pub request_contexts: RequestContexts,
    pub max_height: Option<u32>,
    pub owned_root: bool,
    pub expected_duration: Option<f64>,
    pub playlists: Vec<Url>,
    pub observations: Vec<Url>,
    pub subtitle: Option<SubtitleChoice>,
}
#[derive(Clone, Debug)]
pub(crate) struct SubtitleChoice {
    pub url: Option<Url>,
    pub language: Option<String>,
    pub label: Option<String>,
}
// Created only by the trusted owned-player path, never from a public URL action.
// Query-bearing references stay in this operation's memory and are authorized
// by exact captured roots or by a fully validated same-origin playlist.
#[derive(Clone, Debug)]
pub(crate) struct OwnedScope {
    allowed: HashSet<Url>,
}
impl OwnedScope {
    pub(super) fn from_owned_selection(
        playlists: &[Url],
        subtitle: Option<&Url>,
    ) -> Result<Self, RpcError> {
        if playlists.is_empty()
            || playlists.len() > 8
            || playlists.iter().any(|url| !super::owned_media_url(url))
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
    contexts: &RequestContexts,
    owned: &(impl Fn() -> bool + Sync),
) -> Result<usize, RpcError> {
    super::require_owner(owned)?;
    if let Some(index) = loaded.iter().position(|entry| entry.url == *url) {
        return Ok(index);
    }
    if loaded.len() >= 48 {
        return Err(invalid("The HLS selection has too many playlists."));
    }
    let client = scoped_transport(url, scope.as_ref()).await?;
    super::require_owner(owned)?;
    let playlist = read_playlist(&client, url, scope.is_some(), contexts).await?;
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
    if let (Some(maximum), Playlist::Master { variants, .. }) =
        (selection.max_height, &primary.playlist)
    {
        // A cap can choose another rendition of the same root, once at least
        // one rendition proves ownership of a blob-backed player.
        let owned_master = selection.direct_primary
            || loaded.iter().any(|entry| {
                belongs_to_primary(&entry.url)
                    && !rendition_urls.contains(&&entry.url)
                    && matches_duration(&entry.playlist, selection.expected_duration)
                    && observed_rank(&entry.playlist, &selection.observations).is_some()
            });
        if !owned_master {
            return None;
        }
        return variants
            .iter()
            .filter_map(|variant| {
                let height = variant.height.filter(|height| *height <= maximum)?;
                let index = loaded.iter().position(|entry| {
                    entry.url == variant.url
                        && matches_duration(&entry.playlist, selection.expected_duration)
                })?;
                Some((height, variant.bandwidth.unwrap_or(0), index))
            })
            .max_by_key(|(height, bandwidth, _)| (*height, *bandwidth))
            .map(|(_, _, index)| index);
    }
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
    initial: Option<Loaded>,
    owned: &(impl Fn() -> bool + Sync),
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
    // The selected root must be valid even when older clear playlists remain observed.

    let contexts = &selection.request_contexts;
    if let Some(entry) = initial {
        if let Some(scope) = &mut scope {
            scope.authorize_playlist(&entry.playlist);
        }
        loaded.push(entry);
    } else {
        load(url, &mut loaded, &mut scope, contexts, owned).await?;
    }
    let mut candidates = Vec::new();
    if !selection.direct_primary {
        for candidate in &selection.playlists {
            if candidate != url && !candidates.contains(candidate) {
                candidates.push(candidate.clone());
            }
        }
    }
    for candidate in candidates {
        if let Err(error) = load(&candidate, &mut loaded, &mut scope, contexts, owned).await {
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
                    height: None,
                    bandwidth: None,
                }],
                vec![],
            )),
            _ => None,
        })
        .collect();
    for (variants, _) in &masters {
        for variant in variants {
            // A protected or invalid declared variant must not redirect selection to stale media.
            load(&variant.url, &mut loaded, &mut scope, contexts, owned).await?;
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
                if let Ok(index) = load(&track.url, &mut loaded, &mut scope, contexts, owned).await
                {
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

#[cfg(test)]
pub(super) async fn save_selected_guarded(
    _client: &Client,
    url: &Url,
    selection: &Selection,
    destination: &Path,
    ffmpeg: &Path,
    progress: impl FnMut(u64, Option<u64>),
    owned: &(impl Fn() -> bool + Sync),
) -> Result<(), RpcError> {
    save_hls(url, selection, None, destination, ffmpeg, progress, owned).await
}

async fn save_hls(
    url: &Url,
    selection: &Selection,
    initial: Option<Loaded>,
    destination: &Path,
    ffmpeg: &Path,
    mut progress: impl FnMut(u64, Option<u64>),
    owned: &(impl Fn() -> bool + Sync),
) -> Result<(), RpcError> {
    super::require_owner(owned)?;
    if tokio::fs::try_exists(destination)
        .await
        .map_err(|_| disk())?
    {
        return Err(exists());
    }
    let (video, audio, subtitle, scope) = select_tracks(url, selection, initial, owned).await?;
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
        &selection.request_contexts,
        owned,
        || {
            received += 1;
            progress(received, Some(total));
        },
    )
    .await?;
    if let Some(audio) = &audio {
        stage_track(
            audio,
            staging.path(),
            "audio",
            true,
            &mut remaining,
            &selection.request_contexts,
            owned,
            || {
                received += 1;
                progress(received, Some(total));
            },
        )
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
            &selection.request_contexts,
            owned,
        )
        .await?
        {
            mux_subtitle = None;
        }
        received += 1;
        progress(received, Some(total));
    }
    super::require_owner(owned)?;
    mux_selected(
        ffmpeg,
        staging.path(),
        audio.is_some(),
        mux_subtitle,
        &output,
    )
    .await?;
    publish_mp4(output, destination, owned).await?;
    progress(total, Some(total));
    Ok(())
}

async fn stage_track(
    entry: &Loaded,
    directory: &Path,
    prefix: &str,
    audio: bool,
    remaining: &mut u64,
    contexts: &RequestContexts,
    owned: &(impl Fn() -> bool + Sync),
    mut progress: impl FnMut(),
) -> Result<(), RpcError> {
    super::require_owner(owned)?;
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
        copy_segment(&entry.client, init, &path, remaining, MAX_INIT, contexts).await?;
        let bytes = tokio::fs::read(path).await.map_err(|_| disk())?;
        if !is_mp4_header(&bytes[..bytes.len().min(4096)]) || has_protection_box(&bytes) {
            return Err(invalid("The HLS initialization is invalid or protected."));
        }
        let _ = writeln!(local, "#EXT-X-MAP:URI=\"{name}\"");
    }
    for (index, (seconds, uri)) in segments.iter().enumerate() {
        super::require_owner(owned)?;
        let temporary = directory.join(format!("{prefix}-{index}.part"));
        copy_segment(
            &entry.client,
            uri,
            &temporary,
            remaining,
            MAX_SEGMENT,
            contexts,
        )
        .await?;
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
    contexts: &RequestContexts,
    owned: &(impl Fn() -> bool + Sync),
) -> Result<bool, RpcError> {
    super::require_owner(owned)?;
    let url = choice
        .url
        .as_ref()
        .ok_or_else(|| invalid("The selected subtitle track is unavailable."))?;
    let mut scope = scope.cloned();
    let client = scoped_transport(url, scope.as_ref()).await?;
    let path = directory.join("subtitle.part");
    copy_segment(&client, url, &path, remaining, 2 * 1024 * 1024, contexts).await?;
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
            super::require_owner(owned)?;
            if scope.as_ref().is_some_and(|scope| !scope.contains(uri)) {
                return Err(invalid(
                    "The subtitle reference is outside the active selection.",
                ));
            }
            let path = directory.join(format!("subtitle-{index}.part"));
            copy_segment(&client, uri, &path, remaining, 2 * 1024 * 1024, contexts).await?;
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
    let normalized = super::vtt::normalize(&parts, media_start)?;
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
async fn publish_mp4(
    output: tempfile::TempPath,
    destination: &Path,
    owned: &(impl Fn() -> bool + Sync),
) -> Result<(), RpcError> {
    super::require_owner(owned)?;
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
    super::require_owner(owned)?;
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

async fn read_playlist(
    client: &Client,
    url: &Url,
    owned: bool,
    contexts: &RequestContexts,
) -> Result<Playlist, RpcError> {
    let mut response = media::receive(client, url, contexts).await?;
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

pub(super) async fn download_guarded(
    url: &Url,
    selection: &Selection,
    destination: &Path,
    ffmpeg: Option<&Path>,
    progress: impl FnMut(u64, Option<u64>),
    owned: &(impl Fn() -> bool + Sync),
) -> Result<(), RpcError> {
    super::require_owner(owned)?;
    if tokio::fs::try_exists(destination)
        .await
        .map_err(|_| disk())?
    {
        return Err(exists());
    }
    let client = selection_transport(url, selection).await?;
    let detected =
        media::detect(&client, url, &selection.request_contexts, selection.format).await?;
    let muxer = || ffmpeg.ok_or_else(|| invalid("The bundled MP4 remuxer is missing."));
    match detected.format {
        MediaFormat::Mp4 => {
            if selection
                .subtitle
                .as_ref()
                .is_some_and(|choice| choice.url.is_some())
            {
                let text = selection.subtitle.as_ref().unwrap();
                save_single_container(
                    detected,
                    url,
                    &client,
                    selection,
                    destination,
                    muxer()?,
                    Some(text),
                    progress,
                    owned,
                )
                .await
            } else {
                super::transfer::save_detected(
                    &client,
                    url,
                    &selection.request_contexts,
                    detected,
                    destination,
                    progress,
                    owned,
                )
                .await
            }
        }
        MediaFormat::Webm => {
            save_single_container(
                detected,
                url,
                &client,
                selection,
                destination,
                muxer()?,
                selection
                    .subtitle
                    .as_ref()
                    .filter(|choice| choice.url.is_some()),
                progress,
                owned,
            )
            .await
        }
        MediaFormat::Hls => {
            let text = media::manifest(detected, hls::MAX_MANIFEST).await?;
            let playlist = if selection.scope.is_some() {
                hls::parse_owned(url, &text)?
            } else {
                hls::parse(url, &text)?
            };
            let initial = Loaded {
                url: url.clone(),
                client,
                playlist,
            };
            save_hls(
                url,
                selection,
                Some(initial),
                destination,
                muxer()?,
                progress,
                owned,
            )
            .await
        }
        MediaFormat::Dash => {
            let text = media::manifest(detected, 512 * 1024).await?;
            let manifest = super::dash::parse(url, &text)?;
            save_dash(
                &client,
                url,
                manifest,
                selection,
                destination,
                muxer()?,
                progress,
                owned,
            )
            .await
        }
    }
}

async fn save_single_container(
    detected: Detected,
    url: &Url,
    client: &Client,
    selection: &Selection,
    destination: &Path,
    ffmpeg: &Path,
    subtitle: Option<&SubtitleChoice>,
    mut progress: impl FnMut(u64, Option<u64>),
    owned: &(impl Fn() -> bool + Sync),
) -> Result<(), RpcError> {
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
    let input = scratch.path().join("input.video");
    progress(0, None);
    let mut remaining = MAX_BYTES;
    let format = detected.format;
    super::transfer::save_detected(
        client,
        url,
        &selection.request_contexts,
        detected,
        &input,
        |received, total| progress(received, total.map(|total| total.saturating_add(1))),
        owned,
    )
    .await?;
    super::require_owner(owned)?;
    if let Some(subtitle) = subtitle {
        let mut scope = selection.scope.clone();
        if scope.is_none() && selection.owned_root {
            scope = Some(OwnedScope::from_owned_selection(
                &[url.clone()],
                subtitle.url.as_ref(),
            )?);
        }
        let contains_cues = stage_subtitle(
            subtitle,
            scratch.path(),
            &mut remaining,
            0.0,
            scope.as_ref(),
            &selection.request_contexts,
            owned,
        )
        .await?;
        if contains_cues {
            let mut command = ffmpeg_command(ffmpeg, scratch.path());
            command.args([
                "-f",
                if format == MediaFormat::Mp4 {
                    "mov"
                } else {
                    "matroska"
                },
                "-i",
                "input.video",
                "-f",
                "webvtt",
                "-i",
                "captions.vtt",
            ]);
            command.args([
                "-map", "0:v:0", "-map", "0:a?", "-map", "1:s:0", "-c:v", "copy", "-c:a", "copy",
                "-c:s", "mov_text",
            ]);
            run_ffmpeg(finish_command(command, &output)).await?;
        } else {
            convert_local(
                ffmpeg,
                scratch.path(),
                "input.video",
                if format == MediaFormat::Mp4 {
                    "mov"
                } else {
                    "matroska"
                },
                &output,
            )
            .await?;
        }
    } else {
        convert_local(ffmpeg, scratch.path(), "input.video", "matroska", &output).await?;
    }
    publish_mp4(output, destination, owned).await?;
    progress(1, Some(1));
    Ok(())
}

async fn save_dash(
    client: &Client,
    root: &Url,
    manifest: super::dash::Manifest,
    selection: &Selection,
    destination: &Path,
    ffmpeg: &Path,
    mut progress: impl FnMut(u64, Option<u64>),
    owned: &(impl Fn() -> bool + Sync),
) -> Result<(), RpcError> {
    if let (Some(expected), Some(duration)) = (selection.expected_duration, manifest.duration) {
        if (duration - expected).abs() > (expected * 0.02).max(3.0) {
            return Err(invalid(
                "The DASH manifest does not match the active video duration.",
            ));
        }
    }
    // A blob player's manifest must identify at least one actually observed video segment.
    if !selection.direct_primary
        && !manifest.video.iter().any(|track| {
            track
                .segments
                .iter()
                .any(|url| selection.observations.contains(url))
        })
    {
        return Err(invalid(
            "The DASH manifest does not match the video being played.",
        ));
    }
    let maximum = selection.max_height.unwrap_or(u32::MAX);
    let video = manifest
        .video
        .iter()
        .filter(|track| {
            track.height.is_some_and(|h| h <= maximum)
                || (track.height.is_none() && selection.max_height.is_none())
        })
        .max_by_key(|track| (track.height.unwrap_or(0), track.bandwidth.unwrap_or(0)))
        .ok_or_else(|| invalid("No available DASH video matches the selected quality."))?;
    let audio = manifest
        .audio
        .iter()
        .find(|track| {
            track
                .segments
                .iter()
                .any(|url| selection.observations.contains(url))
        })
        .or_else(|| manifest.audio.first());
    let manifest_subtitle = selection
        .subtitle
        .as_ref()
        .and_then(|picked| {
            manifest.subtitles.iter().find(|track| {
                picked.language.as_ref().is_some_and(|language| {
                    track
                        .language
                        .as_ref()
                        .is_some_and(|supported| language.eq_ignore_ascii_case(supported))
                })
            })
        })
        .or_else(|| manifest.subtitles.first());
    let subtitle = selection
        .subtitle
        .as_ref()
        .and_then(|track| track.url.as_ref())
        .map(|_| selection.subtitle.as_ref().unwrap().clone())
        .or_else(|| {
            manifest_subtitle.and_then(|track| {
                if track.init.is_none() && track.segments.len() == 1 {
                    Some(SubtitleChoice {
                        url: track.segments.first().cloned(),
                        language: track.language.clone(),
                        label: None,
                    })
                } else {
                    None
                }
            })
        });
    if selection.subtitle.is_some() && subtitle.is_none() {
        return Err(invalid("The selected DASH subtitle layout is unavailable."));
    }

    let parent = destination.parent().ok_or_else(disk)?;
    let scratch = tempfile::Builder::new()
        .prefix(".aniverse-dash-")
        .tempdir_in(parent)
        .map_err(|_| disk())?;
    let output = tempfile::Builder::new()
        .prefix(".aniverse-mp4-")
        .tempfile_in(parent)
        .map_err(|_| disk())?
        .into_temp_path();
    let work = scratch.path();
    let chunks = |track: &super::dash::Track| {
        (track.segments.len() + usize::from(track.init.is_some())) as u64
    };
    let total = chunks(video) + audio.map_or(0, chunks) + u64::from(subtitle.is_some()) + 1;
    progress(0, Some(total));
    let contexts = &selection.request_contexts;
    let mut remaining = MAX_BYTES;
    let mut received = 0;
    let mut next = || {
        received += 1;
        progress(received, Some(total));
    };
    stage_dash_track(
        client,
        root,
        video,
        &work.join("video.mp4"),
        contexts,
        &mut remaining,
        &mut next,
        owned,
    )
    .await?;
    if let Some(audio) = audio {
        stage_dash_track(
            client,
            root,
            audio,
            &work.join("audio.mp4"),
            contexts,
            &mut remaining,
            &mut next,
            owned,
        )
        .await?;
    }
    let mut has_subtitle = false;
    if let Some(subtitle) = &subtitle {
        let mut scope = selection.scope.clone();
        if let Some(url) = &subtitle.url {
            if url.origin() == root.origin() || scope.as_ref().is_some_and(|s| s.contains(url)) {
                if let Some(scope) = &mut scope {
                    scope.allowed.insert(url.clone());
                }
            } else {
                return Err(invalid(
                    "The DASH subtitles are outside the active media selection.",
                ));
            }
        }
        has_subtitle = stage_subtitle(
            subtitle,
            work,
            &mut remaining,
            0.0,
            scope.as_ref(),
            contexts,
            owned,
        )
        .await?;
        next();
    }
    super::require_owner(owned)?;
    let mut command = ffmpeg_command(ffmpeg, work);
    command.args(["-f", "mov", "-i", "video.mp4"]);
    if audio.is_some() {
        command.args(["-f", "mov", "-i", "audio.mp4"]);
    }
    if has_subtitle {
        command.args(["-f", "webvtt", "-i", "captions.vtt"]);
    }
    command.args([
        "-map",
        "0:v:0",
        "-map",
        if audio.is_some() { "1:a:0" } else { "0:a?" },
        "-c:v",
        "copy",
        "-c:a",
        "copy",
    ]);
    if has_subtitle {
        command.args([
            "-map",
            if audio.is_some() { "2:s:0" } else { "1:s:0" },
            "-c:s",
            "mov_text",
        ]);
    }
    run_ffmpeg(finish_command(command, &output)).await?;
    publish_mp4(output, destination, owned).await?;
    progress(total, Some(total));
    Ok(())
}

async fn stage_dash_track(
    client: &Client,
    root: &Url,
    track: &super::dash::Track,
    destination: &Path,
    contexts: &RequestContexts,
    remaining: &mut u64,
    progress: &mut impl FnMut(),
    owned: &(impl Fn() -> bool + Sync),
) -> Result<(), RpcError> {
    let mut file = File::create(destination).await.map_err(|_| disk())?;
    let partial = destination.with_extension("part");
    for (index, url) in track.init.iter().chain(&track.segments).enumerate() {
        super::require_owner(owned)?;
        if url.origin() != root.origin() || !super::owned_media_url(url) {
            return Err(invalid(
                "A DASH segment is outside its verified media host.",
            ));
        }
        let limit = if index == 0 && track.init.is_some() {
            MAX_INIT
        } else {
            MAX_SEGMENT
        };
        copy_segment(client, url, &partial, remaining, limit, contexts).await?;
        let mut input = File::open(&partial).await.map_err(|_| disk())?;
        tokio::io::copy(&mut input, &mut file)
            .await
            .map_err(|_| disk())?;
        progress();
    }
    file.flush().await.map_err(|_| disk())?;
    drop(file);
    media::validate_clear_mp4(destination).await
}

async fn copy_segment(
    client: &Client,
    url: &Url,
    path: &Path,
    remaining: &mut u64,
    max_bytes: u64,
    contexts: &RequestContexts,
) -> Result<(), RpcError> {
    let response = media::receive(client, url, contexts).await?;
    copy_response(response, &[], path, remaining, max_bytes).await
}

async fn copy_response(
    mut response: Response,
    prefix: &[u8],
    path: &Path,
    remaining: &mut u64,
    max_bytes: u64,
) -> Result<(), RpcError> {
    let limit = (*remaining).min(max_bytes);
    let expected = response.content_length();
    if expected.is_some_and(|count| count == 0 || count > limit) {
        return Err(oversized());
    }
    let mut file = File::create(path).await.map_err(|_| disk())?;
    let mut bytes = prefix.len() as u64;
    if bytes > limit {
        return Err(oversized());
    }
    file.write_all(prefix).await.map_err(|_| disk())?;
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

struct RemuxChild(Child);

impl Drop for RemuxChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

#[cfg(test)]
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
#[path = "../../../../test/tauri-compat/hls-remux.rs"]
mod tests;
