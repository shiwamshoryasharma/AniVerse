use super::{entries, keep_public, private_titles, summary};
use crate::{
    integrations::{kv_in, set_kv, storage},
    profile, RpcError,
};
use rusqlite::{params, Connection, TransactionBehavior};
use serde_json::{json, Value};
use std::path::Path;

pub(crate) fn restore(
    root: &Path,
    mut backup: Value,
    apply_settings: bool,
) -> Result<Value, RpcError> {
    let mut db = profile::writable(root).map_err(storage)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage)?;
    keep_public(&mut backup, &private_titles(&tx)?);
    let now = chrono::Utc::now().timestamp();
    for media in entries(&backup, "media") {
        tx.execute(
            "INSERT OR IGNORE INTO media_snapshot(id,data,updated_at) VALUES (?1,?2,?3)",
            params![media["id"].as_i64(), media.to_string(), now],
        )
        .map_err(storage)?;
    }
    restore_library(&tx, &backup)?;
    restore_playback(&tx, &backup)?;
    restore_workspace(&tx, &backup)?;
    if apply_settings {
        let mut current = kv_in(&tx, "settings")?;
        for field in ["appearance", "player"] {
            current[field] = backup["settings"][field].clone();
        }
        set_kv(&tx, "settings", &current)?;
    }
    set_kv(
        &tx,
        "drive:lastImport",
        &json!(chrono::Utc::now().timestamp_millis()),
    )?;
    tx.commit().map_err(storage)?;
    Ok(summary(&backup))
}

fn restore_library(db: &Connection, backup: &Value) -> Result<(), RpcError> {
    let mut write = db.prepare("INSERT INTO library(media_id,status,progress,score,updated_at)
        SELECT ?1,?2,?3,?4,?5 WHERE NOT EXISTS
        (SELECT 1 FROM library_tombstones WHERE media_id=?1 AND deleted_at >= ?5)
        ON CONFLICT(media_id) DO UPDATE SET status=excluded.status,progress=excluded.progress,
        score=excluded.score,updated_at=excluded.updated_at WHERE excluded.updated_at>library.updated_at").map_err(storage)?;
    for row in entries(backup, "library") {
        let id = row["mediaId"].as_i64();
        if write
            .execute(params![
                id,
                row["status"].as_str(),
                row["progress"].as_i64(),
                row["score"].as_f64(),
                row["updatedAt"].as_i64()
            ])
            .map_err(storage)?
            > 0
        {
            db.execute("DELETE FROM library_tombstones WHERE media_id=?1", [id])
                .map_err(storage)?;
        }
    }
    for row in entries(backup, "favourites") {
        db.execute(
            "INSERT OR IGNORE INTO favourites(media_id,added_at) VALUES (?1,?2)",
            params![row["mediaId"].as_i64(), row["addedAt"].as_i64()],
        )
        .map_err(storage)?;
    }
    Ok(())
}

fn restore_playback(db: &Connection, backup: &Value) -> Result<(), RpcError> {
    let mut progress = db.prepare("INSERT INTO progress(media_id,episode,position,duration,completed,source_id,updated_at)
        VALUES (?1,?2,?3,?4,?5,NULL,?6) ON CONFLICT(media_id,episode) DO UPDATE
        SET position=excluded.position,duration=excluded.duration,completed=excluded.completed,source_id=NULL,
        updated_at=excluded.updated_at WHERE excluded.updated_at>progress.updated_at").map_err(storage)?;
    for row in entries(backup, "progress") {
        progress
            .execute(params![
                row["mediaId"].as_i64(),
                row["episode"].as_i64(),
                row["position"].as_f64(),
                row["duration"].as_f64(),
                row["completed"].as_bool(),
                row["updatedAt"].as_i64()
            ])
            .map_err(storage)?;
    }
    let mut history = db
        .prepare(
            "INSERT INTO history(media_id,episode,source_id,position,duration,watched_at)
        VALUES (?1,?2,NULL,?3,?4,?5) ON CONFLICT(media_id,episode) DO UPDATE
        SET position=excluded.position,duration=excluded.duration,watched_at=excluded.watched_at
        WHERE excluded.watched_at>history.watched_at",
        )
        .map_err(storage)?;
    for row in entries(backup, "history") {
        history
            .execute(params![
                row["mediaId"].as_i64(),
                row["episode"].as_i64(),
                row["position"].as_f64(),
                row["duration"].as_f64(),
                row["watchedAt"].as_i64()
            ])
            .map_err(storage)?;
    }
    Ok(())
}

fn restore_workspace(db: &Connection, backup: &Value) -> Result<(), RpcError> {
    let mut write = db.prepare("INSERT INTO scene_bookmarks(media_id,episode,position,duration,source_id,note,tags,created_at)
        SELECT ?1,?2,?3,?4,NULL,?5,?6,?7 WHERE NOT EXISTS(SELECT 1 FROM scene_bookmarks
        WHERE media_id=?1 AND episode=?2 AND position=?3 AND note=?5 AND created_at=?7)").map_err(storage)?;
    for row in entries(backup, "bookmarks") {
        write
            .execute(params![
                row["mediaId"].as_i64(),
                row["episode"].as_i64(),
                row["position"].as_f64(),
                row["duration"].as_f64(),
                row["note"].as_str(),
                row["tags"].to_string(),
                row["createdAt"].as_i64()
            ])
            .map_err(storage)?;
    }
    for row in entries(backup, "skips") {
        db.execute(
            "INSERT OR IGNORE INTO skip_ranges(media_id,kind,start,end,enabled,source_id,duration)
            VALUES (?1,?2,?3,?4,0,NULL,?5)",
            params![
                row["mediaId"].as_i64(),
                row["kind"].as_str(),
                row["start"].as_f64(),
                row["end"].as_f64(),
                row["duration"].as_f64()
            ],
        )
        .map_err(storage)?;
    }
    let themes = kv_in(db, "themes:v1")?;
    let mut themes = themes.as_array().cloned().unwrap_or_default();
    for preset in entries(backup, "themes") {
        if themes.len() >= 30 {
            break;
        }
        if !themes.iter().any(|saved| saved["preset"] == *preset) {
            themes.push(json!({"id":uuid::Uuid::new_v4().to_string(),"preset":preset}));
        }
    }
    set_kv(db, "themes:v1", &Value::Array(themes))?;
    if !backup["plan"].is_null() && kv_in(db, "planner:v1")?.is_null() {
        set_kv(db, "planner:v1", &backup["plan"])?;
    }
    Ok(())
}
