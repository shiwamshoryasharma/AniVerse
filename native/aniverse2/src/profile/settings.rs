use super::{invalid, kv, overlay, read_error, writes, DEFAULT_SETTINGS};
use crate::RpcError;
use rusqlite::{params, TransactionBehavior};
use serde_json::{json, Value};
use std::path::Path;

pub(super) fn write(root: &Path, input: &Value) -> Result<Value, RpcError> {
    let patch = input
        .as_object()
        .filter(|patch| (1..=3).contains(&patch.len()))
        .ok_or_else(invalid)?;
    let fail = || {
        RpcError::new(
            "invalid-input",
            "This Windows build accepts appearance, player and profile text preferences.",
        )
    };
    let mut db = writes::writable(root).map_err(read_error)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(read_error)?;
    let mut stored = kv(Some(&tx), "settings")
        .map_err(read_error)?
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    for (group, fields) in patch {
        let fields = fields
            .as_object()
            .filter(|fields| !fields.is_empty() && fields.len() <= 16)
            .ok_or_else(invalid)?;
        if !stored[group].is_object() {
            stored[group] = json!({});
        }
        for (key, value) in fields {
            stored[group][key] = if group == "player" && key == "upscale" {
                crate::player::upscale::merge_settings(&stored[group][key], value)
            } else {
                valid(group, key, value)
            }
            .ok_or_else(fail)?;
        }
    }
    tx.execute("INSERT INTO kv(key,value) VALUES('settings',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![stored.to_string()]).map_err(read_error)?;
    tx.commit().map_err(read_error)?;
    let mut defaults = serde_json::from_slice(DEFAULT_SETTINGS).map_err(read_error)?;
    overlay(&mut defaults, &stored);
    Ok(defaults)
}

fn valid(group: &str, key: &str, value: &Value) -> Option<Value> {
    let text = |allowed: &[&str]| {
        value
            .as_str()
            .filter(|text| allowed.contains(text))
            .map(|text| json!(text))
    };
    let number = |min: f64, max: f64| value.as_f64().map(|number| json!(number.clamp(min, max)));
    match (group, key) {
        ("privacy", "watchInsights" | "adblock") => value.as_bool().map(|flag| json!(flag)),
        ("player", "autoplay" | "autoNext" | "resume" | "theater" | "siteFocus")
        | ("appearance", "showAdult" | "spoilerShield" | "reduceMotion") => {
            value.as_bool().map(|flag| json!(flag))
        }
        ("appearance", "style") => text(&["classic", "aurora", "paper"]),
        ("appearance", "accent") => {
            text(&["ember", "aqua", "violet", "sakura", "crimson", "festival"])
        }
        ("appearance", "density") => text(&["compact", "comfortable"]),
        ("appearance", "fontFamily") => text(&["inter", "system", "arial", "serif", "mono"]),
        ("appearance", "titleLanguage") => text(&["english", "romaji", "native"]),
        ("player", "preferredQuality") => text(&["auto", "1080", "720", "480"]),
        ("player", "volume") => number(0.0, 1.0),
        ("player", "speed") => number(0.25, 3.0),
        ("player", "completeThreshold") => number(0.5, 1.0),
        ("player", "seekStep" | "skipStep") => {
            let (min, max) = if key == "seekStep" {
                (1.0, 60.0)
            } else {
                (5.0, 300.0)
            };
            value
                .as_f64()
                .map(|number| json!(number.round().clamp(min, max) as u32))
        }
        ("profile", "name" | "bio") => value.as_str().map(|value| {
            let max = if key == "name" { 40 } else { 280 };
            if key == "name" && value.trim().is_empty() {
                json!("Viewer")
            } else {
                json!(value.chars().take(max).collect::<String>())
            }
        }),
        _ => None,
    }
}
