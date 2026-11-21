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

pub(super) fn airings(rows: &[Value], adult: bool) -> impl Iterator<Item = Value> + '_ {
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

pub(super) fn visible(raw: &Value, adult: bool) -> bool {
    adult || raw["isAdult"].as_bool() == Some(false)
}

pub(super) fn card(raw: &Value) -> Option<Value> {
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
        "startDate": raw["startDate"], "description": raw["description"].as_str().filter(|text| !text.is_empty()).map(plain_description),
    }))
}

pub(super) fn browse(page: &Value, adult: bool) -> Option<Value> {
    let items: Vec<_> = page["media"]
        .as_array()?
        .iter()
        .filter(|media| visible(media, adult))
        .filter_map(card)
        .collect();
    let info = &page["pageInfo"];
    Some(json!({
        "items": items, "page": info["currentPage"].as_u64()?,
        "hasNext": info["hasNextPage"].as_bool()?, "total": info["total"].as_u64()?,
    }))
}

fn list(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}

fn studios(media: &Value) -> Vec<&str> {
    list(&media["studios"]["nodes"])
        .filter_map(|studio| studio["name"].as_str())
        .collect()
}

pub(super) fn details(media: &Value) -> Option<Value> {
    let mut result = card(media)?;
    for key in [
        "source",
        "countryOfOrigin",
        "endDate",
        "popularity",
        "favourites",
        "trailer",
        "siteUrl",
    ] {
        result[key] = media[key].clone();
    }
    for key in ["synonyms", "streamingEpisodes", "externalLinks"] {
        result[key] = json!(media[key].as_array().map(Vec::as_slice).unwrap_or_default());
    }
    result["studios"] = json!(studios(media));
    result["tags"] = json!(list(&media["tags"])
        .filter_map(|tag| Some(json!({
            "name": tag["name"].as_str()?, "rank": tag["rank"].as_u64()?,
            "isSpoiler": tag["isMediaSpoiler"].as_bool().unwrap_or(false),
        })))
        .collect::<Vec<_>>());
    result["relations"] = json!(list(&media["relations"]["edges"])
        .filter_map(|edge| {
            let node = &edge["node"];
            if node["type"] != "ANIME" {
                return None;
            }
            Some(json!({"relationType": edge["relationType"].as_str()?, "media": card(node)?}))
        })
        .collect::<Vec<_>>());
    result["recommendations"] = json!(list(&media["recommendations"]["nodes"])
        .filter_map(|node| card(&node["mediaRecommendation"]))
        .collect::<Vec<_>>());
    result["characters"] = json!(list(&media["characters"]["edges"]).filter_map(|edge| {
        let node = &edge["node"];
        let actor = &edge["voiceActors"][0];
        let voice = actor["name"]["userPreferred"].as_str()
            .map(|name| json!({"name": name, "image": actor["image"]["medium"]}));
        Some(json!({"name": node["name"]["userPreferred"].as_str()?, "image": node["image"]["medium"],
                   "role": edge["role"].as_str()?, "voiceActor": voice}))
    }).collect::<Vec<_>>());
    Some(result)
}

pub(super) fn hover(media: &Value) -> Option<Value> {
    if !media.is_object() {
        return None;
    }
    static CREATOR: OnceLock<Regex> = OnceLock::new();
    let creator = CREATOR.get_or_init(|| Regex::new(
        r"(?i)original (creator|story|work|character design)|^story( & art)?$|^author$|original manga|original novel",
    ).unwrap());
    let mut seen = HashSet::new();
    let creators: Vec<_> = list(&media["staff"]["edges"])
        .filter(|entry| {
            entry["role"]
                .as_str()
                .is_some_and(|role| creator.is_match(role.trim()))
        })
        .filter_map(|entry| entry["node"]["name"]["full"].as_str())
        .filter(|name| !name.is_empty() && seen.insert(*name))
        .take(2)
        .collect();
    let tags: Vec<_> = list(&media["tags"])
        .filter(|tag| {
            tag["isMediaSpoiler"] != true && tag["rank"].as_u64().is_some_and(|rank| rank >= 60)
        })
        .filter_map(|tag| tag["name"].as_str())
        .take(4)
        .collect();
    Some(json!({
        "studios": studios(media), "creators": creators, "tags": tags,
        "description": media["description"].as_str().filter(|text| !text.is_empty()).map(plain_description),
    }))
}

pub(super) fn genres(data: &Value, adult: bool) -> Option<Value> {
    let genres: Vec<_> = data["GenreCollection"]
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .filter(|genre| adult || *genre != "Hentai")
        .collect();
    let tags: Vec<_> = data["MediaTagCollection"]
        .as_array()?
        .iter()
        .filter(|tag| visible(tag, adult))
        .filter_map(|tag| tag["name"].as_str())
        .collect();
    Some(json!({"genres": genres, "tags": tags}))
}
fn plain_description(text: &str) -> String {
    static MARKUP: OnceLock<Regex> = OnceLock::new();
    static BREAKS: OnceLock<Regex> = OnceLock::new();
    let markup = MARKUP.get_or_init(|| {
        Regex::new(r"(?i)</p>|<br\s*/?>|<[^>]+>|&(#x[0-9a-f]+|#\d+|[a-z]+\d*);").unwrap()
    });
    let collapsed = markup
        .replace_all(text, |captures: &regex::Captures<'_>| {
            if let Some(entity) = captures.get(1) {
                let code = entity.as_str();
                if let Some(number) = code.strip_prefix('#') {
                    let converted = if let Some(hex) = number
                        .strip_prefix('x')
                        .or_else(|| number.strip_prefix('X'))
                    {
                        u32::from_str_radix(hex, 16).ok()
                    } else {
                        number.parse().ok()
                    };
                    return converted
                        .and_then(char::from_u32)
                        .map_or_else(|| captures[0].to_owned(), |ch| ch.to_string());
                }
                return match code.to_ascii_lowercase().as_str() {
                    "amp" => "&",
                    "quot" => "\"",
                    "apos" => "'",
                    "nbsp" => " ",
                    "lt" => "<",
                    "gt" => ">",
                    "lsquo" => "‘",
                    "rsquo" => "’",
                    "ldquo" => "“",
                    "rdquo" => "”",
                    "hellip" => "…",
                    "mdash" => "—",
                    "ndash" => "–",
                    "bull" => "•",
                    "middot" => "·",
                    "shy" => "",
                    _ => &captures[0],
                }
                .into();
            }
            let tag = captures[0].to_ascii_lowercase();
            if tag == "</p>" {
                "\n\n".into()
            } else if tag.trim_end_matches(['>', '/', ' ']) == "<br" {
                "\n".into()
            } else {
                "".into()
            }
        })
        .replace('\r', "");
    BREAKS
        .get_or_init(|| Regex::new(r"\n{3,}").unwrap())
        .replace_all(&collapsed, "\n\n")
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
