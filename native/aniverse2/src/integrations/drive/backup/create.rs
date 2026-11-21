use super::{clean_plan, entries, invalid_backup, private_titles, settings, validate, LIMIT};
use crate::{
    integrations::{kv_in, storage},
    profile, RpcError,
};
use rusqlite::{Connection, TransactionBehavior};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap},
    path::Path,
};

const PALETTES: &[&str] = &["ember", "aqua", "violet", "sakura", "crimson"];

pub(crate) fn create(root: &Path, app_version: &str) -> Result<Vec<u8>, RpcError> {
    let mut db = profile::writable(root).map_err(storage)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(storage)?;
    let mut settings = settings(&tx)?;
    let palette = kv_in(&tx, "theme:festival-2026")?;
    if settings["appearance"]["accent"] == "festival" {
        settings["appearance"]["accent"] = json!(palette["previous"]
            .as_str()
            .filter(|value| PALETTES.contains(value))
            .unwrap_or("ember"));
    }
    let mut backup = json!({"format":"aniverse.backup","version":1,"appVersion":app_version,
        "createdAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),
        "settings":settings,"media":[],"themes":[], "plan":kv_in(&tx,"planner:v1")?});
    for (field, table, fields, maximum) in [
        ("library", "library", "'mediaId',media_id,'status',status,'progress',progress,'score',score,'updatedAt',updated_at", 20_000),
        ("progress", "progress", "'mediaId',media_id,'episode',episode,'position',position,'duration',duration,'completed',json(CASE WHEN completed!=0 THEN 'true' ELSE 'false' END),'updatedAt',updated_at", 100_000),
        ("history", "history", "'mediaId',media_id,'episode',episode,'position',position,'duration',duration,'watchedAt',watched_at", 100_000),
        ("favourites", "favourites", "'mediaId',media_id,'addedAt',added_at", 20_000),
        ("bookmarks", "scene_bookmarks", "'mediaId',media_id,'episode',episode,'position',position,'duration',duration,'note',note,'tags',json(tags),'createdAt',created_at", 20_000),
        ("skips", "skip_ranges", "'mediaId',media_id,'kind',kind,'start',start,'end',end,'duration',duration", 40_000),
    ] {
        let sql = format!("SELECT json_object({fields}) FROM {table} WHERE media_id NOT IN (SELECT media_id FROM private_titles) LIMIT {}", maximum + 1);
        let rows = json_rows(&tx, &sql)?;
        if rows.len() > maximum { return Err(invalid_backup()); }
        backup[field] = Value::Array(rows);
    }
    let private = private_titles(&tx)?;
    clean_plan(&mut backup["plan"], &private);
    let ids = super::TABLES
        .iter()
        .flat_map(|field| entries(&backup, field))
        .filter_map(|row| row["mediaId"].as_i64())
        .collect::<BTreeSet<_>>();
    if ids.len() > 20_000 {
        return Err(invalid_backup());
    }
    let media = json_rows(&tx, "SELECT data FROM media_snapshot WHERE id NOT IN (SELECT media_id FROM private_titles)
        AND id IN (SELECT media_id FROM library UNION SELECT media_id FROM progress UNION SELECT media_id FROM history
        UNION SELECT media_id FROM favourites UNION SELECT media_id FROM scene_bookmarks UNION SELECT media_id FROM skip_ranges)")?;
    let mut indexed = media
        .into_iter()
        .filter_map(|item| Some((item["id"].as_i64()?, item)))
        .collect::<HashMap<_, _>>();
    backup["media"] = Value::Array(ids.into_iter().map(|id| indexed.remove(&id)
        .unwrap_or_else(|| json!({"id":id,"idMal":null,"title":"Unknown title","cover":"","banner":null,"format":null,"episodes":null}))).collect());
    if let Some(themes) = kv_in(&tx, "themes:v1")?.as_array() {
        backup["themes"] = Value::Array(
            themes
                .iter()
                .take(30)
                .filter_map(|theme| {
                    let mut theme = theme.get("preset")?.clone();
                    if theme["appearance"]["accent"] == "festival" {
                        theme["appearance"]["accent"] = json!("ember");
                    }
                    Some(theme)
                })
                .collect(),
        );
    }
    let data = serde_json::to_vec(&validate(backup)?).map_err(|_| invalid_backup())?;
    if data.len() > LIMIT {
        return Err(invalid_backup());
    }
    Ok(data)
}

fn json_rows(db: &Connection, command: &str) -> Result<Vec<Value>, RpcError> {
    let mut stmt = db.prepare(command).map_err(storage)?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(storage)?;
    rows.map(|row| {
        let row = row.map_err(storage)?;
        serde_json::from_str(&row).map_err(|_| invalid_backup())
    })
    .collect()
}
