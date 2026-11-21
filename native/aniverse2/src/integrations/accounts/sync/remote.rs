use super::{privacy, reconcile::Entry, Remote, RemoteEntry, Session};
use crate::{
    integrations::{form, network, positive_id, response_json, safe_link, url_query, Service},
    RpcError,
};
use reqwest::{Method, Url};
use serde_json::{json, Value};

const FIELDS: &str =
    "id idMal title { userPreferred } coverImage { large } bannerImage format episodes";
const MAL: &str = "https://api.myanimelist.net/v2";
const STATUS: &[(&str, &str)] = &[
    ("CURRENT", "watching"),
    ("COMPLETED", "completed"),
    ("PAUSED", "on_hold"),
    ("DROPPED", "dropped"),
    ("PLANNING", "plan_to_watch"),
    ("REPEATING", "watching"),
];

pub(super) async fn pull(service: &Service, session: &Session) -> Result<Remote, RpcError> {
    if session.provider == "anilist" {
        pull_anilist(service, session).await
    } else {
        pull_mal(service, session).await
    }
}

async fn pull_anilist(service: &Service, session: &Session) -> Result<Remote, RpcError> {
    let user = session.user.ok_or_else(network)?;
    let mut result = Remote::default();
    let query = format!("query ($user: Int, $page: Int) {{ MediaListCollection(userId: $user,type:ANIME,chunk:$page) {{
        hasNextChunk lists {{ entries {{ status progress score(format: POINT_10_DECIMAL) updatedAt media {{ {FIELDS} }} }} }}
        }} }}");
    for page in 1..=20 {
        privacy(session.privacy_epoch)?;
        let response = service
            .graphql(
                &query,
                json!({"user":user,"page":page}),
                Some(&session.token),
            )
            .await?;
        let collection = &response["MediaListCollection"];
        for list in collection["lists"].as_array().ok_or_else(network)? {
            for row in list["entries"].as_array().ok_or_else(network)? {
                let media = snapshot(&row["media"])?;
                let entry = entry(
                    row["status"].as_str(),
                    &row["progress"],
                    remote_score(&row["score"]),
                )?;
                let updated = timestamp(row["updatedAt"].as_i64()).ok_or_else(network)?;
                result.insert(RemoteEntry {
                    media,
                    entry,
                    updated,
                });
                if result.entries.len() > 20_000 {
                    return Err(network());
                }
            }
        }
        if collection["hasNextChunk"] == false {
            let query = format!(
                "query ($user: Int) {{ User(id:$user) {{ favourites {{
                anime(perPage:50) {{ nodes {{ {FIELDS} }} }} }} }} }}"
            );
            privacy(session.privacy_epoch)?;
            let favourites = service
                .graphql(&query, json!({"user":user}), Some(&session.token))
                .await?;
            result.favourites = favourites["User"]["favourites"]["anime"]["nodes"]
                .as_array()
                .ok_or_else(network)?
                .iter()
                .take(50)
                .map(snapshot)
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(result);
        }
    }
    Err(RpcError::new(
        "unavailable",
        "AniList’s list was incomplete. No local changes were merged.",
    ))
}

async fn pull_mal(service: &Service, session: &Session) -> Result<Remote, RpcError> {
    let endpoint = format!("{MAL}/users/@me/animelist");
    let mut rows = Vec::new();
    let mut ids = std::collections::BTreeSet::new();
    for page in 0..20 {
        privacy(session.privacy_epoch)?;
        let offset = (page * 500).to_string();
        let url = url_query(
            &endpoint,
            &[
                ("fields", "list_status"),
                ("limit", "500"),
                ("nsfw", "true"),
                ("offset", &offset),
            ],
        )?;
        let data = response_json(
            service
                .send(service.client.get(url).bearer_auth(&session.token))
                .await?,
            2 * 1024 * 1024,
        )
        .await?;
        let entries = data["data"]
            .as_array()
            .filter(|rows| rows.len() <= 500)
            .ok_or_else(network)?;
        for row in entries {
            let id = positive_id(&row["node"]["id"]).ok_or_else(network)?;
            if !ids.insert(id) {
                return Err(network());
            }
            rows.push((id, row["list_status"].clone()));
        }
        if data["paging"]["next"].is_null() {
            return map_mal(service, rows, session.privacy_epoch).await;
        }
        if entries.len() != 500 {
            return Err(network());
        }
    }
    Err(RpcError::new(
        "unavailable",
        "MyAnimeList’s list was incomplete. No local changes were merged.",
    ))
}

