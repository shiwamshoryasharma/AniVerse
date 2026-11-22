mod cards;
mod request;
mod search;

pub(crate) use request::Request;
pub(crate) use search::discovery_score;

use crate::RpcError;
use chrono::Local;
use reqwest::{redirect::Policy, StatusCode};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    future::{poll_fn, Future},
    sync::{Arc, Mutex, MutexGuard, OnceLock, Weak},
    time::{Duration, Instant},
};
use tokio::sync::{Mutex as AsyncMutex, Notify, Semaphore};

const ENDPOINT: &str = "https://graphql.anilist.co";
const HOME: &str = include_str!(concat!(env!("OUT_DIR"), "/anilist-home.graphql"));
const SAFE_HOME: &str = include_str!(concat!(env!("OUT_DIR"), "/anilist-home-safe.graphql"));
const LATEST: &str = include_str!(concat!(env!("OUT_DIR"), "/anilist-latest.graphql"));
const CATALOGUE: &str = include_str!(concat!(env!("OUT_DIR"), "/anilist-catalogue.json"));
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_ENTRIES: usize = 128;
const MAX_PENDING: usize = 32;
const FAILURE_COOLDOWN: Duration = Duration::from_secs(2);
const DAY: i64 = 86_400;

#[derive(Deserialize)]
struct Queries {
    card: String,
    filters: HashMap<String, String>,
    details: String,
    hover: String,
    search: String,
    safe_search: String,
    schedule: String,
    genres: String,
}

impl Queries {
    fn browse(&self, variables: &Map<String, Value>) -> String {
        let mut declarations = String::from("$page: Int, $perPage: Int");
        let mut media_args = String::from("type: ANIME");
        for key in variables.keys() {
            if let Some(kind) = self.filters.get(key.as_str()) {
                declarations.push_str(&format!(", ${key}: {kind}"));
                media_args.push_str(&format!(", {key}: ${key}"));
            }
        }
        format!(
            "{}\nquery ({declarations}) {{ Page(page: $page, perPage: $perPage) {{ pageInfo {{ total currentPage hasNextPage }} media({media_args}) {{ ...card }} }} }}",
            self.card
        )
    }
}

type Key = (Request, bool, Vec<i32>);

struct Entry {
    expires: Instant,
    last_read: Instant,
    value: Value,
}

struct Failure {
    until: Instant,
    code: &'static str,
    message: String,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<Key, Entry>,
    failures: HashMap<Key, Failure>,
    flights: HashMap<Key, Weak<AsyncMutex<()>>>,
    cooldown: Option<Instant>,
    generation: u64,
}

impl Cache {
    fn cached(&mut self, key: &Key) -> Option<(bool, Value)> {
        let entry = self.entries.get_mut(key)?;
        let now = Instant::now();
        if now.saturating_duration_since(entry.expires) > Duration::from_secs(7 * DAY as u64) {
            return None;
        }
        entry.last_read = now;
        Some((entry.expires > now, entry.value.clone()))
    }

    fn insert(&mut self, key: Key, ttl: u64, value: Value) {
        if self.entries.len() >= MAX_ENTRIES && !self.entries.contains_key(&key) {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_read)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                self.entries.remove(&oldest);
            }
        }
        let now = Instant::now();
        self.entries.insert(
            key,
            Entry {
                expires: now + Duration::from_secs(ttl),
                last_read: now,
                value,
            },
        );
    }

    fn failure(&mut self, key: &Key) -> Option<RpcError> {
        let failure = self.failures.get(key)?;
        if failure.until <= Instant::now() {
            self.failures.remove(key);
            return None;
        }
        Some(RpcError::new(failure.code, failure.message.clone()))
    }

    fn failed(&mut self, key: Key, error: &RpcError) {
        let now = Instant::now();
        self.failures.retain(|_, failure| failure.until > now);
        if self.failures.len() >= MAX_ENTRIES && !self.failures.contains_key(&key) {
            if let Some(oldest) = self
                .failures
                .iter()
                .min_by_key(|(_, failure)| failure.until)
                .map(|(key, _)| key.clone())
            {
                self.failures.remove(&oldest);
            }
        }
        self.failures.insert(
            key,
            Failure {
                until: now + FAILURE_COOLDOWN,
                code: error.code,
                message: error.message.clone(),
            },
        );
    }

    fn flight(&mut self, key: &Key) -> Option<Arc<AsyncMutex<()>>> {
        if let Some(running) = self.flights.get(key).and_then(Weak::upgrade) {
            return Some(running);
        }
        self.flights.retain(|_, flight| flight.strong_count() > 0);
        if self.flights.len() >= MAX_PENDING {
            return None;
        }
        let flight = Arc::new(AsyncMutex::new(()));
        self.flights.insert(key.clone(), Arc::downgrade(&flight));
        Some(flight)
    }
}

