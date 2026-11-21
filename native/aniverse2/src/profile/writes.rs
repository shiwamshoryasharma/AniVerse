use super::{invalid, is_private, kv, media_id};
use crate::RpcError;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub(super) fn handles(method: &str) -> bool {
    matches!(
        method,
        "library.saveProgress"
            | "library.markWatched"
            | "library.toggleFavourite"
            | "library.setStatus"
            | "library.setScore"
            | "library.clearHistory"
            | "library.dismissContinue"
    )
}

pub(super) fn write(root: &Path, method: &str, input: &Value) -> Result<Value, RpcError> {
    let mut db = writable(root).map_err(error)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let result = match method {
        "library.saveProgress" => save_progress(&tx, input, now)?,
        "library.markWatched" => mark_watched(&tx, input, now)?,
        "library.toggleFavourite" => {
            let id = snapshot(&tx, input, now)?;
            let removed = tx
                .execute("DELETE FROM favourites WHERE media_id=?1", [id])
                .map_err(error)?;
            if removed == 0 {
                tx.execute(
                    "INSERT INTO favourites(media_id,added_at) VALUES(?1,?2)",
                    params![id, now],
                )
                .map_err(error)?;
            }
            json!({"favourite": removed == 0})
        }
        "library.setStatus" => {
            let status = input.get("status").ok_or_else(invalid)?;
            let id = snapshot(&tx, input, now)?;
            if status.is_null() {
                tx.execute("DELETE FROM library WHERE media_id=?1", [id])
                    .map_err(error)?;
                tx.execute(
                    "INSERT INTO library_tombstones(media_id,deleted_at) VALUES(?1,?2)
                    ON CONFLICT(media_id) DO UPDATE SET deleted_at=excluded.deleted_at",
                    params![id, now],
                )
                .map_err(error)?;
            } else {
                let status = status
                    .as_str()
                    .filter(|status| {
                        matches!(
                            *status,
                            "CURRENT"
                                | "PLANNING"
                                | "COMPLETED"
                                | "DROPPED"
                                | "PAUSED"
                                | "REPEATING"
                        )
                    })
                    .ok_or_else(invalid)?;
                tx.execute("INSERT INTO library(media_id,status,progress,score,updated_at) VALUES(?1,?2,0,NULL,?3)
                    ON CONFLICT(media_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at",
                    params![id, status, now]).map_err(error)?;
                tx.execute("DELETE FROM library_tombstones WHERE media_id=?1", [id])
                    .map_err(error)?;
            }
            Value::Null
        }
        "library.setScore" => {
            let id = writable_title(&tx, media_id(input)?)?;
            let score = match input.get("score") {
                Some(Value::Null) => None,
                Some(value) => Some(
                    value
                        .as_f64()
                        .filter(|score| (0.0..=10.0).contains(score))
                        .map(|score| (score * 10.0).round() / 10.0)
                        .ok_or_else(invalid)?,
                ),
                None => return Err(invalid()),
            };
            if tx
                .execute(
                    "UPDATE library SET score=?1,updated_at=?2 WHERE media_id=?3",
                    params![score, now, id],
                )
                .map_err(error)?
                == 0
            {
                return Err(RpcError::new(
                    "invalid-input",
                    "Add the title to your list before scoring it.",
                ));
            }
            Value::Null
        }
        "library.clearHistory" => {
            match input.get("id").ok_or_else(invalid)? {
                Value::Null => {
                    tx.execute("DELETE FROM history", []).map_err(error)?;
                    set_kv(&tx, "continue-cleared-at", json!(now)).map_err(error)?;
                    set_kv(&tx, "continue-dismissed", json!({})).map_err(error)?;
                }
                other => {
                    let id = other.as_i64().filter(|id| *id > 0).ok_or_else(invalid)?;
                    let media = tx
                        .query_row("SELECT media_id FROM history WHERE id=?1", [id], |row| {
                            row.get::<_, i64>(0)
                        })
                        .optional()
                        .map_err(error)?;
                    tx.execute("DELETE FROM history WHERE id=?1", [id])
                        .map_err(error)?;
                    if let Some(media) = media {
                        dismiss(&tx, media, now).map_err(error)?;
                    }
                }
            }
            Value::Null
        }
        "library.dismissContinue" => {
            dismiss(&tx, media_id(input)?, now).map_err(error)?;
            Value::Null
        }
        _ => return Err(invalid()),
    };
    let affected = match method {
        "library.toggleFavourite" => {
            Some((snapshot_id(&input["media"])?, result["favourite"].as_bool()))
        }
        "library.setScore" => Some((media_id(input)?, None)),
        "library.setStatus" => Some((snapshot_id(&input["media"])?, None)),
        "library.markWatched" => {
            let id = snapshot_id(&input["media"])?;
            let tracked: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM library WHERE media_id=?1)",
                    [id],
                    |row| row.get(0),
                )
                .map_err(error)?;
            tracked.then_some((id, None))
        }
        "library.saveProgress" if result["completedNow"] == true => {
            Some((snapshot_id(&input["media"])?, None))
        }
        _ => None,
    };
    let queued = match affected {
        Some((id, favourite)) => crate::integrations::queue_library_change(&tx, id, favourite)?,
        None => false,
    };
    tx.commit().map_err(error)?;
    if queued {
        crate::integrations::library_queued();
    }
    Ok(result)
}

