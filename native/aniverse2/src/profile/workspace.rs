mod collection;
mod planner;
mod themes;
mod toolkit;

use super::{invalid, read_error, writes};
use crate::{local_player, metadata, RpcError};
use rusqlite::{params, Connection, TransactionBehavior};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, Webview};
use tauri_plugin_dialog::{DialogExt, FilePath};

#[derive(Default)]
pub(crate) struct State {
    observer: toolkit::Observer,
    scan: tokio::sync::Mutex<()>,
    dialog: tokio::sync::Mutex<()>,
}

impl State {
    pub(crate) fn reset_observation(&self) {
        self.observer.reset();
    }
}

pub(crate) fn handles(method: &str) -> bool {
    matches!(
        method.split_once('.').map(|(group, _)| group),
        Some("collection" | "planner" | "themes" | "toolkit")
    )
}

pub(crate) async fn request(
    window: &Webview,
    root: &Path,
    _metadata: &metadata::Client,
    local: &local_player::Service,
    method: &str,
    input: Value,
) -> Result<Value, RpcError> {
    let state = window.state::<State>();
    let root = root.to_path_buf();
    match method.split_once('.').map(|(group, _)| group) {
        Some("toolkit") => {
            let app = window.app_handle().clone();
            let method = method.to_owned();
            blocking(move || {
                toolkit::request(&root, &app.state::<State>().observer, &method, &input)
            })
            .await
        }
        Some("planner") => planner::request(window.app_handle(), &root, method, &input).await,
        Some("themes") => themes::request(window, &root, &state, method, input).await,
        Some("collection") => {
            collection::request(window, &root, &state, local, method, input).await
        }
        _ => Err(invalid()),
    }
}

async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, RpcError> + Send + 'static,
) -> Result<T, RpcError> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(read_error)?
}

fn write<T>(
    root: &Path,
    operation: impl FnOnce(&Connection) -> Result<T, RpcError>,
) -> Result<T, RpcError> {
    let mut db = writes::writable(root).map_err(read_error)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(read_error)?;
    let result = operation(&tx)?;
    tx.commit().map_err(read_error)?;
    Ok(result)
}

fn set(db: &Connection, key: &str, value: &Value) -> Result<(), RpcError> {
    db.execute("INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value.to_string()]).map_err(read_error)?;
    Ok(())
}

fn positive(input: &Value) -> Result<i64, RpcError> {
    input
        .as_i64()
        .filter(|id| (1..=i32::MAX as i64).contains(id))
        .ok_or_else(invalid)
}

fn source(input: &Value) -> Result<Option<&str>, RpcError> {
    if input.is_null() {
        return Ok(None);
    }
    input
        .as_str()
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 80
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
        .map(Some)
        .ok_or_else(invalid)
}

fn number(input: &Value, positive: bool) -> Result<f64, RpcError> {
    input
        .as_f64()
        .filter(|value| (0.0..=604_800.0).contains(value) && (!positive || *value > 0.0))
        .ok_or_else(invalid)
}

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

enum Selection<'a> {
    Folder,
    Json,
    SaveJson(&'a str),
}

async fn pick(
    window: &Webview,
    state: &State,
    title: &str,
    selection: Selection<'_>,
) -> Result<Option<PathBuf>, RpcError> {
    let _dialog = state
        .dialog
        .try_lock()
        .map_err(|_| RpcError::new("invalid-input", "A file picker is already open."))?;
    let dialog = window
        .dialog()
        .file()
        .set_parent(&window.window())
        .set_title(title);
    let (send, receive) = tokio::sync::oneshot::channel::<Option<FilePath>>();
    let callback = move |path| {
        let _ = send.send(path);
    };
    match selection {
        Selection::Folder => dialog.pick_folder(callback),
        Selection::Json => dialog
            .add_filter("Theme JSON", &["json"])
            .pick_file(callback),
        Selection::SaveJson(name) => dialog
            .add_filter("Theme JSON", &["json"])
            .set_file_name(name)
            .save_file(callback),
    }
    receive
        .await
        .map_err(read_error)?
        .map(|file| file.into_path().map_err(read_error))
        .transpose()
}
