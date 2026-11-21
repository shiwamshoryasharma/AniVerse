mod transfer;

use crate::{profile, RpcError};
use aniverse_security::{allows_public_address, allows_public_mp4};
use reqwest::{redirect::Policy, Client, Url};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{Emitter, Manager, Webview};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};
use tokio::{net::lookup_host, sync::oneshot, time::timeout};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveRequest {
    url: String,
    source_id: Option<String>,
}

pub(crate) struct Service {
    folder_file: PathBuf,
    folder: Mutex<Option<PathBuf>>,
    operation: tokio::sync::Mutex<()>,
}

impl Service {
    pub(crate) fn new(home: &Path, data: &Path) -> Self {
        let folder_file = home.join("mp4-download-folder.json");
        let folder = profile::text_file(&folder_file, 32 * 1024)
            .ok()
            .flatten()
            .and_then(|text| serde_json::from_str::<Option<PathBuf>>(&text).ok())
            .unwrap_or_else(|| {
                profile::request(data, "player.mp4Folder", json!({"action": "get"}))
                    .ok()
                    .and_then(|value| value.as_str().map(PathBuf::from))
            });
        Self {
            folder_file,
            folder: Mutex::new(folder),
            operation: tokio::sync::Mutex::new(()),
        }
    }

    pub(crate) async fn folder(
        &self,
        window: &Webview,
        input: Option<&Value>,
    ) -> Result<Value, RpcError> {
        let action = input
            .and_then(|value| value.as_object())
            .filter(|object| object.len() == 1)
            .and_then(|object| object.get("action"))
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Choose a valid download folder action."))?;
        if action == "get" {
            return Ok(self.folder_value());
        }
        let _operation = self.begin()?;
        let selected = match action {
            "choose" => {
                let mut dialog = window
                    .dialog()
                    .file()
                    .set_title("Choose the default MP4 download folder")
                    .set_parent(&window.window());
                if let Some(directory) = self.initial_directory(window) {
                    dialog = dialog.set_directory(directory);
                }
                let Some(path) = choose_path(dialog, true).await? else {
                    return Ok(self.folder_value());
                };
                Some(path)
            }
            "reset" => None,
            _ => return Err(invalid("Choose a valid download folder action.")),
        };
        let file = self.folder_file.clone();
        let next = selected.clone();
        tauri::async_runtime::spawn_blocking(move || persist(&file, &next))
            .await
            .map_err(|_| config_error())?
            .map_err(|_| config_error())?;
        *self
            .folder
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = selected;
        Ok(self.folder_value())
    }

    pub(crate) async fn save(
        &self,
        window: &Webview,
        input: Option<&Value>,
        data: &Path,
    ) -> Result<Value, RpcError> {
        let input = input
            .cloned()
            .and_then(|value| serde_json::from_value::<SaveRequest>(value).ok())
            .ok_or_else(|| invalid("Choose a direct HTTPS MP4 file."))?;
        let _operation = self.begin()?;
        let source_id = input.source_id;
        let origin = if let Some(id) = source_id {
            let data = data.to_owned();
            tauri::async_runtime::spawn_blocking(move || configured_source(&data, &id))
                .await
                .map_err(|_| invalid("Could not check the selected source."))??
        } else {
            input.url.clone()
        };
        if !allows_public_mp4(&input.url, &origin) {
            return Err(invalid("Choose a public HTTPS MP4 file from this source."));
        }
        let url = Url::parse(&input.url).map_err(|_| invalid("The MP4 link is invalid."))?;
        let mut dialog = window
            .dialog()
            .file()
            .set_title("Save MP4 as")
            .add_filter("MP4 video", &["mp4"])
            .set_file_name(suggested_name(&url))
            .set_parent(&window.window());
        if let Some(directory) = self.initial_directory(window) {
            dialog = dialog.set_directory(directory);
        }
        let Some(destination) = choose_path(dialog, false).await? else {
            return Ok(Value::Bool(false));
        };
        if !destination
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"))
        {
            return Err(invalid("Choose a filename ending in .mp4."));
        }
        let client = public_transport(&url).await?;
        timeout(
            Duration::from_secs(45 * 60),
            transfer::save(&client, &url, &destination, |received, total| {
                let _ = window.emit(
                    "aniverse:mp4/progress",
                    json!({"received": received, "total": total}),
                );
            }),
        )
        .await
        .map_err(|_| RpcError::new("network", "The MP4 download timed out."))??;
        Ok(Value::Bool(true))
    }

