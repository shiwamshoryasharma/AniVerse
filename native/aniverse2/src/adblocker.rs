use crate::{profile, RpcError};
use adblock::{
    lists::{FilterSet, ParseOptions, RuleTypes},
    request::Request,
    Engine,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, RwLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, Webview};

const LISTS: [&str; 3] = [
    "https://easylist.to/easylist/easylist.txt",
    "https://easylist.to/easylist/easyprivacy.txt",
    "https://secure.fanboy.co.nz/fanboy-annoyance.txt",
];
const MAX_LIST: usize = 8 * 1024 * 1024;
const MAX_CUSTOM: usize = 1024 * 1024;
const MAX_AGE: u64 = 24 * 3600 * 1000;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Stats {
    pub(crate) enabled: bool,
    ready: bool,
    updating: bool,
    error: Option<&'static str>,
    lists_updated_at: Option<u64>,
    blocked: BTreeMap<String, u64>,
    security_blocked: BTreeMap<String, u64>,
    popups_blocked: BTreeMap<String, u64>,
}

#[derive(Clone, Copy)]
pub(crate) enum Denial {
    Network,
    Security,
    Popup,
}

pub(crate) struct Service {
    root: PathBuf,
    stats: Mutex<Stats>,
    dirty: AtomicBool,
    engine: RwLock<Option<Engine>>,
    source_prefs: RwLock<HashMap<String, bool>>,
    enabled: AtomicBool,
    refresh: tokio::sync::Mutex<()>,
}

impl Service {
    pub(crate) fn new(root: &Path) -> Self {
        let enabled = profile::request(root, "settings.get", Value::Null)
            .ok()
            .and_then(|settings| settings["privacy"]["adblock"].as_bool())
            .unwrap_or(true);
        let source_prefs = profile::request(root, "sources.list", Value::Null)
            .ok()
            .and_then(|sources| sources.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|source| {
                Some((
                    source["id"].as_str()?.to_owned(),
                    source["adblock"].as_bool()?,
                ))
            })
            .collect();
        Self {
            root: root.to_owned(),
            stats: Mutex::new(Stats {
                enabled,
                ..Stats::default()
            }),
            dirty: AtomicBool::new(false),
            engine: RwLock::new(None),
            source_prefs: RwLock::new(source_prefs),
            enabled: AtomicBool::new(enabled),
            refresh: Default::default(),
        }
    }

    pub(crate) fn snapshot(&self) -> Stats {
        self.stats
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub(crate) fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
        self.change(|stats| stats.enabled = enabled);
    }

    pub(crate) fn set_source(&self, id: &str, enabled: bool) {
        self.source_prefs
            .write()
            .unwrap_or_else(|error| error.into_inner())
            .insert(id.to_owned(), enabled);
    }

    fn change(&self, edit: impl FnOnce(&mut Stats)) {
        edit(&mut self.stats.lock().unwrap_or_else(|error| error.into_inner()));
        self.dirty.store(true, Ordering::Release);
    }

    pub(crate) fn count(&self, source: &str, kind: Denial) {
        self.change(|stats| {
            let counts = match kind {
                Denial::Network => &mut stats.blocked,
                Denial::Security => &mut stats.security_blocked,
                Denial::Popup => &mut stats.popups_blocked,
            };
            if counts.len() < 512 || counts.contains_key(source) {
                let total = counts.entry(source.to_owned()).or_default();
                *total = total.saturating_add(1);
            }
        });
    }

    pub(crate) fn enabled_for(&self, id: &str) -> bool {
        self.enabled.load(Ordering::Relaxed)
            && self
                .source_prefs
                .read()
                .ok()
                .and_then(|sources| sources.get(id).copied())
                != Some(false)
    }

    pub(crate) fn blocks(
        &self,
        id: &str,
        source: &str,
        current: &str,
        kind: &str,
        method: &str,
    ) -> bool {
        if !self.enabled_for(id) || current.len() > 8192 {
            return false;
        }
        self.engine
            .read()
            .ok()
            .as_deref()
            .and_then(|engine| engine.as_ref())
            .is_some_and(|engine| {
                Request::new(current, source, kind, method)
                    .is_ok_and(|request| engine.check_network_request(&request).should_block())
            })
    }

    fn custom_path(&self) -> PathBuf {
        self.root.join("config/filters.txt")
    }
    fn cache_path(&self) -> PathBuf {
        self.root.join("rust-network-filters.txt")
    }

    fn replace(&self, next: Option<Engine>, timestamp: Option<u64>) {
        let ready = next.is_some();
        *self
            .engine
            .write()
            .unwrap_or_else(|error| error.into_inner()) = next;
        self.change(|stats| {
            stats.ready = ready;
            stats.lists_updated_at = timestamp;
        });
    }

    async fn restore(&self) {
        let path = self.cache_path();
        let custom = self.custom_path();
        let completed = tauri::async_runtime::spawn_blocking(move || {
            let lists = profile::text_file(&path, MAX_LIST * LISTS.len())
                .ok()
                .flatten()
                .unwrap_or_default();
            let custom = profile::text_file(&custom, MAX_CUSTOM)
                .ok()
                .flatten()
                .unwrap_or_default();
            let stamp = (!lists.is_empty()).then(|| modification(&path)).flatten();
            let engine =
                (!lists.is_empty() || !custom.trim().is_empty()).then(|| compile(lists, custom));
            (engine, stamp)
        })
        .await;
        if let Ok((engine, stamp)) = completed {
            self.replace(engine, stamp);
        }
    }

