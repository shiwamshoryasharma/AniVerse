use crate::{app_origin, profile, RpcError};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, Url, WebviewWindow};
use webview2_com::{
    take_pwstr, Microsoft::Web::WebView2::Win32::*, WebResourceRequestedEventHandler,
};
use windows::core::{w, Interface, PWSTR};
use windows::Win32::System::Com::IStream;

pub(crate) const ARG: &str = "--verify-legacy-profile";
pub(crate) const SCRIPT: &str = include_str!("migration_boot.js");
const PROFILE: &str = "ANIVERSE2_BOOT_PROFILE";
const HOME: &str = "ANIVERSE2_BOOT_HOME";
const TOKEN: &str = "ANIVERSE2_BOOT_TOKEN";

pub(crate) struct Probe {
    pub(crate) data: PathBuf,
    pub(crate) home: PathBuf,
    token: uuid::Uuid,
    used: AtomicBool,
}

impl Probe {
    pub(crate) fn load(root: &Path) -> io::Result<Self> {
        let root = root.canonicalize()?;
        let folder = |key: &str, prefix| -> io::Result<PathBuf> {
            let path = std::env::var_os(key)
                .map(PathBuf::from)
                .ok_or_else(invalid)?;
            let resolved = path.canonicalize()?;
            if resolved.parent() != Some(root.as_path())
                || !resolved
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(prefix))
            {
                return Err(invalid());
            }
            Ok(resolved)
        };
        Ok(Self {
            data: folder(PROFILE, ".aniverse-profile-")?,
            home: folder(HOME, ".aniverse-boot-")?,
            used: AtomicBool::new(false),
            token: std::env::var(TOKEN)
                .ok()
                .and_then(|s| uuid::Uuid::parse_str(&s).ok())
                .ok_or_else(invalid)?,
        })
    }

    /// Only the bundled app window reaches this RPC, and only during the probe.
    pub(crate) fn complete(&self, input: Option<&Value>) -> Result<(), RpcError> {
        let fail = |_| {
            RpcError::new(
                "migration",
                "The migrated profile could not be verified in AniVerse2.",
            )
        };
        let settings = profile::request(&self.data, "settings.get", Value::Null)?;
        let sources = profile::request(&self.data, "sources.list", Value::Null)?;
        let history = profile::request(
            &self.data,
            "library.history",
            json!({"limit":200,"offset":0}),
        )?;
        let preferences: Value =
            serde_json::from_str(&profile::renderer_preferences(&self.data).map_err(fail)?)
                .map_err(|_| fail(invalid()))?;
        let ordered = |rows: &Value, is_history| -> io::Result<Vec<String>> {
            let mut ids = rows
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .map(|row| {
                    if is_history {
                        row["id"]
                            .as_i64()
                            .map(|id| id.to_string())
                            .ok_or_else(invalid)
                    } else {
                        row["id"].as_str().map(str::to_owned).ok_or_else(invalid)
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            ids.sort_unstable();
            Ok(ids)
        };
        let expected = json!([
            settings["profile"]["name"]
                .as_str()
                .ok_or_else(|| fail(invalid()))?,
            ordered(&sources, false).map_err(fail)?,
            ordered(&history, true).map_err(fail)?,
            preferences,
        ]);
        let bytes = serde_json::to_vec(&expected).map_err(|_| fail(invalid()))?;
        let digest = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if input.and_then(Value::as_str) != Some(digest.as_str())
            || self.used.swap(true, Ordering::AcqRel)
        {
            return Err(fail(invalid()));
        }
        let mut pipe = io::stdout().lock();
        writeln!(pipe, "{}", self.token.simple()).map_err(fail)?;
        pipe.flush().map_err(fail)
    }
}

pub(crate) fn profile_lock(root: &Path, exclusive: bool) -> io::Result<File> {
    fs::create_dir_all(root)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(".profile-use"))?;
    if exclusive {
        lock.try_lock()?;
    } else {
        lock.try_lock_shared()?;
    }
    Ok(lock)
}

#[cfg(feature = "installer-handoff")]
pub(crate) fn verify(root: &Path, profile: &Path, application: &Path) -> io::Result<()> {
    let home = tempfile::Builder::new()
        .prefix(".aniverse-boot-")
        .tempdir_in(root)?;
    let token = uuid::Uuid::new_v4();
    let mut command = Command::new(application);
    for (name, _) in std::env::vars_os() {
        if name
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("WEBVIEW2_")
        {
            command.env_remove(name);
        }
    }
    let mut child = command
        .arg(ARG)
        .env_remove("ANIVERSE_ELECTRON_HANDOFF")
        .env(HOME, home.path())
        .env(PROFILE, profile)
        .env(TOKEN, token.simple().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()?;

    let mut pipe = child.stdout.take().ok_or_else(invalid)?;
    let (send, received) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut receipt = [0; 33];
        let _ = send.send(pipe.read_exact(&mut receipt).map(|()| receipt));
    });
    let deadline = Instant::now() + Duration::from_secs(25);
    let result = loop {
        if let Some(status) = child.try_wait()? {
            let receipt = received.recv_timeout(deadline.saturating_duration_since(Instant::now()));
            break if status.success()
                && receipt.is_ok_and(|receipt| {
                    receipt.is_ok_and(|bytes| bytes == format!("{}\n", token.simple()).as_bytes())
                }) {
                Ok(())
            } else {
                Err(invalid())
            };
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "AniVerse2 did not verify the copied profile in time",
            ));
        }
        thread::sleep(Duration::from_millis(50));
    };
    // Chromium's child can release profile handles just after the Tauri host exits.
    for _ in 0..30 {
        match fs::remove_dir_all(home.path()) {
            Ok(()) => break,
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(_) => thread::sleep(Duration::from_millis(100)),
        }
    }
    result
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "AniVerse2 did not verify the copied profile",
    )
}

