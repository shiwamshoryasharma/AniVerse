use super::{allowed_top, invalid, native, Session};
use crate::RpcError;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::sync::{atomic::Ordering, OnceLock};

const GUEST: &str = include_str!("quantum-guest.js");
const WORKLET: &str = include_str!(concat!(env!("OUT_DIR"), "/quantum-worklet.js"));
const WASM: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/quantum-audio.wasm"));
static INIT: OnceLock<String> = OnceLock::new();

pub(super) async fn request(session: &Session, input: &Value) -> Result<Value, RpcError> {
    let action = input["action"]
        .as_str()
        .filter(|action| matches!(*action, "enable" | "off" | "level" | "status"))
        .ok_or_else(invalid)?;
    let intensity = if matches!(action, "enable" | "level") {
        input["intensity"]
            .as_f64()
            .filter(|value| (0.0..=1.0).contains(value))
            .ok_or_else(invalid)?
    } else {
        0.0
    };
    let generation = session.page_generation.load(Ordering::Acquire);
    let binding = session
        .quantum
        .lock()
        .ok()
        .and_then(|entry| *entry)
        .filter(|(seen, _)| *seen == generation);

    if action == "off" {
        stop(session).await;
        return Ok(json!({"state":"off"}));
    }
    if !current(session, generation) {
        return Ok(json!({"state":if action == "enable" {"waiting"} else {"off"}}));
    }
    let result = if let Some((_, frame)) = binding {
        evaluate(session, generation, frame, action, intensity).await
    } else if action == "enable" {
        let top = evaluate(session, generation, false, action, intensity).await;
        if top["state"] == "active" {
            return bind(session, generation, false, top);
        }
        let frame = evaluate(session, generation, true, action, intensity).await;
        if frame["state"] == "active" {
            return bind(session, generation, true, frame);
        }
        if matches!(top["state"].as_str(), Some("unavailable")) {
            top
        } else {
            frame
        }
    } else {
        json!({"state":"off"})
    };
    if !current(session, generation) {
        return Ok(json!({"state":"off"}));
    }
    Ok(result)
}

fn bind(session: &Session, generation: u64, frame: bool, result: Value) -> Result<Value, RpcError> {
    if !current(session, generation) {
        return Ok(json!({"state":"off"}));
    }
    *session.quantum.lock().map_err(|_| invalid())? = Some((generation, frame));
    Ok(result)
}

fn current(session: &Session, generation: u64) -> bool {
    session.focus.load(Ordering::Acquire)
        && !session.closed.load(Ordering::Acquire)
        && session.ready.load(Ordering::Acquire)
        && session.page_generation.load(Ordering::Acquire) == generation
        && session.view.url().is_ok_and(|url| {
            url.as_str() != "about:blank" && allowed_top(&url, &session.source.base)
        })
}

pub(super) async fn stop(session: &Session) {
    let binding = session
        .quantum
        .lock()
        .ok()
        .and_then(|mut entry| entry.take());
    let current_generation = session.page_generation.load(Ordering::Acquire);
    let _ = native::release_audio_frame(
        session,
        current_generation,
        "globalThis.__avQuantum?.('off')".into(),
    )
    .await;
    if let Some((generation, false)) = binding {
        if session.page_generation.load(Ordering::Acquire) == generation {
            let _ = evaluate(session, generation, false, "off", 0.0).await;
        }
    }
}

async fn evaluate(
    session: &Session,
    generation: u64,
    frame: bool,
    action: &str,
    intensity: f64,
) -> Value {
    let arguments = format!("{},{intensity}", json!(action));
    let expression = if action == "enable" {
        let init = INIT.get_or_init(|| {
            format!(
                "{GUEST}({},{})",
                json!(WORKLET),
                json!(STANDARD.encode(WASM))
            )
        });
        format!("(globalThis.__avQuantum ??= {init})({arguments})")
    } else {
        format!("globalThis.__avQuantum?.({arguments}) ?? {{state:'off'}}")
    };
    let result = if frame {
        native::evaluate_audio_frame(session, generation, expression, action == "enable").await
    } else {
        native::evaluate_audio_top(session, generation, expression, action == "enable").await
    };
    result
        .ok()
        .and_then(|value| sanitize(&value))
        .unwrap_or_else(|| json!({"state":if action == "enable" { "waiting" } else { "off" }}))
}

fn sanitize(value: &Value) -> Option<Value> {
    let state = value["state"].as_str()?;
    if matches!(state, "off" | "waiting" | "unavailable") {
        return Some(json!({"state":state}));
    }
    if state != "active" {
        return None;
    }
    Some(json!({"state":"active",
        "samples":value["samples"].as_u64().filter(|value| *value <= 7_000_000_000_000)?,
        "sampleRate":value["sampleRate"].as_u64().filter(|value| (8_000..=192_000).contains(value))?,
        "mediaTime":value["mediaTime"].as_f64().filter(|value| (0.0..=31_536_000.0).contains(value))?,
        "videoFrames":value["videoFrames"].as_u64().filter(|value| *value <= u32::MAX as u64)?,
        "playing":value["playing"].as_bool()?, "signal":value["signal"].as_bool()?
    }))
}
