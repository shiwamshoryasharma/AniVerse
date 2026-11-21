use super::{number, positive, source, unix_millis, write};
use crate::profile::{invalid, is_private, kv, media_at, open, read_error, rows, writes};
use crate::RpcError;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Default)]
pub(super) struct Observer(Mutex<HashMap<String, Point>>);

struct Point {
    media: i64,
    episode: i64,
    position: f64,
    source: Option<String>,
    paused: bool,
    frames: Option<u64>,
    dropped: Option<u64>,
    at: Instant,
}

fn public(db: &Connection, media: i64) -> Result<(), RpcError> {
    if is_private(Some(db), media).map_err(read_error)? {
        return Err(RpcError::new(
            "invalid-input",
            "Saving is disabled for private titles.",
        ));
    }
    Ok(())
}

const BOOKMARKS: &str = "SELECT b.id,b.media_id,m.data,b.episode,b.position,b.duration,b.source_id,b.note,b.tags,b.created_at
    FROM scene_bookmarks b JOIN media_snapshot m ON m.id=b.media_id
    WHERE NOT EXISTS(SELECT 1 FROM private_titles p WHERE p.media_id=b.media_id)";

fn bookmark(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let tags = serde_json::from_str::<Vec<String>>(&row.get::<_, String>(8)?).unwrap_or_default();
    Ok(
        json!({"id": row.get::<_, i64>(0)?, "media": media_at(row, 1, 2)?,
        "episode": row.get::<_, i64>(3)?, "position": row.get::<_, f64>(4)?,
        "duration": row.get::<_, f64>(5)?, "sourceId": row.get::<_, Option<String>>(6)?,
        "note": row.get::<_, String>(7)?, "tags": tags, "createdAt": row.get::<_, i64>(9)?}),
    )
}

fn bookmarks(db: Option<&Connection>, input: &Value) -> Result<Value, RpcError> {
    let media = input.get("mediaId").map(positive).transpose()?;
    let query = input
        .get("search")
        .map(|query| {
            query
                .as_str()
                .filter(|value| value.encode_utf16().count() <= 200)
                .ok_or_else(invalid)
        })
        .transpose()?
        .unwrap_or_default();
    let query = format!("%{}%", query.trim().to_lowercase());
    let sql = format!(
        "{BOOKMARKS} AND (?1 IS NULL OR b.media_id=?1)
        AND (lower(b.note) LIKE ?2 OR lower(b.tags) LIKE ?2 OR lower(m.data) LIKE ?2)
        ORDER BY b.created_at DESC,b.id DESC LIMIT 500"
    );
    Ok(json!(
        rows(db, &sql, params![media, query], bookmark).map_err(read_error)?
    ))
}

