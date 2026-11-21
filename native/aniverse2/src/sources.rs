use crate::{
    profile::{self, rows, text_file},
    RpcError,
};
use regex::Regex;
use rusqlite::{params, Connection, TransactionBehavior};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Url;

const SITES_FILE: &str = "config/streaming-sites.txt";
const RECIPES_FILE: &str = "config/site-recipes.json";
const DISCOVERY_METHODS: &[&str] = &["form", "opensearch", "jsonld", "ui"];

pub(crate) fn search_template<'a>(value: Option<&'a str>, source: &Url) -> Option<&'a str> {
    let value = value?.trim();
    if value.len() > 2000 || value.matches("{query}").count() != 1 {
        return None;
    }
    let (_, rest) = value.split_once("://")?;
    let authority = &rest[..rest.find(['/', '?', '#'])?];
    let probe = "__aniverse_search_value__";
    if authority.contains('{') || value.contains(probe) {
        return None;
    }
    let address = value.replace("{query}", probe);
    let url = Url::parse(&address).ok()?;
    if url.origin() != source.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query_pairs().any(|(key, _)| {
            let key = key.to_ascii_lowercase();
            [
                "token",
                "password",
                "session",
                "secret",
                "signature",
                "authorization",
                "csrf",
                "credential",
            ]
            .iter()
            .any(|protected| key.contains(protected))
        })
        || !aniverse_security::allows_source_network(&address, "")
            && !crate::player::fixture_source(&url)
        || !(url.path().contains(probe)
            || url.query_pairs().any(|(_, value)| value.contains(probe))
            || url
                .fragment()
                .is_some_and(|fragment| fragment.contains(probe)))
    {
        return None;
    }
    Some(value)
}

fn recipe_templates(root: &Path) -> HashMap<String, Value> {
    text_file(&root.join(RECIPES_FILE), 256 * 1024)
        .ok()
        .flatten()
        .and_then(|text| {
            serde_json::from_str::<HashMap<String, Value>>(text.trim_start_matches('\u{feff}')).ok()
        })
        .unwrap_or_default()
        .into_iter()
        .map(|(host, recipe)| {
            (
                host.trim()
                    .to_ascii_lowercase()
                    .trim_start_matches("www.")
                    .to_owned(),
                recipe,
            )
        })
        .collect()
}

fn domain(host: &str) -> &str {
    let mut parts = host.rsplitn(4, '.');
    let Some((tld, sld)) = parts.next().zip(parts.next()) else {
        return host;
    };
    let mut count = tld.len() + sld.len() + 1;
    if tld.len() == 2 && ["co", "com", "net", "org", "ac", "gov", "edu"].contains(&sld) {
        let Some(third) = parts.next() else {
            return host;
        };
        count += third.len() + 1;
    }
    &host[host.len() - count..]
}

fn recipe_entry<'a>(book: &'a HashMap<String, Value>, host: &str) -> Option<&'a Value> {
    book.get(host).or_else(|| book.get(domain(host)))
}

pub(crate) fn save_discovery(
    root: &Path,
    id: &str,
    source: &Url,
    selected: Option<&str>,
    via: &str,
) -> Result<(Value, Vec<Value>), RpcError> {
    let error = |_| RpcError::new("config", "Could not save the source search template.");
    let mut connection = profile::writable(root).map_err(error)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    let lookup = |entries: &[Value]| {
        entries
            .iter()
            .find(|entry| {
                entry["id"] == id
                    && entry["kind"] == "web"
                    && entry["enabled"] == true
                    && entry["url"] == source.as_str()
            })
            .cloned()
    };
    lookup(
        &list(root, Some(&tx))
            .map_err(|_| RpcError::new("config", "Could not read configured sources."))?,
    )
    .ok_or_else(|| RpcError::new("source", "This source changed during search discovery."))?;
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let origin = source.origin().ascii_serialization();
    let key = format!("discovery:{id}");
    let template = search_template(selected, source).unwrap_or("");
    let record = json!({"template":template,"via":via,"at":at,"origin":origin});
    tx.execute(
        "INSERT INTO kv(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, record.to_string()],
    ).map_err(error)?;
    let entries = list(root, Some(&tx))
        .map_err(|_| RpcError::new("config", "Could not read configured sources."))?;
    let updated = lookup(&entries)
        .ok_or_else(|| RpcError::new("source", "This source changed during search discovery."))?;
    tx.commit().map_err(error)?;
    Ok((updated, entries))
}

pub(crate) fn open_config(root: &Path) -> std::io::Result<PathBuf> {
    use std::{fs, io};

    fs::create_dir_all(root.join("config"))?;
    let config = root.join("config").canonicalize()?;
    if config.parent() != Some(root.canonicalize()?.as_path()) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Invalid source folder.",
        ));
    }
    let file = config.join("streaming-sites.txt");
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file)
    {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if !fs::symlink_metadata(&file)?.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Invalid source list.",
                ));
            }
        }
        Err(error) => return Err(error),
    }
    // The editor receives the ordinary DOS path, including spaces, as one filename.
    let path = root.join(SITES_FILE);
    open_in_windows(path.as_os_str())?;
    Ok(path)
}

