use super::{blocking, pick, positive, set, unix_millis, write, Selection, State};
use crate::{
    local_player,
    profile::{invalid, kv, media_at, open, read_error, rows, writes},
    RpcError,
};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};
use tauri::Webview;

const KEY: &str = "collection:roots";
const MAX_FILES: usize = 2000;
const FILES: &str = "SELECT l.id,l.name,l.bytes,l.query,l.episode,l.media_id,m.data,l.missing FROM local_media l
    LEFT JOIN media_snapshot m ON m.id=l.media_id AND NOT EXISTS(SELECT 1 FROM private_titles WHERE media_id=l.media_id)";

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let media = if row.get::<_, Option<String>>(6)?.is_some() {
        media_at(row, 5, 6)?
    } else {
        Value::Null
    };
    Ok(
        json!({"id":row.get::<_, i64>(0)?,"name":row.get::<_, String>(1)?,"bytes":row.get::<_, i64>(2)?,
        "query":row.get::<_, String>(3)?,"episode":row.get::<_, Option<i64>>(4)?,
        "media":media,"missing":row.get::<_, bool>(7)?}),
    )
}

fn list(db: Option<&Connection>) -> Result<Vec<Value>, RpcError> {
    rows(
        db,
        &format!("{FILES} ORDER BY l.missing ASC,l.name COLLATE NOCASE LIMIT 2000"),
        [],
        row,
    )
    .map_err(read_error)
}

fn roots(db: Option<&Connection>) -> Result<Vec<PathBuf>, RpcError> {
    let mut known = kv(db, KEY)
        .map_err(read_error)?
        .and_then(|value| serde_json::from_value::<Vec<PathBuf>>(value).ok())
        .unwrap_or_default();
    known.retain(|path| path.is_absolute());
    keep_recent_roots(&mut known);
    Ok(known)
}

fn keep_recent_roots(known: &mut Vec<PathBuf>) {
    known.drain(..known.len().saturating_sub(10));
}

fn missing() -> RpcError {
    RpcError::new(
        "not-found",
        "The local video moved or is unavailable inside the folders you selected. Scan again.",
    )
}

fn file_path(path: &Path) -> &str {
    let text = path.to_str().unwrap_or_default();
    text.strip_prefix(r"\\?\").unwrap_or(text)
}

fn storage_path(path: &Path) -> String {
    if let Some(rest) = path
        .to_str()
        .and_then(|value| value.strip_prefix(r"\\?\UNC\"))
    {
        format!(r"\\{rest}")
    } else {
        file_path(path).to_owned()
    }
}

fn known_directory(path: &Path) -> Option<PathBuf> {
    let directory = path.canonicalize().ok()?;
    // Roots are canonical when selected. A replacement junction must not silently
    // turn a persisted selection into permission to scan a different directory.
    let stored = storage_path(path);
    let current = storage_path(&directory);
    (directory.is_dir() && stored.eq_ignore_ascii_case(&current)).then_some(directory)
}

fn local_path(known: &Path, candidate: &Path) -> bool {
    candidate != known && candidate.starts_with(known)
}

fn media_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            ["mp4", "m4v", "mkv", "webm", "mov"]
                .iter()
                .any(|kind| extension.eq_ignore_ascii_case(kind))
        })
}

