use super::{invalid, public_media_url};
use crate::RpcError;
use reqwest::Url;

pub(super) const MAX_MANIFEST: usize = 512 * 1024;
const MAX_SEGMENTS: usize = 4096;
const MAX_SECONDS: f64 = 6.0 * 3600.0;

#[derive(Clone, Debug)]
pub(super) struct Variant {
    pub url: Url,
    pub audio: Option<String>,
    pub subtitles: Option<String>,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum RenditionKind {
    Audio,
    Subtitle,
}
#[derive(Clone, Debug)]
pub(super) struct Rendition {
    pub kind: RenditionKind,
    pub group: String,
    pub name: String,
    pub language: Option<String>,
    pub default: bool,
    pub url: Url,
}
#[derive(Clone)]
pub(super) enum Playlist {
    Variant(Url),
    Master {
        variants: Vec<Variant>,
        renditions: Vec<Rendition>,
    },
    Media {
        init: Option<Url>,
        segments: Vec<(f64, Url)>,
    },
}

pub(super) fn parse(base: &Url, text: &str) -> Result<Playlist, RpcError> {
    parse_with_scope(base, text, false)
}
pub(super) fn parse_owned(base: &Url, text: &str) -> Result<Playlist, RpcError> {
    parse_with_scope(base, text, true)
}
fn parse_with_scope(base: &Url, text: &str, owned: bool) -> Result<Playlist, RpcError> {
    let unsupported = || invalid("This HLS playlist layout cannot be saved as an MP4.");
    if text.len() > MAX_MANIFEST {
        return Err(unsupported());
    }
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next().map(str::trim) != Some("#EXTM3U") {
        return Err(invalid("The source did not return an HLS playlist."));
    }
    let mut init = None;
    let mut variants = Vec::new();
    let mut renditions = Vec::new();
    let mut next_variant = None;
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
            "#EXT-X-MEDIA" => {
                let attrs = attributes(line.split_once(':').ok_or_else(unsupported)?.1)?;
                let get = |name: &str| {
                    attrs
                        .iter()
                        .find(|(key, _)| key == name)
                        .map(|(_, value)| value.clone())
                };
                let kind = match get("TYPE").as_deref() {
                    Some("AUDIO") => RenditionKind::Audio,
                    Some("SUBTITLES") => RenditionKind::Subtitle,
                    _ => continue,
                };
                let Some(uri) = get("URI") else {
                    if kind == RenditionKind::Audio {
                        continue;
                    }
                    return Err(unsupported());
                };
                if renditions.len() >= 16 {
                    return Err(unsupported());
                }
                renditions.push(Rendition {
                    kind,
                    group: get("GROUP-ID").ok_or_else(unsupported)?,
                    name: get("NAME").ok_or_else(unsupported)?,
                    language: get("LANGUAGE"),
                    default: get("DEFAULT").as_deref() == Some("YES"),
                    url: resolve(base, &uri, owned)?,
                });
            }
            "#EXT-X-STREAM-INF" => {
                if next_variant.is_some() || variants.len() >= 16 {
                    return Err(unsupported());
                }
                let attrs = attributes(line.split_once(':').ok_or_else(unsupported)?.1)?;
                let get = |name: &str| {
                    attrs
                        .iter()
                        .find(|(key, _)| key == name)
                        .map(|(_, value)| value.clone())
                };
                next_variant = Some((get("AUDIO"), get("SUBTITLES")));
            }
            "#EXT-X-MAP" => {
                if init.is_some() || !segments.is_empty() {
                    return Err(unsupported());
                }
                let attrs = attributes(line.split_once(':').ok_or_else(unsupported)?.1)?;
                if attrs.len() != 1 || attrs[0].0 != "URI" {
                    return Err(unsupported());
                }
                init = Some(resolve(base, &attrs[0].1, owned)?);
            }
            "#EXTINF" => {
                if next_segment.is_some() || ended {
                    return Err(unsupported());
                }
                let seconds = line
                    .strip_prefix("#EXTINF:")
                    .and_then(|v| v.split_once(','))
                    .and_then(|(v, _)| v.parse::<f64>().ok())
                    .filter(|s| *s > 0.0 && *s <= 600.0)
                    .ok_or_else(unsupported)?;
                next_segment = Some(seconds);
            }
            _ if !line.starts_with('#') => {
                let url = resolve(base, line, owned)?;
                if let Some((audio, subtitles)) = next_variant.take() {
                    if !super::has_extension(&url, "m3u8") {
                        return Err(unsupported());
                    }
                    variants.push(Variant {
                        url,
                        audio,
                        subtitles,
                    });
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
    if next_variant.is_some() || next_segment.is_some() {
        return Err(unsupported());
    }
    if !variants.is_empty() {
        if !segments.is_empty() || init.is_some() || ended {
            return Err(unsupported());
        }
        if variants.len() == 1
            && renditions.is_empty()
            && variants[0].audio.is_none()
            && variants[0].subtitles.is_none()
        {
            return Ok(Playlist::Variant(variants.remove(0).url));
        }
        return Ok(Playlist::Master {
            variants,
            renditions,
        });
    }
    if !renditions.is_empty() {
        return Err(unsupported());
    }
    if !ended {
        return Err(invalid("Only complete on-demand HLS streams can be saved."));
    }
    if segments.is_empty() {
        return Err(unsupported());
    }
    Ok(Playlist::Media { init, segments })
}

fn attributes(input: &str) -> Result<Vec<(String, String)>, RpcError> {
    let bad = || invalid("The HLS playlist attributes are invalid.");
    let mut result = Vec::new();
    let mut quoted = false;
    let mut start = 0;
    for (index, byte) in input.bytes().chain(std::iter::once(b',')).enumerate() {
        if byte == b'"' {
            quoted = !quoted;
        }
        if byte != b',' || quoted {
            continue;
        }
        let field = input.get(start..index).ok_or_else(bad)?;
        let (name, value) = field.split_once('=').ok_or_else(bad)?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c == b'-' || c.is_ascii_digit())
        {
            return Err(bad());
        }
        let value = if value.starts_with('"') {
            value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .ok_or_else(bad)?
        } else {
            value
        };
        if value.len() > 4096
            || value.chars().any(char::is_control)
            || value.contains('"')
            || result.iter().any(|(key, _)| key == name)
        {
            return Err(bad());
        }
        result.push((name.to_owned(), value.to_owned()));
        if result.len() > 32 {
            return Err(bad());
        }
        start = index + 1;
    }
    if quoted {
        return Err(bad());
    }
    Ok(result)
}

fn resolve(base: &Url, reference: &str, owned: bool) -> Result<Url, RpcError> {
    let blocked = || invalid("The HLS playlist points outside its public media host.");
    if reference.is_empty()
        || reference
            .bytes()
            .any(|b| b.is_ascii_control() || b == b'\\')
    {
        return Err(blocked());
    }
    let url = base.join(reference).map_err(|_| blocked())?;
    if url.origin() != base.origin()
        || !(if owned {
            super::owned_media_url(&url)
        } else {
            public_media_url(&url)
        })
    {
        return Err(blocked());
    }
    Ok(url)
}
fn protected() -> RpcError {
    invalid("Encrypted or protected streams cannot be saved.")
}
#[cfg(test)]
#[path = "../../../test/native-media/hls-download.rs"]
mod tests;