pub(crate) struct Client {
    http: reqwest::Client,
    cache: Mutex<Cache>,
    outbound: Semaphore,
    pending: Semaphore,
    changed: Notify,
    #[cfg(test)]
    test_endpoint: String,
}

impl Client {
    pub(crate) fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            http: reqwest::Client::builder()
                .https_only(true)
                .redirect(Policy::none())
                .timeout(Duration::from_secs(12))
                .user_agent("AniVerse2 Desktop")
                .build()?,
            cache: Mutex::new(Cache::default()),
            outbound: Semaphore::new(4),
            pending: Semaphore::new(MAX_PENDING),
            changed: Notify::new(),
            #[cfg(test)]
            test_endpoint: ENDPOINT.to_owned(),
        })
    }

    fn cache(&self) -> MutexGuard<'_, Cache> {
        self.cache.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub(crate) fn clear_cache(&self) {
        let mut cache = self.cache();
        cache.entries.clear();
        cache.failures.clear();
        cache.flights.clear();
        cache.generation = cache.generation.wrapping_add(1);
        drop(cache);
        self.changed.notify_waiters();
    }

    /// Manager: admission, deduplication, cancellation and all shared job results live here.
    pub(crate) async fn get(
        &self,
        request: Request,
        adult: bool,
        excluded: Vec<i32>,
    ) -> Result<Value, RpcError> {
        let generation = self.cache().generation;
        if crate::runtime_privacy::active() {
            let _pending = self.pending.try_acquire().map_err(|_| busy())?;
            return self
                .run_worker(&request, adult, &excluded, generation)
                .await;
        }
        let key = (request, adult, excluded);
        let flight = {
            let mut cache = self.cache();
            if let Some((true, cached)) = cache.cached(&key) {
                return Ok(cached);
            }
            cache.flight(&key).ok_or_else(busy)?
        };
        let _pending = self.pending.try_acquire().map_err(|_| busy())?;
        let _guard = flight.lock().await;
        if self.cache().generation != generation {
            return Err(cancelled());
        }
        let stale = match self.cache().cached(&key) {
            Some((true, cached)) => return Ok(cached),
            Some((false, value)) => Some(value),
            None => None,
        };
        if let Some(error) = self.cache().failure(&key) {
            return stale.ok_or(error);
        }
        match self.run_worker(&key.0, adult, &key.2, generation).await {
            Ok(value) => {
                let ttl = key.0.ttl();
                let mut cache = self.cache();
                if cache.generation != generation {
                    return Err(cancelled());
                }
                cache.insert(key, ttl, value.clone());
                Ok(value)
            }
            Err(error) if error.code == "cancelled" => Err(error),
            Err(error) => {
                let mut cache = self.cache();
                if cache.generation != generation {
                    return Err(cancelled());
                }
                cache.failed(key, &error);
                if error.code == "not-found" {
                    Err(error)
                } else {
                    stale.ok_or(error)
                }
            }
        }
    }

    async fn run_worker(
        &self,
        request: &Request,
        adult: bool,
        excluded: &[i32],
        generation: u64,
    ) -> Result<Value, RpcError> {
        // Created before checking generation, so invalidation cannot miss an unpolled waiter.
        let changed = self.changed.notified();
        finish_or_cancel(self.execute(request, adult, excluded, generation), changed)
            .await
            .unwrap_or_else(|| Err(cancelled()))
    }
    async fn execute(
        &self,
        request: &Request,
        adult: bool,
        excluded: &[i32],
        generation: u64,
    ) -> Result<Value, RpcError> {
        let _permit = tokio::time::timeout(Duration::from_secs(15), self.outbound.acquire())
            .await
            .map_err(|_| busy())?
            .map_err(|_| busy())?;
        {
            let cache = self.cache();
            if cache.generation != generation {
                return Err(cancelled());
            }
            if cache.cooldown.is_some_and(|until| until > Instant::now()) {
                return Err(rate_limit());
            }
        }
        let worker = Worker {
            http: self.http.clone(),
            endpoint: {
                #[cfg(test)]
                {
                    self.test_endpoint.clone()
                }
                #[cfg(not(test))]
                {
                    ENDPOINT.to_owned()
                }
            },
            cooldown: Mutex::new(None),
        };
        let result = worker.fetch(request, adult, excluded).await;
        let delay = worker
            .cooldown
            .into_inner()
            .unwrap_or_else(|error| error.into_inner());
        let mut cache = self.cache();
        if let Some(delay) = delay {
            let until = Instant::now() + delay;
            cache.cooldown = Some(cache.cooldown.map_or(until, |previous| previous.max(until)));
        }
        if cache.generation != generation {
            return Err(cancelled());
        }
        result
    }
}

