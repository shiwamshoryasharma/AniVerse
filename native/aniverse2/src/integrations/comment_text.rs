use regex::{Captures, Regex};
use std::sync::OnceLock;

fn limited(text: &str) -> String {
    text.chars()
        .filter(|ch| !ch.is_control() || matches!(*ch, '\n' | '\t'))
        .take(12_000)
        .collect()
}

fn url(text: &str) -> Option<String> {
    let decoded = entities(text);
    let parsed = reqwest::Url::parse(decoded.trim()).ok()?;
    if parsed.as_str().len() > 2048
        || !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !aniverse_security::allows_source_network(parsed.as_str(), "")
    {
        return None;
    }
    Some(parsed.as_str().replace('(', "%28").replace(')', "%29"))
}

fn entities(text: &str) -> String {
    static ENTITY: OnceLock<Regex> = OnceLock::new();
    ENTITY
        .get_or_init(|| {
            Regex::new(r"(?i)&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);").unwrap()
        })
        .replace_all(text, |cap: &Captures<'_>| {
            let lower = cap[1].to_ascii_lowercase();
            let number = lower
                .strip_prefix("#x")
                .and_then(|n| u32::from_str_radix(n, 16).ok())
                .or_else(|| lower.strip_prefix('#').and_then(|n| n.parse().ok()));
            match lower.as_str() {
                "amp" => "&".into(),
                "lt" => "<".into(),
                "gt" => ">".into(),
                "quot" => "\"".into(),
                "apos" => "'".into(),
                "nbsp" => " ".into(),
                _ => number
                    .and_then(char::from_u32)
                    .filter(|ch| !ch.is_control())
                    .map_or_else(String::new, |ch| ch.to_string()),
            }
        })
        .into_owned()
}

fn html_tags(text: &str) -> String {
    static TAG: OnceLock<Regex> = OnceLock::new();
    TAG.get_or_init(|| Regex::new(r"(?is)</?([a-z][a-z0-9]*)\b[^>]*>").unwrap())
        .replace_all(text, |tag: &Captures<'_>| {
            match tag[1].to_ascii_lowercase().as_str() {
                "br" | "p" | "div" | "blockquote" => "\n",
                "b" | "strong" => "**",
                "i" | "em" => "_",
                "s" | "del" | "strike" => "~~",
                "code" => "\x60",
                "li" if !tag[0].starts_with("</") => "\n- ",
                _ => "",
            }
        })
        .into_owned()
}

pub(super) fn html(text: &str) -> String {
    static LINK: OnceLock<Regex> = OnceLock::new();
    static IMAGE: OnceLock<Regex> = OnceLock::new();
    let text = limited(text);
    let with_link = LINK
        .get_or_init(|| {
            Regex::new(r#"(?is)<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>"#).unwrap()
        })
        .replace_all(&text, |cap: &Captures<'_>| {
            let label = html_tags(&cap[2]).replace(['[', ']'], "");
            url(&cap[1]).map_or_else(|| label.clone(), |uri| format!("[{label}]({uri})"))
        });
    let with_images = IMAGE
        .get_or_init(|| {
            Regex::new(r#"(?is)<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>"#).unwrap()
        })
        .replace_all(&with_link, |cap: &Captures<'_>| {
            url(&cap[1]).map_or_else(String::new, |uri| format!("![image]({uri})"))
        });
    entities(&html_tags(&with_images)).trim().to_owned()
}

pub(super) fn anilist(text: &str) -> String {
    static MEDIA: OnceLock<Regex> = OnceLock::new();
    let text = limited(text);
    let clean = MEDIA
        .get_or_init(|| Regex::new(r"(?i)\b(img\d*%?|webm|youtube)\(([^)\s]+)\)").unwrap())
        .replace_all(&text, |cap: &Captures<'_>| {
            let kind = cap[1].to_ascii_lowercase();
            if kind.starts_with("img") {
                return url(&cap[2]).map_or_else(String::new, |uri| format!("![image]({uri})"));
            }
            let content = match kind.as_str() {
                "youtube" if !cap[2].contains(':') => format!("https://youtu.be/{}", &cap[2]),
                _ => cap[2].to_owned(),
            };
            url(&content).map_or_else(String::new, |uri| format!("[video]({uri})"))
        });
    html(&clean)
}

pub(super) fn bbcode(text: &str) -> String {
    static MARKUP: OnceLock<Regex> = OnceLock::new();
    static LINK: OnceLock<Regex> = OnceLock::new();
    let text = limited(text);
    let text = LINK
        .get_or_init(|| Regex::new(r"(?is)\[url=([^\]]+)\](.*?)\[/url\]").unwrap())
        .replace_all(&text, |cap: &Captures<'_>| {
            let label = cap[2].replace(['[', ']'], "");
            url(&cap[1]).map_or_else(|| label.clone(), |uri| format!("[{label}]({uri})"))
        });
    let text = MARKUP
        .get_or_init(|| Regex::new(r"(?i)\[(/?)(b|i|s|spoiler|\*|quote)(?:=[^\]]*)?\]").unwrap())
        .replace_all(&text, |cap: &Captures<'_>| {
            match cap[2].to_ascii_lowercase().as_str() {
                "b" => "**",
                "i" => "_",
                "s" => "~~",
                "*" => "\n- ",
                "spoiler" if cap[1].is_empty() => "~!",
                "spoiler" => "!~",
                "quote" if cap[1].is_empty() => "\n> ",
                _ => "\n",
            }
        });
    html(&text)
}
