use crate::RpcError;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum Request {
    Home,
    Latest(u8),
    Details(i32),
    Hover(i32),
    Search(String),
    Browse {
        variables: Map<String, Value>,
        exclude_library: bool,
    },
    Schedule {
        from: i32,
        to: i32,
    },
    Genres,
}

impl Request {
    pub(crate) fn parse(method: &str, input: Option<&Value>) -> Option<Result<Self, RpcError>> {
        let input = input.and_then(Value::as_object);
        let field = |name: &str| input.and_then(|body| body.get(name));
        let id = || {
            field("id")?
                .as_i64()
                .and_then(|id| i32::try_from(id).ok())
                .filter(|id| *id > 0)
        };
        let request = match method {
            "meta.home" => Some(Self::Home),
            "meta.latest" => field("page")
                .and_then(Value::as_u64)
                .filter(|page| (1..=20).contains(page))
                .map(|page| Self::Latest(page as u8)),
            "meta.details" => id().map(Self::Details),
            "meta.hover" => id().map(Self::Hover),
            "meta.search" => field("q")
                .and_then(Value::as_str)
                .filter(|q| q.encode_utf16().count() <= 200)
                .map(|q| Self::Search(q.trim().to_owned())),
            "meta.browse" => input.and_then(browse),
            "meta.schedule" => {
                let unix = |name| i32::try_from(field(name)?.as_i64()?).ok();
                unix("from")
                    .zip(unix("to"))
                    .filter(|(from, to)| {
                        (1..=15 * 86_400).contains(&(i64::from(*to) - i64::from(*from)))
                    })
                    .map(|(from, to)| Self::Schedule { from, to })
            }
            "meta.genres" => Some(Self::Genres),
            _ => return None,
        };
        Some(request.ok_or_else(|| RpcError::new("invalid-input", "Invalid AniList request.")))
    }

    /// Resolve only AniList IDs already verified by an owned source catalogue.
    pub(crate) fn catalogue(
        ids: &[i32],
        filters: Option<&Value>,
    ) -> Result<Option<Self>, RpcError> {
        let mut seen = std::collections::HashSet::new();
        let mut ids: Vec<_> = ids
            .iter()
            .copied()
            .filter(|id| *id > 0 && seen.insert(*id))
            .take(50)
            .collect();
        if ids.is_empty() {
            return Ok(None);
        }
        ids.sort_unstable();
        let empty = Map::new();
        let parsed = match filters {
            Some(filters) => filters.as_object().and_then(browse),
            None => browse(&empty),
        };
        let Some(Self::Browse {
            mut variables,
            exclude_library,
        }) = parsed
        else {
            return Err(RpcError::new(
                "invalid-input",
                "Invalid AniList catalogue filters.",
            ));
        };
        if variables.remove("search").is_some() {
            let sort = variables["sort"][1].as_str().unwrap_or("POPULARITY_DESC");
            variables.insert("sort".into(), json!([sort]));
        }
        variables.insert("page".into(), json!(1));
        variables.insert("perPage".into(), json!(50));
        variables.insert("id_in".into(), json!(ids));
        Ok(Some(Self::Browse {
            variables,
            exclude_library,
        }))
    }
    pub(crate) fn excludes_library(&self) -> bool {
        matches!(
            self,
            Self::Browse {
                exclude_library: true,
                ..
            }
        )
    }

    pub(super) fn ttl(&self) -> u64 {
        match self {
            Self::Home | Self::Browse { .. } => 600,
            Self::Latest(_) => 90,
            Self::Details(_) => 3600,
            Self::Search(_) => 1800,
            Self::Schedule { .. } => 900,
            Self::Hover(_) | Self::Genres => 7 * 86_400,
        }
    }
}

