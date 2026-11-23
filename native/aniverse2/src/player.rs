mod artwork;
mod capture;
mod catalogue;
mod discovery;
mod download;
mod download_network;
mod frames;
mod legacy_session;
mod native;
mod navigation;
mod private_views;
mod quantum;
mod session_data;
pub(crate) mod upscale;

use crate::{profile, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder, WebviewUrl,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const SURFACE_EVENT: &str = "aniverse:site/surface";
const STATUS_EVENT: &str = "aniverse:site/status";
const PAGE: &str = include_str!(concat!(env!("OUT_DIR"), "/site-page.js"));
const AUDIO: &str = include_str!(concat!(env!("OUT_DIR"), "/site-audio.js"));

type DnsCache = Arc<Mutex<HashMap<String, (Instant, bool)>>>;

#[derive(Clone)]
struct Source {
    id: String,
    name: String,
    kind: String,
    base: Url,
    search: Option<String>,
}

#[derive(Clone, Copy, Deserialize)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Bounds {
    fn dimensions_valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|n| n.is_finite() && n.abs() <= 32_768.0)
            && self.width >= 1.0
            && self.height >= 1.0
    }

    fn valid(&self) -> bool {
        self.dimensions_valid() && self.x >= 0.0 && self.y >= 0.0
    }

    fn contains(&self, visible: &Self) -> bool {
        self.x <= visible.x
            && self.y <= visible.y
            && self.x + self.width >= visible.x + visible.width
            && self.y + self.height >= visible.y + visible.height
    }
}

struct Session {
    view: Webview,
    source: Source,
    id: u64,
    atomic: Arc<GuestState>,
    world: Mutex<Option<(u64, i64)>>,
    active_episode: Mutex<Option<(i64, usize)>>,
    quantum: Mutex<Option<(u64, bool)>>,
    audio_frame: tokio::sync::Mutex<Option<native::AudioFrameWorld>>,
    command: tokio::sync::Mutex<()>,
    focus: AtomicBool,
    lease: Option<private_views::Lease>,
    _temporary_profile: Option<tempfile::TempDir>,
    _slot: OwnedSemaphorePermit,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.close();
    }
}

impl Session {
    fn browsing_private(&self) -> bool {
        self.lease.is_some() || crate::runtime_privacy::active()
    }

    fn close(&self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            capture::revoke(&self.view, &self.capture, None);
            frames::clear(&self.view, self.id);
            if let Ok(mut observed) = self.download_responses.lock() {
                observed.clear();
            }
            let _ = self.view.close();
        }
    }
}

impl std::ops::Deref for Session {
    type Target = GuestState;
    fn deref(&self) -> &Self::Target {
        &self.atomic
    }
}

#[derive(Default)]
struct GuestState {
    page_generation: AtomicU64,
    job: AtomicU64,
    closed: AtomicBool,
    ready: AtomicBool,
    visible: AtomicBool,
    capture: Mutex<Option<Arc<capture::Grant>>>,
    blocked: Mutex<Option<Url>>,
    download_responses: Mutex<download_network::Ledger>,
}

pub(crate) struct Service {
    home: PathBuf,
    last_id: AtomicU64,
    privacy_epoch: AtomicU64,
    views: Mutex<HashMap<u64, Arc<Session>>>,
    dns: DnsCache,
    slots: Arc<Semaphore>,
    capture_slot: Arc<Semaphore>,
    catalogue: Semaphore,
    catalogue_queue: Semaphore,
    catalogue_cache: Mutex<catalogue::SnapshotCache>,
    private_views: private_views::Registry,
}

fn failure(message: impl Into<String>) -> RpcError {
    RpcError::new("source", message)
}
fn invalid() -> RpcError {
    RpcError::new("invalid-input", "The source player request is invalid.")
}

pub(crate) fn handles(method: &str) -> bool {
    matches!(
        method,
        "site.surface"
            | "sources.match"
            | "sources.streams"
            | "sources.discover"
            | "sources.session"
            | "sources.clearSession"
            | "sources.catalogue"
            | "site.openEpisode"
            | "site.options"
            | "site.episodes"
            | "site.choose"
            | "site.focus"
            | "player.upscale"
            | "player.quantum"
            | "player.capturePrepare"
            | "player.captureStop"
            | "player.probe"
            | "player.control"
    )
}

