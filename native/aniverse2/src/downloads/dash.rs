use super::invalid;
use crate::RpcError;
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use reqwest::Url;
use std::str::FromStr;

pub(super) const MAX_MANIFEST: usize = 512 * 1024;
const MAX_TRACKS: usize = 48;
const MAX_SEGMENTS: usize = 4096;
const MAX_TOTAL_SEGMENTS: usize = 8192;
const MAX_SECONDS: f64 = 6.0 * 3600.0;

pub(super) struct Manifest {
    pub video: Vec<Track>,
    pub audio: Vec<Track>,
    pub subtitles: Vec<Track>,
    pub duration: Option<f64>,
}

pub(super) struct Track {
    pub init: Option<Url>,
    pub segments: Vec<Url>,
    pub height: Option<u32>,
    pub bandwidth: Option<u64>,
    pub language: Option<String>,
}

#[derive(Default)]
struct Node {
    name: String,
    attrs: Vec<(String, String)>,
    children: Vec<Node>,
    text: String,
}

impl Node {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    fn named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> {
        self.children.iter().filter(move |node| node.name == name)
    }

    fn child(&self, name: &str) -> Result<Option<&Node>, RpcError> {
        let mut matches = self.children.iter().filter(|node| node.name == name);
        let child = matches.next();
        if matches.next().is_some() {
            return Err(unsupported());
        }
        Ok(child)
    }
}

fn unsupported() -> RpcError {
    invalid("This DASH manifest layout cannot be saved.")
}

fn malformed() -> RpcError {
    invalid("The source did not return a valid DASH manifest.")
}

fn start(event: BytesStart<'_>) -> Result<Node, RpcError> {
    let name = event.local_name().as_ref().to_owned();
    if matches!(
        name.as_str(),
        "ContentProtection" | "pssh" | "ProtectionHeader"
    ) {
        return Err(invalid("Protected DASH media cannot be saved."));
    }
    let mut node = Node {
        name,
        ..Node::default()
    };
    for attr in event.attributes() {
        let attr = attr.map_err(|_| malformed())?;
        let name = attr.key.as_ref();
        if name.starts_with("xlink:") || name == "xml:base" {
            return Err(unsupported());
        }
        if name.rsplit(':').next() == Some("default_KID") {
            return Err(invalid("Protected DASH media cannot be saved."));
        }
        let value = attr
            .normalized_value(XmlVersion::Implicit1_0)
            .map_err(|_| malformed())?;
        if node.attrs.len() >= 64 || value.len() > 8192 {
            return Err(unsupported());
        }
        node.attrs.push((name.to_owned(), value.into_owned()));
    }
    Ok(node)
}

fn xml(text: &str) -> Result<Node, RpcError> {
    if text.len() > MAX_MANIFEST {
        return Err(unsupported());
    }
    let mut reader = Reader::from_str(text.trim_start_matches('\u{feff}'));
    let mut stack = vec![Node::default()];
    let mut nodes = 0usize;
    loop {
        match reader.read_event().map_err(|_| malformed())? {
            Event::Start(event) | Event::Empty(event) if stack.len() > 20 || nodes >= 24_000 => {
                let _ = event;
                return Err(unsupported());
            }
            Event::Start(event) => {
                nodes += 1;
                stack.push(start(event)?);
            }
            Event::Empty(event) => {
                nodes += 1;
                stack
                    .last_mut()
                    .ok_or_else(malformed)?
                    .children
                    .push(start(event)?);
            }
            Event::End(_) => {
                let node = stack.pop().ok_or_else(malformed)?;
                stack.last_mut().ok_or_else(malformed)?.children.push(node);
            }
            Event::Text(text) => {
                let current = stack.last_mut().ok_or_else(malformed)?;
                let value = text.xml_content(XmlVersion::Implicit1_0);
                if current.name == "BaseURL" {
                    current.text.push_str(&value);
                } else if stack.len() == 1 && !value.trim().is_empty() {
                    return Err(malformed());
                }
            }
            Event::GeneralRef(reference) => {
                let value = reference.as_ref();
                let current = stack.last_mut().ok_or_else(malformed)?;
                let value = match value {
                    "amp" => '&',
                    "quot" => '"',
                    "apos" => '\'',
                    "lt" => '<',
                    "gt" => '>',
                    _ => reference
                        .resolve_char_ref()
                        .map_err(|_| malformed())?
                        .ok_or_else(malformed)?,
                };
                if current.name == "BaseURL" {
                    current.text.push(value);
                }
            }
            Event::DocType(_) => return Err(unsupported()),
            Event::CData(_) => return Err(unsupported()),
            Event::Eof => break,
            _ => {}
        }
    }
    let mut document = stack.pop().ok_or_else(malformed)?;
    if !stack.is_empty() || document.children.len() != 1 || document.children[0].name != "MPD" {
        return Err(malformed());
    }
    document.children.pop().ok_or_else(malformed)
}

