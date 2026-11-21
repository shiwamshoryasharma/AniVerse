use super::{
    reconcile::{reconcile, Entry, Target, Timed},
    remote, Remote, Report, Session,
};
use crate::{
    integrations::{network, positive_id, storage},
    profile, RpcError,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::{collections::BTreeSet, path::Path};

pub(super) fn merge(
    root: &Path,
    active: &[(Session, Option<Remote>)],
    report: &mut Report,
) -> Result<(), RpcError> {
    let Some((session, _)) = active.iter().find(|(_, remote)| remote.is_some()) else {
        return Ok(());
    };
    super::privacy(session.privacy_epoch)?;
    let mut db = profile::writable(root).map_err(storage)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage)?;
    let mut ids = ids_from(
        &tx,
        "SELECT media_id FROM library UNION SELECT media_id FROM library_tombstones",
    )?;
    let private = ids_from(&tx, "SELECT media_id FROM private_titles")?;
    for (_, remote) in active {
        if let Some(remote) = remote {
            ids.extend(remote.entries.keys().copied());
        }
    }
    for id in ids {
        if private.contains(&id) {
            continue;
        }
        let current = local(&tx, id)?;
        let snapshot = snapshot(&tx, id)?.or_else(|| {
            active.iter().find_map(|(_, remote)| {
                remote
                    .as_ref()?
                    .entries
                    .get(&id)
                    .map(|item| item.media.clone())
            })
        });
        let Some(snapshot) = snapshot else {
            continue;
        };
        let mal = positive_id(&snapshot["idMal"]);
        let targets: Vec<_> = active
            .iter()
            .filter_map(|(session, remote)| {
                let remote = remote.as_ref()?;
                if session.provider == "mal" && mal.is_none_or(|id| remote.unmapped.contains(&id)) {
                    return None;
                }
                Some(Target {
                    provider: session.provider,
                    last_sync: session.last_sync,
                    entry: remote.entries.get(&id).map(|remote| Timed {
                        entry: Some(&remote.entry),
                        at: remote.updated,
                    }),
                })
            })
            .collect();
        let plan = reconcile(
            Timed {
                entry: current.0.as_ref(),
                at: current.1,
            },
            &targets,
        );
        if let Some((entry, updated)) = plan.apply {
            let mut changed_both = false;
            for target in &targets {
                changed_both |= queued(&tx, target.provider, id)?;
            }
            if changed_both {
                report.resolved += 1;
            }
            save_snapshot(&tx, id, &snapshot)?;
            tx.execute("INSERT INTO library(media_id,status,progress,score,updated_at) VALUES(?1,?2,?3,?4,?5)
                ON CONFLICT(media_id) DO UPDATE SET status=excluded.status,progress=excluded.progress,
                score=excluded.score,updated_at=excluded.updated_at", params![id,entry.status,entry.progress,entry.score,updated]).map_err(storage)?;
            tx.execute("DELETE FROM library_tombstones WHERE media_id=?1", [id])
                .map_err(storage)?;
            report.pulled += 1;
        }
        if let Some(index) = plan.winner {
            drop_entry(&tx, targets[index].provider, id, false)?;
        }
        for index in plan.push {
            enqueue(&tx, targets[index].provider, id, mal)?;
        }
    }
    for (session, data) in active {
        if session.provider != "anilist" {
            continue;
        }
        for media in data
            .as_ref()
            .into_iter()
            .flat_map(|data| data.favourites.iter())
        {
            let Some(id) = positive_id(&media["id"]).filter(|id| !private.contains(id)) else {
                continue;
            };
            let pending = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sync_queue WHERE dedupe_key=?1)",
                    [format!("anilist:favourite:{id}")],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(storage)?;
            if pending {
                continue;
            }
            if tx
                .execute(
                    "INSERT OR IGNORE INTO favourites(media_id,added_at) VALUES(?1,?2)",
                    params![id, now()],
                )
                .map_err(storage)?
                > 0
            {
                save_snapshot(&tx, id, media)?;
                report.pulled += 1;
            }
        }
    }
    super::privacy(session.privacy_epoch)?;
    tx.commit().map_err(storage)?;
    Ok(())
}

fn ids_from(db: &Connection, query: &str) -> Result<BTreeSet<i32>, RpcError> {
    let mut statement = db.prepare(query).map_err(storage)?;
    let rows = statement
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(storage)?;
    let mut ids = BTreeSet::new();
    for row in rows {
        if let Ok(id) = i32::try_from(row.map_err(storage)?) {
            if id > 0 {
                ids.insert(id);
            }
        }
        if ids.len() > 100_000 {
            return Err(network());
        }
    }
    Ok(ids)
}