impl Service {
    pub(crate) fn new(home: PathBuf) -> Self {
        Self {
            home,
            last_id: AtomicU64::new(1),
            privacy_epoch: AtomicU64::new(0),
            views: Mutex::new(HashMap::new()),
            dns: Arc::default(),
            slots: Arc::new(Semaphore::new(4)),
            capture_slot: Arc::new(Semaphore::new(1)),
            catalogue: Semaphore::new(1),
            catalogue_queue: Semaphore::new(8),
            catalogue_cache: Mutex::default(),
            private_views: private_views::Registry::default(),
        }
    }

    pub(crate) fn reset_source_sessions(&self) {
        self.privacy_epoch.fetch_add(1, Ordering::AcqRel);
        self.clear_catalogue_cache();
        let sessions = {
            let mut views = self.views();
            self.private_views.clear();
            std::mem::take(&mut *views)
        };
        for session in sessions.into_values() {
            session.close();
        }
    }

    fn clear_catalogue_cache(&self) {
        if let Ok(mut cache) = self.catalogue_cache.lock() {
            cache.clear();
        }
    }

    pub(crate) async fn list_incognito_sources(&self, root: &Path) -> Result<Value, RpcError> {
        let data = root.to_owned();
        let mut sources = tauri::async_runtime::spawn_blocking(move || all_sources(&data))
            .await
            .map_err(|_| failure("Could not read sources."))??;
        let lease = self
            .private_views
            .browse()
            .ok_or_else(|| failure("Close another private source session first."))?;
        set_private_partitions(&mut sources, lease);
        Ok(Value::Array(sources))
    }

    pub(crate) async fn watch_sources(
        &self,
        root: &Path,
        input: &Value,
    ) -> Result<Value, RpcError> {
        let media = input["mediaId"]
            .as_i64()
            .filter(|id| (1..=i32::MAX as i64).contains(id))
            .ok_or_else(invalid)?;
        let data = root.to_owned();
        let (is_private, mut sources) = tauri::async_runtime::spawn_blocking(move || {
            Ok::<_, RpcError>((profile::private_title(&data, media)?, all_sources(&data)?))
        })
        .await
        .map_err(|_| failure("Could not read source privacy."))??;
        let lease = if is_private {
            Some(
                self.private_views
                    .issue(media)
                    .ok_or_else(|| failure("Close another private source session first."))?,
            )
        } else {
            None
        };
        if let Some(lease) = lease {
            set_private_partitions(&mut sources, lease);
        }
        Ok(json!({"sources":sources,"leaseId":lease.map(|lease|lease.token.to_string())}))
    }

    pub(crate) fn release_private(&self, input: &Value) -> Result<Value, RpcError> {
        let token = input["leaseId"]
            .as_str()
            .and_then(|id| uuid::Uuid::parse_str(id).ok())
            .ok_or_else(invalid)?;
        self.private_views.revoke(token);
        self.views().retain(|_, session| {
            let keep = !session.lease.is_some_and(|lease| lease.token == token);
            if !keep {
                session.close();
            }
            keep
        });
        Ok(Value::Null)
    }

