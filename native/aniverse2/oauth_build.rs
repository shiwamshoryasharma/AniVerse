use serde_json::Value;

const CLIENTS: [(&str, &str, bool); 4] = [
    ("ANIVERSE2_ANILIST_CLIENT_ID", "/aniverse2/anilist", true),
    ("ANIVERSE2_MAL_CLIENT_ID", "/aniverse2/myanimelist", false),
    ("ANIVERSE_MAL_CLIENT_ID", "/myanimelist", false),
    ("ANIVERSE_ANILIST_CLIENT_ID", "/anilist", true),
];

pub(crate) fn credentials(
    config: &Value,
    overrides: [Option<&str>; 4],
) -> Result<[String; 4], &'static str> {
    if !config.is_object() {
        return Err("OAuth configuration must be a JSON object.");
    }
    for (_, pointer, _) in CLIENTS {
        if config.pointer(pointer).is_some_and(|provider| {
            provider.get("clientSecret").is_some() || provider.get("client_secret").is_some()
        }) {
            return Err("OAuth configuration must contain public client IDs only.");
        }
    }

    let mut result = std::array::from_fn(|_| String::new());
    for (index, (name, pointer, numeric)) in CLIENTS.into_iter().enumerate() {
        let from_file = &config.pointer(pointer).unwrap_or(&Value::Null)["clientId"];
        let raw = match (overrides[index], from_file) {
            (Some(value), _) => value.to_owned(),
            (None, Value::String(value)) => value.clone(),
            (None, Value::Number(value)) if numeric => value.to_string(),
            (None, Value::Null) => String::new(),
            _ => return Err(name),
        };
        let id = raw.trim();
        let valid = if numeric {
            (1..=12).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_digit())
        } else {
            (16..=64).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_hexdigit())
        };
        if !id.is_empty() && !valid {
            return Err(name);
        }
        result[index] = id.to_owned();
    }
    Ok(result)
}

#[cfg(not(test))]
pub(crate) fn prepare(root: &std::path::Path) {
    use std::{env, fs, io::ErrorKind, path::PathBuf};
    const CONFIG_ENV: &str = "ANIVERSE_OAUTH_CONFIG";
    let custom = env::var_os(CONFIG_ENV).filter(|path| !path.is_empty());
    let config = custom
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("config/oauth.json"));
    println!("cargo:rerun-if-env-changed={CONFIG_ENV}");
    println!("cargo:rerun-if-changed={}", config.display());
    let mut overrides = [const { None }; 4];
    for (index, (name, _, _)) in CLIENTS.into_iter().enumerate() {
        println!("cargo:rerun-if-env-changed={name}");
        overrides[index] = match env::var(name) {
            Ok(value) => Some(value),
            Err(env::VarError::NotPresent) => None,
            Err(env::VarError::NotUnicode(_)) => panic!("Invalid OAuth client ID setting: {name}"),
        };
    }
    let json = match fs::read_to_string(config) {
        Ok(text) => serde_json::from_str(text.trim_start_matches('\u{feff}'))
            .unwrap_or_else(|_| panic!("Invalid JSON in the OAuth build configuration.")),
        Err(error) if custom.is_none() && error.kind() == ErrorKind::NotFound => {
            serde_json::json!({})
        }
        Err(_) => panic!("Could not read the OAuth build configuration."),
    };
    let ids = credentials(&json, overrides.each_ref().map(|value| value.as_deref()))
        .unwrap_or_else(|error| panic!("Invalid OAuth build configuration: {error}"));
    for ((name, _, _), value) in CLIENTS.into_iter().zip(ids) {
        println!("cargo:rustc-env={name}={value}");
    }
}
