#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "installer-handoff")]
mod incoming;
mod profile;
mod sources;

use serde::Serialize;
use serde_json::Value;
use std::{fs, path::PathBuf};
use tauri::{
    webview::NewWindowResponse, Manager, State, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
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
    window: WebviewWindow,
    root: State<'_, PathBuf>,
    method: String,
    input: Option<Value>,
) -> Result<Value, RpcError> {
    if window.label() != MAIN || !window.url().is_ok_and(|url| app_origin(&url)) {
        return Err(RpcError::new(
            "unauthorised",
            "The request did not come from the AniVerse2 window.",
        ));
    }
    let root = root.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        profile::request(&root, &method, input.unwrap_or_default())
    })
    .await
    .map_err(|_| RpcError::new("internal", "The desktop request was interrupted."))?
}

fn run(context: tauri::Context<tauri::Wry>) -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![desktop_rpc])
        .setup(|app| {
            let root = profile_path(app)?;
            fs::create_dir_all(&root)?;
            let data = match app_data(&root) {
                Ok(data) => data,
                Err(error) => {
                    eprintln!("AniVerse2 could not prepare the profile: {error}");
                    std::process::exit(1);
                }
            };
            let first_run = profile::renderer_preferences(&data)?;
            let palettes = serde_json::to_string(PALETTES)?;
            let startup = format!(r#"
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
            let webview = root.join("webview");
            app.manage(data);
            WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
                .title(app.config().product_name.as_deref().unwrap_or("AniVerse2"))
                .inner_size(1280.0, 860.0)
                .visible(!cfg!(feature = "isolated-test"))
                .use_https_scheme(true)
                .initialization_script(startup)
                .data_directory(webview)
                .on_navigation(app_origin)
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
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
    let preparing = std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "--prepare-legacy-profile");
    let startup_error = if preparing && (!cfg!(feature = "installer-handoff") || marker.is_none()) {
        Some("profile preparation requires a signed AniVerse installer handoff")
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
    if let Err(error) = run(context) {
        eprintln!("AniVerse2 could not start: {error}");
        std::process::exit(1);
    }
}
