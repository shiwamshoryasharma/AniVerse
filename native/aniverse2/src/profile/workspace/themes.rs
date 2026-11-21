use super::{blocking, pick, set, write, Selection, State};
use crate::{
    profile::{invalid, kv, open, overlay, read_error, settings, text_file, DEFAULT_SETTINGS},
    RpcError,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{io::Write, path::Path};
use tauri::Webview;
use uuid::Uuid;

const KEY: &str = "themes:v1";

fn invalid_theme() -> RpcError {
    RpcError::new("invalid-input", "Choose an AniVerse visual theme with only the supported appearance and player preferences.")
}

fn preset(input: &Value) -> Option<Value> {
    let exact = |value: &Value, expected: &[&str]| -> Option<()> {
        let object = value.as_object()?;
        (object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key)))
            .then_some(())
    };
    exact(input, &["version", "name", "appearance", "player"])?;
    if input["version"].as_u64()? != 1 {
        return None;
    }
    let name = input["name"].as_str()?.trim();
    if name.is_empty() || name.encode_utf16().count() > 60 {
        return None;
    }
    let mut appearance = input["appearance"].clone();
    appearance
        .as_object_mut()?
        .entry("style")
        .or_insert_with(|| json!("classic"));
    exact(
        &appearance,
        &["style", "accent", "density", "fontFamily", "reduceMotion"],
    )?;
    let player = &input["player"];
    exact(player, &["theater", "preferredQuality"])?;
    let valid_text =
        |field: &Value, allowed: &[&str]| allowed.contains(&field.as_str().unwrap_or_default());
    if !valid_text(&appearance["style"], &["classic", "aurora", "paper"])
        || !valid_text(
            &appearance["accent"],
            &["ember", "aqua", "violet", "sakura", "crimson", "festival"],
        )
        || !valid_text(&appearance["density"], &["compact", "comfortable"])
        || !valid_text(
            &appearance["fontFamily"],
            &["inter", "system", "arial", "serif", "mono"],
        )
        || !appearance["reduceMotion"].is_boolean()
        || !player["theater"].is_boolean()
        || !valid_text(&player["preferredQuality"], &["auto", "1080", "720", "480"])
    {
        return None;
    }
    Some(json!({"version":1,"name":name,"appearance":appearance,"player":player}))
}

fn id(input: &Value) -> Result<Uuid, RpcError> {
    let text = input["id"].as_str().ok_or_else(invalid)?;
    Uuid::parse_str(text)
        .ok()
        .filter(|id| id.to_string().eq_ignore_ascii_case(text))
        .ok_or_else(invalid)
}

fn themes(db: Option<&Connection>) -> Result<Vec<Value>, RpcError> {
    Ok(kv(db, KEY)
        .map_err(read_error)?
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .take(30)
        .filter_map(|entry| {
            Some(json!({"id": id(entry).ok()?.to_string(),"preset":preset(&entry["preset"])?}))
        })
        .collect())
}

fn selected(root: &Path, input: &Value) -> Result<Value, RpcError> {
    let id = id(input)?.to_string();
    themes(open(root).map_err(read_error)?.as_ref())?
        .into_iter()
        .find(|item| item["id"] == id)
        .map(|mut item| item["preset"].take())
        .ok_or_else(|| RpcError::new("not-found", "Theme not found."))
}

fn save(db: &Connection, candidate: &Value) -> Result<Value, RpcError> {
    let preset = preset(candidate).ok_or_else(invalid_theme)?;
    let entry = json!({"id":Uuid::new_v4().to_string(),"preset":preset});
    let themes = std::iter::once(entry.clone())
        .chain(themes(Some(db))?)
        .take(30)
        .collect::<Vec<_>>();
    set(db, KEY, &json!(themes))?;
    Ok(entry)
}

pub(super) async fn request(
    window: &Webview,
    root: &Path,
    state: &State,
    method: &str,
    input: Value,
) -> Result<Value, RpcError> {
    let root = root.to_owned();
    match method {
        "themes.list" => blocking(move || Ok(json!(themes(open(&root).map_err(read_error)?.as_ref())?))).await,
        "themes.save" => blocking(move || write(&root, |db| {
            let mut current = serde_json::from_slice(DEFAULT_SETTINGS).map_err(read_error)?;
            if let Some(settings) = kv(Some(db), "settings").map_err(read_error)? { overlay(&mut current, &settings); }
            let appearance = &current["appearance"];
            let player = &current["player"];
            save(db, &json!({"version":1,"name":input["name"],"appearance":{
                "style":appearance["style"], "accent":appearance["accent"], "density":appearance["density"],
                "fontFamily":appearance["fontFamily"],"reduceMotion":appearance["reduceMotion"]},
                "player":{"theater":player["theater"],"preferredQuality":player["preferredQuality"]}}))
        })).await,
        "themes.apply" => blocking(move || {
            let preset = selected(&root, &input)?;
            settings::write(&root, &json!({"appearance":preset["appearance"],"player":preset["player"]}))
        }).await,
        "themes.delete" => blocking(move || write(&root, |db| {
            let id = id(&input)?.to_string();
            let retained = themes(Some(db))?.into_iter().filter(|item| item["id"] != id).collect::<Vec<_>>();
            set(db, KEY, &json!(retained))?;
            Ok(Value::Null)
        })).await,
        "themes.import" => {
            let Some(path) = pick(window, state, "Import an AniVerse theme", Selection::Json).await? else {
                return Ok(Value::Null)
            };
            blocking(move || {
                let value = text_file(&path, 20_000).ok().flatten().and_then(|text| serde_json::from_str(&text).ok())
                    .ok_or_else(invalid_theme)?;
                write(&root, |db| save(db, &value))
            }).await
        }
        "themes.export" => {
            let preset = blocking(move || selected(&root, &input)).await?;
            let name: String = preset["name"].as_str().unwrap_or_default().chars()
                .filter(|ch| ch.is_ascii_alphanumeric() || matches!(*ch, ' ' | '_' | '-')).collect();
            let name = if name.trim().is_empty() { "AniVerse" } else { name.trim() };
            let name = format!("{name}.aniverse-theme.json");
            let Some(path) = pick(window, state, "Export visual theme", Selection::SaveJson(&name)).await? else {
                return Ok(json!({"saved":false}))
            };
            blocking(move || {
                let parent = path.parent().ok_or_else(invalid)?;
                let mut output = tempfile::NamedTempFile::new_in(parent).map_err(read_error)?;
                serde_json::to_writer_pretty(&mut output, &preset).map_err(read_error)?;
                output.write_all(b"\n").map_err(read_error)?;
                output.as_file().sync_all().map_err(read_error)?;
                output.persist(path).map_err(read_error)?;
                Ok(json!({"saved":true}))
            }).await
        }
        _ => Err(invalid()),
    }
}

#[cfg(test)]
#[path = "../../../../../test/tauri-compat/workspace-themes.rs"]
mod tests;
