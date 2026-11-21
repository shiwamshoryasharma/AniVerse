use super::{allowed_top, destination, failure, invalid, native, navigate, page, status, Session};
use crate::{
    patterns::{self, EpisodeStep},
    profile, RpcError,
};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{atomic::Ordering, OnceLock},
    time::{Duration, Instant},
};
use tauri::{Manager, Url, Webview};

const CSS: &str = include_str!(concat!(env!("OUT_DIR"), "/site-focus.css"));
const STEP: Duration = Duration::from_millis(200);

pub(super) async fn open(
    owner: &Webview,
    root: &Path,
    session: &Session,
    input: &Value,
    job: u64,
) -> Result<Value, RpcError> {
    let id = input["mediaId"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or_else(invalid)?;
    let is_private = profile::private_title(root, id)?;
    if session.lease.map(|lease| lease.media_id) != is_private.then_some(id) {
        return Err(failure(
            "Private titles need a separate private source session.",
        ));
    }
    let episode = input["episode"]
        .as_u64()
        .filter(|n| (1..=5000).contains(n))
        .ok_or_else(invalid)? as usize;
    let titles = input["titles"]
        .as_array()
        .filter(|titles| (1..=12).contains(&titles.len()))
        .ok_or_else(invalid)?
        .iter()
        .map(|title| {
            title
                .as_str()
                .filter(|text| !text.is_empty() && text.len() <= 400)
                .ok_or_else(invalid)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let origin = session.source.base.origin().ascii_serialization();
    let methods = owner.state::<patterns::Service>();
    let deadline = Instant::now() + Duration::from_secs(28);
    let current =
        || !session.closed.load(Ordering::Acquire) && session.job.load(Ordering::Acquire) == job;
    let alive = || {
        current()
            && Instant::now() < deadline
            && session.blocked.lock().is_ok_and(|url| url.is_none())
    };
    if let Ok(mut blocked) = session.blocked.lock() {
        *blocked = None;
    }
    if let Ok(mut context) = session.active_episode.lock() {
        *context = None;
    }
    let season = season(&titles);
    let _ = focus(session, false).await;
    let mut learned = Vec::<(&str, String)>::new();
    status(owner, session, Some("Looking for the series…"));
    let on_title = alive() && title_matches(session, &titles, season).await;
    let pin = if session.browsing_private() {
        None
    } else {
        profile::saved_pin(root, &session.source.id, id)?
    };
    let pinned = !on_title
        && alive()
        && match pin {
            Some(url) => {
                load(session, url, &alive).await && title_matches(session, &titles, season).await
            }
            None => false,
        };
    let opened = on_title
        || pinned
        || find_title(
            session,
            &titles,
            season,
            &methods,
            &origin,
            &mut learned,
            &alive,
        )
        .await;
    let found = if opened && alive() {
        status(owner, session, Some("Opening the episode…"));
        find_episode(
            session,
            episode,
            (&titles, season),
            &methods,
            &origin,
            &mut learned,
            &alive,
        )
        .await
    } else {
        false
    };
    let url = session
        .view
        .url()
        .ok()
        .filter(|url| allowed_top(url, &session.source.base))
        .map(|url| url.to_string())
        .unwrap_or_default();
    let blocked = session.blocked.lock().ok().and_then(|url| url.clone());
    if found && alive() && blocked.is_none() {
        if let Ok(mut context) = session.active_episode.lock() {
            *context = Some((id, episode));
        }
        methods.remember_verified(&origin, learned, unlearnable_source(session, &origin));
        let mut cards = episodes(owner, session).await;
        let controls = options(session, None)
            .await
            .map(|opts| opts.0)
            .unwrap_or_else(|_| empty_options());
        insert_audio(&mut cards, episode, &controls);
        methods.observe_audio(
            &session.source.id,
            &origin,
            id,
            &cards,
            unlearnable_source(session, &origin),
        );
        let focused = if input["focus"].as_bool().unwrap_or(true) {
            focus(session, true).await.unwrap_or(false)
        } else {
            false
        };
        status(owner, session, None);
        return Ok(
            json!({"ok":true,"url":url,"via":if pinned { "title" } else if on_title { "current" } else { "search" },"episodes":cards,"focused":focused,
            "message":null,"options":controls}),
        );
    }
    status(owner, session, None);
    let redirect = blocked
        .as_ref()
        .and_then(|url| destination(root, &session.source, url));
    let challenged = if current() && blocked.is_none() && Instant::now() < deadline {
        challenge(session).await
    } else {
        false
    };
    let (reason, message) = if !current() {
        ("cancelled", None)
    } else if blocked.is_some() {
        (
            if redirect.is_some() {
                "redirect"
            } else {
                "unavailable"
            },
            Some("This source redirected outside its configured site."),
        )
    } else if challenged {
        (
            "blocked",
            Some("Complete the source’s security check, then try the episode again."),
        )
    } else if Instant::now() >= deadline {
        (
            "unavailable",
            Some("The source took too long to verify this episode."),
        )
    } else {
        (
            "not-found",
            Some("Could not verify the requested episode on this source."),
        )
    };
    Ok(
        json!({"ok":false,"url":url,"failure":reason,"destinationSourceId":redirect,"via":null,
        "focused":false,"message":message,"options":empty_options()}),
    )
}

async fn find_title(
    session: &Session,
    titles: &[&str],
    season: u64,
    methods: &patterns::Service,
    origin: &str,
    learned: &mut Vec<(&'static str, String)>,
    alive: &impl Fn() -> bool,
) -> bool {
    for query in search_queries(titles) {
        if !alive() {
            return false;
        }
        let heading = json!({"op":"findTitle","titles":titles,"season":season});
        let target =
            session.source.search.as_deref().and_then(|template| {
                Url::parse(&template.replace("{query}", &encoded(&query))).ok()
            });
        let submitted = if let Some(target) = target {
            if !load(session, target, alive).await {
                continue;
            }
            true
        } else {
            if !load(session, session.source.base.clone(), alive).await {
                continue;
            }
            if challenge(session).await {
                return false;
            }
            if title_matches(session, titles, season).await {
                return true;
            }
            if let Some(target) = rendered_search_link(session, &query).await {
                if !load(session, target, alive).await {
                    continue;
                }
                true
            } else {
                if !open_search(session, &query, methods, origin, learned, alive).await {
                    continue;
                }
                false
            }
        };
        let mut finder = heading.clone();
        finder["selector"] =
            json!(methods.selector(origin, "titleLink", unlearnable_source(session, origin)));
        let hits = if finder["selector"].is_string() {
            poll(session, &finder, alive, 500).await
        } else {
            None
        };
        let results = session.view.url().ok();
        if let Some(result) = hits {
            if try_titles(session, &result, titles, season, learned, alive).await {
                return true;
            }
            if let Some(initial) =
                results.filter(|url| Some(url) != session.view.url().ok().as_ref())
            {
                if !load(session, initial, alive).await {
                    continue;
                }
            }
        }
        let mut hits = poll(session, &heading, alive, 2200).await;
        if hits.is_none() && !submitted && alive() {
            let _ = key_enter(session).await;
            hits = poll(session, &heading, alive, 2200).await;
        }
        if hits.is_none()
            && alive()
            && page(session, json!({"op":"viewAll"}))
                .await
                .is_ok_and(|result| result["clicked"] == true)
        {
            hits = poll(session, &heading, alive, 3000).await;
        }
        if let Some(hits) = hits {
            if try_titles(session, &hits, titles, season, learned, alive).await {
                if let Some(stale) = finder["selector"].as_str() {
                    methods.forget(
                        origin,
                        "titleLink",
                        stale,
                        unlearnable_source(session, origin),
                    );
                }
                return true;
            }
        }
    }
    false
}

async fn try_titles(
    session: &Session,
    candidates: &Value,
    titles: &[&str],
    season: u64,
    learned: &mut Vec<(&'static str, String)>,
    alive: &impl Fn() -> bool,
) -> bool {
    let results = session.view.url().ok();
    for (index, hit) in candidates
        .as_array()
        .into_iter()
        .flatten()
        .take(3)
        .enumerate()
    {
        if !alive() {
            return false;
        }
        if index > 0 && session.view.url().ok() != results {
            let Some(initial) = results.clone() else {
                return false;
            };
            if !load(session, initial, alive).await {
                return false;
            }
        }
        if follow(session, hit, alive).await && title_matches(session, titles, season).await {
            teach(learned, "titleLink", hit);
            return true;
        }
    }
    false
}

// A site may publish search suggestions even when its text box needs JavaScript.
async fn rendered_search_link(session: &Session, query: &str) -> Option<Url> {
    let script = r#"(() => {
        const links = document.querySelectorAll('a[href]');
        for (let index = 0; index < Math.min(links.length, 300); index++) {
            const href = links[index].getAttribute('href');
            if (!URL.canParse(href, location.href)) continue;
            const url = new URL(href, location.href);
            if (url.origin === location.origin && !url.hash && !url.username && !url.password &&
                /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:search|find)\/?$/i.test(url.pathname)) {
                const fields = [...url.searchParams];
                if (fields.length === 1 && fields[0][1] &&
                    /^(q|query|search|keyword|keywords|term|s)$/i.test(fields[0][0])) return url.href;
            }
        }
        return null;
    })()"#;
    let result = native::evaluate(session, script.into()).await.ok()?;
    let mut target = Url::parse(result.as_str()?).ok()?;
    if target.origin() != session.view.url().ok()?.origin()
        || !allowed_top(&target, &session.source.base)
    {
        return None;
    }
    let key = target.query_pairs().next()?.0.into_owned();
    target.set_query(None);
    target.query_pairs_mut().append_pair(&key, query);
    Some(target)
}

pub(super) async fn open_search(
    session: &Session,
    query: &str,
    methods: &patterns::Service,
    origin: &str,
    learned: &mut Vec<(&'static str, String)>,
    alive: &impl Fn() -> bool,
) -> bool {
    let fill = json!({"op":"fillSearch","query":query,"selector":methods.selector(origin, "searchInput", unlearnable_source(session, origin))});
    let mut outcome = page(session, fill.clone()).await.unwrap_or_default();
    if outcome["ok"] != true {
        let opener = methods.selector(origin, "searchOpener", unlearnable_source(session, origin));
        if let Some(selector) = opener {
            let result = page(
                session,
                json!({"op":"openSearch","attempt":0,"selector":selector}),
            )
            .await
            .unwrap_or_default();
            if result["clicked"] == true {
                outcome = poll(session, &fill, alive, 700).await.unwrap_or_default();
                if outcome["ok"] == true {
                    teach(learned, "searchOpener", &result);
                }
            }
        }
        if outcome["ok"] != true {
            let result = page(session, json!({"op":"openSearch","attempt":0}))
                .await
                .unwrap_or_default();
            outcome = poll(session, &fill, alive, 1800).await.unwrap_or_default();
            if outcome["ok"] == true {
                teach(learned, "searchOpener", &result);
            }
        }
    }
    if outcome["ok"] == true {
        teach(learned, "searchInput", &outcome);
        return true;
    }
    false
}

async fn find_episode(
    session: &Session,
    episode: usize,
    series: (&[&str], u64),
    methods: &patterns::Service,
    origin: &str,
    learned: &mut Vec<(&'static str, String)>,
    alive: &impl Fn() -> bool,
) -> bool {
    let check = json!({"op":"episodeCheck","episode":episode});
    if page(session, check.clone())
        .await
        .is_ok_and(|value| value["matches"] == true)
    {
        return true;
    }
    let Ok(entry) = session.view.url() else {
        return false;
    };
    let slug = slug(&entry);
    let find = json!({"op":"findEpisode","episode":episode,"slug":slug});
    let selector = methods.selector(origin, "episodeLink", unlearnable_source(session, origin));
    for step in methods.episode_steps(origin, unlearnable_source(session, origin)) {
        if !restore_page(session, &entry, alive).await {
            return false;
        }
        let watch = match step {
            EpisodeStep::Direct => None,
            EpisodeStep::EpisodesTab => {
                if !page(session, json!({"op":"episodesTab"}))
                    .await
                    .is_ok_and(|result| result["clicked"] == true)
                {
                    continue;
                }
                None
            }
            EpisodeStep::WatchLink => {
                let Some(watch) =
                    open_watch(session, &entry, series, &slug, methods, origin, alive).await
                else {
                    continue;
                };
                if page(session, check.clone())
                    .await
                    .is_ok_and(|value| value["matches"] == true)
                {
                    teach(learned, "watchLink", &watch);
                    learned.push(("episodeStep", step.name().into()));
                    return true;
                }
                Some(watch)
            }
        };
        let Ok(listing) = session.view.url() else {
            return false;
        };
        let mut found = None;
        if let Some(selector) = selector.as_ref() {
            let mut preferred = find.clone();
            preferred["selector"] = json!(selector.replace("{n}", &episode.to_string()));
            if let Some(hit) = poll(session, &preferred, alive, 600).await {
                if episode_link(session, &hit, &check, &entry, series, alive).await {
                    found = Some(hit);
                } else if !restore_page(session, &listing, alive).await {
                    return false;
                }
            }
        }
        if found.is_none() {
            if let Some(hit) = poll(session, &find, alive, 1700).await {
                if episode_link(session, &hit, &check, &entry, series, alive).await {
                    if let Some(stale) = selector.as_ref() {
                        methods.forget(
                            origin,
                            "episodeLink",
                            stale,
                            unlearnable_source(session, origin),
                        );
                    }
                    found = Some(hit);
                }
            }
        }
        if let Some(hit) = found {
            if let Some(watch) = watch.as_ref() {
                teach(learned, "watchLink", watch);
            }
            teach(learned, "episodeLink", &hit);
            learned.push(("episodeStep", step.name().into()));
            return true;
        }
    }
    false
}

async fn open_watch(
    session: &Session,
    entry: &Url,
    series: (&[&str], u64),
    slug: &Option<String>,
    methods: &patterns::Service,
    origin: &str,
    alive: &impl Fn() -> bool,
) -> Option<Value> {
    let mut watch = json!({"op":"watchLink","slug":slug});
    let preferred = methods.selector(origin, "watchLink", unlearnable_source(session, origin));
    for selector in preferred.iter().map(Some).chain(std::iter::once(None)) {
        watch["selector"] = json!(selector);
        let hit = page(session, watch.clone()).await.unwrap_or_default();
        if follow(session, &hit, alive).await && title_matches(session, series.0, series.1).await {
            if selector.is_none() {
                if let Some(stale) = preferred.as_ref() {
                    methods.forget(
                        origin,
                        "watchLink",
                        stale,
                        unlearnable_source(session, origin),
                    );
                }
            }
            return Some(hit);
        }
        if !restore_page(session, entry, alive).await {
            return None;
        }
    }
    None
}

async fn restore_page(session: &Session, url: &Url, alive: &impl Fn() -> bool) -> bool {
    alive()
        && (session.view.url().ok().as_ref() == Some(url)
            || load(session, url.clone(), alive).await)
}

async fn episode_link(
    session: &Session,
    hit: &Value,
    check: &Value,
    entry: &Url,
    series: (&[&str], u64),
    alive: &impl Fn() -> bool,
) -> bool {
    follow(session, hit, alive).await
        && poll(session, check, alive, 2300).await.is_some()
        && alive()
        && (session.view.url().ok().as_ref() == Some(entry)
            || title_matches(session, series.0, series.1).await)
}

fn unlearnable_source(session: &Session, origin: &str) -> bool {
    session.browsing_private()
        || !session
            .view
            .url()
            .is_ok_and(|url| url.origin().ascii_serialization() == origin)
}

async fn title_matches(session: &Session, titles: &[&str], season: u64) -> bool {
    if !session
        .view
        .url()
        .is_ok_and(|url| url.scheme() != "about" && allowed_top(&url, &session.source.base))
    {
        return false;
    }
    page(
        session,
        json!({"op":"titleCheck","titles":titles,"season":season}),
    )
    .await
    .is_ok_and(|value| value["score"].as_f64().is_some_and(|score| score >= 0.72))
}

fn learnable(value: &Value) -> Option<&str> {
    value["selector"]
        .as_str()
        .filter(|text| !text.is_empty() && text.len() <= 180)
}

fn teach(learned: &mut Vec<(&'static str, String)>, field: &'static str, value: &Value) {
    if let Some(selector) = learnable(value) {
        learned.push((field, selector.to_owned()));
    }
}

async fn poll(
    session: &Session,
    command: &Value,
    alive: &impl Fn() -> bool,
    milliseconds: u64,
) -> Option<Value> {
    let start = Instant::now();
    while alive() && start.elapsed() < Duration::from_millis(milliseconds) {
        if session
            .blocked
            .lock()
            .is_ok_and(|blocked| blocked.is_some())
        {
            return None;
        }
        if let Ok(data) = page(session, command.clone()).await {
            if !data.is_null()
                && data["ok"] != false
                && data["matches"] != false
                && !data.as_array().is_some_and(Vec::is_empty)
            {
                return Some(data);
            }
        }
        tokio::time::sleep(STEP).await;
    }
    None
}

pub(super) async fn load(session: &Session, url: Url, alive: &impl Fn() -> bool) -> bool {
    if !alive() || navigate(session, url).is_err() {
        return false;
    }
    let start = Instant::now();
    while alive() && start.elapsed() < Duration::from_secs(7) {
        if session
            .blocked
            .lock()
            .is_ok_and(|blocked| blocked.is_some())
        {
            break;
        }
        if session.ready.load(Ordering::Acquire) {
            return true;
        }
        tokio::time::sleep(STEP).await;
    }
    false
}

async fn follow(session: &Session, result: &Value, alive: &impl Fn() -> bool) -> bool {
    if !alive() {
        return false;
    }
    if let Some(href) = result["href"]
        .as_str()
        .and_then(|href| Url::parse(href).ok())
    {
        if session.view.url().ok().as_ref() == Some(&href) {
            return true;
        }
        return load(session, href, alive).await;
    }
    if let Some(pick) = result["pick"].as_str().filter(|pick| safe_pick(pick)) {
        let hit = page(session, json!({"op":"click","pick":pick}))
            .await
            .is_ok_and(|value| value == true);
        if hit {
            tokio::time::sleep(Duration::from_millis(350)).await;
        }
        return hit;
    }
    false
}

fn safe_pick(pick: &str) -> bool {
    (3..=40).contains(&pick.len())
        && pick.starts_with("av")
        && pick.bytes().all(|value| value.is_ascii_alphanumeric())
}

pub(super) async fn key_enter(session: &Session) -> Result<(), RpcError> {
    for kind in ["keyDown", "keyUp"] {
        native::devtools(
            &session.view,
            "Input.dispatchKeyEvent",
            json!({"type":kind,
            "key":"Enter","code":"Enter","windowsVirtualKeyCode":13,"nativeVirtualKeyCode":13}),
        )
        .await?;
    }
    Ok(())
}

fn slug(url: &Url) -> Option<String> {
    let parts = url.path_segments()?.collect::<Vec<_>>();
    let value = parts
        .into_iter()
        .skip(1)
        .find(|value| value.len() >= 4 && !value.bytes().all(|b| b.is_ascii_digit()))?;
    Some(value.to_owned())
}

fn season(titles: &[&str]) -> u64 {
    static MARKER: OnceLock<Regex> = OnceLock::new();
    let marker = MARKER.get_or_init(|| {
        Regex::new(r"(?i)(?:\bseason\s*(\d{1,2}|[ivx]{1,4})\b|\b(\d{1,2})(?:st|nd|rd|th)\s+season\b|\bs(\d{1,2})(?:\s*e\d{1,4})?\b|(?:第\s*)?(\d{1,2})\s*期)").unwrap()
    });
    let roman = [
        "", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii",
        "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx",
    ];
    titles
        .iter()
        .flat_map(|title| marker.captures_iter(title))
        .filter_map(|hit| {
            let number = hit.iter().skip(1).flatten().next()?.as_str();
            number.parse::<u64>().ok().or_else(|| {
                roman
                    .iter()
                    .position(|value| value.eq_ignore_ascii_case(number))
                    .map(|n| n as u64)
            })
        })
        .filter(|number| *number > 0)
        .max()
        .unwrap_or(1)
}

fn search_queries(titles: &[&str]) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    let head = titles
        .first()
        .map(|title| {
            title
                .split([':', '–', '—'])
                .next()
                .unwrap_or(title)
                .split(" - ")
                .next()
                .unwrap_or(title)
        })
        .filter(|title| title.chars().count() >= 4);
    for title in titles.iter().copied().take(5).chain(head) {
        let query = title
            .chars()
            .filter_map(|character| {
                if matches!(character, '\'' | '’' | '\u{60}' | '´') {
                    None
                } else if "“”\"!?.,;:()[]{}~|/\\-".contains(character) {
                    Some(' ')
                } else {
                    Some(character)
                }
            })
            .collect::<String>();
        let query = query.split_whitespace().collect::<Vec<_>>().join(" ");
        if query.chars().count() >= 3
            && !result
                .iter()
                .any(|value| value.eq_ignore_ascii_case(&query))
        {
            result.push(query);
        }
    }
    result
}

pub(super) fn encoded(query: &str) -> String {
    let mut out = String::new();
    for byte in query.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub(super) async fn challenge(session: &Session) -> bool {
    page(session, json!({"op":"pageInfo"}))
        .await
        .ok()
        .and_then(|value| value["title"].as_str().map(str::to_ascii_lowercase))
        .is_some_and(|title| {
            [
                "just a moment",
                "attention required",
                "security check",
                "verify you are human",
            ]
            .iter()
            .any(|marker| title.contains(marker))
        })
}

fn empty_options() -> Value {
    json!({"types":[],"servers":[]})
}

pub(super) async fn options(
    session: &Session,
    choice: Option<(&str, &str)>,
) -> Result<(Value, bool), RpcError> {
    let script = r#"(() => {
      const sheet = globalThis.__avSiteFocusSheet;
      const wasDisabled = sheet?.disabled;
      if (sheet) sheet.disabled = true;
      try {
        const list = globalThis.__avSiteAudio(globalThis.__avSitePage({op:'siteOptions'}));
        const choice = CHOICE;
        const active = list.find(item => item.kind === 'type' && item.active)?.value;
        const desired = choice && list.find(item => item.kind === choice[0] && item.value === choice[1] &&
          (item.kind === 'type' || !item.group || !active || active === item.group));
        const element = desired && !desired.active &&
          /^av[a-z0-9]{1,36}$/i.test(desired.pick) &&
          document.querySelector('[data-aniverse-pick="' + desired.pick + '"]');
        if (element) { element.scrollIntoView({ block: 'center' }); element.click(); }
        return { list, clicked: !!element };
      } finally { if (sheet) sheet.disabled = wasDisabled; }
    })()"#.replace("CHOICE", &json!(choice).to_string());

    let result = native::evaluate(session, script).await?;
    let rows = result["list"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let entries = |kind: &str, active: Option<&str>| {
        rows.iter().filter_map(|row| {
        let label = row["label"].as_str().filter(|label| label.len() <= 64)?;
        let value = row["value"].as_str().filter(|value| value.len() <= 64)?;
        let group = row["group"].as_str().filter(|group| matches!(*group,"sub"|"dub"|"raw"));
        let is_valid = match kind { "type" => matches!(value,"sub"|"dub"|"raw"), _ => true };
        if row["kind"] != kind || !is_valid || (active.is_some() && group.is_some() && active != group) { return None; }
        Some(json!({"kind":kind,"label":label,"value":value,"group":group,"active":row["active"]==true}))
    }).take(32).collect::<Vec<_>>()
    };
    let types = entries("type", None);
    let selected = types
        .iter()
        .find(|row| row["active"] == true)
        .and_then(|row| row["value"].as_str());
    Ok((
        json!({"types":types,"servers":entries("server",selected)}),
        result["clicked"] == true,
    ))
}

pub(super) async fn choose(
    owner: &Webview,
    session: &Session,
    input: &Value,
) -> Result<Value, RpcError> {
    let kind = input["kind"]
        .as_str()
        .filter(|kind| matches!(*kind, "type" | "server"))
        .ok_or_else(invalid)?;
    let value = input["value"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 64)
        .ok_or_else(invalid)?;
    let (mut state, clicked) = options(session, Some((kind, value))).await?;
    let key = if kind == "type" { "types" } else { "servers" };
    if clicked {
        let start = Instant::now();
        while !session.closed.load(Ordering::Relaxed) && start.elapsed() < Duration::from_secs(5) {
            tokio::time::sleep(STEP).await;
            if let Ok((next, _)) = options(session, None).await {
                state = next;
                if state[key].as_array().is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item["value"] == value && item["active"] == true)
                }) {
                    break;
                }
            }
        }
    }
    let focused =
        session.focus.load(Ordering::Relaxed) && focus(session, true).await.unwrap_or(false);
    let episode = session
        .active_episode
        .lock()
        .ok()
        .and_then(|context| *context);
    if let Some((id, episode)) = episode {
        let origin = session.source.base.origin().ascii_serialization();
        let mut cards = episodes(owner, session).await;
        insert_audio(&mut cards, episode, &state);
        owner.state::<patterns::Service>().observe_audio(
            &session.source.id,
            &origin,
            id,
            &cards,
            unlearnable_source(session, &origin),
        );
    }
    Ok(json!({"options":state,"focused":focused}))
}

pub(super) async fn episodes(owner: &Webview, session: &Session) -> Value {
    let context = session.active_episode.lock().ok().and_then(|state| *state);
    let result = page(session, json!({"op":"episodeCards","slug":null}))
        .await
        .unwrap_or_default();
    // Only card/audio metadata leaves the guest. Session-owned artwork is not exposed as URLs.
    let rows = result
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|card| {
            let n = card["episode"]
                .as_u64()
                .filter(|n| (1..=5000).contains(n))?;
            let audio = card["audio"]
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .filter(|choice| matches!(*choice, "sub" | "dub"))
                .take(2)
                .collect::<Vec<_>>();
            Some(json!({"episode":n,"thumbnail":null,"audio":audio}))
        })
        .take(500)
        .collect::<Vec<_>>();
    let cards = json!(rows);
    if let Some((id, _)) = context {
        let origin = session.source.base.origin().ascii_serialization();
        owner.state::<patterns::Service>().observe_audio(
            &session.source.id,
            &origin,
            id,
            &cards,
            unlearnable_source(session, &origin),
        );
    }
    cards
}

