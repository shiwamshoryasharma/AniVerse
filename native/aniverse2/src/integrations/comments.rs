use super::{
    accounts, comment_text, invalid, kv, mal_client_id, network, positive_id, response_json,
    safe_link, url_query, Service,
};
use crate::RpcError;
use regex::Regex;
use reqwest::Url;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::Path, sync::OnceLock};

const THREADS: &str = "query ($mediaId: Int, $search: String) { Page(perPage: 15) { threads(mediaCategoryId: $mediaId, search: $search, sort: [ID_DESC]) { id title siteUrl } } }";
const THREAD_COMMENTS: &str = "query ($threadId: Int) { Page(perPage: 50) { threadComments(threadId: $threadId) { id comment(asHtml: false) createdAt likeCount siteUrl user { name avatar { medium } siteUrl } } } }";
const POST_COMMENT: &str = "mutation ($threadId: Int, $comment: String) { SaveThreadComment(threadId: $threadId, comment: $comment) { id comment(asHtml: false) createdAt likeCount siteUrl user { name avatar { medium } siteUrl } } }";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Query {
    media_id: i32,
    id_mal: Option<i32>,
    episode: i32,
    titles: Vec<String>,
    youtube_video_id: Option<String>,
}

impl Query {
    fn parse(value: &Value) -> Result<Self, RpcError> {
        let input: Self = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
        if input.media_id <= 0
            || input.id_mal.is_some_and(|id| id <= 0)
            || !(1..=10_000).contains(&input.episode)
            || !(1..=12).contains(&input.titles.len())
            || input
                .titles
                .iter()
                .any(|title| title.encode_utf16().count() > 300)
            || input
                .youtube_video_id
                .as_deref()
                .is_some_and(|id| id.len() != 11 || !identifier(id))
        {
            return Err(invalid());
        }
        Ok(input)
    }
}

