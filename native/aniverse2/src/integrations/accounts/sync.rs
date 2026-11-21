mod reconcile;
mod remote;
mod state;

use super::{identity, read};
use crate::{
    integrations::{invalid, positive_id, response_json, storage, Service},
    profile, RpcError,
};
use reconcile::Entry;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap},
    path::Path,
};
use tauri::{Emitter, Webview};

#[derive(Clone, Copy, Eq, PartialEq)]
pub(in crate::integrations) enum Mode {
    Full,
    PushDue,
}

pub(in crate::integrations) fn queue(
    db: &Connection,
    id: i64,
    favourite: Option<bool>,
) -> Result<bool, RpcError> {
    state::queue_library(db, id, favourite)
}

struct Session {
    provider: &'static str,
    token: String,
    user: Option<i32>,
    last_sync: Option<i64>,
    privacy_epoch: u64,
}

struct RemoteEntry {
    media: Value,
    entry: Entry,
    updated: i64,
}

#[derive(Default)]
struct Remote {
    entries: HashMap<i32, RemoteEntry>,
    favourites: Vec<Value>,
    unmapped: BTreeSet<i32>,
}

impl Remote {
    fn insert(&mut self, entry: RemoteEntry) {
        if let Some(id) = positive_id(&entry.media["id"]) {
            if self
                .entries
                .get(&id)
                .is_none_or(|known| known.updated < entry.updated)
            {
                self.entries.insert(id, entry);
            }
        }
    }
}

#[derive(Default)]
struct Report {
    pushed: usize,
    failed: usize,
    pulled: usize,
    resolved: usize,
    errors: Vec<String>,
}

pub(in crate::integrations) async fn run(
    service: &Service,
    window: &Webview,
    root: &Path,
    input: &Value,
    mode: Mode,
) -> Result<Value, RpcError> {
    let selected = match input.get("provider") {
        Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_str()
                .filter(|provider| matches!(*provider, "anilist" | "mal"))
                .ok_or_else(invalid)?,
        ),
        None => return Err(invalid()),
    };
    let epoch = crate::runtime_privacy::epoch();
    privacy(epoch)?;
    let two_way = mode == Mode::Full
        && crate::integrations::kv(root, "settings")?["accounts"]["twoWay"] != false;
    let mut report = Report::default();
    let sessions = sessions(service, window, root, selected, epoch, mode, &mut report).await?;
    let mut active = Vec::new();
    let started = chrono::Utc::now().timestamp();
    for mut session in sessions {
        privacy(epoch)?;
        let provider = session.provider;
        event(window, provider, "syncing", "Checking your list…");
        let fetched = async {
            validate_session(service, root, &mut session).await?;
            if two_way {
                remote::pull(service, &session).await.map(Some)
            } else {
                Ok(None)
            }
        }
        .await;
        match fetched {
            Ok(rest) => active.push((session, rest)),
            Err(error) => failure(window, &mut report, provider, error),
        }
    }
    privacy(epoch)?;
    state::merge(root, &active, &mut report)?;
    for (session, remote) in active {
        if let Err(error) = flush(service, root, &session, remote.as_ref(), &mut report).await {
            failure(window, &mut report, session.provider, error);
            continue;
        }
        privacy(epoch)?;
        if mode == Mode::Full {
            state::mark_synced(root, session.provider, started)?;
        }
        event(window, session.provider, "ok", "Account list checked.");
    }
    Ok(
        json!({"pushed":report.pushed,"failed":report.failed,"pulled":report.pulled,
        "resolved":report.resolved,"errors":report.errors}),
    )
}

async fn sessions(
    service: &Service,
    window: &Webview,
    root: &Path,
    selected: Option<&str>,
    epoch: u64,
    mode: Mode,
    report: &mut Report,
) -> Result<Vec<Session>, RpcError> {
    let saved: Vec<_> = {
        let db = profile::open(root).map_err(storage)?;
        ["anilist", "mal"]
            .into_iter()
            .filter(|provider| selected.is_none_or(|selected| selected == *provider))
            .map(|provider| {
                let account = if mode == Mode::PushDue && !state::has_due(db.as_ref(), provider)? {
                    Value::Null
                } else {
                    read(db.as_ref(), provider)?
                };
                Ok::<_, RpcError>((provider, account))
            })
            .collect::<Result<_, _>>()?
    };
    let mut result = Vec::new();
    for (provider, saved) in saved {
        if !saved.is_object() {
            continue;
        }
        privacy(epoch)?;
        match identity::sync_token(service, root, provider, &saved, false).await {
            Ok(token) => result.push(Session {
                provider,
                token,
                user: positive_id(&saved["userId"]),
                last_sync: saved["lastSyncAt"].as_i64(),
                privacy_epoch: epoch,
            }),
            Err(error) => failure(window, report, provider, error),
        }
    }
    Ok(result)
}

