use crate::RpcError;
use std::{collections::HashSet, fmt::Write};

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_CUES: usize = 16_384;
const MAX_SEGMENTS: usize = 4096;
const MAX_LOCAL_MS: i64 = 48 * 60 * 60 * 1000;
const PTS_WRAP: i128 = 1 << 33;

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Timeline {
    Relative,
    AbsoluteMapped,
}

#[derive(Debug)]
pub(super) struct Normalized {
    pub text: String,
    #[cfg(test)]
    pub timeline: Timeline,
    pub cue_count: usize,
}

struct Cue {
    start: i64,
    end: i64,
    settings: String,
    text: String,
}
struct Segment {
    mapping: Option<(i64, u64)>,
    cues: Vec<Cue>,
}

fn invalid() -> RpcError {
    RpcError::new(
        "invalid-input",
        "The subtitle track is not supported clear WebVTT.",
    )
}

/// Flatten only already downloaded clear text. The input timeline classification
/// is retained for diagnostics, but all output timestamps are AV-relative. A
/// mapped cue's 33-bit epoch is selected near the probed AV start plus the
/// segment's playlist position; no first-map or filename timing guess is used.
pub(super) fn normalize(
    segments: &[(f64, Vec<u8>)],
    media_start: f64,
) -> Result<Normalized, RpcError> {
    if segments.is_empty()
        || segments.len() > MAX_SEGMENTS
        || !media_start.is_finite()
        || media_start.abs() > 7.0 * 24.0 * 3600.0
    {
        return Err(invalid());
    }
    let mut total = 0usize;
    let mut previous_start = 0.0;
    let mut parsed = Vec::with_capacity(segments.len());
    let mut cue_count = 0usize;
    for (start, bytes) in segments {
        if !start.is_finite() || *start < previous_start || !(0.0..=21_600.0).contains(start) {
            return Err(invalid());
        }
        previous_start = *start;
        total = total.checked_add(bytes.len()).ok_or_else(invalid)?;
        if total > MAX_BYTES {
            return Err(invalid());
        }
        let segment = parse(bytes)?;
        cue_count += segment.cues.len();
        if cue_count > MAX_CUES {
            return Err(invalid());
        }
        parsed.push((*start, segment));
    }
    let absolute = parsed.iter().any(|(_, segment)| segment.mapping.is_some());
    let media_ticks = (media_start * 90_000.0).round() as i128;
    let mut cues = Vec::with_capacity(cue_count);
    let mut seen = HashSet::new();
    for (segment_start, segment) in parsed {
        let (local, mpeg) = segment.mapping.unwrap_or((0, 0));
        let offset = i128::from(mpeg) - i128::from(local) * 90;
        let expected = ((media_start + segment_start) * 90_000.0).round() as i128;
        for cue in segment.cues {
            let (mut start, end) = if absolute {
                let raw_start = i128::from(cue.start) * 90 + offset;
                let epoch = ((expected - raw_start) as f64 / PTS_WRAP as f64).round() as i128;
                let delta = epoch * PTS_WRAP - media_ticks;
                let to_millis = |ticks: i128| -> Result<i64, RpcError> {
                    let rounded = if ticks < 0 {
                        -((-ticks + 45) / 90)
                    } else {
                        (ticks + 45) / 90
                    };
                    i64::try_from(rounded).map_err(|_| invalid())
                };
                (
                    to_millis(raw_start + delta)?,
                    to_millis(i128::from(cue.end) * 90 + offset + delta)?,
                )
            } else {
                (cue.start, cue.end)
            };
            if end <= 0 {
                continue;
            }
            start = start.max(0);
            if end <= start || end > 22_200_000 {
                return Err(invalid());
            }
            let key = (start, end, cue.settings.clone(), cue.text.clone());
            if seen.insert(key) {
                cues.push(Cue { start, end, ..cue });
            }
        }
    }
    cues.sort_by_key(|cue| (cue.start, cue.end));
    let mut output = String::from("WEBVTT\n\n");
    for (index, cue) in cues.iter().enumerate() {
        let _ = writeln!(
            output,
            "{}\n{} --> {}{}\n{}\n",
            index + 1,
            timestamp(cue.start),
            timestamp(cue.end),
            if cue.settings.is_empty() {
                String::new()
            } else {
                format!(" {}", cue.settings)
            },
            cue.text
        );
        if output.len() > MAX_BYTES {
            return Err(invalid());
        }
    }
    Ok(Normalized {
        text: output,
        #[cfg(test)]
        timeline: if absolute {
            Timeline::AbsoluteMapped
        } else {
            Timeline::Relative
        },
        cue_count: cues.len(),
    })
}