#[cfg(windows)]
fn reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn filename(name: &str) -> (String, Option<i64>) {
    static BRACKETS: OnceLock<Regex> = OnceLock::new();
    static SEASON: OnceLock<Regex> = OnceLock::new();
    static PLAIN: OnceLock<Regex> = OnceLock::new();
    static TECH: OnceLock<Regex> = OnceLock::new();
    let bare = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    let brackets = BRACKETS.get_or_init(|| Regex::new(r"\[[^\]]*\]").unwrap());
    let stem = brackets.replace_all(bare, " ").replace(['.', '_'], " ");
    let numbered = SEASON
        .get_or_init(|| Regex::new(r"(?i-u:\bS([0-9]{1,2})E([0-9]{1,4})\b)").unwrap())
        .captures(&stem);
    let plain = PLAIN.get_or_init(|| {
        Regex::new(r"(?i)\s+-\s+([0-9]{1,4})(?:\s|$)|(?-u:\b)(?:episode|ep)\s*([0-9]{1,4})(?-u:\b)")
            .unwrap()
    });
    let fallback = numbered.is_none().then(|| plain.captures(&stem)).flatten();
    let matched = numbered.as_ref().or(fallback.as_ref());
    let prefix = matched
        .and_then(|parts| parts.get(0))
        .map_or(stem.as_str(), |found| &stem[..found.start()]);
    let tech = TECH.get_or_init(|| Regex::new(r"(?i)(?-u:\b)(?:[0-9]{3,4}p|x26[45]|h\s*26[45]|HEVC|WEB\s*DL|BluRay|AAC|FLAC)(?-u:\b).*$").unwrap());
    let mut query = tech
        .replace(prefix, "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let parse = |group: Option<regex::Match<'_>>| {
        group.and_then(|value| value.as_str().parse::<i64>().ok())
    };
    if let Some(season) = numbered
        .as_ref()
        .and_then(|parts| parse(parts.get(1)))
        .filter(|season| *season > 1)
    {
        query.push_str(&format!(" Season {season}"));
    }
    let episode = matched.and_then(|parts| {
        parse(if numbered.is_some() {
            parts.get(2)
        } else {
            parts.get(1).or_else(|| parts.get(2))
        })
    });
    (
        if query.is_empty() {
            bare.to_owned()
        } else {
            query
        },
        episode,
    )
}

struct Video {
    path: String,
    name: String,
    bytes: i64,
}

struct Batch {
    files: Vec<Video>,
    complete: bool,
    skipped: usize,
}

fn inspect(root: &Path, limit: usize) -> Batch {
    let mut batch = Batch {
        files: Vec::new(),
        complete: true,
        skipped: 0,
    };
    let mut pending = VecDeque::from([(root.to_owned(), 0)]);
    let mut count = 0;
    'scan: while let Some((folder, depth)) = pending.pop_front() {
        let Some(actual) = folder
            .canonicalize()
            .ok()
            .filter(|actual| actual == root || local_path(root, actual))
        else {
            batch.skipped += 1;
            batch.complete = false;
            continue;
        };
        let Ok(entries) = fs::read_dir(actual) else {
            batch.skipped += 1;
            batch.complete = false;
            continue;
        };
        for entry in entries {
            count += 1;
            if batch.files.len() >= limit || count > 40_000 {
                batch.skipped += pending.len() + 1;
                batch.complete = false;
                break 'scan;
            }
            let Ok(entry) = entry else {
                batch.skipped += 1;
                batch.complete = false;
                continue;
            };
            let Ok(info) = entry.metadata() else {
                batch.skipped += 1;
                batch.complete = false;
                continue;
            };
            if reparse(&info) {
                continue;
            }
            let path = entry.path();
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                batch.skipped += 1;
                continue;
            };
            if info.is_dir() && depth < 6 && !name.starts_with('.') {
                if pending.len() >= 4096 {
                    batch.complete = false;
                    batch.skipped += 1;
                } else {
                    pending.push_back((path, depth + 1));
                }
            } else if info.is_file() && media_path(&path) {
                let Ok(bytes) = i64::try_from(info.len()) else {
                    batch.skipped += 1;
                    continue;
                };
                batch.files.push(Video {
                    path: storage_path(&path),
                    name: name.to_owned(),
                    bytes,
                });
            }
        }
    }
    batch
}

