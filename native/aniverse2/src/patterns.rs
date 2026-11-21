use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Url;

const TTL: u64 = 30 * 86_400;
const MAX_ORIGINS: usize = 128;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Hint {
    selector: String,
    checked: u64,
}

type Origins = BTreeMap<String, BTreeMap<String, Hint>>;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    version: u8,
    origins: Origins,
}

struct Observation {
    source: String,
    origin: String,
    media: i64,
    episodes: BTreeMap<u32, u8>,
    observed: Instant,
}

struct CatalogueObservation {
    source: String,
    origin: String,
    media: i64,
    counts: [Option<u64>; 3],
    observed: Instant,
}

pub(crate) struct Service {
    path: PathBuf,
    hints: Mutex<Origins>,
    observed: Mutex<VecDeque<Observation>>,
    catalogue: Mutex<VecDeque<CatalogueObservation>>,
}

impl Service {
    pub(crate) fn new(root: &Path) -> Self {
        let path = root.join("navigation-patterns.json");
        let mut hints = crate::profile::text_file(&path, 256 * 1024)
            .ok()
            .flatten()
            .and_then(|file| serde_json::from_str::<Stored>(&file).ok())
            .filter(|file| file.version == 1 && file.origins.len() <= MAX_ORIGINS)
            .map(|file| file.origins)
            .unwrap_or_default();
        let now = time();
        hints.retain(|origin, group| {
            group.retain(|field, hint| {
                field_allowed(field) && live(hint, now) && structural(&hint.selector)
            });
            origin_allowed(origin) && !group.is_empty()
        });
        Self {
            path,
            hints: Mutex::new(hints),
            observed: Mutex::new(VecDeque::new()),
            catalogue: Mutex::new(VecDeque::new()),
        }
    }

    pub(crate) fn selector(&self, origin: &str, field: &str, private: bool) -> Option<String> {
        if private || !origin_allowed(origin) || !field_allowed(field) {
            return None;
        }
        let hints = self.hints.lock().ok()?;
        let now = time();
        if let Some(hint) = hints
            .get(origin)
            .and_then(|group| group.get(field))
            .filter(|hint| live(hint, now))
        {
            return Some(hint.selector.clone());
        }
        // Reuse structural patterns independently observed on two origins. IDs
        // stay local, as an apparent match may refer to an unrelated site control.
        let mut votes = BTreeMap::<&str, BTreeSet<String>>::new();
        for (origin, group) in hints.iter() {
            let Some(hint) = group.get(field) else {
                continue;
            };
            if live(hint, now) && !hint.selector.starts_with('#') {
                let host = Url::parse(origin).ok().and_then(|url| {
                    url.host_str()
                        .map(|host| host.strip_prefix("www.").unwrap_or(host).to_owned())
                });
                if let Some(host) = host {
                    votes.entry(&hint.selector).or_default().insert(host);
                }
            }
        }
        votes
            .into_iter()
            .filter(|(_, hosts)| hosts.len() >= 2)
            .max_by_key(|(selector, hosts)| (hosts.len(), std::cmp::Reverse(*selector)))
            .map(|(selector, _)| selector.to_owned())
    }

