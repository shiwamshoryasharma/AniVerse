use super::{invalid, is_private, media_id, open, writes};
use crate::{sources, RpcError};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{Map, Value};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Url;

pub(super) fn handles(method: &str) -> bool {
    matches!(method, "sources.update" | "sources.pin" | "site.forget")
}

pub(super) fn write(root: &Path, method: &str, input: &Value) -> Result<Value, RpcError> {
    let id = input[if method == "sources.update" {
        "id"
    } else {
        "sourceId"
    }]
    .as_str()
    .filter(|id| {
        !id.is_empty()
            && id.len() <= 80
            && id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    })
    .ok_or_else(invalid)?;
    let mut db = writes::writable(root).map_err(save_error)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(save_error)?;
    let source = configured(root, &tx, id)?.ok_or_else(unknown_source)?;
    let result = match method {
        "sources.update" => {
            update(
                &tx,
                &source,
                input
                    .get("patch")
                    .and_then(Value::as_object)
                    .ok_or_else(invalid)?,
            )?;
            configured(root, &tx, id)?.ok_or_else(unknown_source)?
        }
        "sources.pin" => {
            pin(
                &tx,
                &source,
                media_id(input)?,
                input.get("url").ok_or_else(invalid)?,
            )?;
            Value::Null
        }
        "site.forget" => {
            let media = media_id(input)?;
            if !is_private(Some(&tx), media).map_err(save_error)? {
                tx.execute(
                    "DELETE FROM site_links WHERE source_id=?1 AND media_id=?2",
                    params![id, media],
                )
                .map_err(save_error)?;
                pin(&tx, &source, media, &Value::Null)?;
            }
            Value::Null
        }
        _ => return Err(invalid()),
    };
    tx.commit().map_err(save_error)?;
    Ok(result)
}

fn configured(root: &Path, db: &Connection, id: &str) -> Result<Option<Value>, RpcError> {
    Ok(sources::list(root, Some(db))
        .map_err(|_| {
            RpcError::new(
                "config",
                "AniVerse2 could not read the current source list.",
            )
        })?
        .into_iter()
        .find(|source| source["id"] == id))
}

fn update(db: &Connection, source: &Value, patch: &Map<String, Value>) -> Result<(), RpcError> {
    let id = source["id"].as_str().ok_or_else(invalid)?;
    let saved: Option<String> = db
        .query_row(
            "SELECT data FROM source_overrides WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(save_error)?;
    let mut merged: Map<String, Value> = saved
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| RpcError::new("config", "This source has unreadable saved settings."))?
        .unwrap_or_default();
    for (key, value) in patch {
        let value = match key.as_str() {
            "enabled" | "adblock" | "autoCloudflare" => {
                Value::Bool(value.as_bool().ok_or_else(invalid)?)
            }
            "order" => value
                .as_u64()
                .filter(|order| *order <= 10_000)
                .map(Value::from)
                .ok_or_else(invalid)?,
            "name" => value
                .as_str()
                .filter(|name| name.encode_utf16().count() <= 60)
                .map(Value::from)
                .ok_or_else(invalid)?,
            "searchTemplate" => template(source, value)?,
            _ => continue,
        };
        merged.insert(key.to_owned(), value);
    }
    db.execute(
        "INSERT INTO source_overrides(id,data) VALUES(?1,?2)
                ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        params![id, Value::Object(merged).to_string()],
    )
    .map_err(save_error)?;
    Ok(())
}

fn template(source: &Value, value: &Value) -> Result<Value, RpcError> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    let text = value
        .as_str()
        .filter(|text| text.encode_utf16().count() <= 2000)
        .map(str::trim)
        .ok_or_else(invalid)?;
    if text.is_empty() {
        return Ok(Value::Null);
    }
    let base = source["url"].as_str().ok_or_else(invalid)?;
    // Both probes must stay on the configured origin. A template cannot place
    // user-entered text in the authority, where it could select another host.
    if source["kind"] != "web"
        || !text.contains("{query}")
        || ["aniverse-search-a", "aniverse-search-b"]
            .iter()
            .any(|probe| public_same_origin(&text.replace("{query}", probe), base).is_none())
    {
        return Err(RpcError::new(
            "invalid-input",
            "Use a public search URL on the configured website containing {query}.",
        ));
    }
    Ok(Value::from(text))
}

fn pin(db: &Connection, source: &Value, media: i64, value: &Value) -> Result<(), RpcError> {
    if is_private(Some(db), media).map_err(save_error)? {
        return Err(RpcError::new(
            "unauthorised",
            "Pins are unavailable for private titles.",
        ));
    }
    let id = source["id"].as_str().ok_or_else(invalid)?;
    if value.is_null() {
        db.execute(
            "DELETE FROM source_pins WHERE source_id=?1 AND media_id=?2",
            params![id, media],
        )
        .map_err(save_error)?;
        return Ok(());
    }
    let url = value
        .as_str()
        .filter(|url| url.encode_utf16().count() <= 4000)
        .ok_or_else(invalid)?;
    if source["enabled"] != true {
        return Err(RpcError::new(
            "invalid-input",
            "Enable this source before pinning a page.",
        ));
    }
    let base = source["url"].as_str().ok_or_else(invalid)?;
    if public_same_origin(url, base).is_none() {
        return Err(RpcError::new(
            "invalid-input",
            "Only public pages on the configured source can be pinned.",
        ));
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    db.execute("INSERT INTO source_pins(source_id,media_id,url,updated_at) VALUES(?1,?2,?3,?4)
                ON CONFLICT(source_id,media_id) DO UPDATE SET url=excluded.url,updated_at=excluded.updated_at",
        params![id,media,url,now]).map_err(save_error)?;
    Ok(())
}

pub(crate) fn saved_pin(
    root: &Path,
    source_id: &str,
    media_id: i64,
) -> Result<Option<Url>, RpcError> {
    let Some(db) = open(root).map_err(save_error)? else {
        return Ok(None);
    };
    if is_private(Some(&db), media_id).map_err(save_error)? {
        return Ok(None);
    }
    let saved: Option<String> = db
        .query_row(
            "SELECT url FROM source_pins WHERE source_id=?1 AND media_id=?2",
            params![source_id, media_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(save_error)?;
    let Some(saved) = saved else {
        return Ok(None);
    };
    let Some(source) = configured(root, &db, source_id)?.filter(|source| source["enabled"] == true)
    else {
        return Ok(None);
    };
    Ok(source["url"]
        .as_str()
        .and_then(|base| public_same_origin(&saved, base)))
}

fn public_same_origin(value: &str, base: &str) -> Option<Url> {
    let (scheme, _) = value.split_once("://")?;
    if !(scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("http"))
        || !aniverse_security::allows_source_network(value, "")
    {
        return None;
    }
    let url = Url::parse(value).ok()?;
    (Url::parse(base).ok()?.origin() == url.origin()).then_some(url)
}

fn unknown_source() -> RpcError {
    RpcError::new(
        "not-found",
        "That source is no longer in the configured list.",
    )
}

fn save_error(_: rusqlite::Error) -> RpcError {
    RpcError::new(
        "internal",
        "AniVerse2 could not access saved source settings.",
    )
}
