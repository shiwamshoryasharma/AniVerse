mod spool;

use super::identity::{self, ANILIST_REDIRECT, MAL_REDIRECT};
use crate::{
    integrations::{invalid, network, url_query, Service},
    runtime_privacy, sources, RpcError,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::Url;
use std::{
    collections::HashMap,
    ffi::OsStr,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, Webview};
use windows_sys::Win32::Security::Cryptography::{
    BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
};

const TTL: Duration = Duration::from_secs(600);

#[derive(Default)]
pub(in crate::integrations) struct Broker {
    slots: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

struct Attempt<'a> {
    broker: &'a Broker,
    provider: &'a str,
    canceled: Arc<AtomicBool>,
    started: Instant,
    epoch: u64,
}

impl Broker {
    pub(in crate::integrations) fn signing_in(&self, provider: &str) -> bool {
        self.slots.lock().is_ok_and(|all| {
            all.get(provider)
                .is_some_and(|state| !state.load(Ordering::Acquire))
        })
    }

    pub(in crate::integrations) fn cancel(&self, provider: &str) -> Result<(), RpcError> {
        if let Some(state) = self.slots.lock().map_err(|_| network())?.remove(provider) {
            state.store(true, Ordering::Release);
        }
        Ok(())
    }

    pub(in crate::integrations) fn configured(&self, provider: &str) -> bool {
        identity::client_id(provider).is_some() && spool::owns_scheme()
    }

    pub(in crate::integrations) async fn connect(
        &self,
        service: &Service,
        window: &Webview,
        data: &Path,
        provider: &str,
    ) -> Result<(), RpcError> {
        if runtime_privacy::active() {
            return Err(RpcError::new(
                "unauthorised",
                "Exit incognito before connecting an account.",
            ));
        }
        let client = identity::client_id(provider).ok_or_else(|| {
            RpcError::new(
                "config",
                "AniVerse2 sign-in is unavailable without a registered provider client ID.",
            )
        })?;
        if !spool::owns_scheme() {
            return Err(RpcError::new(
                "config",
                "Windows is not routing AniVerse2 callbacks to this installation.",
            ));
        }
        let root = window
            .app_handle()
            .path()
            .app_data_dir()
            .map_err(|_| network())?;
        let attempt = self.begin(provider)?;
        std::fs::create_dir_all(&root).map_err(|_| spool::error())?;
        let state = random::<32>()?;
        let verifier = (provider == "mal").then(random::<64>).transpose()?;
        let mut ticket = spool::Ticket::new(&root, provider, &state).map_err(|_| spool::error())?;
        let url = authorize(provider, client, &state, verifier.as_deref())?;
        attempt.check()?;
        sources::open_in_windows(OsStr::new(url.as_str()))
            .map_err(|_| RpcError::new("unavailable", "Could not open your browser."))?;
        let grant = loop {
            attempt.check()?;
            if let Some(raw) = ticket.response().map_err(|_| spool::error())? {
                let callback = parse(&raw)
                    .filter(|callback| {
                        callback.provider == provider && same_secret(&callback.state, &state)
                    })
                    .ok_or_else(spool::error)?;
                break callback.grant;
            }
            tokio::time::sleep(Duration::from_millis(140)).await;
        };
        attempt.check()?;
        let _account = service.account_lock().await;
        attempt.check()?;
        let tokens = match grant {
            Grant::AniList { token, expires } => identity::Tokens::anilist(token, expires)?,
            Grant::Mal(code) => {
                identity::exchange_mal(
                    service,
                    client,
                    &code,
                    verifier.as_deref().ok_or_else(invalid)?,
                )
                .await?
            }
            Grant::Denied => {
                return Err(RpcError::new(
                    "unauthorised",
                    "You did not approve the account connection.",
                ))
            }
        };
        attempt.check()?;
        let identity = identity::identity(service, provider, &tokens.access).await?;
        attempt.complete(|| identity::save_signin(data, provider, client, identity, &tokens))
    }

    fn begin<'a>(&'a self, provider: &'a str) -> Result<Attempt<'a>, RpcError> {
        let canceled = Arc::new(AtomicBool::new(false));
        if let Some(previous) = self
            .slots
            .lock()
            .map_err(|_| network())?
            .insert(provider.into(), canceled.clone())
        {
            previous.store(true, Ordering::Release);
        }
        Ok(Attempt {
            broker: self,
            provider,
            canceled,
            started: Instant::now(),
            epoch: runtime_privacy::epoch(),
        })
    }
}

impl Attempt<'_> {
    fn complete<T>(&self, save: impl FnOnce() -> Result<T, RpcError>) -> Result<T, RpcError> {
        let slots = self.broker.slots.lock().map_err(|_| network())?;
        self.check()?;
        if !slots
            .get(self.provider)
            .is_some_and(|state| Arc::ptr_eq(state, &self.canceled))
        {
            return Err(RpcError::new("unauthorised", "Sign-in was cancelled."));
        }
        save()
    }
    fn check(&self) -> Result<(), RpcError> {
        if self.canceled.load(Ordering::Acquire)
            || runtime_privacy::active()
            || runtime_privacy::epoch() != self.epoch
        {
            return Err(RpcError::new("unauthorised", "Sign-in was cancelled."));
        }
        if self.started.elapsed() >= TTL {
            return Err(RpcError::new(
                "unauthorised",
                "Sign-in timed out. Click Connect to try again.",
            ));
        }
        Ok(())
    }
}