async fn validate_session(
    service: &Service,
    root: &Path,
    session: &mut Session,
) -> Result<(), RpcError> {
    match verify_user(service, session).await {
        Ok(()) => return Ok(()),
        Err(error) if error.code == "unauthorised" => {}
        Err(error) => return Err(error),
    }
    privacy(session.privacy_epoch)?;
    let stored = || {
        let db = profile::open(root).map_err(storage)?;
        read(db.as_ref(), session.provider)
    };
    let refreshed = if session.provider == "mal" {
        identity::sync_token(service, root, session.provider, &stored()?, true).await
    } else {
        Err(RpcError::new(
            "unauthorised",
            "The service rejected the saved account session.",
        ))
    };
    let outcome = match refreshed {
        Ok(token) => {
            session.token = token;
            verify_user(service, session).await
        }
        Err(error) => Err(error),
    };
    if outcome
        .as_ref()
        .is_err_and(|error| error.code == "unauthorised")
    {
        privacy(session.privacy_epoch)?;
        identity::mark_reconnect(root, session.provider, &stored()?)?;
    }
    outcome
}

async fn verify_user(service: &Service, session: &Session) -> Result<(), RpcError> {
    privacy(session.privacy_epoch)?;
    let user = if session.provider == "anilist" {
        service
            .graphql("query { Viewer { id } }", json!({}), Some(&session.token))
            .await?["Viewer"]["id"]
            .clone()
    } else {
        let request = service
            .client
            .get("https://api.myanimelist.net/v2/users/@me")
            .bearer_auth(&session.token);
        response_json(service.send(request).await?, 32_000).await?["id"].clone()
    };
    if positive_id(&user).is_some_and(|id| Some(id) == session.user) {
        return Ok(());
    }
    Err(RpcError::new(
        "unauthorised",
        "The service returned a different account. Reconnect it before syncing.",
    ))
}

async fn flush(
    service: &Service,
    root: &Path,
    session: &Session,
    remote: Option<&Remote>,
    report: &mut Report,
) -> Result<(), RpcError> {
    let epoch = session.privacy_epoch;
    for job in state::jobs(root, session.provider)? {
        privacy(epoch)?;
        let action = state::current(root, &job)?;
        match &action {
            None => state::completed(root, &job, None)?,
            Some((id, mal, entry, favourite)) => {
                if session.provider == "mal"
                    && mal
                        .is_none_or(|id| remote.is_some_and(|remote| remote.unmapped.contains(&id)))
                {
                    // The queued job has no exact MAL identity. Keep it for review.
                    continue;
                }
                match remote::push(
                    service,
                    root,
                    session,
                    *id,
                    *mal,
                    entry.as_ref(),
                    *favourite,
                )
                .await
                {
                    Ok(pushed) => {
                        privacy(epoch)?;
                        if state::current(root, &job)? == action {
                            state::completed(root, &job, None)?;
                        }
                        report.pushed += usize::from(pushed);
                    }
                    Err(error) => {
                        privacy(epoch)?;
                        state::completed(root, &job, Some(&error.message))?;
                        return Err(error);
                    }
                }
            }
        }
    }
    Ok(())
}

fn privacy(epoch: u64) -> Result<(), RpcError> {
    if crate::runtime_privacy::active() {
        return Err(RpcError::new(
            "unauthorised",
            "Exit incognito before syncing accounts.",
        ));
    }
    if crate::runtime_privacy::epoch() != epoch {
        return Err(RpcError::new(
            "unavailable",
            "Privacy changed during sync. Sync again.",
        ));
    }
    Ok(())
}

fn event(window: &Webview, provider: &'static str, state: &str, message: &str) {
    let _ = window.emit(
        "aniverse:sync/status",
        json!({"provider":provider, "state":state, "message":message}),
    );
}

fn failure(window: &Webview, report: &mut Report, provider: &'static str, error: RpcError) {
    report.failed += 1;
    report.errors.push(format!("{provider}: {}", error.message));
    event(window, provider, "error", &error.message);
}
#[cfg(test)]
#[path = "../../../../../test/tauri-compat/account-sync.rs"]
mod tests;
