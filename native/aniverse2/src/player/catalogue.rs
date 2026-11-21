use super::{
    allowed_top, failure, invalid, native, navigation, page, resolve_source, Bounds, Service,
    Session,
};
use crate::{metadata, patterns, profile, RpcError};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::{Manager, Url, Webview};

const PAGE: &str = include_str!(concat!(env!("OUT_DIR"), "/site-catalogue.js"));

pub(super) async fn load(
    service: &Service,
    owner: &Webview,
    root: &Path,
    input: &Value,
) -> Result<Value, RpcError> {
    let source = resolve_source(root, input["sourceId"].as_str().ok_or_else(invalid)?)?;
    if source.kind != "web" {
        return Err(invalid());
    }
    let audio = input["audio"]
        .as_str()
        .filter(|audio| matches!(*audio, "all" | "sub" | "dub"))
        .ok_or_else(invalid)?;
    let requested = input["page"]
        .as_u64()
        .filter(|page| (1..=20).contains(page))
        .ok_or_else(invalid)?;
    let query = input.get("query").filter(|value| !value.is_null());
    if query.is_some_and(|query| !query.is_object()) {
        return Err(invalid());
    }
    let search = match query.and_then(|query| query.get("search")) {
        Some(value) => value
            .as_str()
            .filter(|text| text.len() <= 300)
            .ok_or_else(invalid)?
            .trim(),
        None => "",
    };
    let deadline = Instant::now() + Duration::from_secs(35);
    let target = match (&source.search, search.is_empty()) {
        (Some(template), false) => {
            Url::parse(&template.replace("{query}", &navigation::encoded(search)))
                .map_err(|_| invalid())?
        }
        _ => source.base.clone(),
    };
    let privacy_epoch = crate::runtime_privacy::epoch();
    let private = crate::runtime_privacy::active();
    let session = service
        .create_configured_view(
            owner,
            source.clone(),
            Bounds {
                x: 0.,
                y: 0.,
                width: 1100.,
                height: 750.,
            },
            true,
            private,
            None,
        )
        .await?;
    if !private {
        super::legacy_session::restore(&session.view, &source, &service.home.join(&source.id))
            .await;
    }
    let alive = || {
        privacy_epoch == crate::runtime_privacy::epoch()
            && Instant::now() < deadline
            && !session.closed.load(Ordering::Acquire)
            && session.blocked.lock().is_ok_and(|url| url.is_none())
    };
    if !navigation::load(&session, target, &alive).await {
        return Err(failure("Could not load this source’s catalogue."));
    }
    if !search.is_empty() && source.search.is_none() {
        let methods = owner.state::<patterns::Service>();
        if !navigation::open_search(
            &session,
            search,
            &methods,
            &source.base.origin().ascii_serialization(),
            &mut Vec::new(),
            &alive,
        )
        .await
        {
            return Err(failure("Open this source to search its catalogue."));
        }
        navigation::key_enter(&session).await?;
        tokio::time::sleep(Duration::from_millis(450)).await;
        let _ = page(&session, json!({"op":"viewAll"})).await;
    }
    let mut current = settle(&session, audio, !search.is_empty(), &alive, None).await?;
    let mut number = 1;
    while number < requested && current["hasNext"] == true && alive() {
        let before = signature(&current);
        if operate(&session, "next", audio, !search.is_empty()).await? != true {
            break;
        }
        current = settle(&session, audio, !search.is_empty(), &alive, Some(before)).await?;
        number += 1;
    }
    let visited_origin = session
        .view
        .url()
        .map_err(|_| failure("The catalogue source was closed."))?
        .origin();
    drop(session);
    let cards = current["items"]
        .as_array()
        .ok_or_else(|| failure("The source’s catalogue is unavailable."))?;
    let category = current["active"].as_str().unwrap_or("all");
    if audio != "all"
        && current["canFilter"] != true
        && !cards
            .iter()
            .any(|card| !card["sub"].is_null() || !card["dub"].is_null())
    {
        return Err(failure(
            "This source does not show readable SUB or DUB availability.",
        ));
    }
    let eligible = cards
        .iter()
        .filter_map(|card| {
            let title = card["title"].as_str()?;
            let url = Url::parse(card["url"].as_str()?).ok()?;
            if !allowed_top(&url, &source.base)
                || url.origin() != visited_origin
                || !matches_audio(card, audio, category)
                || (!search.is_empty()
                    && source.search.is_none()
                    && metadata::discovery_score(search, [title]) < 0.55)
            {
                return None;
            }
            let id = card["anilistId"]
                .as_i64()
                .and_then(|id| i32::try_from(id).ok())
                .filter(|id| *id > 0);
            Some((card, title, url, id))
        })
        .collect::<Vec<_>>();
    let ids = eligible
        .iter()
        .filter_map(|(_, _, _, id)| *id)
        .collect::<Vec<_>>();
    let metadata = if let Some(request) = metadata::Request::catalogue(&ids, query)? {
        let (adult, excluded) = profile::metadata_preferences(root, request.excludes_library())?;
        owner
            .state::<metadata::Client>()
            .get(request, adult, excluded)
            .await
    } else {
        Ok(Value::Null)
    };
    let linked_metadata_error = metadata.is_err();
    let mut metadata_error = linked_metadata_error;
    let metadata = metadata.unwrap_or_default();
    let filters = query.and_then(Value::as_object).is_some_and(|fields| {
        fields.iter().any(|(key, value)| {
            !matches!(key.as_str(), "search" | "page" | "perPage" | "sort")
                && !value.is_null()
                && value != false
                && !value.as_array().is_some_and(Vec::is_empty)
        })
    });
    let exact_search = !filters
        && !search.is_empty()
        && search.encode_utf16().count() <= 200
        && eligible.iter().any(|(_, _, _, id)| id.is_none());
    let fallback = if exact_search {
        let (adult, _) = profile::metadata_preferences(root, false)?;
        match owner
            .state::<metadata::Client>()
            .get(
                metadata::Request::Search(search.to_owned()),
                adult,
                Vec::new(),
            )
            .await
        {
            Ok(cards) => unique_exact(search, cards),
            Err(_) => {
                metadata_error = true;
                None
            }
        }
    } else {
        None
    };
    let mut items = eligible.into_iter().filter_map(|(card,title,url,id)| {
        let entry = id.and_then(|id| metadata["items"].as_array()?.iter().find(|value| value["id"] == id));
        if entry.is_none() && (filters || (id.is_some() && !linked_metadata_error)) { return None; }
        let entry = entry.filter(|entry| metadata::discovery_score(title, aliases(entry)) >= 0.75);
        if entry.is_none() && filters { return None; }
        let entry = entry.or_else(|| {
            if id.is_some() { return None; }
            fallback.as_ref().filter(|entry| metadata::discovery_score(title, aliases(entry)) == 2.0)
        });
        Some(json!({"title":title,"url":url.as_str(),"media":entry,"cover":entry.and_then(|entry| entry["cover"].as_str()),
            "sub":count(card,"sub"),"dub":count(card,"dub"),"total":count(card,"total")}))
    }).collect::<Vec<_>>();
    if (!ids.is_empty() || fallback.is_some()) && visited_origin == source.base.origin() {
        let origin = source.base.origin().ascii_serialization();
        if let Ok((sources, private)) = profile::audio_context(root) {
            if sources.get(&source.id) == Some(&origin) {
                owner
                    .state::<patterns::Service>()
                    .observe_catalogue(&source.id, &origin, &items, &private);
            }
        }
    }
    if query.is_some_and(|query| query["sort"] == "SCORE_DESC") {
        items.sort_by_key(|item| std::cmp::Reverse(item["media"]["score"].as_i64().unwrap_or(0)));
    }
    Ok(
        json!({"items":items,"sourceId":source.id,"sourceName":source.name,"page":number,
        "hasNext":current["hasNext"]==true,"audio":audio,"metadataError":metadata_error}),
    )
}