    async fn refresh(&self, force: bool) -> Result<Stats, RpcError> {
        let _refresh = self.refresh.lock().await;
        let current = self.snapshot();
        if !force
            && (!current.enabled
                || current
                    .lists_updated_at
                    .is_some_and(|at| now().saturating_sub(at) < MAX_AGE))
        {
            return Ok(current);
        }
        self.change(|stats| {
            stats.updating = true;
            stats.error = None;
        });
        let result = self.fetch_and_replace().await;
        self.change(|stats| {
            stats.updating = false;
            if result.is_err() {
                stats.error = Some(if stats.ready {
                    "Filter update failed. Existing network rules are still active."
                } else {
                    "Filter update failed. Try updating again when connected."
                });
            }
        });
        result.map(|_| self.snapshot())
    }

    async fn fetch_and_replace(&self) -> Result<(), RpcError> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(18))
            .build()
            .map_err(|_| fetch_error())?;
        let mut pending = tokio::task::JoinSet::new();
        for (index, url) in LISTS.into_iter().enumerate() {
            let client = client.clone();
            pending.spawn(async move { Ok::<_, RpcError>((index, download(&client, url).await?)) });
        }
        let mut lists = LISTS.map(|_| String::new());
        while let Some(result) = pending.join_next().await {
            let (index, list): (usize, String) = result.map_err(|_| fetch_error())??;
            lists[index] = list;
        }
        let lists = lists.join("\n");
        let path = self.cache_path();
        let custom_path = self.custom_path();
        let (engine, stamp) =
            tauri::async_runtime::spawn_blocking(move || -> Result<_, RpcError> {
                let custom = profile::text_file(&custom_path, MAX_CUSTOM)
                    .map_err(|_| {
                        RpcError::new(
                            "config",
                            "Check that your custom filters are readable and at most 1 MB.",
                        )
                    })?
                    .unwrap_or_default();
                let engine = compile(lists.clone(), custom);
                let mut file =
                    tempfile::NamedTempFile::new_in(path.parent().ok_or_else(fetch_error)?)
                        .map_err(|_| fetch_error())?;
                file.write_all(lists.as_bytes())
                    .map_err(|_| fetch_error())?;
                file.as_file().sync_all().map_err(|_| fetch_error())?;
                file.persist(&path).map_err(|_| fetch_error())?;
                Ok((engine, modification(&path)))
            })
            .await
            .map_err(|_| fetch_error())??;
        self.replace(Some(engine), stamp);
        Ok(())
    }
}

pub(crate) fn start(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let service = handle.state::<Service>();
        {
            let _refresh = service.refresh.lock().await;
            service.restore().await;
        }
        if cfg!(feature = "isolated-test") {
            return;
        }
        loop {
            let _ = service.refresh(false).await;
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let service = handle.state::<Service>();
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            if service.dirty.swap(false, Ordering::AcqRel) {
                let _ = handle.emit_to("main", "aniverse:adblock/stats", service.snapshot());
            }
        }
    });
}

pub(crate) async fn request(window: &Webview, method: &str) -> Result<Value, RpcError> {
    let service = window.state::<Service>();
    let result = match method {
        "adblock.stats" => service.snapshot(),
        "adblock.update" => service.refresh(true).await?,
        _ => return Err(RpcError::new("invalid-input", "Unknown filter operation.")),
    };
    serde_json::to_value(result).map_err(|_| fetch_error())
}

fn compile(lists: String, custom: String) -> Engine {
    let mut filters = FilterSet::new(false);
    let opts = ParseOptions {
        rule_types: RuleTypes::NetworkOnly,
        ..Default::default()
    };
    filters.add_filter_list(lists, opts);
    filters.add_filter_list(custom, opts);
    Engine::new_with_filter_set(filters)
}

async fn download(client: &reqwest::Client, url: &str) -> Result<String, RpcError> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| fetch_error())?
        .error_for_status()
        .map_err(|_| fetch_error())?;
    if response
        .content_length()
        .is_some_and(|n| n > MAX_LIST as u64)
    {
        return Err(fetch_error());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| fetch_error())? {
        if bytes.len() + chunk.len() > MAX_LIST {
            return Err(fetch_error());
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = String::from_utf8(bytes).map_err(|_| fetch_error())?;
    if !text.trim_start_matches('\u{feff}').starts_with("[Adblock") || text.len() < 8192 {
        return Err(fetch_error());
    }
    Ok(text)
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn now() -> u64 {
    millis(SystemTime::now())
}
fn modification(path: &Path) -> Option<u64> {
    Some(millis(path.metadata().ok()?.modified().ok()?))
}
fn fetch_error() -> RpcError {
    RpcError::new("network", "Could not update the Windows network filters.")
}

#[cfg(test)]
#[path = "../../../test/tauri-compat/adblock-windows.rs"]
mod tests;