/// Workers have no shared cache or scheduler access; completion and retry-after return to the manager.
struct Worker {
    http: reqwest::Client,
    endpoint: String,
    cooldown: Mutex<Option<Duration>>,
}

impl Worker {
    async fn fetch(
        &self,
        request: &Request,
        adult: bool,
        excluded: &[i32],
    ) -> Result<Value, RpcError> {
        static QUERIES: OnceLock<Queries> = OnceLock::new();
        let queries = QUERIES
            .get_or_init(|| serde_json::from_str(CATALOGUE).expect("generated AniList queries"));
        match request {
            Request::Home => {
                let now = Local::now();
                let seconds = now.timestamp();
                let season = cards::season(&now);
                let rounded = seconds.div_euclid(300) * 300;
                let data = self
                    .query(
                        if adult { HOME } else { SAFE_HOME },
                        json!({"season": season["season"], "year": season["year"],
                           "since": rounded - 3 * DAY, "now": rounded}),
                    )
                    .await?;
                cards::home(&data, season, seconds, adult).ok_or_else(incomplete)
            }
            Request::Latest(page) => {
                let seconds = Local::now().timestamp();
                let data = self
                    .query(
                        LATEST,
                        json!({
                            "page": page, "from": seconds - 14 * DAY,
                            "to": seconds.div_euclid(60) * 60,
                        }),
                    )
                    .await?;
                cards::latest(&data, adult).ok_or_else(incomplete)
            }
            Request::Details(id) => {
                let data = self.query(&queries.details, json!({"id": id})).await?;
                cards::details(&data["Media"]).ok_or_else(incomplete)
            }
            Request::Hover(id) => {
                let data = self.query(&queries.hover, json!({"id": id})).await?;
                cards::hover(&data["Media"]).ok_or_else(incomplete)
            }
            Request::Genres => {
                let data = self.query(&queries.genres, json!({})).await?;
                cards::genres(&data, adult).ok_or_else(incomplete)
            }
            Request::Search(term) => {
                if term.is_empty() {
                    return Ok(json!([]));
                }
                let query = if adult {
                    &queries.search
                } else {
                    &queries.safe_search
                };
                let mut data = self.query(query, json!({"search": term})).await?;
                let primary = take_rows(&mut data["Page"], "media")?;
                let wider = (primary.len() < 8).then(|| search::broader(term)).flatten();
                let nearby = match wider {
                    Some(wider) => self
                        .query(query, json!({"search": wider}))
                        .await
                        .ok()
                        .and_then(|mut data| take_rows(&mut data["Page"], "media").ok())
                        .unwrap_or_default(),
                    None => Vec::new(),
                };
                Ok(Value::Array(search::rank(term, primary, nearby, adult)))
            }
            Request::Browse { variables, .. } => {
                let mut vars = variables.clone();
                if !adult {
                    vars.insert("isAdult".into(), Value::Bool(false));
                }
                if !excluded.is_empty() {
                    vars.insert("id_not_in".into(), json!(excluded));
                }
                let query = queries.browse(&vars);
                let wider = vars
                    .get("search")
                    .and_then(Value::as_str)
                    .and_then(search::broader);
                let first = vars["page"] == 1;
                let data = self.query(&query, Value::Object(vars.clone())).await?;
                let mut page = cards::browse(&data["Page"], adult).ok_or_else(incomplete)?;
                if let Some(wider) =
                    wider.filter(|_| first && page["items"].as_array().is_some_and(Vec::is_empty))
                {
                    vars.insert("search".into(), json!(wider));
                    let data = self.query(&query, Value::Object(vars)).await?;
                    page = cards::browse(&data["Page"], adult).ok_or_else(incomplete)?;
                    page["hasNext"] = Value::Bool(false);
                    page["total"] = json!(data["Page"]["media"]
                        .as_array()
                        .ok_or_else(incomplete)?
                        .len());
                }
                Ok(page)
            }
            Request::Schedule { from, to } => {
                let mut items = Vec::new();
                for page in 1..=6 {
                    let data = self
                        .query(
                            &queries.schedule,
                            json!({"page": page, "from": from, "to": to}),
                        )
                        .await?;
                    let info = &data["Page"];
                    let rows = info["airingSchedules"].as_array().ok_or_else(incomplete)?;
                    items.extend(cards::airings(rows, adult));
                    if !info["pageInfo"]["hasNextPage"]
                        .as_bool()
                        .ok_or_else(incomplete)?
                    {
                        break;
                    }
                }
                Ok(Value::Array(items))
            }
        }
    }

