use super::{allowed_top, invalid, native, Session};
use crate::RpcError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;

const GUEST: &str = include_str!(concat!(env!("OUT_DIR"), "/site-upscale.js"));

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
struct Options {
    enabled: bool,
    mode: Mode,
    darken: bool,
    thin: bool,
}

#[derive(Debug, Default, Deserialize, Serialize)]
enum Mode {
    #[default]
    A,
    B,
    C,
    #[serde(rename = "A+A")]
    AA,
    #[serde(rename = "B+B")]
    BB,
    #[serde(rename = "C+A")]
    CA,
}

fn options(input: &Value) -> Option<Options> {
    if !input.is_object() {
        return None;
    }
    serde_json::from_value(input.clone()).ok()
}

pub(crate) fn merge_settings(current: &Value, patch: &Value) -> Option<Value> {
    let mut merged = serde_json::to_value(options(current).unwrap_or_default()).ok()?;
    for (key, value) in patch.as_object()? {
        merged[key] = value.clone();
    }
    serde_json::to_value(options(&merged)?).ok()
}

/// Filters only browser-readable video pixels inside a loaded, owned site.
/// Renderer input selects typed presets and is never evaluated as code.
pub(super) async fn apply(session: &Session, input: &Value) -> Result<Value, RpcError> {
    let options = options(input).ok_or_else(invalid)?;
    let off = || json!({"state":"off","message":"Anime4K is off"});
    let waiting = || json!({"state":"waiting","message":"Waiting for a compatible website video."});
    let unavailable = || {
        json!({
            "state":"unavailable",
            "message":"This player does not expose video frames for Anime4K. Original playback continues."
        })
    };
    if session.closed.load(Ordering::Acquire) {
        return Err(invalid());
    }
    let current = || {
        session.ready.load(Ordering::Acquire)
            && session.view.url().is_ok_and(|url| {
                url.as_str() != "about:blank" && allowed_top(&url, &session.source.base)
            })
    };
    if !current() {
        return Ok(if options.enabled { waiting() } else { off() });
    }
    if !options.enabled {
        native::read(session, "globalThis.__avSiteUpscale?.stop();null").await?;
        return Ok(off());
    }
    let generation = session.page_generation.load(Ordering::Acquire);
    let call = format!(
        "globalThis.__avSiteUpscale?.apply({}, true) ?? null",
        serde_json::to_string(&options).map_err(|_| invalid())?
    );
    let mut value = native::evaluate_without_activation(session, call.clone()).await?;
    if value.is_null() && current() && session.page_generation.load(Ordering::Acquire) == generation
    {
        let init = format!(
            r#"(() => {{
            if (!globalThis.__avSiteUpscale) {{
                {GUEST}
                globalThis.__avSiteUpscale = AniVerseUpscale;
            }}
            return {call};
        }})()"#
        );
        value = native::evaluate_without_activation(session, init).await?;
    }
    if !current() || session.page_generation.load(Ordering::Acquire) != generation {
        return Ok(waiting());
    }
    Ok(status(&value).unwrap_or_else(unavailable))
}

fn status(value: &Value) -> Option<Value> {
    let state = value["state"]
        .as_str()
        .filter(|state| matches!(*state, "off" | "waiting" | "active" | "unavailable"))?;
    let message = value["message"]
        .as_str()
        .filter(|message| message.len() <= 240)?;
    let mut result = json!({"state":state,"message":message});
    if state == "active" {
        result["width"] = json!(value["width"]
            .as_u64()
            .filter(|value| (1..=3840).contains(value))?);
        result["height"] = json!(value["height"]
            .as_u64()
            .filter(|value| (1..=2160).contains(value))?);
    }
    Some(result)
}
