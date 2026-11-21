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
const AUDIO_TTL: Duration = Duration::from_secs(1800);
const CATALOGUE_AUDIO_TTL: Duration = Duration::from_secs(600);

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum EpisodeStep {
    Direct,
    EpisodesTab,
    WatchLink,
}

impl EpisodeStep {
    const DEFAULT: [Self; 3] = [Self::Direct, Self::EpisodesTab, Self::WatchLink];

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::EpisodesTab => "episodesTab",
            Self::WatchLink => "watchLink",
        }
    }
}

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
    episodes: BTreeMap<u32, [Option<Instant>; 2]>,
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
            group.retain(|field, hint| live(hint, now) && valid_hint(field, &hint.selector));
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
        if private || !origin_allowed(origin) || !field_allowed(field) || field == "episodeStep" {
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
            if live(hint, now) && !hint.selector.starts_with('#') && !hint.selector.contains("{n}")
            {
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

    pub(crate) fn episode_steps(&self, origin: &str, private: bool) -> [EpisodeStep; 3] {
        let mut steps = EpisodeStep::DEFAULT;
        if !private && origin_allowed(origin) {
            if let Ok(hints) = self.hints.lock() {
                if let Some(hint) = hints
                    .get(origin)
                    .and_then(|group| group.get("episodeStep"))
                    .filter(|hint| live(hint, time()))
                {
                    if let Some(index) = steps.iter().position(|step| step.name() == hint.selector)
                    {
                        steps[..=index].rotate_right(1);
                    }
                }
            }
        }
        steps
    }

    pub(crate) fn forget(&self, origin: &str, field: &str, selector: &str, private: bool) {
        if private || !origin_allowed(origin) {
            return;
        }
        let Ok(mut hints) = self.hints.lock() else {
            return;
        };
        let Some(group) = hints.get_mut(origin) else {
            return;
        };
        if !group
            .get(field)
            .is_some_and(|hint| hint.selector == selector)
        {
            return;
        }
        group.remove(field);
        if group.is_empty() {
            hints.remove(origin);
        }
        self.persist(&hints);
    }

    #[cfg(test)]
    fn remember(&self, origin: &str, field: &str, selector: &str, private: bool) {
        self.remember_verified(origin, [(field, selector.to_owned())], private);
    }

    pub(crate) fn remember_verified<'a>(
        &self,
        origin: &str,
        observations: impl IntoIterator<Item = (&'a str, String)>,
        private: bool,
    ) {
        if private || !origin_allowed(origin) {
            return;
        }
        let Ok(mut hints) = self.hints.lock() else {
            return;
        };
        let now = time();
        let mut changed = false;
        for (field, selector) in observations {
            if !valid_hint(field, &selector)
                || hints
                    .get(origin)
                    .and_then(|group| group.get(field))
                    .is_some_and(|hint| {
                        hint.selector == selector && live(hint, now) && now - hint.checked < 86_400
                    })
            {
                continue;
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
                    selector,
                    checked: now,
                },
            );
            changed = true;
        }
        if changed {
            self.persist(&hints);
        }
    }

    fn persist(&self, hints: &Origins) {
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
        let now = Instant::now();
        let mut episodes = BTreeMap::<u32, [Option<Instant>; 2]>::new();
        for card in cards.iter().take(500) {
            let Some(episode) = card["episode"]
                .as_u64()
                .filter(|episode| (1..=9999).contains(episode))
            else {
                continue;
            };
            for audio in card["audio"].as_array().into_iter().flatten().take(2) {
                let index = match audio.as_str() {
                    Some("sub") => 0,
                    Some("dub") => 1,
                    _ => continue,
                };
                episodes.entry(episode as u32).or_default()[index] = Some(now);
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
            for (episode, timestamps) in current.episodes {
                if episodes.len() >= 500 && !episodes.contains_key(&episode) {
                    continue;
                }
                for (index, seen) in timestamps.into_iter().enumerate() {
                    if fresh(seen, now) {
                        let current = &mut episodes.entry(episode).or_default()[index];
                        *current = (*current).max(seen);
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
                            && row.observed.elapsed() < CATALOGUE_AUDIO_TTL
                    })
                    .map(|row| row.counts)
            })
            .unwrap_or_default();
        let now = Instant::now();
        let observed = self
            .observed
            .lock()
            .ok()
            .and_then(|rows| {
                rows.iter()
                    .rev()
                    .find(|row| row.source == source && row.origin == origin && row.media == media)
                    .map(|row| {
                        [0, 1].map(|index| {
                            let count = row
                                .episodes
                                .values()
                                .filter(|times| fresh(times[index], now))
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
        let now = Instant::now();
        let mut titles = BTreeMap::<i64, BTreeMap<u32, u8>>::new();
        for row in observed.iter().filter(|row| {
            !private.contains(&row.media) && sources.get(&row.source) == Some(&row.origin)
        }) {
            for (episode, timestamps) in &row.episodes {
                let flags = u8::from(fresh(timestamps[0], now))
                    | (u8::from(fresh(timestamps[1], now)) << 1);
                if flags != 0 {
                    *titles
                        .entry(row.media)
                        .or_default()
                        .entry(*episode)
                        .or_default() |= flags;
                }
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

fn fresh(seen: Option<Instant>, now: Instant) -> bool {
    seen.is_some_and(|seen| now.saturating_duration_since(seen) < AUDIO_TTL)
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
        "searchInput"
            | "searchOpener"
            | "titleLink"
            | "watchLink"
            | "episodeLink"
            | "player"
            | "episodeStep"
    )
}
fn valid_hint(field: &str, value: &str) -> bool {
    if field == "episodeStep" {
        return EpisodeStep::DEFAULT.iter().any(|step| step.name() == value);
    }
    if field == "episodeLink" && value.contains("{n}") {
        static EPISODE: OnceLock<Regex> = OnceLock::new();
        return EPISODE
            .get_or_init(|| {
                Regex::new(
                    r#"^[a-z][a-z0-9]{0,23}\[data-(episode(-number)?|num|number|ep)="\{n\}"\]$"#,
                )
                .unwrap()
            })
            .is_match(value);
    }
    field_allowed(field) && structural(value)
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
