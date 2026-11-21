use super::{form, invalid, kv, network, response_json, set_kv, storage, vault, Service};
use crate::{profile, sources, RpcError};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::OsStr,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, Webview};
use tauri_plugin_dialog::DialogExt;
use tokio::{
    io::AsyncReadExt,
    sync::{oneshot, Mutex as AsyncMutex},
};

pub(super) mod backup;
mod files;
mod google;
const FOLDER: &str = "AniVerse Sync";
const FILE: &str = "aniverse-backup.v1.json";
const FOLDER_MIME: &str = "application/vnd.google-apps.folder";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Credentials {
    client_id: String,
    client_secret: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Tokens {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredDrive {
    credentials: Credentials,
    tokens: Option<Tokens>,
    shared: bool,
    folder_id: Option<String>,
}

#[derive(Default)]
pub(super) struct Drive {
    pending: Mutex<Option<Pending>>,
    busy: AsyncMutex<()>,
    auth: Mutex<Option<Arc<AtomicBool>>>,
}

struct Pending {
    ticket: String,
    backup: Value,
    expires: std::time::Instant,
}

pub(super) fn handles(method: &str) -> bool {
    matches!(
        method,
        "drive.state"
            | "drive.configure"
            | "drive.connect"
            | "drive.cancel"
            | "drive.disconnect"
            | "drive.folder"
            | "drive.export"
            | "drive.preview"
            | "drive.import"
    )
}

impl Drive {
    pub(super) async fn request(
        &self,
        service: &Service,
        window: &Webview,
        root: &Path,
        method: &str,
        input: &Value,
    ) -> Result<Value, RpcError> {
        if method == "drive.state" {
            let stored = load(root)?;
            return snapshot(root, stored.as_ref(), self.busy.try_lock().is_err());
        }
        if method == "drive.cancel" {
            if let Some(cancel) = self.auth.lock().map_err(|_| network())?.as_ref() {
                cancel.store(true, Ordering::Release);
            }
            return Ok(Value::Null);
        }
        let _busy = self.busy.try_lock().map_err(|_| {
            RpcError::new(
                "unavailable",
                "A Google Drive operation is already running.",
            )
        })?;
        let mut state = load(root)?;
        match method {
            "drive.configure" => {
                if let Some(credentials) = choose_credentials(window).await? {
                    state = Some(StoredDrive {
                        credentials,
                        tokens: None,
                        shared: false,
                        folder_id: None,
                    });
                    save(root, state.as_ref())?;
                    self.invalidate_preview()?;
                }
            }
            "drive.connect" => {
                let shared = input["shared"].as_bool().ok_or_else(invalid)?;
                let current = state.as_mut().ok_or_else(not_configured)?;
                let cancel = Arc::new(AtomicBool::new(false));
                *self.auth.lock().map_err(|_| network())? = Some(cancel.clone());
                let result =
                    google::authorise(service, &current.credentials, shared, &cancel).await;
                *self.auth.lock().map_err(|_| network())? = None;
                let tokens = result?;
                if cancel.load(Ordering::Acquire) {
                    return Err(google::cancelled());
                }
                current.tokens = Some(tokens);
                current.shared = shared;
                current.folder_id = None;
                save(root, state.as_ref())?;
                self.invalidate_preview()?;
            }
            "drive.disconnect" => {
                if let Some(current) = state.as_mut() {
                    let tokens = current.tokens.take();
                    current.folder_id = None;
                    save(root, state.as_ref())?;
                    self.invalidate_preview()?;
                    if let Some(tokens) = tokens {
                        let revoke = if tokens.refresh_token.is_empty() {
                            &tokens.access_token
                        } else {
                            &tokens.refresh_token
                        };
                        let request = service
                            .client
                            .post("https://oauth2.googleapis.com/revoke")
                            .timeout(std::time::Duration::from_secs(10));
                        if let Ok(request) = form(request, &[("token", revoke)]) {
                            let _ = request.send().await;
                        }
                    }
                }
            }
            "drive.folder" => {
                let input = input["value"]
                    .as_str()
                    .filter(|value| value.encode_utf16().count() <= 500)
                    .ok_or_else(invalid)?;
                let id = folder_id(input)?;
                let current = state.as_mut().ok_or_else(not_configured)?;
                let token = refresh(service, root, current).await?;
                if let Some(id) = id.as_deref() {
                    let target = format!("https://www.googleapis.com/drive/v3/files/{id}?fields=id,name,mimeType&supportsAllDrives=true");
                    let info = response_json(
                        service
                            .send(service.client.get(target).bearer_auth(token))
                            .await?,
                        32_000,
                    )
                    .await?;
                    if info["id"] != id || info["name"] != FOLDER || info["mimeType"] != FOLDER_MIME
                    {
                        return Err(RpcError::new(
                            "invalid-input",
                            "Choose a folder named AniVerse Sync.",
                        ));
                    }
                }
                current.folder_id = id;
                save(root, state.as_ref())?;
                self.invalidate_preview()?;
            }
            "drive.export" | "drive.preview" => {
                let privacy = if method == "drive.export" {
                    Some(privacy_scope(root)?)
                } else {
                    None
                };
                let verify_privacy = || {
                    if let Some(scope) = &privacy {
                        if &privacy_scope(root)? != scope {
                            return Err(privacy_changed());
                        }
                    }
                    Ok(())
                };
                let current = state.as_mut().ok_or_else(not_configured)?;
                let selected = current.folder_id.clone();
                let token = refresh(service, root, current).await?;
                verify_privacy()?;
                let api = files::Client { service, token };
                let folder = api
                    .folder(selected.as_deref(), method == "drive.export")
                    .await?;
                let id = files::resource_id(&folder).ok_or_else(network)?;
                if method == "drive.preview" {
                    self.invalidate_preview()?;
                    let backup = api.download(id).await?;
                    let ticket = uuid::Uuid::new_v4().to_string();
                    let summary = backup::summary(&backup);
                    self.pending
                        .lock()
                        .map_err(|_| network())?
                        .replace(Pending {
                            ticket: ticket.clone(),
                            backup,
                            expires: std::time::Instant::now()
                                + std::time::Duration::from_secs(600),
                        });
                    return Ok(json!({"ticket":ticket, "summary":summary}));
                }
                if folder["capabilities"]["canEdit"] == false {
                    return Err(RpcError::new(
                        "unauthorised",
                        "This Drive folder is read-only.",
                    ));
                }
                verify_privacy()?;
                let backup = backup::create(
                    root,
                    &window.app_handle().package_info().version.to_string(),
                )?;
                api.upload(id, backup, verify_privacy).await?;
                current.folder_id = Some(id.to_owned());
                save(root, state.as_ref())?;
                set_kv(
                    &profile::writable(root).map_err(storage)?,
                    "drive:lastExport",
                    &json!(chrono::Utc::now().timestamp_millis()),
                )?;
            }
            "drive.import" => {
                let ticket = input["ticket"]
                    .as_str()
                    .and_then(|ticket| uuid::Uuid::parse_str(ticket).ok())
                    .map(|ticket| ticket.to_string())
                    .ok_or_else(invalid)?;
                let apply = input["applySettings"].as_bool().ok_or_else(invalid)?;
                privacy_scope(root)?;
                let pending = {
                    let mut available = self.pending.lock().map_err(|_| network())?;
                    if !available.as_ref().is_some_and(|pending| {
                        pending.ticket == ticket && pending.expires > std::time::Instant::now()
                    }) {
                        return Err(RpcError::new(
                            "not-found",
                            "The import preview expired. Preview the Drive backup again.",
                        ));
                    }
                    available.take().ok_or_else(network)?
                };
                return backup::restore(root, pending.backup, apply);
            }
            _ => return Err(invalid()),
        }
        snapshot(root, state.as_ref(), false)
    }

    fn invalidate_preview(&self) -> Result<(), RpcError> {
        *self.pending.lock().map_err(|_| network())? = None;
        Ok(())
    }
}

fn privacy_scope(root: &Path) -> Result<(u64, Value), RpcError> {
    use crate::runtime_privacy;
    let epoch = runtime_privacy::epoch();
    if runtime_privacy::active() {
        return Err(RpcError::new(
            "unauthorised",
            "Exit incognito before transferring app data.",
        ));
    }
    let state = profile::request(root, "privacy.state", Value::Null)?;
    if state["incognito"] == true || runtime_privacy::epoch() != epoch {
        return Err(privacy_changed());
    }
    Ok((epoch, state["privateMediaIds"].clone()))
}

fn privacy_changed() -> RpcError {
    RpcError::new(
        "unavailable",
        "Privacy settings changed during export. Export again.",
    )
}

fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 16_000 && token.bytes().all(|b| b.is_ascii_graphic())
}

fn valid_id(id: &str) -> bool {
    (10..=200).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn folder_id(value: &str) -> Result<Option<String>, RpcError> {
    let text = value.trim();
    if text.is_empty() {
        return Ok(None);
    }
    if valid_id(text) {
        return Ok(Some(text.to_owned()));
    }
    let url = Url::parse(text)
        .ok()
        .filter(|url| {
            url.scheme() == "https"
                && url.host_str() == Some("drive.google.com")
                && url.username().is_empty()
                && url.password().is_none()
                && url.port().is_none()
        })
        .ok_or_else(invalid)?;
    let segments: Vec<_> = url
        .path()
        .trim_end_matches('/')
        .trim_start_matches('/')
        .split('/')
        .collect();
    let id = match segments.as_slice() {
        ["drive", "folders", id] => id,
        ["drive", "u", user, "folders", id]
            if !user.is_empty() && user.bytes().all(|b| b.is_ascii_digit()) =>
        {
            id
        }
        _ => return Err(invalid()),
    };
    if !valid_id(id) {
        return Err(invalid());
    }
    Ok(Some((*id).to_owned()))
}

fn valid_credentials(credentials: &Credentials) -> bool {
    credentials
        .client_id
        .strip_suffix(".apps.googleusercontent.com")
        .is_some_and(|id| {
            !id.is_empty()
                && id.len() <= 200
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        })
        && credentials.client_secret.len() <= 500
        && credentials
            .client_secret
            .bytes()
            .all(|b| b.is_ascii_graphic())
}

fn load(root: &Path) -> Result<Option<StoredDrive>, RpcError> {
    let saved = kv(root, "drive:secret")?;
    let Some(text) = saved.as_str() else {
        return Ok(None);
    };
    let plain = match vault::open(root, text) {
        Ok(plain) => plain,
        Err(_) => return Ok(None),
    };
    Ok(serde_json::from_str::<StoredDrive>(&plain)
        .ok()
        .filter(|state| {
            valid_credentials(&state.credentials)
                && state.folder_id.as_deref().is_none_or(valid_id)
                && state.tokens.as_ref().is_none_or(|tokens| {
                    valid_token(&tokens.access_token)
                        && (tokens.refresh_token.is_empty() || valid_token(&tokens.refresh_token))
                })
        }))
}

fn save(root: &Path, state: Option<&StoredDrive>) -> Result<(), RpcError> {
    let protect_error = || {
        RpcError::new(
            "config",
            "Windows could not save the protected Drive credentials.",
        )
    };
    let protected = state
        .map(|state| {
            let plain = serde_json::to_string(state).map_err(|_| protect_error())?;
            vault::seal(root, &plain).map_err(|_| protect_error())
        })
        .transpose()?;
    set_kv(
        &profile::writable(root).map_err(storage)?,
        "drive:secret",
        &json!(protected),
    )
}

fn snapshot(root: &Path, state: Option<&StoredDrive>, busy: bool) -> Result<Value, RpcError> {
    Ok(
        json!({"configured":state.is_some(),"connected":state.is_some_and(|state| state.tokens.is_some()),
        "sharedAccess":state.is_some_and(|state| state.shared),"busy":busy,
        "folderId":state.and_then(|state| state.folder_id.as_deref()),"folderName":FOLDER,"fileName":FILE,
        "persistent":true,"lastExport":kv(root,"drive:lastExport")?.as_i64(),
        "lastImport":kv(root,"drive:lastImport")?.as_i64()}),
    )
}

fn not_configured() -> RpcError {
    RpcError::new("config", "Upload a Google Desktop OAuth client JSON first.")
}

async fn choose_credentials(window: &Webview) -> Result<Option<Credentials>, RpcError> {
    let (send, receive) = oneshot::channel();
    window
        .dialog()
        .file()
        .set_title("Choose Google Desktop OAuth client JSON")
        .add_filter("JSON credentials", &["json"])
        .set_parent(&window.window())
        .pick_file(move |path| {
            let _ = send.send(path);
        });
    let Some(file) = receive.await.map_err(|_| invalid())? else {
        return Ok(None);
    };
    let file = file.into_path().map_err(|_| invalid())?;
    let mut reader = tokio::fs::File::open(file)
        .await
        .map_err(|_| invalid())?
        .take(64_001);
    let mut data = Vec::new();
    reader.read_to_end(&mut data).await.map_err(|_| invalid())?;
    if data.len() > 64_000 {
        return Err(invalid());
    }
    let parsed: Value = serde_json::from_slice(&data).map_err(|_| invalid())?;
    let desktop = &parsed["installed"];
    let credentials = Credentials {
        client_id: desktop["client_id"]
            .as_str()
            .ok_or_else(not_configured)?
            .to_owned(),
        client_secret: desktop["client_secret"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    };
    let auth = desktop["auth_uri"].as_str();
    let token = desktop["token_uri"].as_str();
    if !valid_credentials(&credentials)
        || auth.is_some_and(|url| {
            !matches!(
                url,
                "https://accounts.google.com/o/oauth2/auth"
                    | "https://accounts.google.com/o/oauth2/v2/auth"
            )
        })
        || token.is_some_and(|url| url != "https://oauth2.googleapis.com/token")
    {
        return Err(not_configured());
    }
    Ok(Some(credentials))
}

async fn refresh<'a>(
    service: &Service,
    root: &Path,
    state: &'a mut StoredDrive,
) -> Result<&'a str, RpcError> {
    let tokens = state
        .tokens
        .as_ref()
        .ok_or_else(|| RpcError::new("unauthorised", "Connect your Google account first."))?;
    if tokens.expires_at <= chrono::Utc::now().timestamp_millis() + 60_000 {
        if tokens.refresh_token.is_empty() {
            return Err(RpcError::new(
                "unauthorised",
                "Reconnect your Google account.",
            ));
        }
        state.tokens = Some(
            google::tokens(
                service,
                &state.credentials,
                &[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", &tokens.refresh_token),
                ],
                &tokens.refresh_token,
            )
            .await?,
        );
        save(root, Some(state))?;
    }
    Ok(&state.tokens.as_ref().ok_or_else(network)?.access_token)
}

fn open_browser(url: &Url) -> Result<(), RpcError> {
    sources::open_in_windows(OsStr::new(url.as_str())).map_err(|_| {
        RpcError::new(
            "unavailable",
            "Could not open the system browser for Google sign-in.",
        )
    })
}
