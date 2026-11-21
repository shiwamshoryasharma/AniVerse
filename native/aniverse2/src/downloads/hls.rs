use super::{invalid, public_media_url};
use crate::RpcError;
use reqwest::Url;

pub(super) const MAX_MANIFEST: usize = 512 * 1024;
const MAX_SEGMENTS: usize = 4096;
const MAX_SECONDS: f64 = 6.0 * 3600.0;

pub(super) enum Playlist {
    Variant(Url),
    Media {
        init: Option<Url>,
        segments: Vec<(f64, Url)>,
    },
}

pub(super) fn parse(base: &Url, text: &str) -> Result<Playlist, RpcError> {
    let unsupported = || invalid("This HLS playlist layout cannot be saved as an MP4.");
    let mut lines = text.lines();
    if lines.next() != Some("#EXTM3U") {
        return Err(invalid("The source did not return an HLS playlist."));
    }
    let mut init = None;
    let mut variant = None;
    let mut next_variant = false;
    let mut next_segment = None;
    let mut ended = false;
    let mut duration = 0.0;
    let mut segments = Vec::new();
    for line in lines.map(str::trim).filter(|line| !line.is_empty()) {
        match line.split_once(':').map_or(line, |(tag, _)| tag) {
            "#EXT-X-KEY" if line != "#EXT-X-KEY:METHOD=NONE" => return Err(protected()),
            "#EXT-X-SESSION-KEY" => return Err(protected()),
            "#EXT-X-BYTERANGE"
            | "#EXT-X-GAP"
            | "#EXT-X-SKIP"
            | "#EXT-X-I-FRAMES-ONLY"
            | "#EXT-X-DEFINE"
            | "#EXT-X-DISCONTINUITY" => return Err(unsupported()),
            "#EXT-X-ENDLIST" => ended = true,
            "#EXT-X-MEDIA" if line.contains("TYPE=AUDIO") => return Err(unsupported()),
            "#EXT-X-STREAM-INF" => {
                if next_variant || variant.is_some() || line.contains(",AUDIO=") {
                    return Err(invalid(
                        "Select an HLS rendition with its own video and audio.",
                    ));
                }
                next_variant = true;
            }
            "#EXT-X-MAP" => {
                if init.is_some() || !segments.is_empty() {
                    return Err(unsupported());
                }
                let uri = line
                    .strip_prefix("#EXT-X-MAP:URI=\"")
                    .and_then(|value| value.strip_suffix('"'))
                    .filter(|value| !value.contains('"'))
                    .ok_or_else(unsupported)?;
                init = Some(resolve(base, uri)?);
            }
            "#EXTINF" => {
                if next_segment.is_some() || ended {
                    return Err(unsupported());
                }
                let seconds = line
                    .strip_prefix("#EXTINF:")
                    .and_then(|value| value.split_once(','))
                    .and_then(|(value, _)| value.parse::<f64>().ok())
                    .filter(|seconds| *seconds > 0.0 && *seconds <= 600.0)
                    .ok_or_else(unsupported)?;
                next_segment = Some(seconds);
            }
            _ if !line.starts_with('#') => {
                let url = resolve(base, line)?;
                if next_variant {
                    if !super::has_extension(&url, "m3u8") {
                        return Err(unsupported());
                    }
                    next_variant = false;
                    variant = Some(url);
                } else {
                    let seconds = next_segment
                        .take()
                        .filter(|_| !ended)
                        .ok_or_else(unsupported)?;
                    duration += seconds;
                    if duration > MAX_SECONDS || segments.len() >= MAX_SEGMENTS {
                        return Err(invalid(
                            "This HLS stream exceeds the offline download limit.",
                        ));
                    }
                    segments.push((seconds, url));
                }
            }
            _ => {}
        }
    }
    if next_variant || next_segment.is_some() {
        return Err(unsupported());
    }
    if let Some(variant) = variant {
        if !segments.is_empty() || init.is_some() || ended {
            return Err(unsupported());
        }
        return Ok(Playlist::Variant(variant));
    }
    if !ended {
        return Err(invalid("Only complete on-demand HLS streams can be saved."));
    }
    if segments.is_empty() {
        return Err(unsupported());
    }
    Ok(Playlist::Media { init, segments })
}

fn resolve(base: &Url, reference: &str) -> Result<Url, RpcError> {
    let blocked = || invalid("The HLS playlist points outside its public media host.");
    if reference.is_empty()
        || reference
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte == b'\\')
    {
        return Err(blocked());
    }
    let url = base.join(reference).map_err(|_| blocked())?;
    if url.origin() != base.origin() || !public_media_url(&url) {
        return Err(blocked());
    }
    Ok(url)
}

fn protected() -> RpcError {
    invalid("Encrypted or protected streams cannot be saved.")
}

#[cfg(test)]
#[path = "../../../../test/tauri-compat/hls-download.rs"]
mod tests;
