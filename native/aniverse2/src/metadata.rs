mod cards;

use crate::RpcError;
use chrono::Local;
use reqwest::{redirect::Policy, StatusCode};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

const ENDPOINT: &str = "https://graphql.anilist.co";
const HOME: &str = include_str!(concat!(env!("OUT_DIR"), "/anilist-home.graphql"));
const SAFE_HOME: &str = include_str!(concat!(env!("OUT_DIR"), "/anilist-home-safe.graphql"));
const LATEST: &str = include_str!(concat!(env!("OUT_DIR"), "/anilist-latest.graphql"));
const MAX_RESPONSE: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Request {
    Home,
    Latest(u8),
}

impl Request {
    pub(crate) fn parse(method: &str, input: Option<&Value>) -> Option<Result<Self, RpcError>> {
        match method {
            "meta.home" => Some(Ok(Self::Home)),
            "meta.latest" => Some(
                input
                    .and_then(|value| value["page"].as_u64())
                    .filter(|page| (1..=20).contains(page))
                    .map(|page| Self::Latest(page as u8))
                    .ok_or_else(|| {
                        RpcError::new("invalid-input", "Expected an episode page from 1 to 20.")
                    }),
            ),
            _ => None,
        }
    }
}

#[derive(Default)]
struct Cache {
    entries: HashMap<(Request, bool), (Instant, Value)>,
    cooldown: Option<Instant>,
}

pub(crate) struct Client {
    http: reqwest::Client,
    cache: Mutex<Cache>,
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
        })
    }

    pub(crate) async fn get(&self, request: Request, adult: bool) -> Result<Value, RpcError> {
        let key = (request, adult);
        let (stale, limited) = {
            let cache = self.cache.lock().unwrap_or_else(|error| error.into_inner());
            let cached = cache.entries.get(&key);
            if let Some((expires, value)) = cached {
                if *expires > Instant::now() {
                    return Ok(value.clone());
                }
            }
            (
                cached.map(|(_, value)| value.clone()),
                cache.cooldown.is_some_and(|until| until > Instant::now()),
            )
        };
        if limited {
            return stale.ok_or_else(rate_limit);
        }
        let now = Local::now();
        let day = 86_400;
        let seconds = now.timestamp();
        let season = cards::season(&now);
        let (query, variables, ttl) = match request {
            Request::Home => {
                let rounded = seconds.div_euclid(300) * 300;
                (
                    if adult { HOME } else { SAFE_HOME },
                    json!({"season": season["season"], "year": season["year"],
                           "since": rounded - 3 * day, "now": rounded}),
                    600,
                )
            }
            Request::Latest(page) => (
                LATEST,
                json!({"page": page, "from": seconds.div_euclid(60) * 60 - 14 * day,
                       "to": seconds.div_euclid(60) * 60}),
                90,
            ),
        };
        let result = self.query(query, variables).await.and_then(|data| {
            match request {
                Request::Home => cards::home(&data, season, seconds, adult),
                Request::Latest(_) => cards::latest(&data, adult),
            }
            .ok_or_else(|| RpcError::new("network", "AniList returned incomplete data."))
        });
        match result {
            Ok(value) => {
                self.cache
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .entries
                    .insert(
                        key,
                        (Instant::now() + Duration::from_secs(ttl), value.clone()),
                    );
                Ok(value)
            }
            Err(error) => stale.ok_or(error),
        }
    }

    async fn query(&self, query: &str, variables: Value) -> Result<Value, RpcError> {
        let offline = |_: reqwest::Error| RpcError::new("network", "Could not reach AniList.");
        let mut response = self
            .http
            .post(ENDPOINT)
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
            self.cache
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .cooldown = Some(Instant::now() + Duration::from_secs(delay));
            return Err(rate_limit());
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
        let data = response["data"].take();
        if data.is_object() {
            Ok(data)
        } else {
            Err(RpcError::new(
                "network",
                "AniList returned no catalogue data.",
            ))
        }
    }
}

fn rate_limit() -> RpcError {
    RpcError::new(
        "rate-limited",
        "AniList is rate limiting requests. Try again shortly.",
    )
}
