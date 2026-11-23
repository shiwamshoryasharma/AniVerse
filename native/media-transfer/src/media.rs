use crate::RpcError;
use aniverse_security::is_mp4_header;
use reqwest::{header, Client, RequestBuilder, Response, StatusCode, Url};
use std::{collections::HashMap, time::Duration};

pub(crate) type RequestContexts = HashMap<Url, header::HeaderMap>;

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MediaFormat {
    Mp4,
    Webm,
    Hls,
    Dash,
}

pub(super) struct Detected {
    pub format: MediaFormat,
    pub prefix: Vec<u8>,
    pub response: Response,
}

pub(super) fn request(client: &Client, url: &Url, contexts: &RequestContexts) -> RequestBuilder {
    let mut request = client
        .get(url.clone())
        .header(header::ACCEPT_ENCODING, "identity");
    if let Some(headers) = contexts.get(url) {
        for (name, value) in headers {
            if permitted_header(name.as_str()) && value.as_bytes().len() <= 8192 {
                request = request.header(name, value);
            }
        }
    }
    request
}

pub(super) fn permitted_header(name: &str) -> bool {
    matches!(
        name,
        "accept"
            | "accept-language"
            | "authorization"
            | "cookie"
            | "origin"
            | "referer"
            | "user-agent"
    )
}

pub(super) async fn receive(
    client: &Client,
    url: &Url,
    contexts: &RequestContexts,
) -> Result<Response, RpcError> {
    for attempt in 0..3 {
        match request(client, url, contexts).send().await {
            Ok(response) if response.status() == StatusCode::OK => {
                if response
                    .headers()
                    .get(header::CONTENT_ENCODING)
                    .is_some_and(|value| !value.as_bytes().eq_ignore_ascii_case(b"identity"))
                {
                    return Err(super::invalid(
                        "The media response uses unsupported content encoding.",
                    ));
                }
                return Ok(response);
            }
            Ok(response) => {
                let status = response.status();
                match status.as_u16() {
                    401 | 403 | 410 => return Err(RpcError::new("media-expired", "The media link expired or this session no longer has access. Reload the playing video and try again.")),
                    404 => return Err(RpcError::new("media-missing", "The selected media was not found. Reload the playing video and try again.")),
                    429 | 500 | 502 | 503 | 504 if attempt < 2 => (),
                    429 | 500 | 502 | 503 | 504 => break,
                    _ => return Err(super::invalid("The source did not return accessible video.")),
                }
            }
            Err(_) if attempt < 2 => (),
            Err(_) => break,
        }
        tokio::time::sleep(Duration::from_millis(250 * (attempt + 1))).await;
    }
    Err(network())
}

pub(super) fn network() -> RpcError {
    RpcError::new(
        "network",
        "The media transfer was interrupted. Try again from the active player.",
    )
}

pub(super) async fn detect(
    client: &Client,
    url: &Url,
    contexts: &RequestContexts,
    hint: Option<MediaFormat>,
) -> Result<Detected, RpcError> {
    let mut response = receive(client, url, contexts).await?;
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if matches!(
        content_type.as_str(),
        "text/html" | "application/xhtml+xml" | "application/json"
    ) {
        return Err(super::invalid(
            "The source responded with a page instead of media.",
        ));
    }
    let declared = format_from_mime(&content_type);
    const MAX_SNIFF: usize = 8192;
    const MAX_INITIAL_CHUNKS: usize = 1024 * 1024;
    let mut prefix = Vec::new();
    loop {
        if let Some(format) = sniff(&prefix[..prefix.len().min(MAX_SNIFF)]) {
            if declared.is_some_and(|expected| expected != format)
                || hint.is_some_and(|expected| expected != format)
            {
                return Err(super::invalid(
                    "The selected media type does not match the response.",
                ));
            }
            return Ok(Detected {
                format,
                prefix,
                response,
            });
        }
        if prefix.len() >= MAX_SNIFF {
            break;
        }
        let Some(chunk) = response.chunk().await.map_err(|_| network())? else {
            break;
        };
        if prefix.len() + chunk.len() > MAX_INITIAL_CHUNKS {
            return Err(super::invalid(
                "The media response headers could not be safely identified.",
            ));
        }
        prefix.extend_from_slice(&chunk);
    }
    Err(super::invalid(
        "The selected response is not supported MP4, WebM, HLS, or DASH media.",
    ))
}

