use super::{allowed_top, download_network, failure, invalid, native, Session};
use crate::{
    downloads::{self, media::MediaFormat},
    RpcError,
};
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
    let filename_context = input.get("filenameContext").cloned();
    let max_height = match input.get("maxHeight") {
        None => None,
        Some(value) => Some(
            value
                .as_u64()
                .filter(|height| (144..=4320).contains(height))
                .ok_or_else(invalid)? as u32,
        ),
    };
    if filename_context.as_ref().is_some_and(|context| {
        !episode.is_some_and(|(_, number)| context["episode"].as_u64() == Some(number as u64))
    }) {
        return Err(failure(
            "The episode filename context does not match the selected episode.",
        ));
    }
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
    let mut selected = offer.ok_or_else(|| failure(
        "No supported clear video was detected in the selected player. Start playback, then try again.",
    ))?;
    selected.selection.max_height = max_height;
    owner
        .state::<downloads::Service>()
        .save_active(
            owner,
            selected.url.clone(),
            selected.selection.clone(),
            filename_context,
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
    identity: String,
    media: String,
    url: Url,
    selection: downloads::Selection,
}

impl Candidate {
    fn same_media(&self, next: &Self) -> bool {
        self.identity == next.identity
            && self.media == next.media
            && match (
                self.selection.expected_duration,
                next.selection.expected_duration,
            ) {
                (Some(before), Some(after)) => (before - after).abs() <= 0.5,
                (None, None) => true,
                _ => false,
            }
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
    let responses = session
        .download_responses
        .lock()
        .ok()
        .map(|entries| entries.snapshot(generation, session.job.load(Ordering::Acquire)))
        .unwrap_or_default();
    from_observed_offer(&offer, true, &responses)
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

fn path_format(url: &Url) -> Option<MediaFormat> {
    let (_, suffix) = url.path().rsplit_once('.')?;
    match suffix.to_ascii_lowercase().as_str() {
        "mp4" => Some(MediaFormat::Mp4),
        "webm" => Some(MediaFormat::Webm),
        "m3u8" => Some(MediaFormat::Hls),
        "mpd" => Some(MediaFormat::Dash),
        _ => None,
    }
}

#[cfg(test)]
fn from_offer(offer: &Value, owned_frame: bool) -> Option<Candidate> {
    from_observed_offer(offer, owned_frame, &[])
}

fn from_observed_offer(
    offer: &Value,
    owned_frame: bool,
    responses: &[download_network::Response],
) -> Option<Candidate> {
    let object = offer.as_object()?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "identity"
                | "media"
                | "url"
                | "observed"
                | "playlists"
                | "observations"
                | "resources"
                | "subtitle"
                | "expectedDuration"
        )
    }) {
        return None;
    }
    let identity = offer["identity"].as_str()?.to_owned();
    if identity.is_empty()
        || identity.len() > 96
        || !identity
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b':'))
    {
        return None;
    }
    let media = offer["media"].as_str()?.to_owned();
    if media.len() > 4096 || media.chars().any(char::is_control) {
        return None;
    }
    let proposed = url(&offer["url"], owned_frame)?;
    let mut playlists = urls(offer, "playlists", 8, owned_frame)?;
    if playlists
        .iter()
        .any(|url| path_format(url) != Some(MediaFormat::Hls))
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
    let resources = urls(offer, "resources", 48, owned_frame)?;
    let direct_primary = !media.starts_with("blob:");
    let observed_response = |url: &Url| responses.iter().find(|entry| &entry.url == url);
    let historical_or_observed_format = |url: &Url| {
        observed_response(url)
            .and_then(|entry| downloads::media::format_from_mime(&entry.mime))
            .or_else(|| path_format(url))
    };
    let mut primary = proposed.clone();
    if direct_primary {
        if Url::parse(&media).ok().as_ref() != Some(&proposed) {
            return None;
        }
        // New direct formats (including generic MIME and extensionless paths)
        // need an actual response in the selected view. The old public MP4/HLS
        // paths still work on runtimes without response metadata.
        if observed_response(&primary).is_none()
            && !matches!(
                path_format(&primary),
                Some(MediaFormat::Mp4 | MediaFormat::Hls)
            )
        {
            return None;
        }
    } else {
        for resource in &resources {
            if matches!(
                observed_response(resource)
                    .and_then(|entry| downloads::media::format_from_mime(&entry.mime)),
                Some(MediaFormat::Hls | MediaFormat::Dash)
            ) && !playlists.contains(resource)
                && playlists.len() < 8
            {
                playlists.push(resource.clone());
            }
        }
        if !playlists.contains(&primary) {
            if matches!(
                path_format(&primary),
                Some(MediaFormat::Hls | MediaFormat::Dash)
            ) {
                return None;
            }
            primary = playlists.first()?.clone();
        }
        // The downloader will also match these references and duration to the
        // selected manifest and never treat resource order alone as ownership.
        if observations.is_empty() {
            return None;
        }
    }
    let format = historical_or_observed_format(&primary);
    if !direct_primary && !matches!(format, Some(MediaFormat::Hls | MediaFormat::Dash)) {
        return None;
    }
    if matches!(format, Some(MediaFormat::Hls | MediaFormat::Dash)) {
        playlists.retain(|url| historical_or_observed_format(url) == format);
        if !playlists.contains(&primary) {
            playlists.truncate(7);
            playlists.insert(0, primary.clone());
        }
    } else if format.is_some() {
        playlists.clear();
        observations.clear();
    }
    let expected_duration = match offer.get("expectedDuration") {
        None => None,
        Some(value) => Some(
            value
                .as_f64()
                .filter(|value| value.is_finite() && *value > 0.0 && *value <= 21_600.0)?,
        ),
    };
    let owned_root = owned_frame && observed_response(&primary).is_some();
    if primary.query().is_some()
        && (!owned_frame
            || expected_duration.is_none()
            || !(owned_root || format == Some(MediaFormat::Hls) && playlists.contains(&primary)))
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
    let subtitle_url = subtitle.as_ref().and_then(|choice| choice.url.as_ref());
    let mut request_contexts = downloads::media::RequestContexts::default();
    if owned_frame {
        for response in responses {
            let url = &response.url;
            let observed = url == &primary
                || subtitle_url == Some(url)
                || (format.is_none()
                    || matches!(format, Some(MediaFormat::Hls | MediaFormat::Dash)))
                    && (playlists.contains(url)
                        || observations.contains(url)
                        || resources.contains(url));
            if observed && !response.headers.is_empty() {
                request_contexts.insert(url.clone(), response.headers.clone());
            }
        }
    }
    Some(Candidate {
        identity,
        media,
        url: primary,
        selection: downloads::Selection {
            direct_primary,
            expected_duration,
            format,
            request_contexts,
            owned_root,
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
