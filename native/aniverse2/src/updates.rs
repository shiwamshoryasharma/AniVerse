use crate::{profile, RpcError};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const RELEASES: &str = "https://github.com/shiwamshoryasharma/AniVerse/releases";
const LIMIT: usize = 192 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Preferences {
    auto_check: bool,
    auto_download: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            auto_check: true,
            auto_download: true,
        }
    }
}

struct State {
    ui: Value,
    prefs: Preferences,
    update: Option<Update>,
    package: Option<Vec<u8>>,
}

pub(crate) struct Service {
    state: Mutex<State>,
    operation: tokio::sync::Mutex<()>,
    prefs_path: PathBuf,
    http: reqwest::Client,
}

impl Service {
    pub(crate) fn new(app: &AppHandle, home: &Path, data: &Path) -> Result<Self, reqwest::Error> {
        let prefs_path = home.join("update-preferences.json");
        let prefs = fs::read(&prefs_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .or_else(|| serde_json::from_value(profile::update_defaults(data)).ok())
            .unwrap_or_default();
        let reason =
            cfg!(debug_assertions).then_some("Development builds are updated from source.");
        let status = if reason.is_some() { "disabled" } else { "idle" };
        let http = reqwest::Client::builder()
            .https_only(true)
            .timeout(Duration::from_secs(180))
            .redirect(Policy::custom(|next| {
                let url = next.url();
                if next.previous().len() < 5
                    && url.scheme() == "https"
                    && url.username().is_empty()
                    && url.password().is_none()
                    && matches!(
                        url.host_str(),
                        Some(
                            "release-assets.githubusercontent.com"
                                | "objects.githubusercontent.com"
                        )
                    )
                {
                    next.follow()
                } else {
                    next.error("Unexpected installer download redirect")
                }
            }))
            .build()?;
        Ok(Self {
            state: Mutex::new(State {
                ui: json!({"status": status, "current": app.package_info().version.to_string(),
                    "version": null, "releaseDate": null, "releaseUrl": null, "progress": null,
                    "checkedAt": null, "error": null, "reason": reason}),
                prefs,
                update: None,
                package: None,
            }),
            operation: tokio::sync::Mutex::new(()),
            prefs_path,
            http,
        })
    }

    pub(crate) fn snapshot(&self) -> Value {
        self.lock().ui.clone()
    }

    pub(crate) fn preferences(&self) -> Value {
        json!(self.lock().prefs)
    }

    pub(crate) fn set_preferences(&self, input: Option<&Value>) -> Result<(), RpcError> {
        let invalid = || {
            RpcError::new(
                "invalid-input",
                "Only desktop update preferences can be changed here.",
            )
        };
        let outer = input
            .and_then(Value::as_object)
            .filter(|object| object.len() == 1)
            .ok_or_else(invalid)?;
        let patch = outer
            .get("updates")
            .and_then(Value::as_object)
            .filter(|object| !object.is_empty() && object.len() <= 2)
            .ok_or_else(invalid)?;
        let mut state = self.lock();
        let mut prefs = state.prefs.clone();
        for (key, value) in patch {
            let enabled = value.as_bool().ok_or_else(invalid)?;
            match key.as_str() {
                "autoCheck" => prefs.auto_check = enabled,
                "autoDownload" => prefs.auto_download = enabled,
                _ => return Err(invalid()),
            }
        }
        self.persist(&prefs)
            .map_err(|_| RpcError::new("config", "Could not save update preferences."))?;
        state.prefs = prefs;
        Ok(())
    }

    fn persist(&self, prefs: &Preferences) -> io::Result<()> {
        let mut temporary =
            tempfile::NamedTempFile::new_in(self.prefs_path.parent().expect("profile directory"))?;
        serde_json::to_writer(&mut temporary, prefs)?;
        temporary.flush()?;
        temporary.as_file().sync_all()?;
        temporary.persist(&self.prefs_path)?;
        Ok(())
    }

    pub(crate) async fn check(&self, app: &AppHandle) -> Result<Value, RpcError> {
        let Ok(_operation) = self.operation.try_lock() else {
            return Ok(self.snapshot());
        };
        if matches!(
            self.snapshot()["status"].as_str(),
            Some("disabled" | "downloaded")
        ) {
            return Ok(self.snapshot());
        }
        self.lock().update = None;
        self.publish(app, "checking", json!({"error": null, "version": null, "releaseUrl": null, "releaseDate": null, "progress": null}));
        let updater = app
            .updater_builder()
            .timeout(Duration::from_secs(15))
            .configure_client(|client| client.https_only(true).redirect(Policy::none()))
            .build();
        let response = match updater {
            Ok(updater) => updater.check().await,
            Err(error) => Err(error),
        };
        let candidate = match response {
            Ok(Some(update)) if expected_download(&update) => update,
            Ok(None) => {
                return Ok(self.publish(app, "not-available", json!({"checkedAt": now_ms()})))
            }
            Ok(Some(_)) => {
                return Ok(self.failed(app, "The update feed returned an unexpected installer URL."))
            }
            Err(error) => {
                eprintln!("AniVerse2 update check: {error}");
                return Ok(self.failed(
                    app,
                    "Could not check the AniVerse2 GitHub update feed. Try again shortly.",
                ));
            }
        };
        let patch = json!({
            "version": candidate.version,
            "releaseUrl": format!("{RELEASES}/tag/aniverse2-v{}", candidate.version),
            "releaseDate": candidate.raw_json["pub_date"],
            "checkedAt": now_ms(),
        });
        let auto = {
            let mut state = self.lock();
            state.update = Some(candidate);
            state.prefs.auto_download
        };
        self.publish(app, "available", patch);
        if auto {
            self.download_locked(app).await
        } else {
            Ok(self.snapshot())
        }
    }

    pub(crate) async fn download(&self, app: &AppHandle) -> Result<Value, RpcError> {
        let Ok(_operation) = self.operation.try_lock() else {
            return Ok(self.snapshot());
        };
        self.download_locked(app).await
    }

    async fn download_locked(&self, app: &AppHandle) -> Result<Value, RpcError> {
        let candidate = {
            let state = self.lock();
            if !matches!(state.ui["status"].as_str(), Some("available" | "error")) {
                return Ok(state.ui.clone());
            }
            state.update.clone()
        };
        let Some(candidate) = candidate else {
            return Ok(self.snapshot());
        };
        self.publish(app, "downloading", json!({"error": null, "progress": null}));
        let package = match self.download_bytes(app, &candidate).await {
            Ok(bytes) => bytes,
            Err(error) => return Ok(self.failed(app, &error.message)),
        };
        if candidate.verify(&package).is_err() {
            return Ok(self.failed(
                app,
                "AniVerse2 rejected the installer signature or signed version.",
            ));
        }
        self.lock().package = Some(package);
        Ok(self.publish(app, "downloaded", json!({"progress": null})))
    }

    async fn download_bytes(&self, app: &AppHandle, update: &Update) -> Result<Vec<u8>, RpcError> {
        let failed = |_: reqwest::Error| {
            RpcError::new("network", "Could not download AniVerse2 from GitHub.")
        };
        let mut response = self
            .http
            .get(update.download_url.clone())
            .send()
            .await
            .map_err(failed)?
            .error_for_status()
            .map_err(failed)?;
        let total = response.content_length().unwrap_or(0);
        let oversized = || RpcError::new("network", "The update installer exceeds its size limit.");
        if total > LIMIT as u64 {
            return Err(oversized());
        }
        let start = Instant::now();
        let mut last = start;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(failed)? {
            if chunk.len() > LIMIT - bytes.len() {
                return Err(oversized());
            }
            bytes.extend_from_slice(&chunk);
            if last.elapsed() >= Duration::from_millis(200) && total > 0 {
                last = Instant::now();
                let percent = (100.0 * bytes.len() as f64 / total as f64).min(100.0);
                self.publish(app, "downloading", json!({"progress": {"percent": percent,
                    "transferred": bytes.len(), "total": total,
                    "bytesPerSecond": (bytes.len() as f64 / start.elapsed().as_secs_f64()) as u64}}));
            }
        }
        Ok(bytes)
    }

    pub(crate) async fn install(&self) -> Result<Value, RpcError> {
        let _operation = self.operation.try_lock().map_err(|_| {
            RpcError::new("invalid-input", "An AniVerse2 update is already running.")
        })?;
        let (candidate, bytes) = {
            let mut state = self.lock();
            (state.update.clone(), state.package.take())
        };
        let (Some(candidate), Some(bytes)) = (candidate, bytes) else {
            return Err(RpcError::new(
                "invalid-input",
                "Download the signed update before restarting.",
            ));
        };
        let result = tauri::async_runtime::spawn_blocking(move || {
            let installed = candidate.install(&bytes);
            (bytes, installed)
        })
        .await
        .map_err(|_| RpcError::new("internal", "The installer was interrupted."))?;
        if let Err(error) = result.1 {
            self.lock().package = Some(result.0);
            eprintln!("AniVerse2 update install: {error}");
            return Err(RpcError::new(
                "install",
                "Could not launch the verified AniVerse2 installer. Try again.",
            ));
        }
        Ok(Value::Null)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn publish(&self, app: &AppHandle, status: &str, patch: Value) -> Value {
        let snapshot = {
            let mut state = self.lock();
            if let Some(patch) = patch.as_object() {
                for (key, value) in patch {
                    state.ui[key] = value.clone();
                }
            }
            state.ui["status"] = json!(status);
            state.ui.clone()
        };
        let _ = app.emit_to("main", "aniverse:update/status", &snapshot);
        snapshot
    }

    fn failed(&self, app: &AppHandle, message: &str) -> Value {
        self.publish(
            app,
            "error",
            json!({"error": message, "progress": null, "checkedAt": now_ms()}),
        )
    }
}

fn expected_download(update: &Update) -> bool {
    let mut parts = update.version.split('.');
    parts.clone().count() == 3
        && parts.all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && update.download_url.as_str()
            == format!(
                "{RELEASES}/download/aniverse2-v{0}/AniVerse-Tauri-Setup-{0}-x64.exe",
                update.version
            )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn start(app: &AppHandle) {
    if cfg!(any(debug_assertions, feature = "isolated-test")) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(15)).await;
        loop {
            let updater = app.state::<Service>();
            let should_check = updater.lock().prefs.auto_check;
            if should_check {
                let _ = updater.check(&app).await;
            }
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}