fn browse(input: &Map<String, Value>) -> Option<Request> {
    let mut variables = Map::new();
    for (name, graphql_key, limit, width) in [
        ("genres", "genre_in", 20, 60),
        ("excludedGenres", "genre_not_in", 20, 60),
        ("tags", "tag_in", 20, 80),
    ] {
        if let Some(value) = input.get(name) {
            let entries = value.as_array()?;
            if entries.len() > limit
                || entries.iter().any(|entry| {
                    !entry
                        .as_str()
                        .is_some_and(|label| label.encode_utf16().count() <= width)
                })
            {
                return None;
            }
            if !entries.is_empty() {
                variables.insert(graphql_key.to_owned(), value.clone());
            }
        }
    }
    if let Some(value) = input.get("formats") {
        let entries = value.as_array()?;
        let formats = ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"];
        if entries.len() > formats.len()
            || entries.iter().any(|entry| {
                !entry
                    .as_str()
                    .is_some_and(|format| formats.contains(&format))
            })
        {
            return None;
        }
        if !entries.is_empty() {
            variables.insert("format_in".into(), value.clone());
        }
    }
    for (name, graphql_key, allowed) in [
        (
            "season",
            "season",
            &["WINTER", "SPRING", "SUMMER", "FALL"][..],
        ),
        (
            "status",
            "status",
            &[
                "FINISHED",
                "RELEASING",
                "NOT_YET_RELEASED",
                "CANCELLED",
                "HIATUS",
            ][..],
        ),
        ("country", "countryOfOrigin", &["JP", "KR", "CN", "TW"][..]),
        (
            "sourceMaterial",
            "source",
            &[
                "ORIGINAL",
                "MANGA",
                "LIGHT_NOVEL",
                "VISUAL_NOVEL",
                "VIDEO_GAME",
                "NOVEL",
                "WEB_NOVEL",
                "OTHER",
            ][..],
        ),
    ] {
        if let Some(value) = input.get(name) {
            if !allowed.contains(&value.as_str()?) {
                return None;
            }
            variables.insert(graphql_key.to_owned(), value.clone());
        }
    }
    for (name, graphql_key, min, max, adjustment, default) in [
        ("page", "page", 1, 500, 0, Some(1)),
        ("perPage", "perPage", 1, 50, 0, Some(30)),
        ("year", "seasonYear", 1940, 2100, 0, None),
        ("minScore", "averageScore_greater", 0, 100, -1, None),
        ("minEpisodes", "episodes_greater", 0, 5000, -1, None),
        ("maxEpisodes", "episodes_lesser", 0, 5000, 1, None),
    ] {
        if let Some(value) = input.get(name) {
            let number = value
                .as_i64()
                .filter(|number| (min..=max).contains(number))?;
            if number != 0 {
                variables.insert(graphql_key.to_owned(), json!(number + adjustment));
            }
        } else if let Some(default) = default {
            variables.insert(graphql_key.to_owned(), json!(default));
        }
    }
    let search = match input.get("search") {
        Some(value) => value
            .as_str()
            .filter(|text| text.encode_utf16().count() <= 200)?
            .trim(),
        None => "",
    };
    let sort = match input.get("sort") {
        Some(value) => value.as_str().filter(|sort| {
            [
                "TRENDING_DESC",
                "POPULARITY_DESC",
                "SCORE_DESC",
                "START_DATE_DESC",
                "UPDATED_AT_DESC",
                "TITLE_ROMAJI",
                "FAVOURITES_DESC",
                "EPISODES_DESC",
            ]
            .contains(sort)
        })?,
        None => "POPULARITY_DESC",
    };
    if search.is_empty() {
        variables.insert("sort".into(), json!([sort]));
    } else {
        variables.insert("search".into(), json!(search));
        variables.insert("sort".into(), json!(["SEARCH_MATCH", sort]));
    }
    let exclude_library = match input.get("excludeLibrary") {
        Some(value) => value.as_bool()?,
        None => false,
    };
    Some(Request::Browse {
        variables,
        exclude_library,
    })
}