pub(super) async fn manifest(mut detected: Detected, limit: usize) -> Result<String, RpcError> {
    while let Some(chunk) = detected.response.chunk().await.map_err(|_| network())? {
        if detected.prefix.len() + chunk.len() > limit {
            return Err(super::invalid(
                "The media manifest exceeds the offline download limit.",
            ));
        }
        detected.prefix.extend_from_slice(&chunk);
    }
    if detected.prefix.len() > limit {
        return Err(super::invalid(
            "The media manifest exceeds the offline download limit.",
        ));
    }
    String::from_utf8(detected.prefix)
        .map_err(|_| super::invalid("The media manifest is unreadable."))
}

pub(crate) fn sniff(bytes: &[u8]) -> Option<MediaFormat> {
    if is_mp4_header(bytes) {
        return Some(MediaFormat::Mp4);
    }
    if bytes.starts_with(b"\x1a\x45\xdf\xa3") && bytes.windows(7).any(|w| w == b"\x42\x82\x84webm")
    {
        return Some(MediaFormat::Webm);
    }
    let mut text = bytes
        .strip_prefix(b"\xef\xbb\xbf")
        .unwrap_or(bytes)
        .trim_ascii_start();
    if text
        .strip_prefix(b"#EXTM3U")
        .is_some_and(|rest| rest.first().is_some_and(u8::is_ascii_whitespace))
    {
        return Some(MediaFormat::Hls);
    }
    if text.starts_with(b"<?xml") {
        let declaration_end = text.windows(2).position(|pair| pair == b"?>")?;
        text = text[declaration_end + 2..].trim_ascii_start();
    }
    if text.strip_prefix(b"<MPD").is_some_and(|rest| {
        rest.first()
            .is_some_and(|ch| ch.is_ascii_whitespace() || *ch == b'>')
    }) {
        return Some(MediaFormat::Dash);
    }
    None
}

pub(super) fn has_mp4_protection(bytes: &[u8]) -> bool {
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

/// Inspect container metadata even when it follows the large media data box.
pub(super) async fn validate_clear_mp4(path: &std::path::Path) -> Result<(), RpcError> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    const METADATA_LIMIT: u64 = 16 * 1024 * 1024;
    let invalid = || super::invalid("The MP4 container metadata is invalid or unsupported.");
    let mut file = tokio::fs::File::open(path).await.map_err(|_| invalid())?;
    let length = file.metadata().await.map_err(|_| invalid())?.len();
    let mut offset = 0u64;
    let mut has_movie = false;
    let mut boxes = 0usize;
    while offset < length {
        boxes += 1;
        if boxes > 16_384 || length - offset < 8 {
            return Err(invalid());
        }
        let mut header = [0u8; 8];
        file.read_exact(&mut header).await.map_err(|_| invalid())?;
        let code = &header[4..8];
        let mut header_size = 8;
        let box_size = match u32::from_be_bytes(header[..4].try_into().expect("box size")) {
            0 => length - offset,
            1 => {
                header_size = 16;
                file.read_u64().await.map_err(|_| invalid())?
            }
            size => u64::from(size),
        };
        if !(header_size..=length - offset).contains(&box_size) {
            return Err(invalid());
        }
        let encrypted = || super::invalid("Encrypted or protected streams cannot be saved.");
        if matches!(code, b"pssh" | b"senc" | b"tenc") {
            return Err(encrypted());
        }
        if matches!(code, b"moov" | b"moof") {
            if box_size > METADATA_LIMIT {
                return Err(invalid());
            }
            let mut data = vec![0; (box_size - header_size) as usize];
            file.read_exact(&mut data).await.map_err(|_| invalid())?;
            if has_mp4_protection(&data) {
                return Err(encrypted());
            }
            has_movie |= code == b"moov";
        }
        offset += box_size;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|_| invalid())?;
    }
    if !has_movie {
        return Err(invalid());
    }
    Ok(())
}

pub(crate) fn format_from_mime(mime: &str) -> Option<MediaFormat> {
    match mime.split(';').next()?.trim().to_ascii_lowercase().as_str() {
        "video/mp4" | "application/mp4" => Some(MediaFormat::Mp4),
        "video/webm" => Some(MediaFormat::Webm),
        "application/vnd.apple.mpegurl"
        | "application/x-mpegurl"
        | "audio/mpegurl"
        | "audio/x-mpegurl" => Some(MediaFormat::Hls),
        "application/dash+xml" => Some(MediaFormat::Dash),
        _ => None,
    }
}

