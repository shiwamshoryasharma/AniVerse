use crate::{profile, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::OsStr,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Manager, Webview};

const ARGUMENTS: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
const STABLE_SWITCH: &str = "--disable-gpu-compositing";
// additional_browser_args replaces Wry 0.57.3 defaults, including its enabled autoplay policy.
const WRY_ARGUMENTS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Stable,
    Accelerated,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Preference {
    mode: Mode,
}

pub(crate) struct Service {
    file: PathBuf,
    active: Mode,
    preferred: Mutex<Mode>,
}

impl Service {
    pub(crate) fn startup(root: &Path) -> (Self, String) {
        let file = root.join("graphics.json");
        let preferred = profile::text_file(&file, 4096)
            .ok()
            .flatten()
            .and_then(|value| serde_json::from_str::<Preference>(&value).ok())
            .map_or(Mode::Stable, |preference| preference.mode);
        let existing = std::env::var_os(ARGUMENTS);
        let (active, arguments) = browser_arguments(preferred, existing.as_deref());
        (
            Self {
                file,
                active,
                preferred: Mutex::new(preferred),
            },
            arguments,
        )
    }

    pub(crate) fn snapshot(&self) -> Value {
        snapshot(
            self.active,
            *self
                .preferred
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        )
    }

    fn set(&self, input: Value) -> Result<Value, RpcError> {
        let preference = serde_json::from_value::<Preference>(input)
            .map_err(|_| RpcError::new("invalid-input", "Choose Stable UI or Accelerated UI."))?;
        let save_error = |_| {
            RpcError::new(
                "config",
                "AniVerse2 could not save the rendering preference.",
            )
        };
        let mut preferred = self
            .preferred
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let parent = self
            .file
            .parent()
            .expect("graphics preference has a profile directory");
        let mut output = tempfile::NamedTempFile::new_in(parent).map_err(save_error)?;
        serde_json::to_writer(&mut output, &preference)
            .map_err(|_| RpcError::new("config", "Could not write the rendering preference."))?;
        output.write_all(b"\n").map_err(save_error)?;
        output.as_file().sync_all().map_err(save_error)?;
        output
            .persist(&self.file)
            .map_err(|error| save_error(error.error))?;
        *preferred = preference.mode;
        Ok(snapshot(self.active, *preferred))
    }
}

fn snapshot(active: Mode, preferred: Mode) -> Value {
    json!({"active":active,"preferred":preferred,"restartRequired":active!=preferred})
}

fn browser_arguments(preferred: Mode, inherited: Option<&OsStr>) -> (Mode, String) {
    let current = inherited.unwrap_or_default().to_string_lossy();
    let forced = current
        .split_ascii_whitespace()
        .map(|token| token.trim_matches('"'))
        .any(|token| token.split('=').next() == Some(STABLE_SWITCH));
    let active = if forced { Mode::Stable } else { preferred };
    // Pass shell options explicitly to its environment instead of changing the
    // process environment temporarily. Other source WebViews keep their own policy.
    let mut arguments = WRY_ARGUMENTS.to_owned();
    if !current.is_empty() {
        arguments.push(' ');
        arguments.push_str(&current);
    }
    if active == Mode::Stable && !forced {
        arguments.push(' ');
        arguments.push_str(STABLE_SWITCH);
    }
    (active, arguments)
}
pub(crate) async fn request(window: &Webview, input: Value) -> Result<Value, RpcError> {
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || app.state::<Service>().set(input))
        .await
        .map_err(|_| RpcError::new("internal", "The rendering update was interrupted."))?
}

#[cfg(test)]
#[path = "../../../test/tauri-compat/ui-rendering.rs"]
mod tests;
