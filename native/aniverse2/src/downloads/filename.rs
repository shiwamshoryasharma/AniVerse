use serde_json::Value;

/// Naming metadata cannot grant media access or select a destination directory.
pub(super) fn episode_filename(context: &Value) -> Option<String> {
    let object = context.as_object()?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "title" | "season" | "episode"))
    {
        return None;
    }
    let title = context.get("title")?.as_str()?;
    if title.trim().is_empty() || title.encode_utf16().count() > 300 {
        return None;
    }
    let season = match context.get("season") {
        Some(value) => value.as_u64().filter(|value| (1..=99).contains(value))?,
        None => 1,
    };
    let episode = context
        .get("episode")?
        .as_u64()
        .filter(|value| (1..=10_000).contains(value))?;
    let cleaned: String = title
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
                || ('\u{202a}'..='\u{202e}').contains(&character)
                || ('\u{2066}'..='\u{2069}').contains(&character)
            {
                '_'
            } else {
                character
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches(|character| character == '.' || character == ' ');
    let bounded: String = trimmed.chars().take(100).collect();
    let mut title = bounded
        .trim_end_matches(|character| character == '.' || character == ' ')
        .to_owned();
    if title.is_empty() {
        title = "Series".into();
    }
    let device = title.split('.').next()?.to_ascii_uppercase();
    if matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (device.len() == 4
            && (device.starts_with("COM") || device.starts_with("LPT"))
            && matches!(device.as_bytes()[3], b'1'..=b'9'))
    {
        title.insert(0, '_');
    }
    Some(format!("{title} - S{season:02}E{episode:02}.mp4"))
}

#[cfg(test)]
#[path = "../../../../test/tauri-compat/download-filename.rs"]
mod tests;
