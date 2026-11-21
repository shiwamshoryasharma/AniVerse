mod accounts;
mod comment_text;
mod comments;
mod drive;
mod vault;

use crate::{profile, RpcError};
use accounts::sync::Mode;
use reqwest::{redirect::Policy, Client, RequestBuilder, Response};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};
use tauri::{AppHandle, Manager, Webview};
use tokio::sync::{Mutex, Notify, Semaphore};
static LIBRARY_QUEUED: Notify = Notify::const_new();

pub(crate) struct Service {
    client: Client,
    requests: Semaphore,
    drive: drive::Drive,
    account_action: Mutex<()>,
    oauth: accounts::oauth::Broker,
}

impl Service {
    pub(crate) fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder()
                .https_only(true)
                .redirect(Policy::none())
                .timeout(Duration::from_secs(30))
                .user_agent("AniVerse2 Desktop")
                .build()?,
            requests: Semaphore::new(8),
            drive: drive::Drive::default(),
            account_action: Mutex::new(()),
            oauth: accounts::oauth::Broker::default(),
        })
    }

    pub(crate) async fn request(
        &self,
        window: &Webview,
        root: &Path,
        method: &str,
        input: Option<&Value>,
    ) -> Result<Value, RpcError> {
        let input = input.unwrap_or(&Value::Null);
        match method {
            "accounts.list" => self.account_list(root),
            "accounts.connect" => {
                let selected = accounts::provider(input)?;
                self.oauth.connect(self, window, root, selected).await?;
                self.sync_after_connect(window, root, selected);
                self.account_list(root)?
                    .as_array()
                    .and_then(|items| items.iter().find(|item| item["provider"] == selected))
                    .cloned()
                    .ok_or_else(network)
            }
            "accounts.cancel" => {
                self.oauth.cancel(accounts::provider(input)?)?;
                Ok(Value::Null)
            }
            "accounts.disconnect" => {
                let _account = self.account_guard()?;
                self.oauth.cancel(accounts::provider(input)?)?;
                accounts::disconnect(root, input)
            }
            "accounts.sync" => {
                let _account = self.account_guard()?;
                accounts::sync::run(self, window, root, input, Mode::Full).await
            }
            "comments.list" => self.comment_list(root, input).await,
            "comments.post" => self.comment_post(root, input).await,
            _ => self.drive.request(self, window, root, method, input).await,
        }
    }

    fn sync_after_connect(&self, window: &Webview, root: &Path, provider: &str) {
        if cfg!(feature = "isolated-test") {
            return;
        }
        let provider = json!({"provider":provider});
        let window = window.clone();
        let root = root.to_path_buf();
        tauri::async_runtime::spawn(async move {
            let service = window.state::<Service>();
            let _guard = service.account_lock().await;
            let _ = accounts::sync::run(&service, &window, &root, &provider, Mode::Full).await;
        });
    }

    fn account_list(&self, root: &Path) -> Result<Value, RpcError> {
        let mut result = accounts::list(root)?;
        if let Some(items) = result.as_array_mut() {
            for row in items {
                let provider = accounts::provider(row)?;
                let available = self.oauth.configured(provider);
                let signing_in = self.oauth.signing_in(provider);
                row["clientIdConfigured"] = json!(available);
                row["signingIn"] = json!(signing_in);
            }
        }
        Ok(result)
    }

    async fn account_lock(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.account_action.lock().await
    }

    fn account_guard(&self) -> Result<tokio::sync::MutexGuard<'_, ()>, RpcError> {
        self.account_action
            .try_lock()
            .map_err(|_| RpcError::new("unavailable", "An account operation is already running."))
    }

    async fn send(&self, request: RequestBuilder) -> Result<Response, RpcError> {
        let _permit = self.requests.try_acquire().map_err(|_| {
            RpcError::new(
                "unavailable",
                "Too many account requests are running. Try again.",
            )
        })?;
        let response = request.send().await.map_err(|_| network())?;
        if response.status().is_success() {
            return Ok(response);
        }
        Err(match response.status().as_u16() {
            401 => RpcError::new(
                "unauthorised",
                "The service rejected this sign-in. Reconnect your account.",
            ),
            403 => RpcError::new(
                "unauthorised",
                "The service denied access to this operation.",
            ),
            404 => RpcError::new(
                "not-found",
                "The service could not find the requested item.",
            ),
            412 => RpcError::new(
                "unavailable",
                "The cloud file changed during this operation. Try again.",
            ),
            429 => RpcError::new(
                "rate-limited",
                "The service is rate limiting requests. Try again shortly.",
            ),
            _ => network(),
        })
    }

    async fn graphql(
        &self,
        query: &str,
        variables: Value,
        token: Option<&str>,
    ) -> Result<Value, RpcError> {
        let mut request = self
            .client
            .post("https://graphql.anilist.co")
            .json(&json!({"query": query, "variables": variables}));
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let value = response_json(self.send(request).await?, 2 * 1024 * 1024).await?;
        if let Some(errors) = value["errors"]
            .as_array()
            .filter(|errors| !errors.is_empty())
        {
            if errors.iter().all(|error| error["status"] == 404) {
                return Err(RpcError::new("not-found", "AniList did not find the item."));
            }
            if errors
                .iter()
                .all(|error| error["status"] == 401 || error["status"] == 403)
            {
                return Err(RpcError::new(
                    "unauthorised",
                    "AniList rejected the sign-in.",
                ));
            }
            return Err(RpcError::new(
                "unavailable",
                "AniList did not complete the request.",
            ));
        }
        if !value["data"].is_object() {
            return Err(RpcError::new(
                "unavailable",
                "AniList did not complete the request.",
            ));
        }
        Ok(value["data"].clone())
    }
}