fn resolve(base: &Url, reference: &str) -> Result<Url, RpcError> {
    let reference = reference.trim();
    if reference.is_empty()
        || reference.len() > 8192
        || reference
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace() || ch == '\\')
    {
        return Err(unsupported());
    }
    let url = base.join(reference).map_err(|_| malformed())?;
    if url.origin() != base.origin()
        || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.as_str().len() > 8192
    {
        return Err(invalid(
            "A DASH media resource is outside the admitted source origin.",
        ));
    }
    Ok(url)
}

fn scoped_base(base: &Url, node: &Node) -> Result<Url, RpcError> {
    let mut candidates = node.named("BaseURL").peekable();
    if candidates.peek().is_none() {
        return Ok(base.clone());
    }
    candidates
        .find_map(|child| resolve(base, &child.text).ok())
        .ok_or_else(unsupported)
}

fn attribute<'a>(nodes: &[&'a Node], name: &str) -> Option<&'a str> {
    nodes.iter().rev().find_map(|node| node.attr(name))
}

fn number<T: FromStr>(value: Option<&str>) -> Result<Option<T>, RpcError> {
    value
        .map(|text| text.parse().map_err(|_| unsupported()))
        .transpose()
}

fn duration(value: &str) -> Result<f64, RpcError> {
    let mut rest = value.strip_prefix("PT").ok_or_else(unsupported)?;
    let mut seconds = 0.0;
    let mut present = false;
    for (unit, multiplier) in [('H', 3600.0), ('M', 60.0), ('S', 1.0)] {
        if let Some(index) = rest.find(unit) {
            let amount = rest[..index].parse::<f64>().map_err(|_| unsupported())?;
            if !amount.is_finite() || amount < 0.0 {
                return Err(unsupported());
            }
            present = true;
            seconds += amount * multiplier;
            rest = &rest[index + 1..];
        }
    }
    if !present || !rest.is_empty() || seconds > MAX_SECONDS {
        return Err(unsupported());
    }
    Ok(seconds)
}

enum Kind {
    Video,
    Audio,
    Text,
}

fn kind(nodes: &[&Node]) -> Option<Kind> {
    match attribute(nodes, "mimeType") {
        Some("video/mp4") => Some(Kind::Video),
        Some("audio/mp4") => Some(Kind::Audio),
        Some("text/vtt") => Some(Kind::Text),
        Some(_) => None,
        None => match attribute(nodes, "contentType") {
            Some("video") => Some(Kind::Video),
            Some("audio") => Some(Kind::Audio),
            _ => None,
        },
    }
}

fn template_url(
    base: &Url,
    template: &str,
    representation: &Node,
    sequence: Option<(u64, u64)>,
) -> Result<Url, RpcError> {
    let mut output = String::new();
    let mut rest = template;
    while let Some((prefix, token)) = rest.split_once('$') {
        output.push_str(prefix);
        let (token, tail) = token.split_once('$').ok_or_else(unsupported)?;
        let (name, width) = match token.split_once('%') {
            Some((name, format)) => {
                let width = format
                    .strip_prefix('0')
                    .and_then(|value| value.strip_suffix('d'))
                    .and_then(|value| value.parse::<usize>().ok())
                    .filter(|width| (1..=12).contains(width))
                    .ok_or_else(unsupported)?;
                (name, width)
            }
            None => (token, 0),
        };
        match name {
            "" if width == 0 => output.push('$'),
            "RepresentationID" if width == 0 => {
                output.push_str(representation.attr("id").ok_or_else(unsupported)?)
            }
            "Bandwidth" | "Number" | "Time" => {
                let value = match name {
                    "Bandwidth" => {
                        number(representation.attr("bandwidth"))?.ok_or_else(unsupported)?
                    }
                    "Number" => sequence.ok_or_else(unsupported)?.0,
                    _ => sequence.ok_or_else(unsupported)?.1,
                };
                output.push_str(&format!("{value:0width$}"));
            }
            _ => return Err(unsupported()),
        }
        if output.len() > 8192 {
            return Err(unsupported());
        }
        rest = tail;
    }
    output.push_str(rest);
    resolve(base, &output)
}