fn save_bookmark(db: &Connection, input: &Value) -> Result<Value, RpcError> {
    let duration = number(&input["duration"], true)?;
    let position = number(&input["position"], false)?;
    let episode = positive(&input["episode"])?;
    let source = source(&input["sourceId"])?;
    let note = input["note"]
        .as_str()
        .filter(|text| text.encode_utf16().count() <= 1000)
        .ok_or_else(invalid)?
        .trim();
    let mut tags = Vec::new();
    for tag in input["tags"]
        .as_array()
        .filter(|tags| tags.len() <= 8)
        .ok_or_else(invalid)?
    {
        let tag = tag
            .as_str()
            .filter(|text| text.encode_utf16().count() <= 30)
            .ok_or_else(invalid)?
            .trim();
        if !tag.is_empty() && !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    let tags = json!(tags).to_string();
    let now = unix_millis();
    if position > duration {
        return Err(RpcError::new(
            "invalid-input",
            "Bookmark position is outside the episode.",
        ));
    }
    let media = writes::snapshot(db, input, now / 1000)?;
    let id = if let Some(id) = input.get("id") {
        let id = positive(id)?;
        let count = db
            .execute(
                "UPDATE scene_bookmarks SET note=?1,tags=?2,position=?3
            WHERE id=?4 AND media_id=?5 AND ?3<=duration",
                params![note, tags, position, id, media],
            )
            .map_err(read_error)?;
        if count == 0 {
            return Err(RpcError::new(
                "not-found",
                "Bookmark is unavailable at this position.",
            ));
        }
        id
    } else {
        db.execute("INSERT INTO scene_bookmarks(media_id,episode,position,duration,source_id,note,tags,created_at)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", params![media,episode,position,duration,source,note,tags,now]).map_err(read_error)?;
        db.last_insert_rowid()
    };
    db.query_row(&format!("{BOOKMARKS} AND b.id=?1"), [id], bookmark)
        .map_err(read_error)
}

fn kind(input: &Value) -> Result<&str, RpcError> {
    input["kind"]
        .as_str()
        .filter(|kind| matches!(*kind, "intro" | "outro"))
        .ok_or_else(invalid)
}

fn skips(db: Option<&Connection>, media: i64) -> Result<Value, RpcError> {
    if is_private(db, media).map_err(read_error)? {
        return Ok(json!([]));
    }
    let values = rows(db, "SELECT kind,start,end,enabled,source_id,duration FROM skip_ranges WHERE media_id=?1 ORDER BY start", [media], |row| {
        Ok(json!({"mediaId":media,"kind":row.get::<_, String>(0)?,
            "start":row.get::<_, f64>(1)?,"end":row.get::<_, f64>(2)?,
            "enabled":row.get::<_, bool>(3)?,"sourceId":row.get::<_, Option<String>>(4)?,
            "duration":row.get::<_, f64>(5)?}))
    }).map_err(read_error)?;
    Ok(json!(values))
}

fn save_skip(db: &Connection, input: &Value) -> Result<Value, RpcError> {
    let media = positive(&input["mediaId"])?;
    public(db, media)?;
    let start = number(&input["start"], false)?;
    let end = number(&input["end"], true)?;
    let duration = number(&input["duration"], true)?;
    if start >= end || end > duration {
        return Err(RpcError::new(
            "invalid-input",
            "The range must end after it starts and stay inside the episode.",
        ));
    }
    let enabled = input["enabled"].as_bool().ok_or_else(invalid)?;
    db.execute("INSERT INTO skip_ranges(media_id,kind,start,end,enabled,source_id,duration) VALUES(?1,?2,?3,?4,?5,?6,?7)
        ON CONFLICT(media_id,kind) DO UPDATE SET start=excluded.start,end=excluded.end,enabled=excluded.enabled,source_id=excluded.source_id,duration=excluded.duration",
        params![media,kind(input)?,start,end,enabled,source(&input["sourceId"])?,duration]).map_err(read_error)?;
    skips(Some(db), media)
}

impl Observer {
    pub(super) fn reset(&self) {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }

    fn record(&self, root: &Path, input: &Value) -> Result<Value, RpcError> {
        let session = input["sessionId"]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 100
                    && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
            .ok_or_else(invalid)?;
        let count = |field: &str| match input.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => value
                .as_u64()
                .filter(|count| *count <= 10_000_000_000)
                .map(Some)
                .ok_or_else(invalid),
        };
        let point = Point {
            media: positive(&input["mediaId"])?,
            episode: positive(&input["episode"])?,
            position: number(&input["position"], false)?,
            source: source(&input["sourceId"])?.map(str::to_owned),
            paused: input["paused"].as_bool().ok_or_else(invalid)?,
            frames: count("totalFrames")?,
            dropped: count("droppedFrames")?,
            at: Instant::now(),
        };
        if point.position > number(&input["duration"], true)? {
            return Err(invalid());
        }
        let mut previous = self.0.lock().map_err(read_error)?;
        let recorded = write(root, |db| {
            let settings = kv(Some(db), "settings")
                .map_err(read_error)?
                .unwrap_or_default();
            if settings["privacy"]["watchInsights"] != true
                || is_private(Some(db), point.media).map_err(read_error)?
            {
                return Ok(false);
            }
            let (seconds, frames, dropped) = previous
                .get(session)
                .and_then(|prior| point.delta(prior))
                .unwrap_or_default();
            let clock = unix_millis();
            let done = db.execute("INSERT INTO watch_sessions(id,media_id,episode,source_id,started_at,last_at,watched_seconds,total_frames,dropped_frames,samples)
                VALUES(?1,?2,?3,?4,?5,?5,?6,?7,?8,1)
                ON CONFLICT(id) DO UPDATE SET last_at=excluded.last_at,watched_seconds=watched_seconds+excluded.watched_seconds,
                    total_frames=total_frames+excluded.total_frames,dropped_frames=dropped_frames+excluded.dropped_frames,samples=samples+1
                WHERE media_id=excluded.media_id AND episode=excluded.episode AND source_id IS excluded.source_id",
                params![session,point.media,point.episode,point.source,clock,seconds,frames as i64,dropped as i64]).map_err(read_error)?;
            Ok(done > 0)
        })?;
        if recorded {
            if previous.len() >= 200 {
                previous.retain(|_, prior| {
                    point.at.saturating_duration_since(prior.at) < Duration::from_secs(60)
                });
            }
            if previous.len() < 500 || previous.contains_key(session) {
                previous.insert(session.to_owned(), point);
            }
        } else {
            previous.remove(session);
        }
        Ok(Value::Null)
    }

    fn clear(&self, root: &Path) -> Result<Value, RpcError> {
        let mut previous = self.0.lock().map_err(read_error)?;
        write(root, |db| {
            db.execute("DELETE FROM watch_sessions", [])
                .map_err(read_error)?;
            Ok(Value::Null)
        })?;
        previous.clear();
        Ok(Value::Null)
    }
}

