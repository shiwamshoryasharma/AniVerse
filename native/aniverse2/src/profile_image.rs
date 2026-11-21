use crate::{profile, RpcError};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::{fs, io::Read, path::Path};

const MAX_BYTES: usize = 3 * 1024 * 1024;

pub(crate) fn handles(method: &str) -> bool {
    matches!(method, "profile.setImage" | "profile.clearImage")
}

pub(crate) fn update(root: &Path, method: &str, input: &Value) -> Result<Value, RpcError> {
    let kind = input["kind"]
        .as_str()
        .filter(|kind| matches!(*kind, "avatar" | "banner"))
        .ok_or_else(invalid)?;
    let image = if method == "profile.setImage" {
        let data = input["dataUrl"]
            .as_str()
            .and_then(decode)
            .ok_or_else(invalid)?;
        Value::String(data)
    } else {
        Value::Null
    };
    let failed =
        |_: rusqlite::Error| RpcError::new("config", "Could not update the profile image.");
    let mut db = profile::writable(root).map_err(failed)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(failed)?;
    let saved = tx
        .query_row("SELECT value FROM kv WHERE key='settings'", [], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(failed)?;
    let mut settings = saved
        .map(|value| serde_json::from_str::<Value>(&value))
        .transpose()
        .map_err(|_| RpcError::new("config", "The profile settings could not be read."))?
        .unwrap_or_else(|| json!({}));
    let Some(settings_group) = settings.as_object_mut() else {
        return Err(invalid());
    };
    let group = settings_group.entry("profile").or_insert_with(|| json!({}));
    group
        .as_object_mut()
        .ok_or_else(invalid)?
        .insert(kind.into(), image);
    tx.execute("INSERT INTO kv(key,value) VALUES('settings',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [settings.to_string()]).map_err(failed)?;
    tx.commit().map_err(failed)?;
    let mut updated = profile::request(root, "settings.get", Value::Null)?;
    decorate(root, &mut updated);
    Ok(updated)
}

pub(crate) fn decorate(root: &Path, settings: &mut Value) {
    for kind in ["avatar", "banner"] {
        let slot = &mut settings["profile"][kind];
        let Some(url) = slot
            .as_str()
            .filter(|url| url.starts_with("media://profile/"))
        else {
            continue;
        };
        let file = url
            .trim_start_matches("media://profile/")
            .split('?')
            .next()
            .unwrap_or_default();
        let image = ["png", "jpg", "jpeg", "webp"]
            .into_iter()
            .find(|ext| file == format!("{kind}.{ext}"))
            .and_then(|ext| legacy_image(root, file, ext));
        *slot = image.map(Value::String).unwrap_or(Value::Null);
    }
}

fn legacy_image(root: &Path, file: &str, ext: &str) -> Option<String> {
    let directory = root.join("profile");
    if !fs::symlink_metadata(&directory).ok()?.file_type().is_dir() {
        return None;
    }
    let filename = directory.join(file);
    if !fs::symlink_metadata(&filename).ok()?.file_type().is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(filename)
        .ok()?
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    let mime = if ext == "jpg" { "jpeg" } else { ext };
    encode(mime, bytes)
}

fn decode(url: &str) -> Option<String> {
    if url.len() > 4 * (MAX_BYTES / 3) + 64 {
        return None;
    }
    let (header, base64) = url.split_once(";base64,")?;
    let mime = header.strip_prefix("data:image/")?;
    let bytes = STANDARD.decode(base64).ok()?;
    encode(mime, bytes)
}
fn encode(mime: &str, bytes: Vec<u8>) -> Option<String> {
    if bytes.len() > MAX_BYTES {
        return None;
    }
    let valid = match mime {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.get(12..16) == Some(b"IHDR"),
        "jpeg" => bytes.starts_with(b"\xff\xd8\xff") && bytes.ends_with(b"\xff\xd9"),
        "webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    };
    valid.then(|| format!("data:image/{mime};base64,{}", STANDARD.encode(bytes)))
}
fn invalid() -> RpcError {
    RpcError::new(
        "invalid-input",
        "Choose a PNG, JPEG or WebP profile image up to 3 MiB.",
    )
}
