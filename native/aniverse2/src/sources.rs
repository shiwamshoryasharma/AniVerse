use crate::profile::{rows, text_file};
use regex::Regex;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::OnceLock,
};
use tauri::Url;

pub(crate) fn list(
    root: &Path,
    db: Option<&Connection>,
) -> Result<Vec<Value>, Box<dyn std::error::Error + Send + Sync>> {
    let text =
        text_file(&root.join("config/streaming-sites.txt"), 4 * 1024 * 1024)?.unwrap_or_default();
    let overrides: HashMap<_, _> = rows(db, "SELECT id,data FROM source_overrides", [], |row| {
        let data: String = row.get(1)?;
        Ok((
            row.get::<_, String>(0)?,
            serde_json::from_str::<Value>(&data).unwrap_or_default(),
        ))
    })?
    .into_iter()
    .collect();
    let mut identities = HashSet::new();
    let mut ids = HashSet::new();
    let mut entries = Vec::new();
    static WEB_URL: OnceLock<Regex> = OnceLock::new();
    static YOUTUBE: OnceLock<Regex> = OnceLock::new();
    static SLUG: OnceLock<Regex> = OnceLock::new();
    let pattern = WEB_URL.get_or_init(|| Regex::new(r#"(?i)https?://[^\s'"<>]+"#).unwrap());
    let youtube = YOUTUBE
        .get_or_init(|| Regex::new(r"^/(@[A-Za-z0-9_.-]+|channel/UC[A-Za-z0-9_-]{22})").unwrap());
    let slug = SLUG.get_or_init(|| Regex::new(r"[^a-z0-9]+").unwrap());
    for (index, raw) in text.lines().enumerate() {
        let line = raw.trim_start_matches('\u{feff}').trim();
        if line.starts_with('#') || line.starts_with("//") {
            continue;
        }
        let Some(url) = pattern
            .find(line)
            .and_then(|url| Url::parse(url.as_str().trim_end_matches([')', ',', '.', ';'])).ok())
        else {
            continue;
        };
        let Some(host) = url.host_str() else {
            continue;
        };
        let website = host.strip_prefix("www.").unwrap_or(host);
        let channel = matches!(host, "youtube.com" | "www.youtube.com" | "m.youtube.com")
            .then(|| {
                youtube
                    .captures(url.path())
                    .and_then(|parts| parts.get(1))
                    .map(|name| name.as_str())
            })
            .flatten();
        let identity = match channel {
            Some(channel) => format!(
                "yt:{}",
                channel.trim_start_matches("channel/").to_ascii_lowercase()
            ),
            None => format!("{}{}", host, url.path().trim_end_matches('/')),
        };
        if !identities.insert(identity) {
            continue;
        }
        let name = channel.map_or(website, |channel| channel.trim_start_matches("channel/"));
        let base = slug
            .replace_all(&name.trim_start_matches('@').to_ascii_lowercase(), "-")
            .trim_matches('-')
            .to_owned();
        let base = if channel.is_some() {
            format!("yt-{base}")
        } else {
            base
        };
        let mut id = base.clone();
        let mut suffix = 2;
        while !ids.insert(id.clone()) {
            id = format!("{base}-{suffix}");
            suffix += 1;
        }
        let prefs = overrides.get(&id).unwrap_or(&Value::Null);
        let configured = prefs.get("searchTemplate").and_then(Value::as_str);
        let url = channel
            .map(|channel| format!("https://www.youtube.com/{channel}"))
            .unwrap_or_else(|| url.to_string());
        let partition = if channel.is_some() {
            "persist:src-youtube".into()
        } else {
            format!("persist:src-{id}")
        };
        entries.push(json!({
            "id":id, "line":index+1, "name":prefs["name"].as_str().filter(|name| !name.is_empty()).unwrap_or(name),
            "url": url, "host": host, "kind": if channel.is_some() { "youtube" } else { "web" },
            "enabled": prefs["enabled"].as_bool().unwrap_or(true), "order": prefs["order"].as_u64().unwrap_or(entries.len() as u64),
            "adblock": prefs["adblock"].as_bool().unwrap_or(true), "autoCloudflare": prefs["autoCloudflare"].as_bool().unwrap_or(true),
            "searchTemplate": configured, "searchTemplateSource": configured.map(|_| "user"), "searchCheckedAt": null,
            "capabilities": {"search":false,"episodes":false,"streams":false,"comments":false,"login":false}, "partition": partition,
        }));
    }
    entries.sort_by_key(|entry| entry["order"].as_u64().unwrap_or(0));
    Ok(entries)
}