impl Point {
    fn delta(&self, previous: &Self) -> Option<(f64, u64, u64)> {
        let elapsed = self.at.saturating_duration_since(previous.at).as_secs_f64();
        let traveled = self.position - previous.position;
        if self.media != previous.media
            || self.episode != previous.episode
            || self.source != previous.source
            || self.paused
            || previous.paused
            || elapsed <= 0.0
            || elapsed > 15.0
            || traveled <= 0.0
            || traveled > elapsed * 4.0 + 2.0
        {
            return None;
        }
        let changed = |after: Option<u64>, before: Option<u64>| {
            after
                .zip(before)
                .map_or(0, |(after, before)| after.saturating_sub(before))
        };
        let frames = changed(self.frames, previous.frames);
        Some((
            elapsed,
            frames,
            changed(self.dropped, previous.dropped).min(frames),
        ))
    }
}

fn insights(db: Option<&Connection>) -> Result<Value, RpcError> {
    let empty = json!({"watchedSeconds":0,"episodes":0,"daily":[],"sources":[],"titles":[]});
    let Some(db) = db else { return Ok(empty) };
    let visible = "WITH visible AS (SELECT * FROM watch_sessions w WHERE NOT EXISTS(SELECT 1 FROM private_titles p WHERE p.media_id=w.media_id)) ";
    let (seconds, episodes): (f64,i64) = db.query_row(&format!("{visible}SELECT COALESCE(sum(watched_seconds),0),
        (SELECT count(*) FROM (SELECT media_id,episode FROM visible GROUP BY media_id,episode HAVING sum(watched_seconds)>=60)) FROM visible"),
        [], |row| Ok((row.get(0)?,row.get(1)?))).map_err(read_error)?;
    let daily = rows(Some(db), &format!("{visible}SELECT date(started_at/1000,'unixepoch','localtime') date,
        sum(watched_seconds) FROM visible WHERE date IS NOT NULL GROUP BY date ORDER BY date DESC LIMIT 30"), [],
        |row| Ok(json!({"date":row.get::<_, String>(0)?,"seconds":row.get::<_, f64>(1)?}))).map_err(read_error)?;
    let sources = rows(Some(db), &format!("{visible}SELECT source_id,sum(watched_seconds),sum(samples),
        sum(total_frames),sum(dropped_frames) FROM visible GROUP BY source_id ORDER BY 2 DESC"), [],
        |row| {
            let frames = row.get::<_, i64>(3)?;
            let dropped = row.get::<_, i64>(4)?;
            Ok(json!({"sourceId":row.get::<_, Option<String>>(0)?,"seconds":row.get::<_, f64>(1)?,
                "samples":row.get::<_, i64>(2)?,"dropPercent":(frames>0).then(|| 100.0*dropped as f64/frames as f64)}))
        }).map_err(read_error)?;
    let titles = rows(Some(db), &format!("{visible}SELECT w.media_id,m.data,sum(w.watched_seconds)
        FROM visible w LEFT JOIN media_snapshot m ON m.id=w.media_id GROUP BY w.media_id ORDER BY 3 DESC LIMIT 12"), [],
        |row| Ok(json!({"title":media_at(row,0,1)?["title"],"seconds":row.get::<_, f64>(2)?}))).map_err(read_error)?;
    Ok(
        json!({"watchedSeconds":seconds,"episodes":episodes,"daily":daily,"sources":sources,"titles":titles}),
    )
}

pub(super) fn request(
    root: &Path,
    observer: &Observer,
    method: &str,
    input: &Value,
) -> Result<Value, RpcError> {
    match method {
        "toolkit.bookmarks" => bookmarks(open(root).map_err(read_error)?.as_ref(), input),
        "toolkit.skips" => skips(
            open(root).map_err(read_error)?.as_ref(),
            positive(&input["mediaId"])?,
        ),
        "toolkit.saveBookmark" => write(root, |db| save_bookmark(db, input)),
        "toolkit.saveSkip" => write(root, |db| save_skip(db, input)),
        "toolkit.deleteBookmark" => write(root, |db| {
            db.execute("DELETE FROM scene_bookmarks WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM private_titles WHERE media_id=scene_bookmarks.media_id)", [positive(&input["id"])?]).map_err(read_error)?;
            Ok(Value::Null)
        }),
        "toolkit.deleteSkip" => write(root, |db| {
            let media = positive(&input["mediaId"])?;
            public(db, media)?;
            db.execute(
                "DELETE FROM skip_ranges WHERE media_id=?1 AND kind=?2",
                params![media, kind(input)?],
            )
            .map_err(read_error)?;
            Ok(Value::Null)
        }),
        "toolkit.record" => observer.record(root, input),
        "toolkit.insights" => insights(open(root).map_err(read_error)?.as_ref()),
        "toolkit.clearInsights" => observer.clear(root),
        _ => Err(invalid()),
    }
}

#[cfg(test)]
#[path = "../../../../../test/tauri-compat/workspace-toolkit.rs"]
mod tests;