async fn map_mal(
    service: &Service,
    rows: Vec<(i32, Value)>,
    epoch: u64,
) -> Result<Remote, RpcError> {
    let mut result = Remote::default();
    let query = format!("query ($ids: [Int]){{ Page(perPage:50) {{ media(idMal_in:$ids,type:ANIME) {{ {FIELDS} }} }} }}");
    for group in rows.chunks(50) {
        privacy(epoch)?;
        let ids: Vec<_> = group.iter().map(|(id, _)| *id).collect();
        let data = service.graphql(&query, json!({"ids":ids}), None).await?;
        let mut mapped = std::collections::HashMap::new();
        for row in data["Page"]["media"].as_array().ok_or_else(network)? {
            let id = positive_id(&row["idMal"]).ok_or_else(network)?;
            if !ids.contains(&id) || mapped.insert(id, snapshot(row)?).is_some() {
                return Err(RpcError::new(
                    "unavailable",
                    "Ambiguous MyAnimeList title matching. No local changes were merged.",
                ));
            }
        }
        for (id, row) in group {
            let Some(media) = mapped.remove(id) else {
                result.unmapped.insert(*id);
                continue;
            };
            let status = if row["is_rewatching"] == true {
                Some("REPEATING")
            } else {
                STATUS
                    .iter()
                    .find_map(|(native, mal)| (row["status"] == *mal).then_some(*native))
            };
            let updated = row["updated_at"]
                .as_str()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .map(|date| date.timestamp());
            let entry = entry(
                status,
                &row["num_episodes_watched"],
                remote_score(&row["score"]),
            )?;
            result.insert(RemoteEntry {
                media,
                entry,
                updated: timestamp(updated).ok_or_else(network)?,
            });
        }
    }
    Ok(result)
}

pub(super) async fn push(
    service: &Service,
    session: &Session,
    id: i32,
    id_mal: Option<i32>,
    wanted: Option<&Entry>,
    favourite: Option<bool>,
) -> Result<(), RpcError> {
    privacy(session.privacy_epoch)?;
    if session.provider == "mal" {
        if let (Some(id), None) = (id_mal, favourite) {
            push_mal(service, session, id, wanted).await?;
        }
    } else if let Some(wanted) = favourite {
        let query = "query ($id:Int){ Media(id:$id,type:ANIME) { isFavourite } }";
        let current = service
            .graphql(query, json!({"id":id}), Some(&session.token))
            .await?["Media"]["isFavourite"]
            .as_bool()
            .ok_or_else(network)?;
        if wanted != current {
            privacy(session.privacy_epoch)?;
            let query = "mutation ($id:Int){ ToggleFavourite(animeId:$id){ anime { pageInfo { total } } } }";
            service
                .graphql(query, json!({"id":id}), Some(&session.token))
                .await?;
        }
    } else {
        push_anilist(service, session, id, wanted).await?;
    }
    Ok(())
}

async fn push_mal(
    service: &Service,
    session: &Session,
    id: i32,
    desired: Option<&Entry>,
) -> Result<(), RpcError> {
    let url = Url::parse(&format!("{MAL}/anime/{id}/my_list_status")).map_err(|_| network())?;
    let mut req = service
        .client
        .request(
            if desired.is_some() {
                Method::PATCH
            } else {
                Method::DELETE
            },
            url,
        )
        .bearer_auth(&session.token);
    if let Some(entry) = desired {
        let status = STATUS
            .iter()
            .find_map(|(native, mal)| (*native == entry.status).then_some(*mal))
            .ok_or_else(network)?;
        let progress = entry.progress.to_string();
        let score = entry.score.map(|value| value.round().to_string());
        let mut args = vec![
            ("status", status),
            (
                "is_rewatching",
                if entry.status == "REPEATING" {
                    "true"
                } else {
                    "false"
                },
            ),
            ("num_watched_episodes", progress.as_str()),
        ];
        if let Some(score) = &score {
            args.push(("score", score.as_str()));
        }
        req = form(req, &args)?;
    }
    match service.send(req).await {
        Ok(_) => Ok(()),
        Err(error) if desired.is_none() && error.code == "not-found" => Ok(()),
        Err(error) => Err(error),
    }
}