impl Drop for Attempt<'_> {
    fn drop(&mut self) {
        if let Ok(mut slots) = self.broker.slots.lock() {
            if slots
                .get(self.provider)
                .is_some_and(|state| Arc::ptr_eq(state, &self.canceled))
            {
                slots.remove(self.provider);
            }
        }
    }
}

enum Grant {
    AniList { token: String, expires: Option<i64> },
    Mal(String),
    Denied,
}

struct Callback {
    provider: &'static str,
    state: String,
    grant: Grant,
}

fn authorize(
    provider: &str,
    id: &str,
    state: &str,
    verifier: Option<&str>,
) -> Result<Url, RpcError> {
    if provider == "anilist" {
        return url_query(
            "https://anilist.co/api/v2/oauth/authorize",
            &[
                ("client_id", id),
                ("response_type", "token"),
                ("state", state),
            ],
        );
    }
    let verifier = verifier.ok_or_else(invalid)?;
    url_query(
        "https://myanimelist.net/v1/oauth2/authorize",
        &[
            ("response_type", "code"),
            ("client_id", id),
            ("state", state),
            ("redirect_uri", MAL_REDIRECT),
            ("code_challenge", verifier),
            ("code_challenge_method", "plain"),
        ],
    )
}

fn parse(raw: &str) -> Option<Callback> {
    if raw.len() > 16_384
        || raw
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return None;
    }
    let provider = match raw.split(['?', '#']).next()? {
        ANILIST_REDIRECT => "anilist",
        MAL_REDIRECT => "mal",
        _ => return None,
    };
    let url = Url::parse(raw).ok()?;
    let query = url.query_pairs();
    let fragment = || {
        reqwest::Url::parse("https://aniverse2.invalid/")
            .ok()
            .map(|mut fragment| {
                fragment.set_query(url.fragment());
                fragment
            })
    };
    let fragment = fragment()?;
    let unique = |field: &str| {
        let mut found = query
            .clone()
            .chain(fragment.query_pairs())
            .filter_map(|(key, value)| (key == field).then_some(value));
        let first = found.next().map(|value| value.into_owned());
        found.next().is_none().then_some(first)
    };
    let state = unique("state")??;
    if !valid_state(&state) {
        return None;
    }
    let token = unique("access_token")?;
    let code = unique("code")?;
    let expires = unique("expires_in")?;
    let error = unique("error")?;
    let grant = if let Some(error) = error.filter(|error| !error.is_empty()) {
        if error.len() > 100 || token.is_some() || code.is_some() {
            return None;
        }
        Grant::Denied
    } else if provider == "anilist" {
        if code.is_some() {
            return None;
        }
        let token = token.filter(|value| identity::valid_token(value))?;
        if !fragment.query_pairs().any(|(key, _)| key == "access_token") {
            return None;
        }
        let expires = match expires {
            Some(text) => Some(
                text.parse::<i64>()
                    .ok()
                    .filter(|secs| (1..=31_536_000).contains(secs))?,
            ),
            None => None,
        };
        Grant::AniList { token, expires }
    } else {
        if token.is_some() || expires.is_some() {
            return None;
        }
        let code = code.filter(|value| identity::valid_token(value))?;
        if !query.clone().any(|(key, _)| key == "code") {
            return None;
        }
        Grant::Mal(code)
    };
    Some(Callback {
        provider,
        state,
        grant,
    })
}

fn valid_state(state: &str) -> bool {
    state.len() == 43
        && state
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn same_secret(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left
            .bytes()
            .zip(right.bytes())
            .fold(0u8, |sum, (x, y)| sum | (x ^ y))
            == 0
}

fn random<const N: usize>() -> Result<String, RpcError> {
    let mut bytes = [0; N];
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            N as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        return Err(network());
    }
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub(in crate::integrations) fn receive_callback(identifier: &str) -> Option<bool> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new("--oauth-callback")) {
        return None;
    }
    if cfg!(feature = "isolated-test") || !spool::owns_scheme() {
        return Some(false);
    }
    let payload = args.next().and_then(|raw| raw.into_string().ok());
    let valid = (|| {
        let raw = payload?;
        if args.next().is_some() {
            return None;
        }
        let callback = parse(&raw)?;
        let root = spool::roaming_root(identifier).ok()?;
        spool::deliver(&root, &callback, &raw).ok()
    })()
    .is_some();
    Some(valid)
}

#[cfg(test)]
#[path = "../../../../../test/tauri-compat/accounts-oauth.rs"]
mod tests;