    fn begin(&self) -> Result<tokio::sync::MutexGuard<'_, ()>, RpcError> {
        self.operation
            .try_lock()
            .map_err(|_| invalid("Another MP4 download or folder selection is in progress."))
    }

    fn initial_directory(&self, window: &Webview) -> Option<PathBuf> {
        self.folder
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
            .filter(|path| path.is_dir())
            .or_else(|| window.path().download_dir().ok())
    }

    fn folder_value(&self) -> Value {
        self.folder
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .map(|path| Value::String(path.to_string_lossy().into_owned()))
            .unwrap_or_default()
    }
}

async fn choose_path(
    dialog: FileDialogBuilder<tauri::Wry>,
    directory: bool,
) -> Result<Option<PathBuf>, RpcError> {
    let (send, receive) = oneshot::channel();
    let callback = move |selected| {
        let _ = send.send(selected);
    };
    if directory {
        dialog.pick_folder(callback);
    } else {
        dialog.save_file(callback);
    }
    receive
        .await
        .map_err(|_| config_error())?
        .map(|file| file.into_path().map_err(|_| config_error()))
        .transpose()
}

fn persist(path: &Path, folder: &Option<PathBuf>) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("The preferences path has no parent."))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(&mut temporary, folder)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    temporary.persist(path)?;
    Ok(())
}

fn configured_source(data: &Path, id: &str) -> Result<String, RpcError> {
    profile::request(data, "sources.list", Value::Null)?
        .as_array()
        .and_then(|sources| {
            sources.iter().find(|source| {
                source["id"] == id && source["enabled"] == true && source["kind"] == "web"
            })
        })
        .and_then(|source| source["url"].as_str())
        .map(str::to_owned)
        .ok_or_else(|| invalid("The source is no longer enabled."))
}

fn suggested_name(url: &Url) -> String {
    let base = url
        .path_segments()
        .and_then(|segments| segments.last())
        .unwrap_or("video.mp4");
    let stem = base.get(..base.len().saturating_sub(4)).unwrap_or("video");
    let safe: String = stem
        .chars()
        .take(96)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    format!(
        "AniVerse - {}.mp4",
        safe.trim_matches(|ch| ch == '.' || ch == ' ')
    )
}

async fn public_transport(url: &Url) -> Result<Client, RpcError> {
    let failed = || RpcError::new("network", "Could not reach a public MP4 host.");
    let host = url.host_str().ok_or_else(failed)?.trim_matches(['[', ']']);
    let port = url.port_or_known_default().ok_or_else(failed)?;
    let addresses = timeout(Duration::from_secs(5), lookup_host((host, port)))
        .await
        .map_err(|_| failed())?
        .map_err(|_| failed())?
        .collect::<Vec<_>>();
    if addresses.is_empty()
        || !addresses
            .iter()
            .all(|address| allows_public_address(address.ip()))
    {
        return Err(failed());
    }
    // Connect only to the DNS results already checked. A proxy or redirect could change the destination.
    Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(Policy::none())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| failed())
}

fn invalid(message: &str) -> RpcError {
    RpcError::new("invalid-input", message)
}

fn config_error() -> RpcError {
    RpcError::new("config", "Could not select or save the download folder.")
}

#[cfg(test)]
#[path = "../../../test/tauri-compat/mp4-public.rs"]
mod public_tests;