fn addressed_segments(
    templates: &[&Node],
    duration_seconds: Option<f64>,
) -> Result<Vec<u64>, RpcError> {
    let timescale = number::<u64>(attribute(templates, "timescale"))?.unwrap_or(1);
    if !(1..=1_000_000_000).contains(&timescale) {
        return Err(unsupported());
    }
    let offset = number::<u64>(attribute(templates, "presentationTimeOffset"))?.unwrap_or(0);
    let end = duration_seconds
        .map(|seconds| (seconds * timescale as f64).ceil() as u64)
        .map(|ticks| ticks.checked_add(offset).ok_or_else(unsupported))
        .transpose()?;
    let mut timeline = None;
    for node in templates.iter().rev() {
        timeline = node.child("SegmentTimeline")?;
        if timeline.is_some() {
            break;
        }
    }
    let mut times = Vec::new();
    if let Some(timeline) = timeline {
        let mut next = 0u64;
        let mut segments = timeline.named("S").peekable();
        while let Some(segment) = segments.next() {
            let time = number(segment.attr("t"))?.unwrap_or(next);
            let step = number::<u64>(segment.attr("d"))?
                .filter(|step| *step > 0)
                .ok_or_else(unsupported)?;
            if time < next {
                return Err(unsupported());
            }
            let repeat = number::<i64>(segment.attr("r"))?.unwrap_or(0);
            let count = match repeat {
                -1 => {
                    let limit = if let Some(following) = segments.peek() {
                        number(following.attr("t"))?.ok_or_else(unsupported)?
                    } else {
                        end.ok_or_else(unsupported)?
                    };
                    let span = limit
                        .checked_sub(time)
                        .filter(|span| *span > 0)
                        .ok_or_else(unsupported)?;
                    span.div_ceil(step)
                }
                n if n >= 0 => n as u64 + 1,
                _ => return Err(unsupported()),
            };
            if count > (MAX_SEGMENTS - times.len()) as u64 {
                return Err(unsupported());
            }
            next = time;
            for _ in 0..count {
                times.push(next);
                next = next.checked_add(step).ok_or_else(unsupported)?;
            }
        }
    } else {
        let step = number::<u64>(attribute(templates, "duration"))?
            .filter(|step| *step > 0)
            .ok_or_else(unsupported)?;
        let span = end
            .and_then(|end| end.checked_sub(offset))
            .ok_or_else(unsupported)?;
        let count = span.div_ceil(step);
        if count > MAX_SEGMENTS as u64 {
            return Err(unsupported());
        }
        for index in 0..count {
            times.push(
                offset
                    .checked_add(index.checked_mul(step).ok_or_else(unsupported)?)
                    .ok_or_else(unsupported)?,
            );
        }
    }
    if times.is_empty() {
        return Err(unsupported());
    }
    Ok(times)
}

fn template_track(
    base: &Url,
    templates: &[&Node],
    representation: &Node,
    seconds: Option<f64>,
) -> Result<(Option<Url>, Vec<Url>), RpcError> {
    let init = attribute(templates, "initialization")
        .map(|value| template_url(base, value, representation, None))
        .transpose()?;
    let media = attribute(templates, "media").ok_or_else(unsupported)?;
    let start = number::<u64>(attribute(templates, "startNumber"))?.unwrap_or(1);
    let mut segments = Vec::new();
    for (index, time) in addressed_segments(templates, seconds)?
        .into_iter()
        .enumerate()
    {
        let sequence = start.checked_add(index as u64).ok_or_else(unsupported)?;
        segments.push(template_url(
            base,
            media,
            representation,
            Some((sequence, time)),
        )?);
    }
    Ok((init, segments))
}

