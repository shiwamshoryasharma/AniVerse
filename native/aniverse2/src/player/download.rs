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
            && session
                .active_episode
                .lock()
                .ok()
                .is_some_and(|active| *active == episode)
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
    let selected = offer.ok_or_else(|| failure("This player did not expose a clear MP4 or a supported HLS stream. Start playback, then try again."))?;
    owner
        .state::<downloads::Service>()
        .save_active(
            owner,
            selected.url.clone(),
            selected.selection.clone(),
            || async {
                if !current() {
                    return false;
                }
                let _command = session.command.lock().await;
                candidate(session, generation)
                    .await
                    .is_some_and(|next| selected.same_media(&next))
                    && current()
            },
            current,
        )
        .await
}

struct Candidate {
    media: String,
    url: Url,
    selection: downloads::Selection,
}

impl Candidate {
    fn same_media(&self, next: &Self) -> bool {
        let subtitle = |candidate: &Self| {
            candidate.selection.subtitle.as_ref().map(|choice| {
                (
                    choice.url.clone(),
                    choice.language.clone(),
                    choice.label.clone(),
                )
            })
        };
        self.media == next.media && self.url == next.url && subtitle(self) == subtitle(next)
    }
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
    from_offer(&offer, true)
}

fn url(value: &Value, owned_frame: bool) -> Option<Url> {
    let raw = value
        .as_str()
        .filter(|value| value.len() <= 4096 && !value.chars().any(char::is_control))?;
    Url::parse(raw).ok().filter(|url| {
        if owned_frame {
            downloads::is_owned_player_endpoint(url)
        } else {
            downloads::public_media_url(url)
        }
    })
}

fn urls(offer: &Value, key: &str, limit: usize, owned_frame: bool) -> Option<Vec<Url>> {
    let Some(value) = offer.get(key) else {
        return Some(Vec::new());
    };
    let values = value.as_array().filter(|values| values.len() <= limit)?;
    let mut result = Vec::new();
    for value in values {
        let value = url(value, owned_frame)?;
        if !result.contains(&value) {
            result.push(value);
        }
    }
    Some(result)
}

fn metadata(value: Option<&Value>, limit: usize) -> Option<Option<String>> {
    let Some(value) = value else {
        return Some(None);
    };
    let value = value.as_str()?.trim();
    if value.is_empty() || value.chars().count() > limit || value.chars().any(char::is_control) {
        return None;
    }
    Some(Some(value.to_owned()))
}

fn from_offer(offer: &Value, owned_frame: bool) -> Option<Candidate> {
    let object = offer.as_object()?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "media"
                | "url"
                | "observed"
                | "playlists"
                | "observations"
                | "subtitle"
                | "expectedDuration"
        )
    }) {
        return None;
    }
    let media = offer["media"].as_str()?.to_owned();
    if media.len() > 4096 || media.chars().any(char::is_control) {
        return None;
    }
    let primary = url(&offer["url"], owned_frame)?;
    let hls = primary.path().to_ascii_lowercase().ends_with(".m3u8");
    if !downloads::is_active_media_url(&primary) && !(owned_frame && hls) {
        return None;
    }
    let playlists = urls(offer, "playlists", 8, owned_frame)?;
    if playlists
        .iter()
        .any(|url| !url.path().to_ascii_lowercase().ends_with(".m3u8"))
    {
        return None;
    }
    let mut observations = urls(offer, "observations", 32, owned_frame)?;
    if let Some(value) = offer.get("observed") {
        let observed = url(value, owned_frame)?;
        if !observations.contains(&observed) && observations.len() < 32 {
            observations.push(observed);
        }
    }
    if media.starts_with("blob:") {
        if !primary.path().to_ascii_lowercase().ends_with(".m3u8") || observations.is_empty() {
            return None;
        }
    } else if Url::parse(&media).ok().as_ref() != Some(&primary) {
        return None;
    }
    let expected_duration = match offer.get("expectedDuration") {
        None => None,
        Some(value) => Some(
            value
                .as_f64()
                .filter(|value| value.is_finite() && *value > 0.0 && *value <= 21_600.0)?,
        ),
    };
    if primary.query().is_some()
        && (!owned_frame || expected_duration.is_none() || !playlists.contains(&primary))
    {
        return None;
    }
    let subtitle = match offer.get("subtitle") {
        None => None,
        Some(value) => {
            if value
                .as_object()?
                .keys()
                .any(|key| !matches!(key.as_str(), "url" | "language" | "label"))
            {
                return None;
            }
            let choice = downloads::SubtitleChoice {
                url: match value.get("url") {
                    None => None,
                    Some(value) => Some(url(value, owned_frame)?),
                },
                language: metadata(value.get("language"), 64)?,
                label: metadata(value.get("label"), 128)?,
            };
            if choice.url.is_none() && choice.language.is_none() && choice.label.is_none() {
                return None;
            }
            Some(choice)
        }
    };
    let direct_primary = media == primary.as_str();
    Some(Candidate {
        media,
        url: primary,
        selection: downloads::Selection {
            direct_primary,
            expected_duration,
            playlists,
            observations,
            subtitle,
            ..downloads::Selection::default()
        },
    })
}

#[cfg(test)]
#[path = "../../../../test/tauri-compat/download-offer.rs"]
mod tests;
