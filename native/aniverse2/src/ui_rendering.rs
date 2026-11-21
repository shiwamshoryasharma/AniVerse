use crate::{profile, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::{OsStr, OsString},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Manager, Webview};

const ARGUMENTS: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
const STABLE_SWITCH: &str = "--disable-gpu-compositing";

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

pub(crate) struct BootArguments(Option<Option<OsString>>);

impl Drop for BootArguments {
    fn drop(&mut self) {
        match self.0.take() {
            Some(Some(original)) => std::env::set_var(ARGUMENTS, original),
            Some(None) => std::env::remove_var(ARGUMENTS),
            None => {}
        }
    }
}

impl Service {
    pub(crate) fn startup(root: &Path) -> (Self, BootArguments) {
        let file = root.join("graphics.json");
        let preferred = profile::text_file(&file, 4096)
            .ok()
            .flatten()
            .and_then(|value| serde_json::from_str::<Preference>(&value).ok())
            .map_or(Mode::Accelerated, |preference| preference.mode);
        let existing = std::env::var_os(ARGUMENTS);
        let (active, append) = browser_arguments(preferred, existing.as_deref());
        let original = append.as_ref().map(|_| existing);
        if let Some(arguments) = append {
            // Before constructing the first WebView2 controller. Keep Wry's own
            // arguments and any host-provided options intact. RPC input is an enum.
            std::env::set_var(ARGUMENTS, arguments);
        }
        (
            Self {
                file,
                active,
                preferred: Mutex::new(preferred),
            },
            BootArguments(original),
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

fn browser_arguments(preferred: Mode, inherited: Option<&OsStr>) -> (Mode, Option<OsString>) {
    let current = inherited.unwrap_or_default();
    let forced = current
        .to_string_lossy()
        .split_ascii_whitespace()
        .map(|token| token.trim_matches('"'))
        .any(|token| token.split('=').next() == Some(STABLE_SWITCH));
    if forced || preferred == Mode::Accelerated {
        return (if forced { Mode::Stable } else { preferred }, None);
    }
    let mut arguments = current.to_owned();
    if !arguments.is_empty() {
        arguments.push(" ");
    }
    arguments.push(STABLE_SWITCH);
    (Mode::Stable, Some(arguments))
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
