#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod adblocker;
mod desktop;
mod downloads;
#[cfg(feature = "installer-handoff")]
mod incoming;
mod integrations;
mod local_player;
mod metadata;
mod migration_boot;
mod patterns;
mod player;
mod profile;
mod profile_image;
mod runtime_privacy;
mod sources;
mod ui_rendering;
mod updates;

use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use tauri::{
    webview::NewWindowResponse, Manager, State, Url, Webview, WebviewUrl, WebviewWindowBuilder,
};

const MAIN: &str = "main";
const BRIDGE: &str = include_str!("desktop-bridge.js");
const PALETTES: &str = include_str!("../../../assets/aniverse2/palettes.css");

#[derive(Debug, thiserror::Error, Serialize)]
#[error("{message}")]
struct RpcError {
    code: &'static str,
    message: String,
}

impl RpcError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

fn app_origin(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("tauri.localhost")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

#[tauri::command]
async fn desktop_rpc(
    window: Webview,
    root: State<'_, PathBuf>,
    metadata: State<'_, metadata::Client>,
    updater: State<'_, updates::Service>,
    patterns: State<'_, patterns::Service>,
    player: State<'_, player::Service>,
    downloads: State<'_, downloads::Service>,
    local: State<'_, local_player::Service>,
    method: String,
    input: Option<Value>,
) -> Result<Value, RpcError> {
    if window.label() != MAIN
        || window.window().label() != MAIN
        || !window.url().is_ok_and(|url| app_origin(&url))
    {
        return Err(RpcError::new(
            "unauthorised",
            "The request did not come from the AniVerse2 window.",
        ));
    }
    let root = root.inner().clone();
    let app = window.app_handle();
    if let Some(boot) = app.try_state::<migration_boot::Probe>() {
        match method.as_str() {
            "migration.preferenceKeys" => {
                let preferences = profile::renderer_preferences(&root)
                    .map_err(|_| RpcError::new("migration", "Could not read migrated interface preferences."))?;
                let keys: serde_json::Map<String, Value> = serde_json::from_str(&preferences)
                    .map_err(|_| RpcError::new("migration", "Could not read migrated interface preferences."))?;
                return Ok(serde_json::json!(keys.keys().collect::<Vec<_>>()));
            }
            "migration.ready" => {
                boot.complete(input.as_ref())?;
                app.exit(0);
                return Ok(Value::Null);
            }
            "settings.get" | "sources.list" | "library.history" => {}
            _ => return Err(RpcError::new("migration", "This request is unavailable during the migration check.")),
        }
    }
    if desktop::handles(&method) {
        return desktop::request(
            &window,
            &root,
            &metadata,
            &method,
            &input.unwrap_or_default(),
        )
        .await;
    }
    if profile_image::handles(&method) {
        let mut result = tauri::async_runtime::spawn_blocking(move || {
            profile_image::update(&root, &method, &input.unwrap_or_default())
        })
        .await
        .map_err(|_| RpcError::new("internal", "The profile image update was interrupted."))??;
        result["updates"] = updater.preferences();
        return Ok(result);
    }
    if profile::workspace_handles(&method) {
        let mut result = profile::workspace_request(
            &window,
            &root,
            &metadata,
            &local,
            &method,
            input.unwrap_or_default(),
        )
        .await?;
        if method == "themes.apply" {
            profile_image::decorate(&root, &mut result);
            result["updates"] = updater.preferences();
        }
        return Ok(result);
    }
    if integrations::handles(&method) {
        return window
            .state::<integrations::Service>()
            .request(&window, &root, &method, input.as_ref())
            .await;
    }
    if player::handles(&method) {
        return player
            .request(&window, &root, &method, input.unwrap_or_default())
            .await;
    }
    let update_preferences = method == "settings.set"
        && input
            .as_ref()
            .and_then(Value::as_object)
            .is_some_and(|patch| patch.len() == 1 && patch.contains_key("updates"));
    match method.as_str() {
        "player.openFile" => return local.open_file(&window).await,
        "player.openSubtitles" => return local.open_subtitles(&window).await,
        "player.releaseFile" => return local.release(input.as_ref()),
        "player.mp4Folder" => return downloads.folder(&window, input.as_ref()).await,
        "player.saveMp4" => return downloads.save(&window, input.as_ref(), &root).await,
        "update.state" => return Ok(updater.snapshot()),
        "update.check" => return updater.check(app).await,
        "update.download" => return updater.download(app).await,
        "update.install" => return updater.install().await,
        "app.openExternal" => {
            return tauri::async_runtime::spawn_blocking(move || {
                sources::open_external(&root, input.as_ref())
            })
            .await
            .map_err(|_| RpcError::new("internal", "Opening the link was interrupted."))?;
        }
        "privacy.incognito" => {
            let on = input
                .as_ref()
                .and_then(|input| input["on"].as_bool())
                .ok_or_else(|| RpcError::new("invalid-input", "Choose an incognito state."))?;
            let mut state = profile::request(&root, "privacy.state", Value::Null)?;
            if on != runtime_privacy::active() {
                runtime_privacy::set_active(on);
                player.reset_source_sessions();
                metadata.clear_cache();
                window
                    .state::<profile::WorkspaceState>()
                    .reset_observation();
                state["incognito"] = Value::Bool(on);
                let _ = tauri::Emitter::emit(&window, "aniverse:privacy/changed", &state);
                let sources = if on {
                    player.list_incognito_sources(&root).await
                } else {
                    profile::request(&root, "sources.list", Value::Null)
                };
                if let Ok(sources) = sources {
                    let _ = tauri::Emitter::emit(&window, "aniverse:sources/changed", sources);
                }
            }
            return Ok(state);
        }
        "sources.list" | "sources.reload" if runtime_privacy::active() => {
            return player.list_incognito_sources(&root).await
        }
        "privacy.title" => {
            let state = tauri::async_runtime::spawn_blocking(move || {
                desktop::set_title_privacy(&root, &input.unwrap_or_default())
            })
            .await
            .map_err(|_| RpcError::new("internal", "The privacy update was interrupted."))??;
            player.reset_source_sessions();
            window
                .state::<profile::WorkspaceState>()
                .reset_observation();
            let _ = tauri::Emitter::emit(&window, "aniverse:privacy/changed", &state);
            return Ok(state);
        }
        "privacy.watchSources" => {
            return player
                .watch_sources(&root, &input.unwrap_or_default())
                .await
        }
        "privacy.releaseSources" => return player.release_private(&input.unwrap_or_default()),
        "sources.audio" | "sources.hoverAudio" => {
            if runtime_privacy::active() {
                return Ok(if method == "sources.audio" {
                    serde_json::json!({})
                } else {
                    Value::Null
                });
            }
            let (sources, private) =
                tauri::async_runtime::spawn_blocking(move || profile::audio_context(&root))
                    .await
                    .map_err(|_| {
                        RpcError::new("internal", "Could not read source availability.")
                    })??;
            if method == "sources.audio" {
                return Ok(patterns.observed(&sources, &private));
            }
            let input = input.unwrap_or_default();
            let source = input["sourceId"]
                .as_str()
                .ok_or_else(|| RpcError::new("invalid-input", "Choose an enabled source."))?;
            let media = input["mediaId"]
                .as_i64()
                .filter(|id| (1..=i32::MAX as i64).contains(id))
                .ok_or_else(|| RpcError::new("invalid-input", "Choose a title."))?;
            let audio = sources
                .get(source)
                .filter(|_| !private.contains(&media))
                .map_or(Value::Null, |origin| patterns.hover(source, origin, media));
            return Ok(audio);
        }
        "adblock.stats" | "adblock.update" => return adblocker::request(&window, &method).await,
        "app.setUiRendering" => {
            return ui_rendering::request(&window, input.unwrap_or_default()).await
        }
        "app.info" => {
            return Ok(serde_json::json!({
                "version": app.package_info().version.to_string(), "tauri": tauri::VERSION,
                "webview2": tauri::webview_version().ok(),
                "platform": "win32",
                "uiRendering": window.state::<ui_rendering::Service>().snapshot(),
                "dataPath": root,
                "configPath": root.join("config/streaming-sites.txt"),
            }))
        }
        "settings.set" if update_preferences => updater.set_preferences(input.as_ref())?,
        _ => {}
    }
    let settings = matches!(method.as_str(), "settings.get" | "settings.set");
    let settings_write = method == "settings.set";
    let source_write = method == "sources.update";
    let reset_insights = method == "settings.set"
        && input
            .as_ref()
            .is_some_and(|input| input["privacy"]["watchInsights"].is_boolean());
    if let Some(request) = metadata::Request::parse(&method, input.as_ref()) {
        let request = request?;
        let exclude_library = request.excludes_library();
        let (show_adult, excluded_ids) = tauri::async_runtime::spawn_blocking(move || {
            profile::metadata_preferences(&root, exclude_library)
        })
        .await
        .map_err(|_| RpcError::new("internal", "Could not read metadata preferences."))??;
        return metadata.get(request, show_adult, excluded_ids).await;
    }
    let mut result = tauri::async_runtime::spawn_blocking(move || {
        let method = if update_preferences {
            "settings.get"
        } else {
            &method
        };
        let mut value = profile::request(&root, method, input.unwrap_or_default())?;
        if settings {
            profile_image::decorate(&root, &mut value);
        }
        Ok::<Value, RpcError>(value)
    })
    .await
    .map_err(|_| RpcError::new("internal", "The desktop request was interrupted."))??;
    if settings_write {
        if let Some(enabled) = result["privacy"]["adblock"].as_bool() {
            window.state::<adblocker::Service>().set_enabled(enabled);
        }
    }
    if source_write {
        if let (Some(id), Some(enabled)) = (result["id"].as_str(), result["adblock"].as_bool()) {
            window.state::<adblocker::Service>().set_source(id, enabled);
        }
    }
    if reset_insights {
        window
            .state::<profile::WorkspaceState>()
            .reset_observation();
    }
    if settings {
        result["updates"] = updater.preferences();
    }
    Ok(result)
}

fn run(context: tauri::Context<tauri::Wry>, checking: bool) -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("localmedia", local_player::respond)
        .invoke_handler(tauri::generate_handler![desktop_rpc])
        .setup(move |app| {
            let profile = profile_path(app)?;
            let (root, data) = if checking {
                let boot = migration_boot::Probe::load(&profile)?;
                let paths = (boot.home.clone(), boot.data.clone());
                app.manage(boot);
                paths
            } else {
                app.manage(migration_boot::profile_lock(&profile, false)?);
                let data = app_data(&profile).unwrap_or_else(|error| {
                    eprintln!("AniVerse2 could not prepare the profile: {error}");
                    std::process::exit(1)
                });
                (profile, data)
            };
            let first_run = profile::renderer_preferences(&data)?;
            let palettes = serde_json::to_string(PALETTES)?;
            let mut startup = format!(r#"
                {BRIDGE}
                (() => {{
                    if (window !== window.top || location.origin !== 'https://tauri.localhost') return;
                    for (const [key, value] of Object.entries({first_run})) {{
                        if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
                    }}
                    const sheet = new CSSStyleSheet();
                    sheet.replaceSync({palettes});
                    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
                    const setEdition = () => {{
                        document.documentElement.dataset.aniverseEdition = '2';
                        const saved = localStorage.getItem('aniverse2.palette');
                        document.documentElement.dataset.aniverse2Theme = ['ion', 'copper', 'wisteria', 'legacy'].includes(saved)
                            ? saved : localStorage.getItem('aniverse.desktop-theme') === 'midnight' ? 'legacy' : 'ion';
                        document.title = 'AniVerse2';
                    }};
                    if (document.documentElement) setEdition();
                    else document.addEventListener('DOMContentLoaded', setEdition, {{ once: true }});
                }})();
            "#);
            if checking {
                startup.push_str(migration_boot::SCRIPT);
            }
            let webview = root.join("webview");
            app.manage(updates::Service::new(app.handle(), &root, &data)?);
            let (rendering, rendering_arguments) = ui_rendering::Service::startup(&data);
            app.manage(rendering);
            app.manage(patterns::Service::new(&data));
            app.manage(player::Service::new(root.join("site-webviews")));
            app.manage(local_player::Service::default());
            app.manage(profile::WorkspaceState::default());
            app.manage(adblocker::Service::new(&data));
            app.manage(integrations::Service::new()?);
            app.manage(downloads::Service::new(&root, &data));
            app.manage(data);
            app.manage(metadata::Client::new()?);
            let initial = if checking {
                WebviewUrl::External(Url::parse("about:blank")?)
            } else {
                WebviewUrl::App("index.html".into())
            };
            let window = WebviewWindowBuilder::new(app, MAIN, initial)
                .title(app.config().product_name.as_deref().unwrap_or("AniVerse2"))
                .inner_size(1280.0, 860.0)
                .decorations(false)
                .visible(!checking && !cfg!(feature = "isolated-test"))
                .use_https_scheme(true)
                .initialization_script(startup)
                .data_directory(dunce::simplified(&webview).to_owned())
                .on_navigation(move |url| app_origin(url) || (checking && url.as_str() == "about:blank"))
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
            drop(rendering_arguments);
            if checking {
                migration_boot::start(&window, webview)?;
            } else {
                updates::start(app.handle());
                adblocker::start(app.handle());
            }
            Ok(())
        })
        .run(context)
}

#[cfg(not(feature = "isolated-test"))]
fn profile_path(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(app.path().app_data_dir()?)
}

#[cfg(feature = "isolated-test")]
fn profile_path(_: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    isolated_profile_path()
}

#[cfg(feature = "isolated-test")]
fn isolated_profile_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let cache = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/cache/aniverse2")
        .canonicalize()?;
    let path = PathBuf::from(
        std::env::var_os("ANIVERSE2_TEST_PROFILE").ok_or("missing isolated test profile")?,
    )
    .canonicalize()?;
    if path == cache || !path.starts_with(cache) {
        return Err("the test profile must be in the AniVerse2 test cache".into());
    }
    Ok(path)
}