pub(crate) fn open_migrated_secret(root: &Path, encoded: &str) -> std::io::Result<String> {
    vault::open(root, encoded)
}

pub(crate) fn queue_library_change(
    db: &Connection,
    id: i64,
    favourite: Option<bool>,
) -> Result<bool, RpcError> {
    accounts::sync::queue(db, id, favourite)
}

pub(crate) fn library_queued() {
    LIBRARY_QUEUED.notify_one();
}

pub(crate) fn start(app: &AppHandle) {
    if cfg!(feature = "isolated-test") {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tokio::time::{sleep, timeout, Instant};
        const PUSH_INTERVAL: Duration = Duration::from_secs(300);
        const PULL_INTERVAL: Duration = Duration::from_secs(1800);
        sleep(Duration::from_secs(8)).await;
        let mut next_push = Instant::now();
        let mut next_pull = next_push;
        loop {
            let Some(window) = app.get_webview("main") else {
                return;
            };
            let root = app.state::<std::path::PathBuf>();
            let service = app.state::<Service>();
            let now = Instant::now();
            let mut mode = Mode::PushDue;
            if now >= next_push {
                next_push = now + PUSH_INTERVAL;
            }
            let settings = kv(root.inner(), "settings")
                .ok()
                .filter(|settings| settings["accounts"]["autoSync"] != false);
            if let Some(settings) = settings.filter(|_| !crate::runtime_privacy::active()) {
                if now >= next_pull && settings["accounts"]["twoWay"] != false {
                    mode = Mode::Full;
                }
                if let Ok(_guard) = service.account_guard() {
                    let _ = accounts::sync::run(
                        &service,
                        &window,
                        root.inner(),
                        &json!({"provider":null}),
                        mode,
                    )
                    .await;
                    if mode == Mode::Full {
                        next_pull = now + PULL_INTERVAL;
                    }
                }
            }
            let _ = timeout(
                next_push.saturating_duration_since(Instant::now()),
                LIBRARY_QUEUED.notified(),
            )
            .await;
        }
    });
}

pub(crate) fn handle_account_callback(identifier: &str) -> Option<bool> {
    accounts::oauth::receive_callback(identifier)
}

pub(crate) fn handles(method: &str) -> bool {
    matches!(
        method,
        "accounts.list"
            | "accounts.connect"
            | "accounts.cancel"
            | "accounts.disconnect"
            | "accounts.sync"
            | "comments.list"
            | "comments.post"
    ) || drive::handles(method)
}

async fn bounded(mut response: Response, limit: usize) -> Result<Vec<u8>, RpcError> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err(response_limit());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| network())? {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err(response_limit());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn response_json(response: Response, limit: usize) -> Result<Value, RpcError> {
    serde_json::from_slice(&bounded(response, limit).await?).map_err(|_| network())
}

fn response_limit() -> RpcError {
    RpcError::new(
        "unavailable",
        "The service response exceeded its allowed size.",
    )
}

fn network() -> RpcError {
    RpcError::new(
        "unavailable",
        "The service request did not complete. Try again.",
    )
}

fn invalid() -> RpcError {
    RpcError::new("invalid-input", "The account request is invalid.")
}

fn storage(_: rusqlite::Error) -> RpcError {
    RpcError::new(
        "config",
        "The local account settings could not be read or saved.",
    )
}

fn kv(root: &Path, key: &str) -> Result<Value, RpcError> {
    let Some(db) = profile::open(root).map_err(storage)? else {
        return Ok(Value::Null);
    };
    kv_in(&db, key)
}

fn kv_in(db: &Connection, key: &str) -> Result<Value, RpcError> {
    let row = db
        .query_row("SELECT value FROM kv WHERE key = ?1", [key], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(storage)?;
    row.map_or(Ok(Value::Null), |data| {
        serde_json::from_str(&data)
            .map_err(|_| RpcError::new("config", "The saved account setting is invalid."))
    })
}

fn set_kv(db: &Connection, key: &str, value: &Value) -> Result<(), RpcError> {
    db.execute("INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value.to_string()]).map_err(storage)?;
    Ok(())
}

fn url_query(url: &str, pairs: &[(&str, &str)]) -> Result<reqwest::Url, RpcError> {
    let mut url = reqwest::Url::parse(url).map_err(|_| network())?;
    url.query_pairs_mut().extend_pairs(pairs);
    Ok(url)
}

fn form(request: RequestBuilder, pairs: &[(&str, &str)]) -> Result<RequestBuilder, RpcError> {
    let encoded = url_query("https://oauth2.googleapis.com/token", pairs)?;
    Ok(request
        .header("content-type", "application/x-www-form-urlencoded")
        .body(encoded.query().unwrap_or_default().to_owned()))
}

fn mal_client_id() -> Option<&'static str> {
    option_env!("ANIVERSE_MAL_CLIENT_ID")
        .map(str::trim)
        .filter(|id| (16..=64).contains(&id.len()) && id.bytes().all(|x| x.is_ascii_hexdigit()))
}

fn positive_id(value: &Value) -> Option<i32> {
    i32::try_from(value.as_i64()?).ok().filter(|id| *id > 0)
}

fn safe_link(value: &Value) -> Value {
    value
        .as_str()
        .filter(|raw| raw.len() <= 2048)
        .and_then(|raw| reqwest::Url::parse(raw).ok())
        .filter(|url| {
            matches!(url.scheme(), "https" | "http")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
        })
        .filter(|url| aniverse_security::allows_source_network(url.as_str(), ""))
        .map_or(Value::Null, |url| json!(url.as_str()))
}
#[cfg(test)]
#[path = "../../../test/tauri-compat/integrations.rs"]
mod tests;
