use super::{allowed_top, failure, invalid, native, Session};
use crate::{downloads, RpcError};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tauri::{Manager, Url, Webview};

const INSPECT: &str = include_str!("download-guest.js");

pub(super) async fn request(
    owner: &Webview,
    session: &Session,
    input: &Value,
) -> Result<Value, RpcError> {
    let save = input["save"].as_bool().ok_or_else(invalid)?;
    let generation = session.page_generation.load(Ordering::Acquire);
    let job = session.job.load(Ordering::Acquire);
    let episode = session
        .active_episode
        .lock()
        .ok()
        .and_then(|active| *active);
    let current = || {
        episode.is_some()
            && !session.browsing_private()
            && session.source.kind == "web"
            && !session.closed.load(Ordering::Acquire)
            && session.ready.load(Ordering::Acquire)
            && session.page_generation.load(Ordering::Acquire) == generation
            && session.job.load(Ordering::Acquire) == job
            && session.view.url().is_ok_and(|url| {
                url.as_str() != "about:blank" && allowed_top(&url, &session.source.base)
            })
    };
    let offer = if current() {
        let _command = session.command.lock().await;
        candidate(session, generation).await.filter(|_| current())
    } else {
        None
    };
    if !save {
        return Ok(json!({"available":offer.is_some()}));
    }
    let selected = offer.ok_or_else(|| failure(
        "This player did not expose a clear MP4 or a supported HLS stream. Start playback, then try again.",
    ))?;
    owner
        .state::<downloads::Service>()
        .save_active(
            owner,
            selected.url.clone(),
            selected.observed.clone(),
            || async {
                if !current() {
                    return false;
                }
                let _command = session.command.lock().await;
                candidate(session, generation).await.is_some_and(|current| {
                    current.media == selected.media && current.url == selected.url
                }) && current()
            },
        )
        .await
}

struct Candidate {
    media: String,
    url: Url,
    observed: Option<Url>,
}

async fn candidate(session: &Session, generation: u64) -> Option<Candidate> {
    let top = native::read(session, INSPECT).await.ok()?;
    let offer = if top["frame"] == true {
        native::inspect_player_frame(session, generation, INSPECT)
            .await
            .ok()?
    } else {
        top
    };
    let media = offer["media"].as_str()?.to_owned();
    let url = Url::parse(offer["url"].as_str()?).ok()?;
    if !downloads::is_active_media_url(&url) {
        return None;
    }
    let observed = if media.starts_with("blob:") {
        Some(Url::parse(offer["observed"].as_str()?).ok()?)
    } else {
        None
    };
    Some(Candidate {
        media,
        url,
        observed,
    })
}
