use super::{bounded_name, read};
use crate::{
    integrations::{
        form, mal_client_id, network, positive_id, response_json, safe_link, storage, Service,
    },
    profile, RpcError,
};
use rusqlite::{params, TransactionBehavior};
use serde_json::{json, Value};
use std::path::Path;

const MAL_TOKEN: &str = "https://myanimelist.net/v1/oauth2/token";

pub(super) const ANILIST_REDIRECT: &str = "aniverse2://oauth/anilist";
pub(super) const MAL_REDIRECT: &str = "aniverse2://oauth/myanimelist";
pub(super) const LEGACY_ANILIST_REDIRECT: &str = "aniverse://oauth/anilist";
pub(super) const LEGACY_MAL_REDIRECT: &str = "aniverse://oauth/myanimelist";

pub(super) fn client_id(provider: &str) -> Option<&'static str> {
    match provider {
        "anilist" => option_env!("ANIVERSE2_ANILIST_CLIENT_ID")
            .map(str::trim)
            .filter(|id| (1..=12).contains(&id.len()) && id.bytes().all(|x| x.is_ascii_digit())),
        "mal" => option_env!("ANIVERSE2_MAL_CLIENT_ID")
            .map(str::trim)
            .filter(|id| {
                (16..=64).contains(&id.len()) && id.bytes().all(|x| x.is_ascii_hexdigit())
            }),
        _ => None,
    }
}

pub(super) fn legacy_client_id(provider: &str) -> Option<&'static str> {
    match provider {
        "anilist" => option_env!("ANIVERSE_ANILIST_CLIENT_ID")
            .map(str::trim)
            .filter(|id| (1..=12).contains(&id.len()) && id.bytes().all(|x| x.is_ascii_digit())),
        "mal" => mal_client_id(),
        _ => None,
    }
}

fn saved_mal_client(account: &Value) -> Option<&'static str> {
    if account["oauthClient"].is_null() {
        mal_client_id()
    } else {
        // A profile may only select a currently compiled/public client, never an
        // arbitrary application ID from renderer input or migrated settings.
        [client_id("mal"), legacy_client_id("mal")]
            .into_iter()
            .flatten()
            .find(|current| account["oauthClient"] == *current)
    }
}

pub(super) fn can_refresh(root: &Path, provider: &str, account: &Value) -> bool {
    provider == "mal"
        && saved_mal_client(account).is_some()
        && account["refreshToken"].as_str().is_some_and(|secret| {
            crate::integrations::vault::open(root, secret).is_ok_and(|token| valid_token(&token))
        })
}

pub(super) struct Tokens {
    pub(super) access: String,
    refresh: Option<String>,
    expires: Option<i64>,
}

impl Tokens {
    pub(super) fn anilist(access: String, seconds: Option<i64>) -> Result<Self, RpcError> {
        if !valid_token(&access) {
            return Err(reconnect());
        }
        Ok(Self {
            access,
            refresh: None,
            expires: seconds.map(|seconds| chrono::Utc::now().timestamp() + seconds),
        })
    }
}

pub(super) fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 16_000 && token.bytes().all(|byte| byte.is_ascii_graphic())
}

pub(super) async fn exchange_mal(
    service: &Service,
    client: &str,
    code: &str,
    verifier: &str,
    redirect: &'static str,
) -> Result<Tokens, RpcError> {
    mal_exchange(
        service,
        &[
            ("client_id", client),
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect),
        ],
        None,
    )
    .await
}

async fn mal_exchange(
    service: &Service,
    fields: &[(&str, &str)],
    fallback: Option<&str>,
) -> Result<Tokens, RpcError> {
    let _permit = service.requests.try_acquire().map_err(|_| network())?;
    let response = form(service.client.post(MAL_TOKEN), fields)?
        .send()
        .await
        .map_err(|_| network())?;
    match response.status().as_u16() {
        200 => {}
        400 | 401 | 403 => return Err(reconnect()),
        _ => return Err(network()),
    }
    let body = response_json(response, 64_000).await?;
    let access = body["access_token"]
        .as_str()
        .filter(|token| valid_token(token))
        .ok_or_else(network)?;
    let refresh = match body.get("refresh_token") {
        Some(token) => Some(
            token
                .as_str()
                .filter(|token| valid_token(token))
                .ok_or_else(network)?,
        ),
        None => fallback,
    };
    let lifetime = body["expires_in"]
        .as_i64()
        .filter(|n| (1..=31_536_000).contains(n))
        .ok_or_else(network)?;
    Ok(Tokens {
        access: access.into(),
        refresh: refresh.map(str::to_owned),
        expires: Some(chrono::Utc::now().timestamp() + lifetime),
    })
}