async fn ebml_integer(
    input: &mut tokio::fs::File,
    is_id: bool,
) -> Result<(u64, u64, bool), RpcError> {
    use tokio::io::AsyncReadExt;
    let invalid = || super::invalid("The WebM container metadata is invalid.");
    let first = input.read_u8().await.map_err(|_| invalid())?;
    let width = first.leading_zeros() + 1;
    if width > if is_id { 4 } else { 8 } {
        return Err(invalid());
    }
    let marker = 1u8 << (8 - width);
    let mut value = u64::from(if is_id { first } else { first - marker });
    for _ in 1..width {
        value = (value << 8) | u64::from(input.read_u8().await.map_err(|_| invalid())?);
    }
    Ok((
        value,
        u64::from(width),
        !is_id && value == (1u64 << (7 * width)) - 1,
    ))
}

pub(super) async fn validate_clear_webm(path: &std::path::Path) -> Result<(), RpcError> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let invalid = || super::invalid("The WebM container metadata is invalid or unsupported.");
    let mut file = tokio::fs::File::open(path).await.map_err(|_| invalid())?;
    let length = file.metadata().await.map_err(|_| invalid())?.len();
    let (header, id_len, _) = ebml_integer(&mut file, true).await?;
    let (header_len, size_len, unknown) = ebml_integer(&mut file, false).await?;
    if header != 0x1a45dfa3 || unknown || header_len > 8192 {
        return Err(invalid());
    }
    let header_end = id_len + size_len + header_len;
    file.seek(std::io::SeekFrom::Start(header_end))
        .await
        .map_err(|_| invalid())?;
    let (segment, id_len, _) = ebml_integer(&mut file, true).await?;
    let (size, size_len, unknown) = ebml_integer(&mut file, false).await?;
    let mut offset = header_end + id_len + size_len;
    let end = if unknown { length } else { offset + size };
    if segment != 0x18538067 || !(offset..=length).contains(&end) {
        return Err(invalid());
    }
    for _ in 0..256 {
        if offset >= end {
            break;
        }
        let (id, id_len, _) = ebml_integer(&mut file, true).await?;
        let (size, size_len, unknown) = ebml_integer(&mut file, false).await?;
        offset += id_len + size_len;
        // Track encryption and other content encodings are inside the bounded Tracks metadata.
        if unknown || offset + size > end {
            return Err(invalid());
        }
        if id == 0x1654ae6b {
            if size > 2 * 1024 * 1024 {
                return Err(invalid());
            }
            let mut data = vec![0; size as usize];
            file.read_exact(&mut data).await.map_err(|_| invalid())?;
            if data
                .windows(2)
                .any(|bytes| matches!(bytes, b"\x6d\x80" | b"\x50\x35"))
            {
                return Err(super::invalid(
                    "Encrypted or protected WebM streams cannot be saved.",
                ));
            }
            return Ok(());
        }
        offset += size;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|_| invalid())?;
    }
    Err(invalid())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinguishes_media_from_pages_without_relying_on_url_suffix() {
        assert_eq!(
            sniff(b"\xef\xbb\xbf#EXTM3U\r\n#EXT-X-ENDLIST"),
            Some(MediaFormat::Hls)
        );
        assert_eq!(
            sniff(b"<?xml version=\"1.0\"?>\n<MPD type=\"static\">"),
            Some(MediaFormat::Dash)
        );
        assert_eq!(
            sniff(b"\x1a\x45\xdf\xa3\x42\x82\x84webm"),
            Some(MediaFormat::Webm)
        );
        assert_eq!(sniff(b"<html><MPD type=\"static\">"), None);
        assert_eq!(sniff(b"<MPData>"), None);
        assert_eq!(sniff(b"#EXTM3U-not-a-playlist"), None);
    }

    #[test]
    fn credentials_apply_to_exact_url_only_and_cannot_override_transport_headers() {
        let target = Url::parse("https://assets.example.test/file?lease=old").unwrap();
        let other = Url::parse("https://assets.example.test/file?lease=new").unwrap();
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            header::HeaderValue::from_static("Bearer test"),
        );
        headers.insert(
            header::RANGE,
            header::HeaderValue::from_static("bytes=123-"),
        );
        let contexts = HashMap::from([(target.clone(), headers)]);
        let client = Client::new();
        let exact = request(&client, &target, &contexts).build().unwrap();
        assert!(exact.headers().contains_key(header::AUTHORIZATION));
        assert!(!exact.headers().contains_key(header::RANGE));
        let changed = request(&client, &other, &contexts).build().unwrap();
        assert!(!changed.headers().contains_key(header::AUTHORIZATION));
    }
}
