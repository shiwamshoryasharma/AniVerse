use crate::{sources, RpcError};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Params, Row};
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::{self, Read},
    path::Path,
};

const DEFAULT_SETTINGS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/settings-defaults.json"));
const PREFERENCES: &[&str] = &[
    "aniverse.rail",
    "aniverse.desktop-theme",
    "aniverse.historyView",
    "aniverse.scheduleView",
    "aniverse.latestSeen",
];

pub(crate) fn update_defaults(root: &Path) -> Value {
    open(root)
        .ok()
        .and_then(|db| kv(db.as_ref(), "settings").ok().flatten())
        .map(|mut settings| settings["updates"].take())
        .unwrap_or_default()
}

pub(crate) fn show_adult(root: &Path) -> Result<bool, RpcError> {
    let db = open(root).map_err(read_error)?;
    let settings = kv(db.as_ref(), "settings").map_err(read_error)?;
    Ok(settings
        .as_ref()
        .and_then(|settings| settings["appearance"]["showAdult"].as_bool())
        .unwrap_or(false))
}

pub(crate) fn request(root: &Path, method: &str, input: Value) -> Result<Value, RpcError> {
    if method == "sources.openConfig" {
        return sources::open_config(root)
            .map(|path| json!({ "path": path }))
            .map_err(|error| {
                RpcError::new(
                    "config",
                    format!("Could not open streaming-sites.txt. {error}"),
                )
            });
    }
    if !matches!(
        method,
        "settings.get"
            | "privacy.state"
            | "library.history"
            | "library.entries"
            | "library.favourites"
            | "library.continue"
            | "sources.list"
            | "sources.reload"
            | "player.mp4Folder"
    ) {
        return Err(RpcError::new(
            "unavailable",
            format!("{method} is not available in this AniVerse2 build."),
        ));
    }
    let db = open(root).map_err(read_error)?;
    let db = db.as_ref();
    match method {
        "library.continue" => Ok(Value::Array(continue_watching(db).map_err(read_error)?)),
        "settings.get" => {
            let mut defaults = serde_json::from_slice(DEFAULT_SETTINGS).map_err(read_error)?;
            if let Some(saved) = kv(db, "settings").map_err(read_error)? {
                overlay(&mut defaults, &saved);
            }
            Ok(defaults)
        }
        "privacy.state" => {
            let ids = rows(
                db,
                "SELECT media_id FROM private_titles ORDER BY media_id",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(read_error)?;
            Ok(json!({"incognito": false, "privateMediaIds": ids}))
        }
        "library.history" => {
            let limit = input["limit"]
                .as_u64()
                .filter(|limit| (1..=500).contains(limit));
            let offset = input["offset"]
                .as_u64()
                .filter(|offset| *offset <= 1_000_000);
            let (Some(limit), Some(offset)) = (limit, offset) else {
                return Err(invalid());
            };
            let entries = rows(db, "SELECT h.media_id, m.data, h.id, h.episode, h.source_id, h.position, h.duration, h.watched_at FROM history h
                LEFT JOIN media_snapshot m ON m.id=h.media_id WHERE NOT EXISTS(SELECT 1 FROM private_titles p WHERE p.media_id=h.media_id)
                ORDER BY h.watched_at DESC,h.id DESC LIMIT ?1 OFFSET ?2", params![limit as i64, offset as i64], |row| Ok(json!({
                "media": media(row)?, "id": row.get::<_, i64>(2)?, "episode": row.get::<_, i64>(3)?,
                "sourceId": row.get::<_, Option<String>>(4)?, "position": row.get::<_, f64>(5)?,
                "duration": row.get::<_, f64>(6)?, "watchedAt": row.get::<_, i64>(7)?,
            }))).map_err(read_error)?;
            Ok(Value::Array(entries))
        }
        "library.entries" => {
            let status = match input.get("status") {
                Some(Value::Null) => None,
                Some(Value::String(value))
                    if [
                        "CURRENT",
                        "PLANNING",
                        "COMPLETED",
                        "DROPPED",
                        "PAUSED",
                        "REPEATING",
                    ]
                    .contains(&value.as_str()) =>
                {
                    Some(value)
                }
                _ => return Err(invalid()),
            };
            let entries = rows(db, "SELECT l.media_id,m.data,l.status,l.progress,l.score,l.updated_at FROM library l
                LEFT JOIN media_snapshot m ON m.id=l.media_id WHERE ?1 IS NULL OR l.status=?1 ORDER BY l.updated_at DESC", [status], |row| Ok(json!({
                "media": media(row)?, "status": row.get::<_, String>(2)?, "progress": row.get::<_, i64>(3)?,
                "score": row.get::<_, Option<f64>>(4)?, "updatedAt": row.get::<_, i64>(5)?,
            }))).map_err(read_error)?;
            Ok(Value::Array(entries))
        }
        "library.favourites" => {
            let entries = rows(db, "SELECT f.media_id,m.data,f.added_at FROM favourites f LEFT JOIN media_snapshot m ON m.id=f.media_id ORDER BY f.added_at DESC", [], |row| {
                Ok(json!({"media":media(row)?,"addedAt":row.get::<_, i64>(2)?}))
            }).map_err(read_error)?;
            Ok(Value::Array(entries))
        }
        "sources.list" | "sources.reload" => {
            Ok(Value::Array(sources::list(root, db).map_err(read_error)?))
        }
        "player.mp4Folder" if input["action"] == "get" => Ok(kv(db, "windows:mp4-download-folder")
            .map_err(read_error)?
            .filter(Value::is_string)
            .unwrap_or_default()),
        _ => Err(invalid()),
    }
}