fn local(db: &Connection, id: i32) -> Result<(Option<Entry>, i64), RpcError> {
    let row = db
        .query_row(
            "SELECT status,progress,score,updated_at FROM library WHERE media_id=?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i32>(1)?,
                    row.get::<_, Option<f64>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(storage)?;
    if let Some((status, progress, score, updated)) = row {
        return Ok((
            Some(remote::entry(
                Some(&status),
                &json!(progress),
                &json!(score),
            )?),
            updated,
        ));
    }
    let tombstone = db
        .query_row(
            "SELECT deleted_at FROM library_tombstones WHERE media_id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage)?
        .unwrap_or_default();
    Ok((None, tombstone))
}

fn snapshot(db: &Connection, id: i32) -> Result<Option<Value>, RpcError> {
    let data = db
        .query_row("SELECT data FROM media_snapshot WHERE id=?1", [id], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(storage)?;
    data.map(|data| serde_json::from_str(&data).map_err(|_| network()))
        .transpose()
}

fn save_snapshot(db: &Connection, id: i32, media: &Value) -> Result<(), RpcError> {
    db.execute(
        "INSERT OR IGNORE INTO media_snapshot(id,data,updated_at) VALUES(?1,?2,?3)",
        params![id, media.to_string(), now()],
    )
    .map_err(storage)?;
    Ok(())
}

fn keys(provider: &str, id: i32) -> [String; 4] {
    ["entry", "progress", "status", "remove"].map(|op| format!("{provider}:{op}:{id}"))
}

fn queued(db: &Connection, provider: &str, id: i32) -> Result<bool, RpcError> {
    let key = keys(provider, id);
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_queue WHERE dedupe_key IN (?1,?2,?3,?4))",
        params![key[0], key[1], key[2], key[3]],
        |row| row.get(0),
    )
    .map_err(storage)
}

fn drop_entry(db: &Connection, provider: &str, id: i32, legacy_only: bool) -> Result<(), RpcError> {
    let key = keys(provider, id);
    let first = if legacy_only { "" } else { &key[0] };
    db.execute(
        "DELETE FROM sync_queue WHERE dedupe_key IN (?1,?2,?3,?4)",
        params![first, key[1], key[2], key[3]],
    )
    .map_err(storage)?;
    Ok(())
}

fn enqueue(db: &Connection, provider: &str, id: i32, mal: Option<i32>) -> Result<(), RpcError> {
    drop_entry(db, provider, id, true)?;
    let key = format!("{provider}:entry:{id}");
    let data = json!({"mediaId":id,"idMal":mal}).to_string();
    db.execute("INSERT INTO sync_queue(provider,op,dedupe_key,payload,attempts,last_error,created_at,next_at)
        VALUES(?1,'entry',?2,?3,0,NULL,?4,?4)
        ON CONFLICT(dedupe_key) DO UPDATE SET payload=excluded.payload",
        params![provider,key,data,now()]).map_err(storage)?;
    Ok(())
}

pub(super) fn queue_library(
    db: &Connection,
    id: i64,
    favourite: Option<bool>,
) -> Result<bool, RpcError> {
    let id = i32::try_from(id)
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(network)?;
    if crate::runtime_privacy::active()
        || db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM private_titles WHERE media_id=?1)",
                [id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(storage)?
        || !db
            .query_row("SELECT EXISTS(SELECT 1 FROM accounts)", [], |row| {
                row.get::<_, bool>(0)
            })
            .map_err(storage)?
        || crate::integrations::kv_in(db, "settings")?["accounts"]["autoSync"] == false
    {
        return Ok(false);
    }
    let mal = snapshot(db, id)?.and_then(|snapshot| positive_id(&snapshot["idMal"]));
    let op = if favourite.is_some() {
        "favourite"
    } else {
        "entry"
    };
    let mut payload = json!({"mediaId":id,"idMal":mal});
    if let Some(favourite) = favourite {
        payload["favourite"] = json!(favourite);
    }
    let payload = payload.to_string();
    let mut queued = false;
    for provider in ["anilist", "mal"] {
        if (provider == "mal" && (favourite.is_some() || mal.is_none()))
            || !super::read(Some(db), provider)?.is_object()
        {
            continue;
        }
        if favourite.is_none() {
            drop_entry(db, provider, id, true)?;
        }
        let key = format!("{provider}:{op}:{id}");
        db.execute("INSERT INTO sync_queue(provider,op,dedupe_key,payload,attempts,last_error,created_at,next_at)
            VALUES(?1,?2,?3,?4,0,NULL,?5,?5)
            ON CONFLICT(dedupe_key) DO UPDATE SET payload=excluded.payload,attempts=0,last_error=NULL,next_at=excluded.next_at",
            params![provider,op,key,payload,now()]).map_err(storage)?;
        queued = true;
    }
    Ok(queued)
}

pub(super) fn has_due(db: Option<&Connection>, provider: &str) -> Result<bool, RpcError> {
    let Some(db) = db else {
        return Ok(false);
    };
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_queue WHERE provider=?1 AND next_at<=?2)",
        params![provider, now()],
        |row| row.get(0),
    )
    .map_err(storage)
}