pub(super) async fn sync_token(
    service: &Service,
    root: &Path,
    provider: &str,
    account: &Value,
    force: bool,
) -> Result<String, RpcError> {
    if account["needsReconnect"] == true {
        return Err(reconnect());
    }
    let saved = account["token"]
        .as_str()
        .and_then(|secret| crate::integrations::vault::open(root, secret).ok())
        .filter(|token| valid_token(token));
    let now = chrono::Utc::now().timestamp();
    let expiry = account["expiresAt"].as_i64();
    let live = expiry.is_none_or(|end| end > now);
    if provider != "mal" || (!force && live && expiry.is_none_or(|end| end > now + 86_400)) {
        return saved.filter(|_| !force && live).ok_or_else(reconnect);
    }
    let client = saved_mal_client(account);
    let refresh = account["refreshToken"]
        .as_str()
        .and_then(|secret| crate::integrations::vault::open(root, secret).ok())
        .filter(|token| valid_token(token));
    let (Some(client), Some(refresh)) = (client, refresh) else {
        return saved.filter(|_| !force && live).ok_or_else(reconnect);
    };
    match mal_exchange(
        service,
        &[
            ("client_id", client),
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh),
        ],
        Some(&refresh),
    )
    .await
    {
        Ok(tokens) => {
            let mut update = account.clone();
            seal_tokens(root, &mut update, &tokens)?;
            replace_account(root, provider, account, &update, false)?;
            Ok(tokens.access)
        }
        Err(error)
            if !force
                && error.code != "unauthorised"
                && expiry.is_some_and(|end| end > now + 60) =>
        {
            saved.ok_or(error)
        }
        Err(error) => {
            if error.code == "unauthorised" {
                mark_reconnect(root, provider, account)?;
            }
            Err(error)
        }
    }
}

pub(super) async fn identity(
    service: &Service,
    provider: &str,
    token: &str,
) -> Result<Value, RpcError> {
    let mut account = if provider == "anilist" {
        let data = service
            .graphql(
                "query { Viewer { id name avatar { medium } } }",
                json!({}),
                Some(token),
            )
            .await?;
        let user = &data["Viewer"];
        json!({"userId":positive_id(&user["id"]),"userName":bounded_name(&user["name"]),"avatar":safe_link(&user["avatar"]["medium"])})
    } else {
        let request = service
            .client
            .get("https://api.myanimelist.net/v2/users/@me")
            .bearer_auth(token);
        let user = response_json(service.send(request).await?, 32_000).await?;
        json!({"userId":positive_id(&user["id"]),"userName":bounded_name(&user["name"]),"avatar":safe_link(&user["picture"])})
    };
    if account["userId"].is_null() || account["userName"].is_null() {
        return Err(network());
    }
    account["provider"] = json!(provider);
    Ok(account)
}

pub(super) fn save_signin(
    root: &Path,
    provider: &str,
    client: &str,
    mut data: Value,
    tokens: &Tokens,
) -> Result<(), RpcError> {
    let db = profile::open(root).map_err(storage)?;
    let previous = read(db.as_ref(), provider)?;
    let same_user = previous["userId"]
        .as_i64()
        .is_some_and(|id| data["userId"] == id);
    data["lastSyncAt"] = if same_user {
        previous["lastSyncAt"].clone()
    } else {
        Value::Null
    };
    data["oauthClient"] = json!(client);
    seal_tokens(root, &mut data, tokens)?;
    replace_account(root, provider, &previous, &data, !same_user)
}

fn seal_tokens(root: &Path, data: &mut Value, tokens: &Tokens) -> Result<(), RpcError> {
    let protected = |token| {
        crate::integrations::vault::seal(root, token)
            .map_err(|_| RpcError::new("config", "Windows could not protect this credential."))
    };
    data["token"] = json!(protected(&tokens.access)?);
    data["refreshToken"] = json!(tokens.refresh.as_deref().map(protected).transpose()?);
    data["expiresAt"] = json!(tokens.expires);
    data["lastError"] = Value::Null;
    data["needsReconnect"] = Value::Bool(false);
    Ok(())
}

pub(super) fn mark_reconnect(root: &Path, provider: &str, account: &Value) -> Result<(), RpcError> {
    let mut update = account.clone();
    update["needsReconnect"] = Value::Bool(true);
    replace_account(root, provider, account, &update, false)
}

fn replace_account(
    root: &Path,
    provider: &str,
    expected: &Value,
    update: &Value,
    clear_queue: bool,
) -> Result<(), RpcError> {
    let mut db = profile::writable(root).map_err(storage)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage)?;
    if read(Some(&tx), provider)? != *expected {
        return Err(RpcError::new(
            "unavailable",
            "The saved account changed. Try again.",
        ));
    }
    tx.execute(
        "INSERT INTO accounts(provider,data) VALUES(?1,?2)
        ON CONFLICT(provider) DO UPDATE SET data=excluded.data",
        params![provider, update.to_string()],
    )
    .map_err(storage)?;
    if clear_queue {
        tx.execute("DELETE FROM sync_queue WHERE provider=?1", [provider])
            .map_err(storage)?;
    }
    tx.commit().map_err(storage)?;
    Ok(())
}

fn reconnect() -> RpcError {
    RpcError::new(
        "unauthorised",
        "The account needs to reconnect before syncing.",
    )
}