pub(crate) fn open_external(root: &Path, input: Option<&Value>) -> Result<Value, RpcError> {
    let raw = input
        .and_then(|body| body["url"].as_str())
        .ok_or_else(external_denied)?;
    let target = external_target(root, raw)?;
    open_in_windows(std::ffi::OsStr::new(target.as_str()))
        .map_err(|_| RpcError::new("internal", "Windows could not open the link."))?;
    Ok(Value::Null)
}

pub(crate) fn external_target(root: &Path, raw: &str) -> Result<Url, RpcError> {
    let (scheme, _) = raw.split_once("://").ok_or_else(external_denied)?;
    if !(scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("http")) {
        return Err(external_denied());
    }
    let url = Url::parse(raw).map_err(|_| external_denied())?;
    if !aniverse_security::allows_source_network(raw, url.as_str()) {
        return Err(external_denied());
    }
    if url.scheme() == "https" && aniverse_security::allows_source_network(raw, "") {
        return Ok(url);
    }
    // A non-public or plain HTTP destination must be explicitly configured.
    let origin = url.origin();
    let configured = profile::request(root, "sources.list", Value::Null)?;
    if configured.as_array().is_some_and(|entries| {
        entries.iter().any(|entry| {
            entry["enabled"] == true
                && entry["url"]
                    .as_str()
                    .and_then(|base| Url::parse(base).ok())
                    .is_some_and(|base| base.origin() == origin)
        })
    }) {
        return Ok(url);
    }
    Err(external_denied())
}

fn external_denied() -> RpcError {
    RpcError::new(
        "unauthorised",
        "This external link is blocked by source protection.",
    )
}

pub(crate) fn open_in_windows(target: &std::ffi::OsStr) -> std::io::Result<()> {
    use std::{io, os::windows::ffi::OsStrExt, ptr::null_mut};
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

    let name: Vec<_> = target.encode_wide().chain([0]).collect();
    let verb: Vec<_> = "open".encode_utf16().chain([0]).collect();
    let result = unsafe {
        ShellExecuteW(
            null_mut(),
            verb.as_ptr(),
            name.as_ptr(),
            null_mut(),
            null_mut(),
            SW_SHOWNORMAL,
        )
    };
    if result as usize <= 32 {
        return Err(io::Error::other(format!(
            "Windows could not open the item ({}).",
            result as usize
        )));
    }
    Ok(())
}

pub(crate) fn list(
    root: &Path,
    db: Option<&Connection>,
) -> Result<Vec<Value>, Box<dyn std::error::Error + Send + Sync>> {
    let text = text_file(&root.join(SITES_FILE), 4 * 1024 * 1024)?.unwrap_or_default();
    let overrides: HashMap<_, _> = rows(db, "SELECT id,data FROM source_overrides", [], |row| {
        let data: String = row.get(1)?;
        Ok((
            row.get::<_, String>(0)?,
            serde_json::from_str::<Value>(&data).unwrap_or_default(),
        ))
    })?
    .into_iter()
    .collect();
    let discoveries: HashMap<_, _> = rows(
        db,
        "SELECT substr(key, 11),value FROM kv WHERE key >= 'discovery:' AND key < 'discovery;' AND length(value) <= 8192",
        [],
        |row| {
            let data: String = row.get(1)?;
            Ok((row.get::<_, String>(0)?, serde_json::from_str::<Value>(&data).unwrap_or_default()))
        },
    )?.into_iter().collect();
    let recipes = recipe_templates(root);
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
        let cached = discoveries.get(&id).filter(|record| {
            record["origin"]
                .as_str()
                .is_none_or(|origin| origin == url.origin().ascii_serialization())
        });
        let saved = cached.and_then(|record| {
            let via = record["via"]
                .as_str()
                .filter(|via| DISCOVERY_METHODS.contains(via))?;
            Some((search_template(record["template"].as_str(), &url)?, via))
        });
        let recipe = recipe_entry(&recipes, website)
            .and_then(|recipe| search_template(recipe["search"].as_str(), &url));
        let configured = if channel.is_some() {
            None
        } else {
            search_template(prefs["searchTemplate"].as_str(), &url)
                .map(|template| (template, "user"))
                .or_else(|| recipe.map(|template| (template, "recipe")))
                .or(saved)
        };
        let checked = cached
            .and_then(|record| record["at"].as_u64())
            .filter(|_| channel.is_none());
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
            "searchTemplate": configured.map(|(template, _)| template), "searchTemplateSource": configured.map(|(_, via)| via), "searchCheckedAt": checked,
            "capabilities": {"search":channel.is_none(),"episodes":false,"streams":false,"comments":false,"login":false}, "partition": partition,
        }));
    }
    entries.sort_by_key(|entry| entry["order"].as_u64().unwrap_or(0));
    Ok(entries)
}

#[cfg(test)]
#[path = "../../../test/tauri-compat/source-discovery.rs"]
mod tests;