    fn views(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Arc<Session>>> {
        self.views.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub(crate) async fn request(
        &self,
        owner: &Webview,
        root: &Path,
        method: &str,
        input: Value,
    ) -> Result<Value, RpcError> {
        if method == "sources.catalogue" {
            return catalogue::load(self, owner, root, &input).await;
        }
        if crate::runtime_privacy::active()
            && matches!(
                method,
                "sources.discover" | "sources.session" | "sources.clearSession"
            )
        {
            return Err(failure(
                "Exit incognito to manage the saved source session.",
            ));
        }
        if matches!(method, "sources.session" | "sources.clearSession") {
            let source = session_source(root, input["id"].as_str().ok_or_else(invalid)?, false)?;
            let active = self
                .views()
                .values()
                .find(|view| view.source.id == source.id && view.lease.is_none())
                .cloned();
            let session = match active {
                Some(session) => session,
                None => {
                    self.create_view(
                        owner,
                        source,
                        Bounds {
                            x: 0.,
                            y: 0.,
                            width: 800.,
                            height: 600.,
                        },
                        true,
                    )
                    .await?
                }
            };
            let _guard = session.command.lock().await;
            if method == "sources.session" {
                return session_data::cookies(&session).await;
            }
            legacy_session::forget(root, &session.source)?;
            crate::desktop::clear_browsing_data(&session.view, true).await?;
            self.clear_catalogue_cache();
            return Ok(Value::Null);
        }
        if method == "sources.discover" {
            return discovery::discover(self, owner, root, &input).await;
        }
        if method == "sources.streams" {
            let source = resolve_source(root, input["sourceId"].as_str().ok_or_else(invalid)?)?;
            if source.kind == "web" {
                return Ok(json!([]));
            }
            let id = input["ref"]
                .as_str()
                .filter(|id| {
                    id.len() == 11
                        && id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                })
                .ok_or_else(|| RpcError::new("invalid-input", "Invalid YouTube video ID."))?;
            return Ok(json!([{"type":"youtube","videoId":id,"label":"YouTube · official embed"}]));
        }
        if method == "sources.match" {
            let id = input["sourceId"].as_str().ok_or_else(invalid)?;
            let source = resolve_source(root, id)?;
            let media = input["media"]["id"]
                .as_i64()
                .filter(|id| *id > 0)
                .ok_or_else(invalid)?;
            let pin = profile::saved_pin(root, id, media)?;
            return Ok(
                json!({"sourceId":source.id, "mode":"web","titleUrl":pin.as_ref().map(Url::as_str),
                "episodeUrls":{},"episodes":[],"pageUrl":pin.as_ref().unwrap_or(&source.base).as_str(),"pinned":pin.is_some(),"note":null}),
            );
        }
        if method == "site.surface" && input["action"] == "attach" {
            return self.attach(owner, root, &input).await;
        }
        if method == "player.captureStop" {
            return capture::stop(self, owner, &input);
        }
        let id = input["webContentsId"].as_u64().ok_or_else(invalid)?;
        let session = self
            .views()
            .get(&id)
            .cloned()
            .ok_or_else(|| failure("The source page was closed."))?;
        if session.view.window().label() != owner.window().label()
            || session.closed.load(Ordering::Relaxed)
        {
            return Err(failure("This window does not own the source page."));
        }
        if input["sourceId"]
            .as_str()
            .is_some_and(|id| id != session.source.id)
        {
            return Err(invalid());
        }
        if method == "site.surface" {
            return self.surface(owner, &session, &input).await;
        }
        if method == "site.openEpisode" {
            let job = session.job.fetch_add(1, Ordering::AcqRel) + 1;
            if let Ok(mut observed) = session.download_responses.lock() {
                observed.clear();
            }
            let _guard = session.command.lock().await;
            quantum::stop(&session).await;
            return navigation::open(owner, root, &session, &input, job).await;
        }
        let _guard = session.command.lock().await;
        let result = match method {
            "site.options" => navigation::options(&session, None).await?.0,
            "site.episodes" => navigation::episodes(owner, &session).await,
            "site.choose" => {
                quantum::stop(&session).await;
                navigation::choose(owner, &session, &input).await?
            }
            "site.focus" => {
                let on = input["on"].as_bool().ok_or_else(invalid)?;
                if !on {
                    quantum::stop(&session).await;
                    capture::revoke_mirror(&session);
                }
                json!({"focused": navigation::focus(&session, on).await?})
            }
            "player.upscale" => upscale::apply(&session, &input["options"]).await?,
            "player.quantum" => quantum::request(&session, &input).await?,
            "player.capturePrepare" => capture::prepare(self, owner, &session).await?,
            "player.probe" => navigation::probe(&session).await,
            "player.control" => json!(navigation::control(&session, &input).await?),
            _ => return Err(invalid()),
        };
        Ok(result)
    }

    async fn attach(&self, owner: &Webview, root: &Path, input: &Value) -> Result<Value, RpcError> {
        let epoch = self.privacy_epoch.load(Ordering::Acquire);
        let source = resolve_source(root, input["sourceId"].as_str().ok_or_else(invalid)?)?;
        let partition = input["partition"].as_str().ok_or_else(invalid)?;
        let lease = self.private_views.resolve(partition, &source.id);
        if let Some(media) = input.get("mediaId").filter(|value| !value.is_null()) {
            let media = media
                .as_i64()
                .filter(|id| (1..=i32::MAX as i64).contains(id))
                .ok_or_else(invalid)?;
            if lease.map(|lease| lease.media_id)
                != profile::private_title(root, media)?.then_some(media)
            {
                return Err(failure("This title needs its matching source session."));
            }
        }
        if lease.is_none()
            && (crate::runtime_privacy::active()
                || partition != format!("persist:src-{}", source.id)
                    && !(youtube(&source.base) && input["partition"] == "persist:src-youtube"))
        {
            return Err(failure(
                "This source session is not available in the Windows player.",
            ));
        }
        let bounds = read_bounds(input)?;
        let session = self
            .create_configured_view(owner, source, bounds, false, false, lease)
            .await?;
        let id = session.id;
        let mut views = self.views();
        if epoch != self.privacy_epoch.load(Ordering::Acquire)
            || lease.is_some_and(|lease| !self.private_views.contains(lease))
        {
            return Err(failure("The private source lease expired."));
        }
        views.insert(id, session);
        Ok(json!({"webContentsId":id}))
    }

    async fn create_view(
        &self,
        owner: &Webview,
        source: Source,
        bounds: Bounds,
        hidden: bool,
    ) -> Result<Arc<Session>, RpcError> {
        self.create_configured_view(owner, source, bounds, hidden, false, None)
            .await
    }

    async fn create_discovery_view(
        &self,
        owner: &Webview,
        source: Source,
    ) -> Result<Arc<Session>, RpcError> {
        self.create_configured_view(
            owner,
            source,
            Bounds {
                x: 0.,
                y: 0.,
                width: 950.,
                height: 700.,
            },
            true,
            true,
            None,
        )
        .await
    }

    async fn create_configured_view(
        &self,
        owner: &Webview,
        source: Source,
        bounds: Bounds,
        hidden: bool,
        discovery: bool,
        lease: Option<private_views::Lease>,
    ) -> Result<Arc<Session>, RpcError> {
        if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_some() {
            return Err(failure("Remove the shared WebView2 data-folder override before opening an isolated source."));
        }
        let slot = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| failure("Close another source page before opening this one."))?;
        // The source view may issue requests as soon as it is attached.
        // Join the one-time restore before creating it, even at cold startup.
        owner
            .state::<crate::adblocker::Service>()
            .ensure_ready()
            .await;
        let id = self.last_id.fetch_add(1, Ordering::Relaxed);
        let state = Arc::new(GuestState::default());
        let guard = state.clone();
        let load = state.clone();
        let base = source.base.clone();
        let emitter = owner.clone();
        let popup_app = owner.app_handle().clone();
        let popup_source = source.id.clone();
        let temporary_profile = if discovery || lease.is_some() {
            std::fs::create_dir_all(&self.home)
                .map_err(|_| failure("Could not prepare discovery storage."))?;
            Some(
                tempfile::Builder::new()
                    .prefix(".discovery-")
                    .tempdir_in(&self.home)
                    .map_err(|_| failure("Could not isolate source discovery."))?,
            )
        } else {
            None
        };
        let directory = temporary_profile
            .as_ref()
            .map(|folder| folder.path().to_owned())
            .unwrap_or_else(|| self.home.join(&source.id));
        let initial = Url::parse("about:blank").expect("valid blank URI");
        let view = owner.window().add_child(
            WebviewBuilder::new(format!("source-{id}"), WebviewUrl::External(initial))
                .incognito(discovery || lease.is_some())
                .data_directory(dunce::simplified(&directory).to_owned())
                .on_new_window(move|_,_|{
                    if !crate::runtime_privacy::active() && lease.is_none(){
                       if let Some(service)=popup_app.try_state::<crate::adblocker::Service>(){
                          service.count(&popup_source,crate::adblocker::Denial::Popup);
                       }
                    }
                    NewWindowResponse::Deny
                })
                .on_download(|_, _| false)
                .on_navigation(move |url| {
                    if guard.closed.load(Ordering::Relaxed) { return false; }
                    if allowed_top(url,&base) && (!discovery || url.as_str()=="about:blank" || url.origin()==base.origin()) {return true;}
                    if let Ok(mut blocked) = guard.blocked.lock() { *blocked = Some(url.clone()); }
                    if !hidden { let _ = emitter.emit(SURFACE_EVENT, json!({"webContentsId":id,"blocked":true,"finished":true})); }
                    false
                })
                .on_page_load({
                    let owner = owner.clone();
                    move |view, event| {
                        let finished = matches!(event.event(), PageLoadEvent::Finished);
                        if !finished {
                            load.page_generation.fetch_add(1, Ordering::Relaxed);
                            if let Ok(mut observed) = load.download_responses.lock() {
                                observed.clear();
                            }
                            capture::revoke(&view, &load.capture, None);
                        }
                        load.ready.store(finished, Ordering::Release);
                        if !hidden { let _ = owner.emit(SURFACE_EVENT, json!({"webContentsId":id,"url":event.url().as_str(),"finished":finished})); }
                    }
                }),
            LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width, bounds.height),
        ).map_err(|_| failure("Could not open the Windows source view."))?;
        let _ = view.hide();
        if let Err(error) = native::install_guards(
            &view,
            owner.app_handle().clone(),
            source.base.clone(),
            source.id.clone(),
            self.dns.clone(),
            hidden,
            !hidden && !discovery && lease.is_none(),
            (!hidden).then(|| (id, state.clone())),
            !hidden && !discovery && lease.is_none() && source.kind == "web",
        )
        .await
        {
            let _ = view.close();
            return Err(error);
        }
        if !hidden && !discovery && lease.is_none() && !crate::runtime_privacy::active() {
            legacy_session::restore(&view, &source, &directory).await;
        }
        Ok(Arc::new(Session {
            view,
            source,
            id,
            atomic: state,
            world: Mutex::new(None),
            active_episode: Mutex::new(None),
            quantum: Mutex::new(None),
            audio_frame: tokio::sync::Mutex::new(None),
            command: tokio::sync::Mutex::new(()),
            focus: AtomicBool::new(false),
            lease,
            _temporary_profile: temporary_profile,
            _slot: slot,
        }))
    }