pub(crate) fn start(webview: &WebviewWindow, directory: PathBuf) -> tauri::Result<()> {
    let app = webview.app_handle().clone();
    webview.with_webview(move |platform| {
        let result = unsafe {
            let environment = platform.environment();
            verify_webview_folder(&environment, &directory)
                .and_then(|()| platform.controller().CoreWebView2())
                .and_then(|core| guard(&core, &environment))
        };
        if result.is_err() {
            app.exit(1);
        }
    })
}

unsafe fn verify_webview_folder(
    environment: &ICoreWebView2Environment,
    path: &Path,
) -> windows::core::Result<()> {
    let mut raw = PWSTR::null();
    environment
        .cast::<ICoreWebView2Environment7>()?
        .UserDataFolder(&mut raw)?;
    if PathBuf::from(take_pwstr(raw)).canonicalize().ok() != Some(path.canonicalize()?) {
        return Err(windows::core::Error::from(windows::core::HRESULT(
            0x80070005_u32 as i32,
        )));
    }
    Ok(())
}

unsafe fn guard(
    core: &ICoreWebView2,
    environment: &ICoreWebView2Environment,
) -> windows::core::Result<()> {
    core.Settings()?.SetAreDevToolsEnabled(false)?;
    let filtered = core.cast::<ICoreWebView2_22>()?;
    for pattern in [w!("http://*"), w!("https://*")] {
        filtered.AddWebResourceRequestedFilterWithRequestSourceKinds(
            pattern,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
        )?;
    }
    let denied = environment.CreateWebResourceResponse(
        None::<&IStream>,
        403,
        w!("Offline verification"),
        w!("Cache-Control: no-store"),
    )?;
    let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
        if let Some(args) = args {
            let mut uri = PWSTR::null();
            args.Request()?.Uri(&mut uri)?;
            let allowed = Url::parse(&take_pwstr(uri)).is_ok_and(|url| {
                app_origin(&url)
                    || matches!(
                        url.origin().ascii_serialization().as_str(),
                        "https://ipc.localhost" | "http://ipc.localhost"
                    )
            });
            if !allowed {
                args.SetResponse(&denied)?;
            }
        }
        Ok(())
    }));
    let mut token = 0;
    core.add_WebResourceRequested(&handler, &mut token)?;
    core.Navigate(w!("https://tauri.localhost/index.html#/history"))
}