fn list_track(base: &Url, lists: &[&Node]) -> Result<(Option<Url>, Vec<Url>), RpcError> {
    let mut init = None;
    let mut segments = None;
    for list in lists {
        if let Some(item) = list.child("Initialization")? {
            if item.attr("range").is_some() {
                return Err(unsupported());
            }
            init = Some(resolve(
                base,
                item.attr("sourceURL").ok_or_else(unsupported)?,
            )?);
        }
        let mut urls = list.named("SegmentURL").peekable();
        if urls.peek().is_some() {
            let mut selected = Vec::new();
            for item in urls {
                if item.attr("mediaRange").is_some()
                    || item.attr("indexRange").is_some()
                    || item.attr("index").is_some()
                    || selected.len() >= MAX_SEGMENTS
                {
                    return Err(unsupported());
                }
                selected.push(resolve(base, item.attr("media").ok_or_else(unsupported)?)?);
            }
            segments = Some(selected);
        }
    }
    Ok((init, segments.ok_or_else(unsupported)?))
}

fn track(
    manifest_url: &Url,
    base: &Url,
    nodes: &[&Node],
    seconds: Option<f64>,
    kind: &Kind,
) -> Result<Track, RpcError> {
    let mut templates = Vec::new();
    let mut lists = Vec::new();
    for node in nodes {
        if node.child("SegmentBase")?.is_some() {
            return Err(unsupported());
        }
        templates.extend(node.child("SegmentTemplate")?);
        lists.extend(node.child("SegmentList")?);
    }
    let (init, segments) = match (templates.is_empty(), lists.is_empty()) {
        (false, true) => template_track(base, &templates, nodes[nodes.len() - 1], seconds)?,
        (true, false) => list_track(base, &lists)?,
        (true, true) if base != manifest_url && !base.path().ends_with('/') => {
            (None, vec![base.clone()])
        }
        _ => return Err(unsupported()),
    };
    if matches!(kind, Kind::Text) && init.is_some() {
        return Err(unsupported());
    }
    Ok(Track {
        init,
        segments,
        height: number(attribute(nodes, "height"))?,
        bandwidth: number(attribute(nodes, "bandwidth"))?,
        language: attribute(nodes, "lang")
            .filter(|language| {
                !language.is_empty()
                    && language.len() <= 35
                    && language
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
            .map(str::to_owned),
    })
}

pub(super) fn parse(base: &Url, text: &str) -> Result<Manifest, RpcError> {
    let mpd = xml(text)?;
    if !matches!(mpd.attr("type"), None | Some("static")) {
        return Err(invalid("Live DASH media cannot be saved."));
    }
    let period = mpd.child("Period")?.ok_or_else(malformed)?;
    let start = period
        .attr("start")
        .map(duration)
        .transpose()?
        .unwrap_or(0.0);
    let seconds = period.attr("duration").map(duration).transpose()?.or(mpd
        .attr("mediaPresentationDuration")
        .map(duration)
        .transpose()?
        .map(|total| total - start));
    if seconds.is_some_and(|seconds| seconds <= 0.0) {
        return Err(unsupported());
    }
    let mut manifest = Manifest {
        duration: seconds,
        video: vec![],
        audio: vec![],
        subtitles: vec![],
    };
    let period_base = scoped_base(&scoped_base(base, &mpd)?, period)?;
    let mut segments = 0usize;
    let mut tracks = 0usize;
    let mut has_audio = false;
    let mut has_video = false;
    for adaptation in period.named("AdaptationSet") {
        let adaptation_base = scoped_base(&period_base, adaptation)?;
        for representation in adaptation.named("Representation") {
            let nodes = [period, adaptation, representation];
            let media_type = attribute(&nodes, "contentType").or_else(|| {
                attribute(&nodes, "mimeType")
                    .and_then(|mime| mime.split_once('/').map(|pair| pair.0))
            });
            has_audio |= media_type == Some("audio");
            has_video |= media_type == Some("video");
            let Some(kind) = kind(&nodes) else { continue };
            let track = track(
                base,
                &scoped_base(&adaptation_base, representation)?,
                &nodes,
                seconds,
                &kind,
            )?;
            tracks += 1;
            segments += track.segments.len();
            if tracks > MAX_TRACKS || segments > MAX_TOTAL_SEGMENTS {
                return Err(unsupported());
            }
            match kind {
                Kind::Video => manifest.video.push(track),
                Kind::Audio => manifest.audio.push(track),
                Kind::Text => manifest.subtitles.push(track),
            }
        }
    }
    if !has_video || manifest.video.is_empty() || (has_audio && manifest.audio.is_empty()) {
        return Err(unsupported());
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(text: &str) -> Result<Manifest, RpcError> {
        parse(
            &Url::parse("https://source.test/path/manifest?t=root").unwrap(),
            text,
        )
    }

    #[test]
    fn expands_inherited_template_into_video_audio_and_extensionless_captions() {
        let parsed = fixture(
            r#"<MPD type="static" mediaPresentationDuration="PT4S"><Period>
          <AdaptationSet mimeType="video/mp4">
            <SegmentTemplate timescale="10" duration="20" startNumber="7"
              initialization="init/$RepresentationID$?token=a&amp;value=b"
              media="segments/$RepresentationID$/$Number%03d$"/>
            <Representation id="low" height="480" bandwidth="800000"/>
            <Representation id="high" height="1080" bandwidth="4000000"/>
          </AdaptationSet>
          <AdaptationSet mimeType="audio/mp4" lang="ja">
            <Representation id="audio" bandwidth="60000">
              <SegmentList><Initialization sourceURL="audio-header"/>
                <SegmentURL media="audio-one"/><SegmentURL media="audio-two"/></SegmentList>
            </Representation>
          </AdaptationSet>
          <AdaptationSet mimeType="text/vtt" lang="en">
            <Representation id="sub"><BaseURL>captions?token=one&amp;v=2</BaseURL></Representation>
          </AdaptationSet>
        </Period></MPD>"#,
        )
        .unwrap();
        assert_eq!(parsed.duration, Some(4.0));
        assert_eq!(parsed.video[0].height, Some(480));
        assert_eq!(parsed.video[1].bandwidth, Some(4_000_000));
        assert_eq!(
            parsed.video[0].init.as_ref().unwrap().query(),
            Some("token=a&value=b")
        );
        assert_eq!(
            parsed.video[1].segments[0].path(),
            "/path/segments/high/007"
        );
        assert_eq!(parsed.audio[0].language.as_deref(), Some("ja"));
        assert_eq!(parsed.audio[0].segments[1].path(), "/path/audio-two");
        assert_eq!(
            parsed.subtitles[0].segments[0].query(),
            Some("token=one&v=2")
        );
    }

    #[test]
    fn bounds_time_repeats_to_next_entry_or_period_duration() {
        let parsed = fixture(
            r#"<MPD><Period duration="PT8S"><AdaptationSet contentType="video">
          <SegmentTemplate timescale="1" initialization="init" media="assets/$Time$">
            <SegmentTimeline><S t="0" d="2" r="-1"/><S t="4" d="2" r="-1"/></SegmentTimeline>
          </SegmentTemplate><Representation id="video"/>
        </AdaptationSet></Period></MPD>"#,
        )
        .unwrap();
        let urls: Vec<_> = parsed.video[0].segments.iter().map(Url::path).collect();
        assert_eq!(
            urls,
            [
                "/path/assets/0",
                "/path/assets/2",
                "/path/assets/4",
                "/path/assets/6"
            ]
        );
    }

    #[test]
    fn rejects_protected_dynamic_external_and_unbounded_manifests() {
        for text in [
            r#"<MPD><Period><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/></Period></MPD>"#,
            r#"<MPD type="dynamic"><Period/></MPD>"#,
            r#"<!DOCTYPE MPD [<!ENTITY unsafe SYSTEM "file:///a">]><MPD><Period/></MPD>"#,
            r#"<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation><BaseURL>https://other.test/movie</BaseURL></Representation></AdaptationSet></Period></MPD>"#,
            r#"<MPD><Period><AdaptationSet contentType="video"><SegmentTemplate media="s-$Time$" initialization="init"><SegmentTimeline><S d="1" r="90000"/></SegmentTimeline></SegmentTemplate><Representation id="id"/></AdaptationSet></Period></MPD>"#,
        ] {
            assert!(fixture(text).is_err(), "{text}");
        }
    }
}