fn save_progress(db: &Connection, input: &Value, now: i64) -> Result<Value, RpcError> {
    let id = snapshot_id(&input["media"])?;
    if is_private(Some(db), id).map_err(error)? {
        return Ok(json!({"completedNow": false}));
    }
    let episode = episode(input)?;
    let number = |key| {
        input[key]
            .as_f64()
            .filter(|n| (0.0..=604800.0).contains(n))
            .ok_or_else(invalid)
    };
    let duration = number("duration")?;
    let position = number("position")?;
    let source = input.get("sourceId").and_then(Value::as_str);
    if source.is_some_and(|source| {
        source.len() > 96
            || !source
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    }) {
        return Err(invalid());
    }
    snapshot(db, input, now)?;
    let threshold = kv(Some(db), "settings")
        .map_err(error)?
        .and_then(|setting| setting["player"]["completeThreshold"].as_f64())
        .unwrap_or(0.85)
        .clamp(0.5, 1.0);
    let before = db
        .query_row(
            "SELECT completed FROM progress WHERE media_id=?1 AND episode=?2",
            params![id, episode],
            |row| row.get::<_, bool>(0),
        )
        .optional()
        .map_err(error)?
        .unwrap_or(false);
    let reached = duration > 0.0 && position / duration >= threshold;
    db.execute("INSERT INTO progress(media_id,episode,position,duration,completed,source_id,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)
        ON CONFLICT(media_id,episode) DO UPDATE SET position=excluded.position,duration=excluded.duration,
        completed=excluded.completed,source_id=excluded.source_id,updated_at=excluded.updated_at",
        params![id,episode,position,duration,reached || before,source,now]).map_err(error)?;
    history(db, id, episode, source, position, duration, now).map_err(error)?;
    if reached && !before {
        bump(db, id, episode, &input["media"], now).map_err(error)?;
    }
    Ok(json!({"completedNow": reached && !before}))
}

