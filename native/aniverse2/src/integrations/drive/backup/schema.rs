use super::invalid_backup;
use crate::RpcError;
use regex::Regex;
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap},
    sync::{Mutex, OnceLock},
};

static SCHEMA: OnceLock<Option<Value>> = OnceLock::new();
static PATTERNS: OnceLock<Mutex<HashMap<String, Regex>>> = OnceLock::new();

pub(crate) fn validate(mut value: Value) -> Result<Value, RpcError> {
    let schema = SCHEMA
        .get_or_init(|| {
            let value: Value = serde_json::from_str(include_str!(concat!(
                env!("OUT_DIR"),
                "/backup-schema.json"
            )))
            .ok()?;
            (value["type"] == "object"
                && value["properties"]["format"]["const"] == "aniverse.backup")
                .then_some(value)
        })
        .as_ref()
        .ok_or_else(|| {
            RpcError::new(
                "config",
                "This build is missing the portable backup schema.",
            )
        })?;
    if !matches(schema, &value) {
        return Err(invalid_backup());
    }
    apply_defaults(schema, &mut value);
    validate_relationships(&value)?;
    Ok(value)
}

fn matches(schema: &Value, value: &Value) -> bool {
    if let Some(expected) = schema.get("const") {
        if expected != value {
            return false;
        }
    }
    if let Some(options) = schema["enum"].as_array() {
        if !options.contains(value) {
            return false;
        }
    }
    if let Some(alternatives) = schema["anyOf"].as_array() {
        return alternatives.iter().any(|schema| matches(schema, value));
    }
    match schema["type"].as_str() {
        Some("object") => {
            let (Some(props), Some(obj)) = (schema["properties"].as_object(), value.as_object())
            else {
                return false;
            };
            let missing = schema["required"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|name| !name.as_str().is_some_and(|name| obj.contains_key(name)));
            !missing
                && obj
                    .iter()
                    .all(|(name, value)| props.get(name).is_some_and(|child| matches(child, value)))
        }
        Some("array") => value.as_array().is_some_and(|arr| {
            schema["minItems"]
                .as_u64()
                .is_none_or(|limit| arr.len() >= limit as usize)
                && schema["maxItems"]
                    .as_u64()
                    .is_none_or(|limit| arr.len() <= limit as usize)
                && arr.iter().all(|value| matches(&schema["items"], value))
        }),
        Some("number" | "integer") => value.as_f64().is_some_and(|number| {
            (schema["type"] != "integer" || value.as_i64().is_some())
                && schema["minimum"].as_f64().is_none_or(|min| number >= min)
                && schema["exclusiveMinimum"]
                    .as_f64()
                    .is_none_or(|min| number > min)
                && schema["maximum"].as_f64().is_none_or(|max| number <= max)
        }),
        Some("string") => value.as_str().is_some_and(|text| {
            let length = text.encode_utf16().count();
            schema["minLength"]
                .as_u64()
                .is_none_or(|limit| length >= limit as usize)
                && schema["maxLength"]
                    .as_u64()
                    .is_none_or(|limit| length <= limit as usize)
                && schema["pattern"]
                    .as_str()
                    .is_none_or(|pattern| regex_matches(pattern, text))
        }),
        Some("boolean") => value.is_boolean(),
        Some("null") => value.is_null(),
        _ => false,
    }
}

fn regex_matches(pattern: &str, text: &str) -> bool {
    let Ok(mut patterns) = PATTERNS.get_or_init(Default::default).lock() else {
        return false;
    };
    if let Some(compiled) = patterns.get(pattern) {
        return compiled.is_match(text);
    }
    let Ok(compiled) = Regex::new(pattern) else {
        return false;
    };
    let accepted = compiled.is_match(text);
    patterns.insert(pattern.to_owned(), compiled);
    accepted
}

fn apply_defaults(schema: &Value, value: &mut Value) {
    if let Some(alternatives) = schema["anyOf"].as_array() {
        if let Some(schema) = alternatives.iter().find(|schema| matches(schema, value)) {
            apply_defaults(schema, value);
        }
    } else if let (Some(properties), Some(values)) =
        (schema["properties"].as_object(), value.as_object_mut())
    {
        for (key, schema) in properties {
            if !values.contains_key(key) {
                if let Some(value) = schema.get("default") {
                    values.insert(key.clone(), value.clone());
                }
            }
            if let Some(value) = values.get_mut(key) {
                apply_defaults(schema, value);
            }
        }
    } else if let Some(values) = value.as_array_mut() {
        for value in values {
            apply_defaults(&schema["items"], value);
        }
    }
}

fn validate_relationships(value: &Value) -> Result<(), RpcError> {
    let mut ids = BTreeSet::new();
    for media in super::entries(value, "media") {
        if !ids.insert(media["id"].as_i64().ok_or_else(invalid_backup)?) || !safe_images(media) {
            return Err(invalid_backup());
        }
    }
    for field in [
        "library",
        "progress",
        "history",
        "favourites",
        "bookmarks",
        "skips",
    ] {
        for row in super::entries(value, field) {
            if !ids.contains(&row["mediaId"].as_i64().ok_or_else(invalid_backup)?) {
                return Err(invalid_backup());
            }
            if matches!(field, "progress" | "bookmarks")
                && row["position"].as_f64() > row["duration"].as_f64()
            {
                return Err(invalid_backup());
            }
            if field == "skips"
                && (row["start"].as_f64() >= row["end"].as_f64()
                    || row["end"].as_f64() > row["duration"].as_f64())
            {
                return Err(invalid_backup());
            }
        }
    }
    for day in super::entries(&value["plan"], "days") {
        for item in super::entries(day, "items") {
            if !safe_images(&item["media"]) {
                return Err(invalid_backup());
            }
        }
    }
    Ok(())
}

fn safe_images(media: &Value) -> bool {
    [&media["cover"], &media["banner"]]
        .into_iter()
        .all(|value| {
            value.as_str().is_none_or(|url| {
                url.is_empty()
                    || (url.starts_with("https://")
                        && !super::super::super::safe_link(value).is_null())
            })
        })
}