fn insert_audio(cards: &mut Value, episode: usize, controls: &Value) {
    let Some(rows) = cards.as_array_mut() else {
        return;
    };
    let audio = controls["types"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["value"].as_str())
        .filter(|choice| matches!(*choice, "sub" | "dub"))
        .take(2)
        .collect::<Vec<_>>();
    if audio.is_empty() {
        return;
    }
    if let Some(row) = rows.iter_mut().find(|row| row["episode"] == episode) {
        let mut merged = row["audio"].as_array().cloned().unwrap_or_default();
        for choice in audio {
            if !merged.iter().any(|value| value == choice) {
                merged.push(json!(choice));
            }
        }
        row["audio"] = json!(merged);
    } else {
        rows.push(json!({"episode":episode,"thumbnail":null,"audio":audio}));
    }
}

pub(super) async fn focus(session: &Session, on: bool) -> Result<bool, RpcError> {
    session.focus.store(on, Ordering::Relaxed);
    let css = json!(CSS);
    let script = format!(
        r#"(() => {{
        const prior = globalThis.__avSiteFocusSheet;
        if (!{on}) {{
            globalThis.__avSitePage({{op:"releasePlayer"}});
            if (prior) document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== prior);
            delete globalThis.__avSiteFocusSheet;
            return false;
        }}
        // Install before marking, including when the player's DOM has not hydrated yet.
        const sheet = prior ?? new CSSStyleSheet();
        if (!prior) sheet.replaceSync({css});
        if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        globalThis.__avSiteFocusSheet = sheet;
        const result = globalThis.__avSitePage({{op:"markPlayer",keep:true}});
        const player = document.querySelector('[data-aniverse-player]');
        if (!result?.found || !player) return false;
        const box = player.getBoundingClientRect();
        return Math.abs(box.x) <= 2 && Math.abs(box.y) <= 2 &&
            Math.abs(box.width - innerWidth) <= 2 && Math.abs(box.height - innerHeight) <= 2;
    }})()"#
    );
    native::evaluate(session, script)
        .await
        .map(|value| value == true)
}