fn mark_watched(db: &Connection, input: &Value, now: i64) -> Result<Value, RpcError> {
    let id = snapshot_id(&input["media"])?;
    if is_private(Some(db), id).map_err(error)? {
        return Ok(Value::Null);
    }
    let watched = input["watched"].as_bool().ok_or_else(invalid)?;
    let episode = episode(input)?;
    snapshot(db, input, now)?;
    let duration = db
        .query_row(
            "SELECT duration FROM progress WHERE media_id=?1 AND episode=?2",
            params![id, episode],
            |row| row.get::<_, f64>(0),
        )
        .optional()
        .map_err(error)?
        .unwrap_or_default();
    db.execute("INSERT INTO progress(media_id,episode,position,duration,completed,source_id,updated_at) VALUES(?1,?2,?3,?4,?5,NULL,?6)
        ON CONFLICT(media_id,episode) DO UPDATE SET position=excluded.position,completed=excluded.completed,updated_at=excluded.updated_at",
        params![id,episode,if watched {duration} else {0.0},duration,watched,now]).map_err(error)?;
    if watched {
        history(db, id, episode, None, duration, duration, now).map_err(error)?;
        bump(db, id, episode, &input["media"], now).map_err(error)?;
    } else {
        db.execute("UPDATE library SET progress=COALESCE((SELECT MAX(episode) FROM progress WHERE media_id=?1 AND completed=1),0),
            updated_at=?2 WHERE media_id=?1 AND progress>=?3", params![id,now,episode]).map_err(error)?;
    }
    Ok(Value::Null)
}

fn history(
    db: &Connection,
    id: i64,
    episode: i64,
    source: Option<&str>,
    position: f64,
    duration: f64,
    now: i64,
) -> rusqlite::Result<()> {
    db.execute("INSERT INTO history(media_id,episode,source_id,position,duration,watched_at) VALUES(?1,?2,?3,?4,?5,?6)
        ON CONFLICT(media_id,episode) DO UPDATE SET source_id=COALESCE(excluded.source_id,history.source_id),
        position=excluded.position,duration=excluded.duration,watched_at=excluded.watched_at",
        params![id,episode,source,position,duration,now])?;
    Ok(())
}

fn bump(db: &Connection, id: i64, episode: i64, media: &Value, now: i64) -> rusqlite::Result<()> {
    let current = db
        .query_row(
            "SELECT progress,status FROM library WHERE media_id=?1",
            [id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let progress = current
        .as_ref()
        .map_or(episode, |(progress, _)| episode.max(*progress));
    let status = if media["episodes"]
        .as_i64()
        .is_some_and(|count| progress >= count)
    {
        "COMPLETED"
    } else if current.is_some_and(|(_, status)| status == "REPEATING") {
        "REPEATING"
    } else {
        "CURRENT"
    };
    db.execute("INSERT INTO library(media_id,status,progress,score,updated_at) VALUES(?1,?2,?3,NULL,?4)
        ON CONFLICT(media_id) DO UPDATE SET status=excluded.status,progress=excluded.progress,updated_at=excluded.updated_at",
        params![id,status,progress,now])?;
    db.execute("DELETE FROM library_tombstones WHERE media_id=?1", [id])?;
    Ok(())
}

pub(crate) fn writable(root: &Path) -> rusqlite::Result<Connection> {
    static MIGRATIONS: OnceLock<Vec<String>> = OnceLock::new();
    let migrations = MIGRATIONS.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(
            env!("OUT_DIR"),
            "/profile-migrations.json"
        )))
        .expect("bundled SQLite schema")
    });
    let mut db = Connection::open(root.join("aniverse.db"))?;
    db.busy_timeout(Duration::from_secs(3))?;
    let current: u32 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current as usize == migrations.len() {
        return Ok(db);
    }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: u32 = tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version as usize > migrations.len() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    for (index, sql) in migrations.iter().enumerate().skip(version as usize) {
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", index as u32 + 1)?;
    }
    tx.commit()?;
    Ok(db)
}

fn episode(input: &Value) -> Result<i64, RpcError> {
    input["episode"]
        .as_i64()
        .filter(|number| (1..=9999).contains(number))
        .ok_or_else(invalid)
}

fn snapshot_id(media: &Value) -> Result<i64, RpcError> {
    media["id"]
        .as_i64()
        .filter(|id| (1..=i32::MAX as i64).contains(id))
        .ok_or_else(invalid)
}

fn writable_title(db: &Connection, id: i64) -> Result<i64, RpcError> {
    if is_private(Some(db), id).map_err(error)? {
        return Err(RpcError::new(
            "unauthorised",
            "Saved state is unavailable for a private title.",
        ));
    }
    Ok(id)
}

pub(super) fn snapshot(db: &Connection, input: &Value, now: i64) -> Result<i64, RpcError> {
    let media = &input["media"];
    let id = writable_title(db, snapshot_id(media)?)?;
    let title = media["title"]
        .as_str()
        .filter(|title| !title.trim().is_empty() && title.len() <= 500)
        .ok_or_else(invalid)?;
    let field = |key: &str| media[key].as_str().filter(|value| value.len() <= 2048);
    let value = json!({"id":id, "idMal":media["idMal"].as_u64(), "title":title,
        "cover":field("cover").unwrap_or_default(), "banner":field("banner"),
        "format":field("format"), "episodes":media["episodes"].as_u64().filter(|count| (1..=9999).contains(count))});
    db.execute(
        "INSERT INTO media_snapshot(id,data,updated_at) VALUES(?1,?2,?3)
        ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
        params![id, value.to_string(), now],
    )
    .map_err(error)?;
    Ok(id)
}

fn dismiss(db: &Connection, id: i64, now: i64) -> rusqlite::Result<()> {
    let mut dismissed = kv(Some(db), "continue-dismissed")?
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    dismissed[id.to_string()] = json!(now);
    set_kv(db, "continue-dismissed", dismissed)
}

fn set_kv(db: &Connection, key: &str, value: Value) -> rusqlite::Result<()> {
    db.execute("INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key,value.to_string()])?;
    Ok(())
}

fn error(_: rusqlite::Error) -> RpcError {
    RpcError::new("internal", "AniVerse2 could not save the current profile.")
}