fn scan(
    root: &Path,
    mut known: Vec<PathBuf>,
    selected: Option<PathBuf>,
) -> Result<Value, RpcError> {
    if let Some(selected) = selected {
        let selected = selected
            .canonicalize()
            .ok()
            .filter(|path| path.is_dir())
            .ok_or_else(missing)?;
        known.retain(|current| current.canonicalize().ok().as_ref() != Some(&selected));
        known.push(PathBuf::from(storage_path(&selected)));
        keep_recent_roots(&mut known);
        write(root, |db| set(db, KEY, &json!(known)))?;
    }
    let mut remaining = MAX_FILES;
    let mut skipped = 0;
    for directory in known {
        let directory = match known_directory(&directory) {
            Some(path) => path,
            None => {
                skipped += 1;
                continue;
            }
        };
        let batch = inspect(&directory, remaining);
        remaining -= batch.files.len();
        skipped += batch.skipped;
        write(root, |db| {
            let paths = if batch.complete {
                rows(Some(db), "SELECT id,path FROM local_media", [], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(read_error)?
            } else {
                Vec::new()
            };
            let mut seen = HashSet::new();
            for file in batch.files {
                let (query, episode) = filename(&file.name);
                db.execute("INSERT INTO local_media(path,name,bytes,query,episode,missing)
                    VALUES(?1,?2,?3,?4,?5,0) ON CONFLICT(path) DO UPDATE SET bytes=excluded.bytes,missing=0",
                    params![file.path,file.name,file.bytes,query,episode]).map_err(read_error)?;
                seen.insert(file.path);
            }
            let directory = PathBuf::from(storage_path(&directory));
            for (id, path) in paths {
                if !seen.contains(&path) && local_path(&directory, Path::new(&path)) {
                    db.execute("UPDATE local_media SET missing=1 WHERE id=?1", [id])
                        .map_err(read_error)?;
                }
            }
            Ok(())
        })?;
    }
    Ok(json!({"files":list(open(root).map_err(read_error)?.as_ref())?, "skipped":skipped}))
}

fn matched(db: &Connection, input: &Value) -> Result<Value, RpcError> {
    let id = positive(&input["id"])?;
    let episode = positive(&input["episode"])?;
    let media = writes::snapshot(db, input, unix_millis() / 1000)?;
    let changed = db
        .execute(
            "UPDATE local_media SET media_id=?1,episode=?2 WHERE id=?3",
            params![media, episode, id],
        )
        .map_err(read_error)?;
    if changed == 0 {
        return Err(missing());
    }
    db.query_row(&format!("{FILES} WHERE l.id=?1"), [id], row)
        .map_err(read_error)
}

fn opened(root: &Path, id: i64) -> Result<(PathBuf, Vec<PathBuf>, Value), RpcError> {
    let db = open(root).map_err(read_error)?.ok_or_else(missing)?;
    let path: String = db
        .query_row("SELECT path FROM local_media WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(read_error)?
        .ok_or_else(missing)?;
    let file = db
        .query_row(&format!("{FILES} WHERE l.id=?1"), [id], row)
        .map_err(read_error)?;
    let allowed = roots(Some(&db))?
        .into_iter()
        .filter_map(|path| known_directory(&path))
        .collect();
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(missing());
    }
    Ok((path, allowed, file))
}

pub(super) async fn request(
    window: &Webview,
    root: &Path,
    state: &State,
    local: &local_player::Service,
    method: &str,
    input: Value,
) -> Result<Value, RpcError> {
    let root = root.to_owned();
    match method {
        "collection.list" => {
            blocking(move || Ok(json!(list(open(&root).map_err(read_error)?.as_ref())?))).await
        }
        "collection.scan" => {
            let _scan = state
                .scan
                .try_lock()
                .map_err(|_| RpcError::new("invalid-input", "A folder scan is already running."))?;
            let choose = input["choose"].as_bool().ok_or_else(invalid)?;
            let known = blocking({
                let root = root.clone();
                move || roots(open(&root).map_err(read_error)?.as_ref())
            })
            .await?;
            let selected = if choose || known.is_empty() {
                let selected = pick(
                    window,
                    state,
                    "Choose your local video folder",
                    Selection::Folder,
                )
                .await?;
                if selected.is_none() {
                    return blocking(move || Ok(json!({"files":list(open(&root).map_err(read_error)?.as_ref())?,"skipped":0}))).await;
                }
                selected
            } else {
                None
            };
            blocking(move || scan(&root, known, selected)).await
        }
        "collection.match" => blocking(move || write(&root, |db| matched(db, &input))).await,
        "collection.remove" => {
            blocking(move || {
                write(&root, |db| {
                    db.execute(
                        "DELETE FROM local_media WHERE id=?1",
                        [positive(&input["id"])?],
                    )
                    .map_err(read_error)?;
                    Ok(Value::Null)
                })
            })
            .await
        }
        "collection.open" => {
            let id = positive(&input["id"])?;
            let generation = local.reserve_grant();
            let (path, roots, file) = blocking(move || opened(&root, id)).await?;
            let grant = local.grant_collection_file(generation, path, roots).await?;
            Ok(
                json!({"url":grant["url"],"name":file["name"],"media":file["media"],"episode":file["episode"]}),
            )
        }
        _ => Err(invalid()),
    }
}

#[cfg(test)]
#[path = "../../../../../test/tauri-compat/workspace-collection.rs"]
mod tests;