fn parse(bytes: &[u8]) -> Result<Segment, RpcError> {
    let raw = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    if raw
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(invalid());
    }
    let text = raw
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut lines = text.lines().peekable();
    let header = lines.next().ok_or_else(invalid)?;
    if header != "WEBVTT" && !header.starts_with("WEBVTT ") && !header.starts_with("WEBVTT\t") {
        return Err(invalid());
    }
    if header.contains("-->") {
        return Err(invalid());
    }
    let mut mapping = None;
    for line in lines.by_ref() {
        if line.trim().is_empty() {
            break;
        }
        if let Some(value) = line.strip_prefix("X-TIMESTAMP-MAP=") {
            if mapping.is_some() {
                return Err(invalid());
            }
            mapping = Some(parse_map(value)?);
        } else if line.contains("-->") {
            return Err(invalid());
        }
    }
    let mut cues = Vec::new();
    let mut block = Vec::new();
    for line in lines.chain(std::iter::once("")) {
        if line.trim().is_empty() {
            if !block.is_empty() {
                if let Some(cue) = parse_cue(&block)? {
                    cues.push(cue);
                }
                if cues.len() > MAX_CUES {
                    return Err(invalid());
                }
                block.clear();
            }
        } else {
            block.push(line);
        }
    }
    Ok(Segment { mapping, cues })
}

fn parse_map(value: &str) -> Result<(i64, u64), RpcError> {
    let mut local = None;
    let mut mpeg = None;
    for field in value.split(',') {
        let (key, value) = field.split_once(':').ok_or_else(invalid)?;
        match key {
            "LOCAL" if local.is_none() => local = Some(parse_time(value)?),
            "MPEGTS" if mpeg.is_none() => {
                if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err(invalid());
                }
                let ticks = value.parse::<u64>().map_err(|_| invalid())?;
                if u128::from(ticks) >= PTS_WRAP as u128 {
                    return Err(invalid());
                }
                mpeg = Some(ticks);
            }
            _ => return Err(invalid()),
        }
    }
    Ok((local.ok_or_else(invalid)?, mpeg.ok_or_else(invalid)?))
}

fn parse_cue(lines: &[&str]) -> Result<Option<Cue>, RpcError> {
    let first = lines[0];
    if first == "NOTE"
        || first.starts_with("NOTE ")
        || first.starts_with("NOTE\t")
        || matches!(first, "STYLE" | "REGION")
    {
        return Ok(None);
    }
    let timing = usize::from(!first.contains("-->"));
    let (start, rest) = lines
        .get(timing)
        .and_then(|line| line.split_once("-->"))
        .ok_or_else(invalid)?;
    let mut fields = rest.split_whitespace();
    let end = fields.next().ok_or_else(invalid)?;
    let start = parse_time(start.trim())?;
    let end = parse_time(end)?;
    if end <= start {
        return Err(invalid());
    }
    let settings = fields.collect::<Vec<_>>().join(" ");
    if settings.len() > 1024 || settings.contains("-->") {
        return Err(invalid());
    }
    let text = lines[timing + 1..].join("\n");
    if text.is_empty() {
        return Ok(None);
    }
    Ok(Some(Cue {
        start,
        end,
        settings,
        text,
    }))
}

fn parse_time(value: &str) -> Result<i64, RpcError> {
    let parts = value.split(':').collect::<Vec<_>>();
    let (hours, minutes, seconds) = match parts.as_slice() {
        [minutes, seconds] => (0, *minutes, *seconds),
        [hours, minutes, seconds] if hours.len() >= 2 => {
            if !hours.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(invalid());
            }
            (
                hours.parse::<i64>().map_err(|_| invalid())?,
                *minutes,
                *seconds,
            )
        }
        _ => return Err(invalid()),
    };
    let number = |text: &str, length: usize| -> Result<i64, RpcError> {
        if text.len() != length || !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid());
        }
        text.parse().map_err(|_| invalid())
    };
    let minutes = number(minutes, 2)?;
    let (seconds, milliseconds) = seconds.split_once('.').ok_or_else(invalid)?;
    let seconds = number(seconds, 2)?;
    let milliseconds = number(milliseconds, 3)?;
    if minutes >= 60 || seconds >= 60 {
        return Err(invalid());
    }
    let time = hours
        .checked_mul(3_600_000)
        .and_then(|hours| hours.checked_add(minutes * 60_000 + seconds * 1000 + milliseconds))
        .filter(|time| *time <= MAX_LOCAL_MS)
        .ok_or_else(invalid)?;
    Ok(time)
}

fn timestamp(milliseconds: i64) -> String {
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        milliseconds / 3_600_000,
        milliseconds / 60_000 % 60,
        milliseconds / 1000 % 60,
        milliseconds % 1000
    )
}

#[cfg(test)]
#[path = "../../../../test/tauri-compat/vtt.rs"]
mod tests;
