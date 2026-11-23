use super::GuestState;
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, COOKIE, ORIGIN, REFERER, USER_AGENT,
};
use std::{
    collections::VecDeque,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tauri::Url;
use webview2_com::{
    take_pwstr, Microsoft::Web::WebView2::Win32::*, WebResourceResponseReceivedEventHandler,
};
use windows::core::{w, Interface, HSTRING, PWSTR};

const LIMIT: usize = 192;
const MAX_AGE: Duration = Duration::from_secs(600);
const MAX_HEADER: usize = 4096;
const MAX_HEADER_BYTES: usize = 8192;

#[derive(Clone)]
pub(super) struct Response {
    pub(super) url: Url,
    pub(super) mime: String,
    pub(super) headers: HeaderMap,
    generation: u64,
    job: u64,
    seen: Instant,
}

#[derive(Default)]
pub(super) struct Ledger(VecDeque<Response>);

#[cfg(test)]
impl Response {
    pub(super) fn test_entry(url: &str, mime: &str, headers: HeaderMap) -> Self {
        Self {
            url: Url::parse(url).unwrap(),
            mime: mime.into(),
            headers,
            generation: 1,
            job: 1,
            seen: Instant::now(),
        }
    }
}

impl Ledger {
    fn record(&mut self, response: Response) {
        self.0.retain(|entry| {
            entry.generation == response.generation
                && entry.job == response.job
                && entry.url != response.url
                && entry.seen.elapsed() <= MAX_AGE
        });
        if self.0.len() == LIMIT {
            self.0.pop_front();
        }
        self.0.push_back(response);
    }

    pub(super) fn clear(&mut self) {
        self.0.clear();
    }

    pub(super) fn snapshot(&self, generation: u64, job: u64) -> Vec<Response> {
        self.0
            .iter()
            .rev()
            .filter(|entry| {
                entry.generation == generation
                    && entry.job == job
                    && entry.seen.elapsed() <= MAX_AGE
            })
            .cloned()
            .collect()
    }
}

pub(super) unsafe fn install(
    core: &ICoreWebView2,
    state: Arc<GuestState>,
) -> windows::core::Result<()> {
    let mut token = 0;
    core.cast::<ICoreWebView2_2>()?
        .add_WebResourceResponseReceived(
            &WebResourceResponseReceivedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    // Tracking cannot deny or mutate a webpage response.
                    let _ = unsafe { observe(&state, &args) };
                }
                Ok(())
            })),
            &mut token,
        )
}

unsafe fn observe(
    state: &GuestState,
    args: &ICoreWebView2WebResourceResponseReceivedEventArgs,
) -> windows::core::Result<()> {
    let job = state.job.load(Ordering::Acquire);
    if job == 0 || state.closed.load(Ordering::Acquire) || crate::runtime_privacy::active() {
        return Ok(());
    }
    let generation = state.page_generation.load(Ordering::Acquire);
    let response = args.Response()?;
    let mut status = 0;
    response.StatusCode(&mut status)?;
    if !matches!(status, 200 | 206) {
        return Ok(());
    }
    let request = args.Request()?;
    let mut raw = PWSTR::null();
    request.Method(&mut raw)?;
    if take_pwstr(raw) != "GET" {
        return Ok(());
    }
    let mut raw = PWSTR::null();
    request.Uri(&mut raw)?;
    let raw = take_pwstr(raw);
    let Some(url) = Url::parse(&raw)
        .ok()
        .filter(crate::downloads::is_owned_player_endpoint)
    else {
        return Ok(());
    };
    let mut kind = PWSTR::null();
    let response_headers = response.Headers()?;
    let mime = if response_headers
        .GetHeader(w!("Content-Type"), &mut kind)
        .is_ok()
    {
        let value = take_pwstr(kind);
        value
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
    } else {
        String::new()
    };
    if mime.len() > 128
        || mime.bytes().any(|byte| byte.is_ascii_control())
        || mime.starts_with("text/html")
        || mime.ends_with("json")
        || mime.ends_with("javascript")
        || mime == "text/css"
    {
        return Ok(());
    }
    let request_headers = request.Headers()?;
    let headers = captured_headers(|name| {
        let mut raw = PWSTR::null();
        unsafe {
            request_headers
                .GetHeader(&HSTRING::from(name.as_str()), &mut raw)
                .ok()?
        };
        Some(take_pwstr(raw))
    });
    if state.page_generation.load(Ordering::Acquire) == generation
        && state.job.load(Ordering::Acquire) == job
        && !state.closed.load(Ordering::Acquire)
    {
        if let Ok(mut observed) = state.download_responses.lock() {
            observed.record(Response {
                url,
                mime,
                headers,
                generation,
                job,
                seen: Instant::now(),
            });
        }
    }
    Ok(())
}

fn captured_headers(mut read: impl FnMut(&HeaderName) -> Option<String>) -> HeaderMap {
    let mut result = HeaderMap::new();
    let mut bytes = 0;
    for name in [COOKIE, AUTHORIZATION, REFERER, ORIGIN, ACCEPT, USER_AGENT] {
        let Some(raw) = read(&name) else { continue };
        if raw.is_empty() || raw.len() > MAX_HEADER || bytes + raw.len() > MAX_HEADER_BYTES {
            continue;
        }
        if let Ok(mut value) = HeaderValue::from_str(&raw) {
            // These can carry session tokens and must not appear in debug output.
            value.set_sensitive(true);
            bytes += raw.len();
            result.insert(name, value);
        }
    }
    result
}

#[cfg(test)]
#[path = "../../../../test/tauri-compat/download-network.rs"]
mod tests;