    pub(crate) fn remember(&self, origin: &str, field: &str, selector: &str, private: bool) {
        if private || !origin_allowed(origin) || !field_allowed(field) || !structural(selector) {
            return;
        }
        let Ok(mut hints) = self.hints.lock() else {
            return;
        };
        let now = time();
        if hints
            .get(origin)
            .and_then(|group| group.get(field))
            .is_some_and(|hint| {
                hint.selector == selector
                    && live(hint, now)
                    && now.saturating_sub(hint.checked) < 86_400
            })
        {
            return;
        }
        if hints.len() >= MAX_ORIGINS && !hints.contains_key(origin) {
            let oldest = hints
                .iter()
                .min_by_key(|(_, group)| group.values().map(|hint| hint.checked).max())
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                hints.remove(&oldest);
            }
        }
        hints.entry(origin.to_owned()).or_default().insert(
            field.to_owned(),
            Hint {
                selector: selector.to_owned(),
                checked: now,
            },
        );
        if let Some(dir) = self.path.parent() {
            let _ = (|| -> std::io::Result<()> {
                let mut file = tempfile::NamedTempFile::new_in(dir)?;
                serde_json::to_writer(
                    &mut file,
                    &Stored {
                        version: 1,
                        origins: hints.clone(),
                    },
                )?;
                file.flush()?;
                file.as_file().sync_all()?;
                file.persist(&self.path)?;
                Ok(())
            })();
        }
    }

    pub(crate) fn observe_audio(
        &self,
        source: &str,
        origin: &str,
        media: i64,
        cards: &Value,
        private: bool,
    ) {
        if private || media <= 0 || source.len() > 96 || !origin_allowed(origin) {
            return;
        }
        let Some(cards) = cards.as_array() else {
            return;
        };
        let mut episodes = BTreeMap::new();
        for card in cards.iter().take(500) {
            let Some(episode) = card["episode"]
                .as_u64()
                .filter(|episode| (1..=9999).contains(episode))
            else {
                continue;
            };
            let flags =
                card["audio"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(2)
                    .fold(0, |flags, audio| {
                        flags
                            | match audio.as_str() {
                                Some("sub") => 1,
                                Some("dub") => 2,
                                _ => 0,
                            }
                    });
            if flags != 0 {
                *episodes.entry(episode as u32).or_default() |= flags;
            }
        }
        if episodes.is_empty() {
            return;
        }
        let Ok(mut observed) = self.observed.lock() else {
            return;
        };
        let current = observed
            .iter()
            .position(|row| row.source == source && row.origin == origin && row.media == media);
        if let Some(current) = current.and_then(|index| observed.remove(index)) {
            if current.observed.elapsed() < Duration::from_secs(1800) {
                for (episode, flags) in current.episodes {
                    if episodes.len() < 500 || episodes.contains_key(&episode) {
                        *episodes.entry(episode).or_default() |= flags;
                    }
                }
            }
        }
        while observed.len() >= 64 {
            observed.pop_front();
        }
        observed.push_back(Observation {
            source: source.to_owned(),
            origin: origin.to_owned(),
            media,
            episodes,
            observed: Instant::now(),
        });
    }

    pub(crate) fn observe_catalogue(
        &self,
        source: &str,
        origin: &str,
        items: &[Value],
        private: &BTreeSet<i64>,
    ) {
        if source.len() > 180 || !origin_allowed(origin) {
            return;
        }
        let Ok(mut cache) = self.catalogue.lock() else {
            return;
        };
        for item in items.iter().take(48) {
            let Some(media) = item["media"]["id"]
                .as_i64()
                .filter(|id| *id > 0 && !private.contains(id))
            else {
                continue;
            };
            let counts = ["sub", "dub", "total"]
                .map(|field| item[field].as_u64().filter(|count| *count <= 99_999));
            if counts[0].is_none() && counts[1].is_none() {
                continue;
            }
            if let Some(index) = cache
                .iter()
                .position(|row| row.source == source && row.origin == origin && row.media == media)
            {
                cache.remove(index);
            }
            while cache.len() >= 256 {
                cache.pop_front();
            }
            cache.push_back(CatalogueObservation {
                source: source.to_owned(),
                origin: origin.to_owned(),
                media,
                counts,
                observed: Instant::now(),
            });
        }
    }

    pub(crate) fn hover(&self, source: &str, origin: &str, media: i64) -> Value {
        let counts = self
            .catalogue
            .lock()
            .ok()
            .and_then(|rows| {
                rows.iter()
                    .rev()
                    .find(|row| {
                        row.source == source
                            && row.origin == origin
                            && row.media == media
                            && row.observed.elapsed() < Duration::from_secs(600)
                    })
                    .map(|row| row.counts)
            })
            .unwrap_or_default();
        let observed = self
            .observed
            .lock()
            .ok()
            .and_then(|rows| {
                rows.iter()
                    .rev()
                    .find(|row| {
                        row.source == source
                            && row.origin == origin
                            && row.media == media
                            && row.observed.elapsed() < Duration::from_secs(1800)
                    })
                    .map(|row| {
                        [1, 2].map(|flag| {
                            let count = row
                                .episodes
                                .values()
                                .filter(|audio| **audio & flag != 0)
                                .count();
                            (count > 0).then_some(count as u64)
                        })
                    })
            })
            .unwrap_or_default();
        let sub = counts[0].max(observed[0]);
        let dub = counts[1].max(observed[1]);
        if sub.is_none() && dub.is_none() {
            return Value::Null;
        }
        json!({"sub": sub, "dub": dub, "total": counts[2]})
    }

    pub(crate) fn observed(
        &self,
        sources: &BTreeMap<String, String>,
        private: &BTreeSet<i64>,
    ) -> Value {
        let Ok(observed) = self.observed.lock() else {
            return json!([]);
        };
        let mut titles = BTreeMap::<i64, BTreeMap<u32, u8>>::new();
        for row in observed.iter().filter(|row| {
            row.observed.elapsed() < Duration::from_secs(1800)
                && !private.contains(&row.media)
                && sources.get(&row.source) == Some(&row.origin)
        }) {
            let episodes = titles.entry(row.media).or_default();
            for (episode, flags) in &row.episodes {
                *episodes.entry(*episode).or_default() |= flags;
            }
        }
        let names = |flags: u8| {
            ["sub", "dub"]
                .into_iter()
                .enumerate()
                .filter_map(|(index, name)| (flags & (1 << index) != 0).then_some(name))
                .collect::<Vec<_>>()
        };
        json!(titles
            .into_iter()
            .map(|(media, episodes)| {
                let audio = names(episodes.values().fold(0, |all, flags| all | *flags));
                let episodes = episodes
                    .into_iter()
                    .map(|(episode, flags)| json!({"episode": episode, "audio": names(flags)}))
                    .collect::<Vec<_>>();
                json!({"mediaId": media, "audio": audio, "episodes": episodes})
            })
            .collect::<Vec<_>>())
    }
}

fn time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn live(hint: &Hint, now: u64) -> bool {
    hint.checked <= now && now - hint.checked < TTL
}
fn origin_allowed(origin: &str) -> bool {
    origin.len() <= 300
        && Url::parse(origin).is_ok_and(|url| {
            url.scheme() == "https"
                && url.username().is_empty()
                && url.password().is_none()
                && url.origin().ascii_serialization() == origin
        })
}
fn field_allowed(field: &str) -> bool {
    matches!(
        field,
        "searchInput" | "searchOpener" | "titleLink" | "watchLink" | "episodeLink" | "player"
    )
}
fn structural(selector: &str) -> bool {
    static SELECTOR: OnceLock<Regex> = OnceLock::new();
    static TITLE_ID: OnceLock<Regex> = OnceLock::new();
    selector.len() <= 150
        && SELECTOR.get_or_init(|| Regex::new(r#"(?i)^(#[a-z][a-z0-9_-]{1,79}|[a-z][a-z0-9]{0,23}(\.[a-z][a-z0-9_-]{1,59}){1,2}|input\[(type="search"|name="[a-z][a-z0-9_-]{1,39}")\])$"#).unwrap()).is_match(selector)
        && !TITLE_ID.get_or_init(|| Regex::new(r"\d{5,}").unwrap()).is_match(selector)
}
#[cfg(test)]
#[path = "../../../test/tauri-compat/player-learning.rs"]
mod tests;