fn continue_watching(db: Option<&Connection>) -> rusqlite::Result<Vec<Value>> {
    let dismissed = kv(db, "continue-dismissed")?.unwrap_or_default();
    let cleared_at = kv(db, "continue-cleared-at")?
        .and_then(|value| value.as_i64())
        .unwrap_or(0);
    let recent = rows(db, "SELECT p.media_id,m.data,p.episode,p.position,p.duration,p.source_id,p.updated_at,p.completed
        FROM progress p LEFT JOIN media_snapshot m ON m.id=p.media_id
        JOIN (SELECT media_id,MAX(updated_at) AS newest FROM progress GROUP BY media_id) r
            ON r.media_id=p.media_id AND r.newest=p.updated_at
        WHERE NOT EXISTS(SELECT 1 FROM private_titles h WHERE h.media_id=p.media_id)
        ORDER BY p.updated_at DESC,p.episode DESC LIMIT 40", [], |row| {
        Ok((row.get::<_, i64>(0)?, media(row)?, row.get::<_, i64>(2)?, row.get::<_, f64>(3)?,
            row.get::<_, f64>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, i64>(6)?, row.get::<_, bool>(7)?))
    })?;
    let mut visited = std::collections::HashSet::new();
    Ok(recent.into_iter().filter_map(|(id, media, episode, position, duration, source, updated_at, complete)| {
        if !visited.insert(id) || updated_at <= cleared_at.max(dismissed[id.to_string()].as_i64().unwrap_or(0)) ||
            (complete && media["episodes"].as_i64().is_some_and(|episodes| episode >= episodes)) {
            return None;
        }
        Some(json!({
            "media":media, "episode": if complete { episode + 1 } else { episode },
            "position": if complete { 0.0 } else { position }, "duration": if complete { 0.0 } else { duration },
            "sourceId":source, "updatedAt":updated_at, "completed":false,
        }))
    }).take(20).collect())
}

fn open(root: &Path) -> rusqlite::Result<Option<Connection>> {
    let db = root.join("aniverse.db");
    if matches!(fs::metadata(&db), Err(error) if error.kind() == io::ErrorKind::NotFound) {
        return Ok(None);
    }
    let db = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.pragma_update(None, "trusted_schema", false)?;
    Ok(Some(db))
}

fn kv(db: Option<&Connection>, key: &str) -> rusqlite::Result<Option<Value>> {
    let Some(db) = db else {
        return Ok(None);
    };
    let json = db
        .query_row("SELECT value FROM kv WHERE key=?1", [key], |row| {
            row.get::<_, String>(0)
        })
        .optional()?;
    Ok(json.and_then(|value| serde_json::from_str(&value).ok()))
}

pub(crate) fn rows<T>(
    db: Option<&Connection>,
    sql: &str,
    params: impl Params,
    map: impl FnMut(&Row) -> rusqlite::Result<T>,
) -> rusqlite::Result<Vec<T>> {
    let Some(db) = db else {
        return Ok(Vec::new());
    };
    let mut statement = db.prepare(sql)?;
    let values = statement.query_map(params, map)?;
    values.collect()
}

fn media(row: &Row) -> rusqlite::Result<Value> {
    let id: i64 = row.get(0)?;
    Ok(row.get::<_, Option<String>>(1)?.and_then(|row| serde_json::from_str(&row).ok())
        .filter(Value::is_object).unwrap_or_else(|| json!({
            "id":id,"idMal":null,"title":format!("AniList #{id}"),"cover":"","banner":null,"format":null,"episodes":null,
        })))
}

fn overlay(defaults: &mut Value, saved: &Value) {
    if let (Some(defaults), Some(saved)) = (defaults.as_object_mut(), saved.as_object()) {
        for (key, value) in defaults {
            if let Some(saved) = saved.get(key) {
                overlay(value, saved);
            }
        }
    } else if (defaults.is_null() && saved.is_string())
        || (!defaults.is_object()
            && std::mem::discriminant(defaults) == std::mem::discriminant(saved))
    {
        *defaults = saved.clone();
    }
}

pub(crate) fn text_file(path: &Path, limit: usize) -> io::Result<Option<String>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut text = String::new();
    file.take((limit + 1) as u64).read_to_string(&mut text)?;
    if text.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "profile file exceeds its size limit",
        ));
    }
    Ok(Some(text))
}

pub(crate) fn renderer_preferences(root: &Path) -> io::Result<String> {
    let saved = text_file(&root.join("renderer-preferences.json"), 4096)?
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let prefs = PREFERENCES
        .iter()
        .filter_map(|key| {
            let value = saved.as_ref()?.get(*key)?.as_str()?;
            (value.encode_utf16().count() <= 128).then_some((key.to_string(), json!(value)))
        })
        .collect::<serde_json::Map<_, _>>();
    Ok(Value::Object(prefs).to_string())
}

fn invalid() -> RpcError {
    RpcError::new("invalid-input", "Invalid desktop request.")
}
fn read_error(_: impl std::fmt::Display) -> RpcError {
    RpcError::new("internal", "AniVerse2 could not read the current profile.")
}
