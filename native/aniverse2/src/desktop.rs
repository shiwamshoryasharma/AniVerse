use crate::{metadata, profile, sources, RpcError};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{ffi::OsStr, path::Path, sync::OnceLock, time::Duration};
use tauri::{Manager, Webview};
use webview2_com::{ClearBrowsingDataCompletedHandler, Microsoft::Web::WebView2::Win32::*};
use windows::core::Interface;

pub(crate) fn handles(method: &str) -> bool {
    matches!(
        method,
        "changelog.state"
            | "changelog.markSeen"
            | "app.cacheClear"
            | "app.openGraphicsSettings"
            | "app.restart"
            | "cast.windowsDisplay"
    )
}

pub(crate) async fn request(
    window: &Webview,
    root: &Path,
    metadata: &metadata::Client,
    method: &str,
    input: &Value,
) -> Result<Value, RpcError> {
    match method {
        "changelog.state" | "changelog.markSeen" => {
            let version = window.app_handle().package_info().version.to_string();
            let mark = method == "changelog.markSeen";
            if mark && input["version"] != version {
                return Err(RpcError::new(
                    "invalid-input",
                    "Only this app version can be acknowledged.",
                ));
            }
            let root = root.to_owned();
            blocking(move || changelog(&root, &version, mark)).await
        }
        "app.cacheClear" => {
            clear_browsing_data(window, false).await?;
            let root = root.to_owned();
            blocking(move || {
                if let Some(db) = profile::open(&root).map_err(database_error)? {
                    // The database was opened read-only by the profile reader.
                    drop(db);
                    profile::writable(&root)
                        .map_err(database_error)?
                        .execute("DELETE FROM http_cache", [])
                        .map_err(database_error)?;
                }
                Ok(Value::Null)
            })
            .await?;
            metadata.clear_cache();
            Ok(Value::Null)
        }
        "app.openGraphicsSettings" => {
            blocking(|| {
                open_settings("ms-settings:display-advancedgraphics")?;
                Ok(Value::Null)
            })
            .await
        }
        "app.restart" => {
            window.app_handle().request_restart();
            Ok(Value::Null)
        }
        "cast.windowsDisplay" => {
            let target = input["target"].as_str().unwrap_or_default().to_owned();
            blocking(move || {
                let uri = match target.as_str() {
                    "connect" => "ms-settings-connectabledevices:devicediscovery",
                    "display" => "ms-settings:display",
                    "sound" => "ms-settings:sound",
                    _ => {
                        return Err(RpcError::new(
                            "invalid-input",
                            "Choose a Windows display destination.",
                        ))
                    }
                };
                match open_settings(uri) {
                    Err(_) if target == "connect" => {
                        open_settings("ms-settings:display")?;
                        Ok(json!({"opened":"display","fallback":true}))
                    }
                    Err(error) => Err(error),
                    Ok(()) => Ok(json!({"opened":target,"fallback":false})),
                }
            })
            .await
        }
        _ => Err(RpcError::new(
            "unavailable",
            "This Windows operation is unavailable.",
        )),
    }
}

fn changelog(root: &Path, version: &str, mark: bool) -> Result<Value, RpcError> {
    const KEY: &str = "changelog:lastSeen";
    static RELEASES: OnceLock<Vec<String>> = OnceLock::new();
    let releases = RELEASES.get_or_init(|| {
        serde_json::from_slice(include_bytes!(concat!(
            env!("OUT_DIR"),
            "/changelog-versions.json"
        )))
        .expect("bundled desktop changelog versions")
    });
    let seen = if mark {
        profile::writable(root).map_err(database_error)?.execute(
            "INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![KEY, json!(version).to_string()],
        ).map_err(database_error)?;
        Some(version.to_owned())
    } else {
        profile::open(root)
            .map_err(database_error)?
            .map(|db| {
                db.query_row("SELECT value FROM kv WHERE key=?1", [KEY], |row| {
                    row.get::<_, String>(0)
                })
                .optional()
            })
            .transpose()
            .map_err(database_error)?
            .flatten()
            .and_then(|value| serde_json::from_str::<String>(&value).ok())
    };
    Ok(
        json!({"version":version,"seen":seen,"unread":releases.iter().any(|v|v==version)&&seen.as_deref()!=Some(version)}),
    )
}

fn open_settings(uri: &'static str) -> Result<(), RpcError> {
    sources::open_in_windows(OsStr::new(uri))
        .map_err(|_| RpcError::new("system", "Windows could not open Settings."))
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, RpcError> + Send + 'static,
) -> Result<T, RpcError> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| RpcError::new("internal", "The Windows operation was interrupted."))?
}

fn database_error(_: rusqlite::Error) -> RpcError {
    RpcError::new("config", "Could not access the local AniVerse2 profile.")
}

pub(crate) async fn clear_browsing_data(window: &Webview, all: bool) -> Result<(), RpcError> {
    let failed = || RpcError::new("system", "Could not clear the app browser cache.");
    let (send, receive) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |platform| {
            let callback = ClearBrowsingDataCompletedHandler::create(Box::new(move |status| {
                let _ = send.send(status.is_ok());
                Ok(())
            }));
            let _ = unsafe {
                platform
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| core.cast::<ICoreWebView2_13>())
                    .and_then(|core| core.Profile())
                    .and_then(|profile| profile.cast::<ICoreWebView2Profile2>())
                    .and_then(|profile| {
                        if all {
                            profile.ClearBrowsingDataAll(&callback)
                        } else {
                            profile.ClearBrowsingData(
                                COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE,
                                &callback,
                            )
                        }
                    })
            };
        })
        .map_err(|_| failed())?;
    match tokio::time::timeout(Duration::from_secs(10), receive).await {
        Ok(Ok(true)) => Ok(()),
        _ => Err(failed()),
    }
}

pub(crate) fn set_title_privacy(root: &Path, input: &Value) -> Result<Value, RpcError> {
    let invalid = || RpcError::new("invalid-input", "Choose a valid title and privacy state.");
    let id = input["mediaId"]
        .as_i64()
        .filter(|id| (1..=i32::MAX as i64).contains(id))
        .ok_or_else(invalid)?;
    let on = input["on"].as_bool().ok_or_else(invalid)?;
    let mut db = profile::writable(root).map_err(database_error)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(database_error)?;
    let changed = if on {
        let added = tx
            .execute(
                "INSERT OR IGNORE INTO private_titles(media_id) VALUES(?1)",
                [id],
            )
            .map_err(database_error)?;
        tx.execute(
            "DELETE FROM sync_queue WHERE json_extract(payload,'$.mediaId')=?1",
            [id],
        )
        .map_err(database_error)?;
        added
    } else {
        tx.execute("DELETE FROM private_titles WHERE media_id=?1", [id])
            .map_err(database_error)?
    };
    if changed > 0 {
        crate::runtime_privacy::advance();
    }
    tx.commit().map_err(database_error)?;
    profile::request(root, "privacy.state", Value::Null)
}