    async fn surface(
        &self,
        owner: &Webview,
        session: &Session,
        input: &Value,
    ) -> Result<Value, RpcError> {
        let action = input["action"].as_str().ok_or_else(invalid)?;
        match action {
            "place" => {
                let bounds = read_bounds(input)?;
                let visible = input["visible"].as_bool().ok_or_else(invalid)?;
                if visible {
                    let viewport = if let Some(raw) = input.get("viewport") {
                        serde_json::from_value::<Bounds>(raw.clone())
                            .ok()
                            .filter(|viewport| viewport.dimensions_valid() && viewport.contains(&bounds))
                            .ok_or_else(invalid)?
                    } else {
                        bounds
                    };
                    if let Err(error) = native::place(&session.view, viewport, bounds).await {
                        session.visible.store(false, Ordering::Release);
                        capture::revoke(&session.view, &session.capture, None);
                        let _ = session.view.hide();
                        return Err(error);
                    }
                    if !session.visible.swap(true, Ordering::AcqRel) {
                        let _ = session.view.show();
                    }
                } else if session.visible.swap(false, Ordering::AcqRel) {
                    // Leaving the viewport should not resize the hidden site's layout.
                    capture::revoke(&session.view, &session.capture, None);
                    let _ = session.view.hide();
                }
            }
            "detach" => {
                session.close();
                self.views().remove(&session.id);
            }
            "navigate" => {
                let target = Url::parse(input["url"].as_str().ok_or_else(invalid)?)
                    .map_err(|_| invalid())?;
                navigate(session, target)?;
            }
            "reload" => {
                let _ = session.view.reload();
            }
            "back" | "forward" | "stop" => {
                let code = match action {
                    "back" => "history.back()",
                    "forward" => "history.forward()",
                    _ => "window.stop()",
                };
                native::evaluate(session, code.into()).await?;
            }
            #[cfg(feature = "isolated-test")]
            "probeDiagnostics" => return navigation::probe_diagnostics(session).await,
            "downloadMedia" => return download::request(owner, session, input).await,
            "directMp4" => {
                let current = session.view.url().ok().filter(|url| {
                    url.query().is_none()
                        && aniverse_security::allows_public_mp4(
                            url.as_str(),
                            session.source.base.as_str(),
                        )
                });
                return Ok(json!(current.map(|url| url.to_string())));
            }
            "external" => {
                let url = session
                    .view
                    .url()
                    .map_err(|_| failure("The source page was closed."))?;
                if !matches!(url.scheme(), "https" | "http")
                    || !allowed_top(&url, &session.source.base)
                {
                    return Err(invalid());
                }
                crate::sources::open_in_windows(std::ffi::OsStr::new(url.as_str()))
                    .map_err(|_| failure("Could not open the source in your browser."))?;
            }
            "redirect" => {
                let blocked = session.blocked.lock().ok().and_then(|url| url.clone());
                let destination = blocked.and_then(|url| {
                    destination(owner.state::<PathBuf>().inner(), &session.source, &url)
                });
                return Ok(json!(destination));
            }
            _ => return Err(invalid()),
        }
        Ok(Value::Null)
    }
}

