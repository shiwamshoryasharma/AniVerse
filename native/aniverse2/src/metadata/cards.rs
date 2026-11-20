use chrono::{DateTime, Datelike, Local, TimeZone};
use regex::Regex;
use serde_json::{json, Value};
use std::{collections::HashSet, sync::OnceLock};

pub(super) fn season(now: &DateTime<Local>) -> Value {
    let name = match now.month() {
        12 | 1 | 2 => "WINTER",
        3..=5 => "SPRING",
        6..=8 => "SUMMER",
        _ => "FALL",
    };
    json!({"season": name, "year": now.year() + i32::from(now.month() == 12)})
}

pub(super) fn home(data: &Value, season: Value, now: i64, adult: bool) -> Option<Value> {
    let cards = |key: &str| {
        Some(
            data[key]["media"]
                .as_array()?
                .iter()
                .filter(|raw| visible(raw, adult))
                .filter_map(card)
                .collect::<Vec<_>>(),
        )
    };
    let trending = cards("trending")?;
    let popular = cards("popularSeason")?;
    let mut ids = HashSet::new();
    let mut coming = popular
        .iter()
        .chain(&trending)
        .chain(&cards("upcoming")?)
        .filter(|card| pending(card, now) && ids.insert(card["id"].as_i64()))
        .cloned()
        .collect::<Vec<_>>();
    coming.sort_by_key(release_key);
    Some(json!({
        "spotlight": cards("spotlight")?.into_iter().filter(|card| card["banner"].is_string() && !pending(card, now)).take(9).collect::<Vec<_>>(),
        "trending": trending.into_iter().filter(|card| !pending(card, now)).collect::<Vec<_>>(),
        "popularSeason": popular.into_iter().filter(|card| !pending(card, now)).collect::<Vec<_>>(),
        "upcoming": coming,
        "topRated": cards("topRated")?,
        "recentlyAired": airings(data["recent"]["airingSchedules"].as_array()?, adult).collect::<Vec<_>>(),
        "season": season,
    }))
}

pub(super) fn latest(data: &Value, adult: bool) -> Option<Value> {
    let page = &data["Page"];
    let mut ids = HashSet::new();
    let items = airings(page["airingSchedules"].as_array()?, adult)
        .filter(|item| ids.insert(item["media"]["id"].as_i64()))
        .take(36)
        .collect::<Vec<_>>();
    Some(json!({"items": items, "hasNext": page["pageInfo"]["hasNextPage"].as_bool()?}))
}

fn airings(rows: &[Value], adult: bool) -> impl Iterator<Item = Value> + '_ {
    rows.iter().filter_map(move |row| {
        let raw = &row["media"];
        if !visible(raw, adult) || raw["type"].as_str() != Some("ANIME") {
            return None;
        }
        Some(
            json!({"id": row["id"].as_u64()?, "episode": row["episode"].as_u64()?,
                   "airingAt": row["airingAt"].as_u64()?, "media": card(raw)?}),
        )
    })
}

fn visible(raw: &Value, adult: bool) -> bool {
    adult || raw["isAdult"].as_bool() == Some(false)
}

fn card(raw: &Value) -> Option<Value> {
    let title = &raw["title"];
    let preferred = ["userPreferred", "english", "romaji", "native"]
        .iter()
        .find_map(|key| title[*key].as_str().filter(|value| !value.is_empty()))?;
    let cover = &raw["coverImage"];
    Some(json!({
        "id": raw["id"].as_u64()?, "idMal": raw["idMal"], "title": {
            "romaji": title["romaji"], "english": title["english"], "native": title["native"], "userPreferred": preferred,
        },
        "cover": cover["extraLarge"].as_str().or_else(|| cover["large"].as_str()).unwrap_or_default(),
        "coverColor": cover["color"], "banner": raw["bannerImage"], "format": raw["format"],
        "status": raw["status"], "episodes": raw["episodes"], "duration": raw["duration"],
        "score": raw["averageScore"], "season": raw["season"], "seasonYear": raw["seasonYear"],
        "genres": raw["genres"].as_array().map(Vec::as_slice).unwrap_or_default(),
        "isAdult": raw["isAdult"].as_bool().unwrap_or(false), "nextAiring": raw["nextAiringEpisode"],
        "startDate": raw["startDate"], "description": raw["description"].as_str().map(plain_description),
    }))
}

fn plain_description(text: &str) -> String {
    static TAG: OnceLock<Regex> = OnceLock::new();
    let tag = TAG.get_or_init(|| Regex::new(r"(?i)<[^>]+>").unwrap());
    tag.replace_all(text, |captures: &regex::Captures<'_>| {
        let html = captures[0].to_ascii_lowercase();
        if html.starts_with("<br") {
            "\n"
        } else if html == "</p>" {
            "\n\n"
        } else {
            ""
        }
    })
    .replace("&quot;", "\"")
    .replace("&#39;", "'")
    .replace("&nbsp;", " ")
    .replace("&lt;", "<")
    .replace("&gt;", ">")
    .replace("&amp;", "&")
    .trim()
    .to_owned()
}

fn date(year: &Value, month: u32, day: u32) -> Option<i64> {
    let year = i32::try_from(year.as_i64()?).ok()?;
    Local
        .with_ymd_and_hms(year, month, day, 0, 0, 0)
        .earliest()
        .map(|time| time.timestamp())
}

fn pending(card: &Value, now: i64) -> bool {
    let next = &card["nextAiring"];
    let start = &card["startDate"];
    let premiere = start["month"]
        .as_u64()
        .zip(start["day"].as_u64())
        .and_then(|(month, day)| date(&start["year"], month as u32, day as u32));
    (next["episode"].as_u64() == Some(1) && next["airingAt"].as_i64().is_some_and(|at| at > now))
        || premiere.is_some_and(|at| at > now)
        || (card["status"] == "NOT_YET_RELEASED" && premiere.is_none_or(|at| at + 86_400 >= now))
        || (card["format"] == "MOVIE" && card["status"] == "RELEASING")
}

fn release_key(card: &Value) -> i64 {
    let start = &card["startDate"];
    card["nextAiring"]["airingAt"]
        .as_i64()
        .or_else(|| {
            date(
                &start["year"],
                start["month"].as_u64().unwrap_or(12) as u32,
                start["day"].as_u64().unwrap_or(28) as u32,
            )
        })
        .or_else(|| {
            date(
                &card["seasonYear"],
                match card["season"].as_str() {
                    Some("WINTER") => 1,
                    Some("SPRING") => 4,
                    Some("SUMMER") => 7,
                    _ => 10,
                },
                28,
            )
        })
        .unwrap_or(i64::MAX)
}