#[cfg(not(feature = "installer-handoff"))]
fn app_data(root: &std::path::Path) -> std::io::Result<PathBuf> {
    Ok(root.to_path_buf())
}

#[cfg(feature = "installer-handoff")]
fn app_data(root: &std::path::Path) -> std::io::Result<PathBuf> {
    incoming::data_root(root)
}

fn main() {
    let marker = std::env::var_os("ANIVERSE_ELECTRON_HANDOFF");
    let mode = std::env::args_os().nth(1);
    let preparing = mode.as_deref().is_some_and(|arg| arg == "--prepare-legacy-profile");
    let checking = mode.as_deref().is_some_and(|arg| arg == migration_boot::ARG);
    let startup_error = if preparing && (!cfg!(feature = "installer-handoff") || marker.is_none()) {
        Some("profile preparation requires a signed AniVerse installer handoff")
    } else if checking && !cfg!(feature = "installer-handoff") {
        Some("profile verification requires the AniVerse2 migration worker")
    } else if !preparing && marker.is_some() {
        Some("this launcher is not the AniVerse installer handoff worker")
    } else if !cfg!(feature = "isolated-test")
        && std::env::var_os("ANIVERSE2_TEST_PROFILE").is_some()
    {
        Some("the normal launcher cannot use an isolated test profile")
    } else {
        None
    };
    if let Some(error) = startup_error {
        eprintln!("AniVerse2 could not start: {error}");
        std::process::exit(1);
    }
    let context = tauri::generate_context!();
    #[cfg(feature = "installer-handoff")]
    if preparing {
        if let Err(error) = incoming::prepare(
            context.config().identifier.as_str(),
            marker.as_deref().unwrap(),
        ) {
            eprintln!("AniVerse2 could not prepare the profile: {error}");
            std::process::exit(1);
        }
        return;
    }
    if let Err(error) = run(context, checking) {
        eprintln!("AniVerse2 could not start: {error}");
        std::process::exit(1);
    }
}
