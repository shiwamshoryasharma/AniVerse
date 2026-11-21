mod create;
mod restore;
mod schema;

use super::super::{kv_in, storage};
use crate::RpcError;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub(in crate::integrations) use create::create;
pub(in crate::integrations) use restore::restore;
pub(in crate::integrations) use schema::validate;

pub(super) const LIMIT: usize = 25 * 1024 * 1024;
const TABLES: &[&str] = &[
    "library",
    "progress",
    "history",
    "favourites",
    "bookmarks",
    "skips",
];

pub(super) fn summary(backup: &Value) -> Value {
    json!({"createdAt":backup["createdAt"],"appVersion":backup["appVersion"],
        "library":entries(backup,"library").len(),"progress":entries(backup,"progress").len(),
        "history":entries(backup,"history").len(),"favourites":entries(backup,"favourites").len(),
        "bookmarks":entries(backup,"bookmarks").len(),"skips":entries(backup,"skips").len(),
        "themes":entries(backup,"themes").len(),"hasPlan":!backup["plan"].is_null()})
}

fn entries<'a>(backup: &'a Value, key: &str) -> &'a [Value] {
    backup[key].as_array().map_or(&[], Vec::as_slice)
}

fn private_titles(db: &Connection) -> Result<BTreeSet<i64>, RpcError> {
    let mut query = db
        .prepare("SELECT media_id FROM private_titles")
        .map_err(storage)?;
    let records = query.query_map([], |row| row.get(0)).map_err(storage)?;
    records.collect::<Result<BTreeSet<_>, _>>().map_err(storage)
}

fn keep_public(backup: &mut Value, private: &BTreeSet<i64>) {
    for field in TABLES {
        if let Some(rows) = backup[field].as_array_mut() {
            rows.retain(|row| {
                row["mediaId"]
                    .as_i64()
                    .is_some_and(|id| !private.contains(&id))
            });
        }
    }
    if let Some(rows) = backup["media"].as_array_mut() {
        rows.retain(|row| row["id"].as_i64().is_some_and(|id| !private.contains(&id)));
    }
    clean_plan(&mut backup["plan"], private);
}

fn clean_plan(plan: &mut Value, private: &BTreeSet<i64>) {
    if let Some(days) = plan.get_mut("days").and_then(Value::as_array_mut) {
        for day in days {
            if let Some(items) = day["items"].as_array_mut() {
                items.retain(|item| {
                    item["media"]["id"]
                        .as_i64()
                        .is_some_and(|id| !private.contains(&id))
                });
                day["minutes"] = json!(items
                    .iter()
                    .filter_map(|item| item["minutes"].as_f64())
                    .sum::<f64>());
            }
        }
    }
}

fn settings(db: &Connection) -> Result<Value, RpcError> {
    let defaults: Value = serde_json::from_str(include_str!(concat!(
        env!("OUT_DIR"),
        "/settings-defaults.json"
    )))
    .map_err(|_| RpcError::new("config", "Default settings are unavailable."))?;
    let stored = kv_in(db, "settings")?;
    let mut data = json!({});
    for field in ["appearance", "player"] {
        let mut base = defaults[field].clone();
        merge_known(&mut base, &stored[field]);
        data[field] = base;
    }
    Ok(data)
}

fn merge_known(base: &mut Value, data: &Value) {
    if let (Some(base), Some(data)) = (base.as_object_mut(), data.as_object()) {
        for (field, value) in base {
            if let Some(replacement) = data.get(field) {
                merge_known(value, replacement);
            }
        }
    } else if !data.is_null() && !base.is_object() {
        *base = data.clone();
    }
}

fn invalid_backup() -> RpcError {
    RpcError::new(
        "invalid-input",
        "This backup has invalid app data or uses an unsupported format. No data was imported.",
    )
}