fn aliases(entry: &Value) -> impl Iterator<Item = &str> {
    ["english", "romaji", "native", "userPreferred"]
        .into_iter()
        .filter_map(|key| entry["title"][key].as_str())
}

fn unique_exact(query: &str, cards: Value) -> Option<Value> {
    let mut matching = cards.as_array()?.iter().filter(|card| {
        card["id"].as_i64().is_some_and(|id| id > 0)
            && metadata::discovery_score(query, aliases(card)) == 2.0
    });
    let card = matching.next()?;
    matching.next().is_none().then(|| card.clone())
}

async fn operate(
    session: &Session,
    kind: &str,
    audio: &str,
    search: bool,
) -> Result<Value, RpcError> {
    let value = json!({"kind":kind,"audio":audio,"search":search});
    native::evaluate(session, format!("{PAGE}({value})")).await
}

async fn settle(
    session: &Session,
    audio: &str,
    search: bool,
    alive: &impl Fn() -> bool,
    before: Option<Vec<String>>,
) -> Result<Value, RpcError> {
    let until = Instant::now() + Duration::from_secs(7);
    let mut last = None;
    let mut filtered = false;
    while alive() && Instant::now() < until {
        if let Ok(snapshot) = operate(session, "read", audio, search).await {
            if snapshot["canFilter"] == true && snapshot["active"] != audio {
                if !filtered {
                    filtered = operate(session, "filter", audio, search)
                        .await
                        .is_ok_and(|result| result == true);
                }
            } else {
                let key = signature(&snapshot);
                if (!key.is_empty() || snapshot["empty"] == true) && Some(&key) != before.as_ref() {
                    let eligible = snapshot["items"].as_array().is_some_and(|cards| {
                        cards.iter().all(|card| matches_audio(card, audio, audio))
                    });
                    if snapshot["canFilter"] != true || eligible {
                        if last.as_ref() == Some(&key) {
                            return Ok(snapshot);
                        }
                        last = Some(key);
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    if navigation::challenge(session).await {
        return Err(failure(
            "Open this source and complete its security check, then retry the catalogue.",
        ));
    }
    Err(failure(
        "The source did not provide a readable catalogue. Open the source or try another.",
    ))
}

fn signature(snapshot: &Value) -> Vec<String> {
    snapshot["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["url"].as_str().map(str::to_owned))
        .collect()
}

fn count(item: &Value, label: &str) -> Option<u64> {
    item[label].as_u64().filter(|n| *n <= 99_999)
}

fn matches_audio(item: &Value, audio: &str, category: &str) -> bool {
    let sub = count(item, "sub").map_or(matches!(category, "sub" | "dub"), |n| n > 0);
    let dub = count(item, "dub").map_or(category == "dub", |n| n > 0);
    audio == "all" || sub && (audio == "sub" || dub)
}