async fn push_anilist(
    service: &Service,
    session: &Session,
    id: i32,
    desired: Option<&Entry>,
) -> Result<(), RpcError> {
    if let Some(entry) = desired {
        let score = entry.score.map(|value| (value * 10.0).round() as i32);
        let mut variables = json!({"media":id,"progress":entry.progress,"status":entry.status});
        let (param, field) = if let Some(score) = score {
            variables["score"] = json!(score);
            (",$score:Int", ",scoreRaw:$score")
        } else {
            ("", "")
        };
        let query = format!("mutation ($media:Int,$progress:Int,$status:MediaListStatus{param}) {{
            SaveMediaListEntry(mediaId:$media,progress:$progress,status:$status{field}) {{ id }} }}");
        service
            .graphql(&query, variables, Some(&session.token))
            .await?;
    } else {
        let user = session.user.ok_or_else(network)?;
        let result = service
            .graphql(
                "query ($media:Int,$user:Int){ MediaList(mediaId:$media,userId:$user){ id } }",
                json!({"media":id,"user":user}),
                Some(&session.token),
            )
            .await;
        let result = match result {
            Ok(result) => result,
            Err(error) if error.code == "not-found" => return Ok(()),
            Err(error) => return Err(error),
        };
        if let Some(entry) = positive_id(&result["MediaList"]["id"]) {
            privacy(session.privacy_epoch)?;
            let query = "mutation($id:Int){ DeleteMediaListEntry(id:$id){ deleted } }";
            let data = service
                .graphql(query, json!({"id":entry}), Some(&session.token))
                .await?;
            if data["DeleteMediaListEntry"]["deleted"] != true {
                return Err(network());
            }
        }
    }
    Ok(())
}

fn snapshot(raw: &Value) -> Result<Value, RpcError> {
    let id = positive_id(&raw["id"]).ok_or_else(network)?;
    let title = raw["title"]["userPreferred"]
        .as_str()
        .filter(|name| name.chars().count() <= 300)
        .ok_or_else(network)?;
    let cover = safe_link(&raw["coverImage"]["large"]);
    let cover = cover
        .as_str()
        .filter(|url| url.starts_with("https:"))
        .unwrap_or_default();
    let image = safe_link(&raw["bannerImage"]);
    let image = image.as_str().filter(|url| url.starts_with("https:"));
    let format = raw["format"].as_str().filter(|kind| {
        ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"].contains(kind)
    });
    Ok(
        json!({"id":id,"idMal":positive_id(&raw["idMal"]),"title":title,"cover":cover,
        "banner":image,"format":format,"episodes": raw["episodes"].as_i64().filter(|n| (0..=100_000).contains(n))}),
    )
}

pub(super) fn entry(
    status: Option<&str>,
    progress: &Value,
    score: &Value,
) -> Result<Entry, RpcError> {
    let status = status
        .filter(|status| STATUS.iter().any(|(key, _)| *status == *key))
        .ok_or_else(network)?;
    let progress = progress
        .as_i64()
        .filter(|n| (0..=100_000).contains(n))
        .ok_or_else(network)? as i32;
    let score = score.as_f64().filter(|score| (0.0..=10.0).contains(score));
    Ok(Entry {
        status: status.into(),
        progress,
        score,
    })
}

fn remote_score(value: &Value) -> &Value {
    if value.as_f64() == Some(0.0) {
        &Value::Null
    } else {
        value
    }
}

fn timestamp(value: Option<i64>) -> Option<i64> {
    let now = chrono::Utc::now().timestamp();
    value.filter(|time| (1..=now + 3600).contains(time))
}