fn read_bounds(input: &Value) -> Result<Bounds, RpcError> {
    let bounds: Bounds = serde_json::from_value(input["bounds"].clone()).map_err(|_| invalid())?;
    if !bounds.valid() {
        return Err(invalid());
    }
    Ok(bounds)
}

fn set_private_partitions(sources: &mut [Value], lease: private_views::Lease) {
    for source in sources {
        if let Some(id) = source["id"].as_str() {
            source["partition"] = Value::from(format!("private-{}-{id}", lease.token));
        }
    }
}

fn all_sources(root: &Path) -> Result<Vec<Value>, RpcError> {
    match profile::request(root, "sources.list", Value::Null)? {
        Value::Array(entries) => Ok(entries),
        _ => Err(failure("The source list is unavailable.")),
    }
}

fn resolve_source(root: &Path, id: &str) -> Result<Source, RpcError> {
    session_source(root, id, true)
}
fn session_source(root: &Path, id: &str, enabled: bool) -> Result<Source, RpcError> {
    if id.is_empty()
        || id.len() > 180
        || !id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err(invalid());
    }
    let item = all_sources(root)?
        .into_iter()
        .find(|item| item["id"] == id && (!enabled || item["enabled"] == true))
        .ok_or_else(|| failure("This configured source is disabled or missing."))?;
    let base = Url::parse(item["url"].as_str().ok_or_else(invalid)?).map_err(|_| invalid())?;
    if !matches!(base.scheme(), "https" | "http")
        || !aniverse_security::allows_source_network(base.as_str(), "") && !fixture_source(&base)
    {
        return Err(failure(
            "This source URL is not allowed by the Windows player.",
        ));
    }
    Ok(Source {
        id: id.to_owned(),
        name: item["name"].as_str().unwrap_or(id).to_owned(),
        kind: item["kind"].as_str().unwrap_or_default().to_owned(),
        base,
        search: item["searchTemplate"].as_str().map(str::to_owned),
    })
}