fn identifier(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 120
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn episode_thread(title: &str, episode: i32) -> bool {
    static EPISODE: OnceLock<Regex> = OnceLock::new();
    static RANGE: OnceLock<Regex> = OnceLock::new();
    let ep = EPISODE.get_or_init(|| Regex::new(r"(?i)\bepisode\s*0*(\d+)\b").unwrap());
    let range = RANGE.get_or_init(|| Regex::new(r"(?i)\bepisodes?\s*\d+\s*[-–]\s*\d+").unwrap());
    !range.is_match(title)
        && ep
            .captures_iter(title)
            .any(|capture| capture[1].parse::<i32>().ok() == Some(episode))
}

impl Service {
    pub(super) async fn comment_list(&self, root: &Path, input: &Value) -> Result<Value, RpcError> {
        let q = Query::parse(input)?;
        let connected = accounts::token(root, "anilist").is_ok();
        let settings = kv(root, "settings")?;
        let key = settings["accounts"]["youtubeApiKey"]
            .as_str()
            .filter(|key| !key.is_empty() && key.len() <= 200 && identifier(key));
        let first = self.anilist_comments(&q, connected).await;
        let second = self.mal_comments(&q).await;
        let third = match q.youtube_video_id.as_deref() {
            Some(id) => Some(self.youtube_comments(id, key).await),
            None => None,
        };
        let mut channels = Vec::new();
        let mut items = Vec::new();
        for (channel, entries) in [Some(first), Some(second), third].into_iter().flatten() {
            channels.push(channel);
            items.extend(entries);
        }
        items.sort_by_key(|value| {
            std::cmp::Reverse(value["createdAt"].as_i64().unwrap_or_default())
        });
        Ok(json!({"channels": channels, "items": items}))
    }

    pub(super) async fn comment_post(&self, root: &Path, input: &Value) -> Result<Value, RpcError> {
        if input["provider"] != "anilist" {
            return Err(invalid());
        }
        let thread = positive_id(&input["threadId"]).ok_or_else(invalid)?;
        let body = input["body"]
            .as_str()
            .filter(|body| body.encode_utf16().count() <= 5000)
            .map(str::trim)
            .filter(|body| body.chars().count() >= 2)
            .ok_or_else(invalid)?;
        let token = accounts::token(root, "anilist")?;
        let data = self
            .graphql(
                POST_COMMENT,
                json!({"threadId": thread, "comment": body}),
                Some(&token),
            )
            .await?;
        anilist_item(&data["SaveThreadComment"]).ok_or_else(network)
    }

    async fn anilist_comments(&self, q: &Query, connected: bool) -> (Value, Vec<Value>) {
        let mut channel = channel("anilist", "AniList", None);
        let result = async {
            let data = self
                .graphql(
                    THREADS,
                    json!({"mediaId": q.media_id, "search": format!("Episode {}", q.episode)}),
                    None,
                )
                .await?;
            let threads = data["Page"]["threads"].as_array().ok_or_else(network)?;
            let thread = threads.iter().take(15).find(|row| {
                row["title"]
                    .as_str()
                    .is_some_and(|title| episode_thread(title, q.episode))
            });
            let Some(thread) = thread else {
                return Ok(Vec::new());
            };
            let id = positive_id(&thread["id"]).ok_or_else(network)?;
            let data = self
                .graphql(THREAD_COMMENTS, json!({"threadId": id}), None)
                .await?;
            channel["threadId"] = json!(id);
            channel["threadTitle"] = json!(bounded_text(&thread["title"], 400));
            channel["threadUrl"] = safe_link(&thread["siteUrl"]);
            channel["canPost"] = json!(connected);
            let message =
                (!connected).then_some("Connect AniList in Settings → Accounts to post here.");
            channel["message"] = json!(message);
            Ok(data["Page"]["threadComments"]
                .as_array()
                .ok_or_else(network)?
                .iter()
                .take(50)
                .filter_map(anilist_item)
                .collect::<Vec<_>>())
        }
        .await;
        if result.as_ref().is_ok_and(Vec::is_empty) && channel["threadId"].is_null() {
            channel["message"] = json!(format!(
                "No AniList discussion thread for episode {} yet.",
                q.episode
            ));
        }
        finish(channel, result)
    }

    async fn mal_comments(&self, q: &Query) -> (Value, Vec<Value>) {
        let mut channel = channel(
            "mal",
            "MyAnimeList",
            Some("Read-only: MyAnimeList’s API does not allow posting."),
        );
        let Some(key) = mal_client_id() else {
            return needs(
                channel,
                "This build needs a MyAnimeList client ID to load discussions.",
            );
        };
        let result = async {
            let search = format!("{} Episode {} Discussion", q.titles[0], q.episode);
            let target = url_query("https://api.myanimelist.net/v2/forum/topics", &[("limit", "15"), ("q", &search)])?;
            let topic_request = self.client.get(target).header("X-MAL-CLIENT-ID", key);
            let topics = response_json(self.send(topic_request).await?, 512_000).await?;
            let rows = topics["data"].as_array().ok_or_else(network)?;
            let topic = rows.iter().take(15).find(|row| row["title"].as_str().is_some_and(|title| {
                episode_thread(title, q.episode) && crate::metadata::discovery_score(
                    title.split_once("Episode").map_or(title, |(title, _)| title), q.titles.iter().map(String::as_str)) >= 0.5
            }));
            let Some(id) = topic.and_then(|row| positive_id(&row["id"])) else {
                channel["message"] = json!(format!("No MyAnimeList discussion found for episode {}.", q.episode));
                return Ok(Vec::new());
            };
            let target = format!("https://api.myanimelist.net/v2/forum/topic/{id}?limit=60");
            let request = self.client.get(&target).header("X-MAL-CLIENT-ID", key);
            let data = response_json(self.send(request).await?, 2 * 1024 * 1024).await?;
            let data = &data["data"];
            let url = format!("https://myanimelist.net/forum/?topicid={id}");
            channel["threadId"] = json!(id);
            channel["threadTitle"] = json!(bounded_text(&data["title"], 400));
            channel["threadUrl"] = json!(&url);
            Ok(data["posts"].as_array().ok_or_else(network)?.iter().take(60).filter_map(|post| {
                let id = positive_id(&post["id"])?;
                let author = bounded_text(&post["created_by"]["name"], 200).unwrap_or_else(|| "Deleted user".to_owned());
                let mut author_url = Url::parse("https://myanimelist.net/profile/").ok()?;
                author_url.path_segments_mut().ok()?.pop_if_empty().push(&author);
                let body = comment_text::bbcode(post["body"].as_str()?);
                if body.is_empty() { return None; }
                Some(json!({"id": format!("mal-{id}"), "provider": "mal",
                    "author": author_json(author, &post["created_by"]["forum_avator"], &json!(author_url.as_str())),
                    "body": body, "createdAt": timestamp(&post["created_at"]), "likes": null,
                    "url": format!("{url}&show=0#msg{id}")}))
            }).collect::<Vec<_>>())
        }.await;
        finish(channel, result)
    }

    async fn youtube_comments(&self, id: &str, key: Option<&str>) -> (Value, Vec<Value>) {
        let mut channel = channel(
            "youtube",
            "YouTube",
            Some("Read-only here. Reply on YouTube."),
        );
        channel["threadUrl"] = json!(format!("https://www.youtube.com/watch?v={id}"));
        let Some(key) = key else {
            return needs(
                channel,
                "Add a YouTube Data API key in Settings → Accounts to load YouTube comments.",
            );
        };
        let result = async {
            let target = url_query("https://www.googleapis.com/youtube/v3/commentThreads",
                &[("part", "snippet"), ("maxResults", "40"), ("order", "relevance"),
                ("textFormat", "html"), ("videoId", id), ("key", key)])?;
            let request = self.client.get(target);
            let data = response_json(self.send(request).await?, 2 * 1024 * 1024).await?;
            Ok(data["items"].as_array().ok_or_else(network)?.iter().take(40).filter_map(|row| {
                let item = row["id"].as_str().filter(|item| identifier(item))?;
                let snippet = &row["snippet"]["topLevelComment"]["snippet"];
                Some(json!({"id": format!("yt-{item}"), "provider": "youtube",
                    "author": author_json(bounded_text(&snippet["authorDisplayName"], 200).unwrap_or_else(|| "Deleted user".to_owned()),
                        &snippet["authorProfileImageUrl"], &snippet["authorChannelUrl"]),
                    "body": comment_text::html(snippet["textDisplay"].as_str()?),
                    "createdAt": timestamp(&snippet["publishedAt"]), "likes": snippet["likeCount"].as_u64(),
                    "url": format!("https://www.youtube.com/watch?v={id}&lc={item}")}))
            }).collect::<Vec<_>>())
        }.await;
        finish(channel, result)
    }
}

fn channel(provider: &str, label: &str, message: Option<&str>) -> Value {
    json!({"provider":provider,"label":label,"status":"empty","canPost":false,
        "threadId":null,"threadTitle":null,"threadUrl":null,"message":message,"count":0})
}

fn needs(mut channel: Value, message: &str) -> (Value, Vec<Value>) {
    channel["status"] = json!("needs-config");
    channel["message"] = json!(message);
    (channel, Vec::new())
}

fn finish(mut channel: Value, result: Result<Vec<Value>, RpcError>) -> (Value, Vec<Value>) {
    match result {
        Ok(items) => {
            channel["count"] = json!(items.len());
            channel["status"] = json!(if items.is_empty() { "empty" } else { "ok" });
            (channel, items)
        }
        Err(error) => {
            channel["status"] = json!("error");
            channel["message"] = json!(error.message);
            (channel, Vec::new())
        }
    }
}

fn anilist_item(comment: &Value) -> Option<Value> {
    let id = positive_id(&comment["id"])?;
    let user = &comment["user"];
    Some(json!({"id": format!("al-{id}"), "provider": "anilist",
        "author": author_json(bounded_text(&user["name"], 200).unwrap_or_else(|| "Deleted user".to_owned()),
            &user["avatar"]["medium"], &user["siteUrl"]),
        "body": comment_text::anilist(comment["comment"].as_str().unwrap_or_default()), "createdAt": comment["createdAt"].as_i64().unwrap_or_default(),
        "likes": comment["likeCount"].as_u64(), "url": safe_link(&comment["siteUrl"])}))
}

fn bounded_text(value: &Value, size: usize) -> Option<String> {
    value.as_str().map(|text| text.chars().take(size).collect())
}

fn author_json(name: String, avatar: &Value, url: &Value) -> Value {
    json!({"name": name, "avatar": safe_link(avatar), "url": safe_link(url)})
}

fn timestamp(value: &Value) -> i64 {
    value
        .as_str()
        .and_then(|date| chrono::DateTime::parse_from_rfc3339(date).ok())
        .map(|date| date.timestamp())
        .unwrap_or_default()
}