pub(super) struct Job {
    id: i64,
    op: String,
    payload: String,
    attempts: u32,
    next: i64,
}

pub(super) fn jobs(root: &Path, provider: &str) -> Result<Vec<Job>, RpcError> {
    let db = profile::writable(root).map_err(storage)?;
    let mut query = db
        .prepare(
            "SELECT id,op,payload,attempts,next_at FROM sync_queue
        WHERE provider=?1 AND next_at<=?2 AND length(payload)<=8192 ORDER BY id LIMIT 250",
        )
        .map_err(storage)?;
    let rows = query
        .query_map(params![provider, now()], |r| {
            Ok(Job {
                id: r.get(0)?,
                op: r.get(1)?,
                payload: r.get(2)?,
                attempts: r.get(3)?,
                next: r.get(4)?,
            })
        })
        .map_err(storage)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage)
}

pub(super) type Action = (i32, Option<i32>, Option<Entry>, Option<bool>);

pub(super) fn current(root: &Path, job: &Job) -> Result<Option<Action>, RpcError> {
    let db = profile::writable(root).map_err(storage)?;
    let data: Value = serde_json::from_str(&job.payload).map_err(|_| network())?;
    let id = positive_id(&data["mediaId"]).ok_or_else(network)?;
    let private = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM private_titles WHERE media_id=?1)",
            [id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(storage)?;
    if private {
        return Ok(None);
    }
    let mal = snapshot(&db, id)?
        .and_then(|media| positive_id(&media["idMal"]))
        .or_else(|| positive_id(&data["idMal"]));
    let favourite = if job.op == "favourite" {
        Some(
            db.query_row(
                "SELECT EXISTS(SELECT 1 FROM favourites WHERE media_id=?1)",
                [id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(storage)?,
        )
    } else if matches!(job.op.as_str(), "entry" | "progress" | "status" | "remove") {
        None
    } else {
        return Err(network());
    };
    Ok(Some((id, mal, local(&db, id)?.0, favourite)))
}

pub(super) fn completed(root: &Path, job: &Job, error: Option<&str>) -> Result<(), RpcError> {
    let db = profile::writable(root).map_err(storage)?;
    if let Some(error) = error {
        let backoff = (30_i64 << job.attempts.min(7)).min(3600);
        db.execute(
            "UPDATE sync_queue SET attempts=?2,last_error=?3,next_at=?4
            WHERE id=?1 AND payload=?5 AND next_at=?6",
            params![
                job.id,
                job.attempts.saturating_add(1),
                error,
                now() + backoff,
                job.payload,
                job.next
            ],
        )
        .map_err(storage)?;
    } else {
        db.execute(
            "DELETE FROM sync_queue WHERE id=?1 AND payload=?2 AND next_at=?3",
            params![job.id, job.payload, job.next],
        )
        .map_err(storage)?;
    }
    Ok(())
}

pub(super) fn sync_status(
    root: &Path,
    provider: &str,
    synced_at: Option<i64>,
    error: Option<&str>,
) -> Result<(), RpcError> {
    let mut db = profile::writable(root).map_err(storage)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage)?;
    let mut data = super::read(Some(&tx), provider)?;
    let message = json!(error);
    if data.is_object() && (data["lastError"] != message || synced_at.is_some()) {
        if let Some(synced_at) = synced_at {
            data["lastSyncAt"] = json!(synced_at);
        }
        data["lastError"] = message;
        tx.execute(
            "UPDATE accounts SET data=?2 WHERE provider=?1",
            params![provider, data.to_string()],
        )
        .map_err(storage)?;
    }
    tx.commit().map_err(storage)
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