const VIDEO: &str = r#"[...document.querySelectorAll('video')].filter(v=>v.videoWidth>0).sort((a,b)=>b.videoWidth*b.videoHeight-a.videoWidth*a.videoHeight)[0]"#;

// Inspect decoded playback in the main document, then visible same-origin media frames.
const PROBE: &str = r#"(() => {
  const info = {topVideos:0, decodedTopVideos:0, sameOriginFrames:0, opaqueFrames:0, uniqueOpaquePlayer:false};
  let examined = 0;
  function inspect(doc, depth) {
    const videos = doc.getElementsByTagName('video');
    let video = null;
    if (!depth) info.topVideos = videos.length;
    for (let index = 0; index < Math.min(videos.length, 24); index++) {
      const item = videos[index];
      if (!item.videoWidth || !Number.isFinite(item.duration) || item.duration <= 0) continue;
      if (!depth) info.decodedTopVideos++;
      if (!video || item.videoWidth * item.videoHeight > video.videoWidth * video.videoHeight) video = item;
    }
    if (video) {
      const quality = video.getVideoPlaybackQuality?.();
      let bufferedAhead = 0;
      for (let index = 0; index < video.buffered.length; index++) {
        if (video.buffered.start(index) <= video.currentTime && video.currentTime <= video.buffered.end(index)) {
          bufferedAhead = video.buffered.end(index) - video.currentTime;
          break;
        }
      }
      return {currentTime:video.currentTime, duration:video.duration, paused:video.paused, ended:video.ended,
        video:{width:video.videoWidth, height:video.videoHeight, readyState:video.readyState, bufferedAhead, playbackRate:video.playbackRate,
          totalFrames:quality?.totalVideoFrames ?? null, droppedFrames:quality?.droppedVideoFrames ?? null}};
    }
    if (depth >= 2) return null;
    const marked = doc.querySelector('iframe[data-aniverse-media]');
    const frames = marked ? [marked] : doc.getElementsByTagName('iframe');
    for (let index = 0; examined < 6 && index < Math.min(frames.length, 32); index++) {
      const frame = frames[index];
      const box = frame.getBoundingClientRect();
      if (box.width < 240 || box.height < 135 ||
          !frame.checkVisibility({checkVisibilityCSS:true, checkOpacity:true})) continue;
      examined++;
      // A cross-origin or sandboxed frame has no accessible contentDocument.
      const child = frame.contentDocument;
      if (!child) {
        info.opaqueFrames++;
        if (!depth && doc.getElementsByTagName('iframe').length === 1 && frame.contentWindow &&
            frame.hasAttribute('src') && !frame.hasAttribute('srcdoc') &&
            (!frame.hasAttribute('sandbox') || frame.sandbox.contains('allow-same-origin')) &&
            box.width / box.height >= 1.1 && box.width / box.height <= 2.6) info.uniqueOpaquePlayer = true;
        continue;
      }
      info.sameOriginFrames++;
      const result = inspect(child, depth + 1);
      if (result) return result;
    }
    return null;
  }
  return {sample:inspect(document, 0), info};
})()"#;