    async fn query(&self, query: &str, variables: Value) -> Result<Value, RpcError> {
        let offline = |_: reqwest::Error| RpcError::new("network", "Could not reach AniList.");
        let mut response = self
            .http
            .post(&self.endpoint)
            .json(&json!({"query": query, "variables": variables}))
            .send()
            .await
            .map_err(offline)?;
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            let delay = response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok()?.parse::<u64>().ok())
                .unwrap_or(60)
                .clamp(1, 300);
            *self
                .cooldown
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(Duration::from_secs(delay));
            return Err(rate_limit());
        }
        if response.status() == StatusCode::NOT_FOUND {
            return Err(not_found());
        }
        if !response.status().is_success() {
            return Err(RpcError::new(
                "network",
                format!("AniList returned HTTP {}.", response.status().as_u16()),
            ));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(offline)? {
            if chunk.len() > MAX_RESPONSE - body.len() {
                return Err(RpcError::new(
                    "network",
                    "The AniList response was too large.",
                ));
            }
            body.extend_from_slice(&chunk);
        }
        let mut response: Value = serde_json::from_slice(&body)
            .map_err(|_| RpcError::new("network", "AniList returned an invalid response."))?;
        if response["errors"][0]["status"] == 404 {
            return Err(not_found());
        }
        response
            .get_mut("data")
            .filter(|data| data.is_object())
            .map(Value::take)
            .ok_or_else(incomplete)
    }
}

async fn finish_or_cancel<T>(
    job: impl Future<Output = T>,
    signal: impl Future<Output = ()>,
) -> Option<T> {
    let mut job = std::pin::pin!(job);
    let mut signal = std::pin::pin!(signal);
    poll_fn(|context| {
        if signal.as_mut().poll(context).is_ready() {
            return std::task::Poll::Ready(None);
        }
        job.as_mut().poll(context).map(Some)
    })
    .await
}
fn busy() -> RpcError {
    RpcError::new(
        "rate-limited",
        "AniList metadata is busy. Try again shortly.",
    )
}
fn cancelled() -> RpcError {
    RpcError::new(
        "cancelled",
        "The metadata request changed before its result was ready.",
    )
}
fn take_rows(data: &mut Value, key: &str) -> Result<Vec<Value>, RpcError> {
    match data.get_mut(key).map(Value::take) {
        Some(Value::Array(rows)) => Ok(rows),
        _ => Err(incomplete()),
    }
}

fn incomplete() -> RpcError {
    RpcError::new("network", "AniList returned incomplete data.")
}

fn rate_limit() -> RpcError {
    RpcError::new(
        "rate-limited",
        "AniList is rate limiting requests. Try again shortly.",
    )
}

fn not_found() -> RpcError {
    RpcError::new("not-found", "AniList could not find that title.")
}

#[cfg(test)]
#[path = "../../../test/tauri-compat/metadata-jobs.rs"]
mod metadata_jobs;
