use super::{blocking, set, write};
use crate::{
    metadata,
    profile::{invalid, kv, media_at, metadata_preferences, open, read_error, rows},
    RpcError,
};
use chrono::{Days, Local, NaiveDate, TimeZone, Utc};
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, Manager};

const KEY: &str = "planner:v1";

struct Entry {
    id: i32,
    media: Value,
    next: i64,
}

struct Candidate {
    entry: Entry,
    available: i64,
    minutes: i64,
    estimated: bool,
}

fn build(mut candidates: Vec<Candidate>, budget: i64, start: NaiveDate) -> Value {
    let mut cursor = 0;
    let days = (0..7)
        .map(|day| {
            let date = start
                .checked_add_days(Days::new(day))
                .unwrap_or(start)
                .format("%Y-%m-%d")
                .to_string();
            let mut items = Vec::new();
            let mut minutes = 0;
            while !candidates.is_empty() {
                let mut next = None;
                for _ in 0..candidates.len() {
                    let index = cursor;
                    cursor = (cursor + 1) % candidates.len();
                    let candidate = &candidates[index];
                    if candidate.entry.next <= candidate.available
                        && minutes + candidate.minutes <= budget
                    {
                        next = Some(index);
                        break;
                    }
                }
                let Some(index) = next else { break };
                let candidate = &mut candidates[index];
                items.push(
                    json!({"media":candidate.entry.media, "episode":candidate.entry.next,
                "minutes":candidate.minutes, "estimated":candidate.estimated}),
                );
                minutes += candidate.minutes;
                candidate.entry.next += 1;
            }
            json!({"date":date,"minutes":minutes,"items":items})
        })
        .collect::<Vec<_>>();
    let unscheduled = candidates
        .iter()
        .map(|candidate| (candidate.available - candidate.entry.next + 1).max(0))
        .sum::<i64>();
    json!({"budget":budget,"days":days,"unscheduled":unscheduled})
}

fn candidate(entry: Entry, details: &Value, now: i64) -> Option<Candidate> {
    let status = details["status"].as_str()?;
    let airing = details["nextAiring"]["episode"]
        .as_i64()
        .filter(|episode| (1..=9999).contains(episode));
    let upcoming = details["nextAiring"]["airingAt"]
        .as_i64()
        .is_some_and(|at| at > now);
    let day = &details["startDate"];
    let start = (|| {
        let year = i32::try_from(day["year"].as_i64()?).ok()?;
        let month = u32::try_from(day["month"].as_u64()?).ok()?;
        let date = u32::try_from(day["day"].as_u64()?).ok()?;
        let midnight = NaiveDate::from_ymd_opt(year, month, date)?.and_hms_opt(0, 0, 0)?;
        Some(Local.from_local_datetime(&midnight).earliest()?.timestamp())
    })();
    if (airing == Some(1) && upcoming)
        || start.is_some_and(|start| start > now)
        || (status == "NOT_YET_RELEASED"
            && !start.is_some_and(|start| start.saturating_add(86_400) < now))
        || (status == "RELEASING" && details["format"] == "MOVIE")
    {
        return None;
    }
    let fallback = entry.next - 1;
    let available = if status == "FINISHED" {
        details["episodes"]
            .as_i64()
            .filter(|number| (0..=9999).contains(number))
            .unwrap_or(fallback)
    } else {
        airing.map_or(fallback, |airing| airing - 1)
    };
    let duration = details["duration"]
        .as_i64()
        .filter(|minutes| (1..=9999).contains(minutes));
    Some(Candidate {
        entry,
        available,
        minutes: duration.unwrap_or(24),
        estimated: duration.is_none(),
    })
}

pub(super) async fn request(
    app: &AppHandle,
    root: &Path,
    method: &str,
    input: &Value,
) -> Result<Value, RpcError> {
    if method == "planner.get" {
        let root = root.to_owned();
        return blocking(move || {
            Ok(kv(open(&root).map_err(read_error)?.as_ref(), KEY)
                .map_err(read_error)?
                .unwrap_or_default())
        })
        .await;
    }
    if method != "planner.build" {
        return Err(invalid());
    }
    let budget = input["budget"]
        .as_i64()
        .filter(|budget| (5..=360).contains(budget))
        .ok_or_else(invalid)?;
    let requested = input["startDate"]
        .as_str()
        .filter(|date| date.len() == 10)
        .ok_or_else(invalid)?;
    let start = NaiveDate::parse_from_str(requested, "%Y-%m-%d")
        .ok()
        .filter(|date| date.format("%Y-%m-%d").to_string() == requested)
        .filter(|date| {
            date.checked_add_days(Days::new(6))
                .is_some_and(|last| last.format("%Y-%m-%d").to_string().len() == 10)
        })
        .ok_or_else(|| RpcError::new("invalid-input", "Choose a valid planner start date."))?;
    let root = root.to_owned();
    let (entries, adult) = blocking({
        let root = root.clone();
        move || {
            let db = open(&root).map_err(read_error)?;
            let entries = rows(db.as_ref(), "SELECT l.media_id,m.data,l.progress FROM library l
                LEFT JOIN media_snapshot m ON m.id=l.media_id
                WHERE l.status IN('CURRENT','PLANNING','REPEATING') AND l.media_id BETWEEN 1 AND 2147483647
                AND NOT EXISTS(SELECT 1 FROM private_titles WHERE media_id=l.media_id)
                ORDER BY l.updated_at DESC LIMIT 20", [], |row| {
                Ok(Entry { id:row.get(0)?, media:media_at(row,0,1)?, next:row.get::<_,i64>(2)?.clamp(0,9999)+1 })
            }).map_err(read_error)?;
            Ok((entries, metadata_preferences(&root, false)?.0))
        }
    }).await?;
    let now = Utc::now().timestamp();
    let handles = entries
        .into_iter()
        .map(|entry| {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let details = app
                    .state::<metadata::Client>()
                    .get(metadata::Request::Details(entry.id), adult, Vec::new())
                    .await
                    .ok()?;
                candidate(entry, &details, now)
            })
        })
        .collect::<Vec<_>>();
    let mut candidates = Vec::new();
    for handle in handles {
        if let Ok(Some(candidate)) = handle.await {
            candidates.push(candidate);
        }
    }
    let plan = build(candidates, budget, start);
    blocking(move || {
        write(&root, |db| {
            set(db, KEY, &plan)?;
            Ok(plan)
        })
    })
    .await
}

#[cfg(test)]
#[path = "../../../../../test/tauri-compat/workspace-planner.rs"]
mod tests;