#[cfg(feature = "isolated-test")]
pub(super) async fn probe_diagnostics(session: &Session) -> Result<Value, RpcError> {
    Ok(native::read(session, PROBE).await?["info"].clone())
}

pub(super) async fn probe(session: &Session) -> Value {
    let generation = session.page_generation.load(Ordering::Acquire);
    let result = native::read(session, PROBE).await.unwrap_or_default();
    let mut probe = result["sample"].clone();
    if probe.is_null() && result["info"]["uniqueOpaquePlayer"] == true {
        probe = super::frames::probe(session, generation)
            .await
            .unwrap_or_default();
    }
    if probe.is_object() {
        probe["url"] = json!(session
            .view
            .url()
            .ok()
            .filter(|url| allowed_top(url, &session.source.base))
            .map(|url| url.to_string())
            .unwrap_or_default());
    }
    probe
}

pub(super) async fn control(session: &Session, input: &Value) -> Result<bool, RpcError> {
    let action = input["action"].as_str().ok_or_else(invalid)?;
    let command = match action {
        "play" => "video.play().catch(() => {});".to_owned(),
        "pause" => "video.pause();".to_owned(),
        "seek" => format!(
            "video.currentTime = Math.min(video.duration, {});",
            input["value"]
                .as_f64()
                .filter(|next| next.is_finite() && *next >= 0.0)
                .ok_or_else(invalid)?
        ),
        // There is no source URL reload or private-player access behind this health control.
        "resync" => "video.currentTime = video.currentTime;".to_owned(),
        _ => return Err(invalid()),
    };
    native::evaluate(session, format!("(() => {{ const video = {VIDEO}; if (!video) return false; {command} return true; }})()"))
        .await.map(|value| value == true)
}
