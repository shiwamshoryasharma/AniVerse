use crate::{profile, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Manager, Webview};

const ARGUMENTS: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
const HIGH: &str = "--force_high_performance_gpu";
const LOW: &str = "--force_low_power_gpu";

#[derive(Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Preference {
    #[default]
    System,
    HighPerformance,
    PowerSaving,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Setting {
    preference: Preference,
}

pub(crate) struct Service {
    file: PathBuf,
    applied: Preference,
    preferred: Mutex<Preference>,
    supported: bool,
}

fn browser_arguments(
    preferred: Preference,
    inherited: &OsString,
    supported: bool,
) -> (Preference, Option<OsString>) {
    let mut forced = Preference::System;
    for token in inherited.to_string_lossy().split_ascii_whitespace() {
        match token.trim_matches('"').split('=').next() {
            Some(HIGH) => forced = Preference::HighPerformance,
            Some(LOW) => forced = Preference::PowerSaving,
            Some("--disable-gpu") => return (Preference::System, None),
            _ => {}
        }
    }
    if forced != Preference::System || !supported || preferred == Preference::System {
        return (forced, None);
    }
    let mut args = inherited.clone();
    if !args.is_empty() {
        args.push(" ");
    }
    args.push(if preferred == Preference::HighPerformance {
        HIGH
    } else {
        LOW
    });
    (preferred, Some(args))
}

impl Service {
    pub(crate) fn startup(root: &Path) -> Self {
        let file = root.join("graphics-adapter.json");
        let preferred = profile::text_file(&file, 1024)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Setting>(&raw).ok())
            .map_or(Preference::System, |setting| setting.preference);
        let supported = tauri::webview_version()
            .ok()
            .and_then(|version| version.split('.').next()?.parse::<u32>().ok())
            .is_some_and(|major| major >= 145);
        let inherited = std::env::var_os(ARGUMENTS).unwrap_or_default();
        let (applied, args) = browser_arguments(preferred, &inherited, supported);
        if let Some(args) = args {
            // Browser processes for new source WebViews read the same process-local
            // preference. The stable UI override is applied separately to the shell.
            std::env::set_var(ARGUMENTS, args);
        }
        Self {
            file,
            applied,
            preferred: Mutex::new(preferred),
            supported,
        }
    }

    pub(crate) fn snapshot(&self) -> Value {
        let preferred = *self
            .preferred
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        json!({"applied": self.applied, "preferred": preferred, "supported": self.supported,
              "restartRequired": self.supported && self.applied != preferred})
    }

    fn set(&self, setting: Setting) -> Result<Value, RpcError> {
        let failed = |_| RpcError::new("config", "Could not save the graphics adapter preference.");
        let mut preferred = self
            .preferred
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let folder = self
            .file
            .parent()
            .expect("adapter preference has a profile directory");
        let mut output = tempfile::NamedTempFile::new_in(folder).map_err(failed)?;
        serde_json::to_writer(&mut output, &setting).map_err(|_| {
            RpcError::new("config", "Could not write the graphics adapter preference.")
        })?;
        output.as_file().sync_all().map_err(failed)?;
        output
            .persist(&self.file)
            .map_err(|error| failed(error.error))?;
        *preferred = setting.preference;
        drop(preferred);
        Ok(self.snapshot())
    }
}

pub(crate) async fn request(window: &Webview, input: Value) -> Result<Value, RpcError> {
    let setting = serde_json::from_value::<Setting>(input).map_err(|_| {
        RpcError::new(
            "invalid-input",
            "Choose System, Dedicated GPU, or Power saving.",
        )
    })?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || app.state::<Service>().set(setting))
        .await
        .map_err(|_| RpcError::new("internal", "The graphics adapter update was interrupted."))?
}

#[cfg(test)]
#[path = "../../../test/tauri-compat/gpu-preference.rs"]
mod tests;
