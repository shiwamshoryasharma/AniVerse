mod identity;
pub(super) mod oauth;
pub(super) mod sync;

use super::{invalid, safe_link, storage, vault};
use crate::{profile, RpcError};
use rusqlite::{OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::path::Path;

pub(super) fn list(root: &Path) -> Result<Value, RpcError> {
    let db = profile::open(root).map_err(storage)?;
    ["anilist", "mal"].into_iter().map(|provider| {
        let account = read(db.as_ref(), provider)?;
        let token_present = account["token"].as_str().is_some_and(|token| vault::open(root, token).is_ok());
        let expired = account["expiresAt"].as_i64().is_some_and(|end| end <= chrono::Utc::now().timestamp());
        let reconnect = account.is_object() && (account["needsReconnect"] == true
            || ((!token_present || expired) && !identity::can_refresh(root, provider, &account)));
        let pending = if account.is_object() {
            db.as_ref().map(|db| db.query_row("SELECT count(*) FROM sync_queue WHERE provider=?1",
                [provider], |row| row.get::<_, i64>(0))).transpose().map_err(storage)?.unwrap_or_default()
        } else {
            0
        };
        let last_error = if reconnect {
            json!("Reconnect the saved account in Settings → Accounts.")
        } else {
            json!(bounded_name(&account["lastError"]))
        };
        Ok(json!({"provider": provider, "connected": account.is_object(), "clientIdConfigured": false,
            "signingIn": false, "needsReconnect": reconnect, "userName": bounded_name(&account["userName"]),
            "avatar": safe_link(&account["avatar"]), "expiresAt": account["expiresAt"].as_i64(),
            "lastSyncAt": account["lastSyncAt"].as_i64(), "lastError": last_error, "pending": pending}))
    }).collect::<Result<Vec<_>, RpcError>>().map(Value::Array)
}

fn bounded_name(name: &Value) -> Option<&str> {
    name.as_str()
        .filter(|value| value.chars().count() <= 200 && !value.chars().any(char::is_control))
}

fn read(db: Option<&rusqlite::Connection>, provider: &str) -> Result<Value, RpcError> {
    let Some(db) = db else {
        return Ok(Value::Null);
    };
    let encoded = db
        .query_row(
            "SELECT data FROM accounts WHERE provider=?1 AND length(data)<=200000",
            [provider],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(storage)?;
    Ok(encoded
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default())
}

pub(super) fn token(root: &Path, provider: &str) -> Result<String, RpcError> {
    let db = profile::open(root).map_err(storage)?;
    let account = read(db.as_ref(), provider)?;
    let reconnect = || {
        RpcError::new(
            "unauthorised",
            "Connect your account in Settings → Accounts.",
        )
    };
    if account["needsReconnect"] == true
        || account["expiresAt"]
            .as_i64()
            .is_some_and(|end| end <= chrono::Utc::now().timestamp())
    {
        return Err(reconnect());
    }
    account["token"]
        .as_str()
        .and_then(|token| vault::open(root, token).ok())
        .filter(|token| token.len() <= 16_000 && token.bytes().all(|byte| byte.is_ascii_graphic()))
        .ok_or_else(reconnect)
}

pub(super) fn provider(input: &Value) -> Result<&str, RpcError> {
    input["provider"]
        .as_str()
        .filter(|name| matches!(*name, "anilist" | "mal"))
        .ok_or_else(invalid)
}

pub(super) fn disconnect(root: &Path, input: &Value) -> Result<Value, RpcError> {
    let provider = provider(input)?;
    if profile::open(root).map_err(storage)?.is_some() {
        let mut db = profile::writable(root).map_err(storage)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        tx.execute("DELETE FROM accounts WHERE provider=?1", [provider])
            .map_err(storage)?;
        tx.execute("DELETE FROM sync_queue WHERE provider=?1", [provider])
            .map_err(storage)?;
        tx.commit().map_err(storage)?;
    }
    Ok(Value::Null)
}