fn youtube(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("www.youtube.com" | "youtube.com" | "m.youtube.com")
    )
}

fn allowed_top(url: &Url, base: &Url) -> bool {
    url.as_str() == "about:blank"
        || aniverse_security::allows_source_navigation(url.as_str(), base.as_str())
}

fn navigate(session: &Session, url: Url) -> Result<(), RpcError> {
    if !allowed_top(&url, &session.source.base) {
        return Err(failure(
            "The source redirected outside its configured site.",
        ));
    }
    if url.scheme() == "https" && !session.browsing_private() {
        let root = session.view.state::<PathBuf>();
        // Native cookie writes finish before any regular guest can contact this source.
        legacy_session::forget(root.inner(), &session.source)?;
    }
    session.ready.store(false, Ordering::Release);
    session.page_generation.fetch_add(1, Ordering::Relaxed);
    session
        .view
        .navigate(url)
        .map_err(|_| failure("Could not navigate the source page."))
}

fn destination(root: &Path, source: &Source, target: &Url) -> Option<String> {
    if !fixture_source(target)
        && (target.scheme() != "https"
            || !aniverse_security::allows_source_network(target.as_str(), ""))
    {
        return None;
    }
    all_sources(root).ok()?.iter().find_map(|entry| {
        let id = entry["id"].as_str()?;
        let configured = Url::parse(entry["url"].as_str()?).ok()?;
        (id != source.id && entry["enabled"] == true && configured.origin() == target.origin())
            .then(|| id.to_owned())
    })
}

pub(crate) fn fixture_source(url: &Url) -> bool {
    #[cfg(feature = "isolated-test")]
    {
        use std::net::IpAddr;
        return url.scheme() == "http"
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_some()
            && url
                .host_str()
                .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok())
                .is_some_and(|ip| ip.is_loopback())
            && [
                "ANIVERSE2_TEST_SITE_ORIGIN",
                "ANIVERSE2_TEST_REDIRECT_ORIGIN",
            ]
            .iter()
            .any(|key| {
                std::env::var(key).is_ok_and(|origin| origin == url.origin().ascii_serialization())
            });
    }
    #[cfg(not(feature = "isolated-test"))]
    {
        let _ = url;
        false
    }
}

async fn page(session: &Session, input: Value) -> Result<Value, RpcError> {
    native::evaluate(session, format!("globalThis.__avSitePage({input})")).await
}

fn status(owner: &Webview, session: &Session, message: Option<&str>) {
    let _ = owner.emit(
        STATUS_EVENT,
        json!({"webContentsId":session.id, "sourceId":session.source.id, "message":message}),
    );
}
