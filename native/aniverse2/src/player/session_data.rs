use super::{failure, Session};
use crate::RpcError;
use serde_json::{json, Value};
use std::{
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use webview2_com::{take_pwstr, GetCookiesCompletedHandler, Microsoft::Web::WebView2::Win32::*};
use windows::core::{w, Interface, BOOL, PWSTR};

pub(super) async fn cookies(session: &Session) -> Result<Value, RpcError> {
    let error = || failure("Could not inspect this source session.");
    let (send, receive) = tokio::sync::oneshot::channel();
    session
        .view
        .with_webview(move |platform| {
            let handler = GetCookiesCompletedHandler::create(Box::new(move |status, list| {
                let result = if status.is_ok() {
                    list.and_then(|list| unsafe { describe(list).ok() })
                } else {
                    None
                };
                let _ = send.send(result);
                Ok(())
            }));
            let _ = unsafe {
                platform
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| core.cast::<ICoreWebView2_2>())
                    .and_then(|core| core.CookieManager())
                    .and_then(|manager| manager.GetCookies(w!(""), &handler))
            };
        })
        .map_err(|_| error())?;
    tokio::time::timeout(Duration::from_secs(10), receive)
        .await
        .ok()
        .and_then(Result::ok)
        .flatten()
        .ok_or_else(error)
}

unsafe fn describe(list: ICoreWebView2CookieList) -> windows::core::Result<Value> {
    static AUTH: OnceLock<regex::Regex> = OnceLock::new();
    let auth = AUTH.get_or_init(|| {
        regex::Regex::new(r"(?i)remember|auth|token|jwt|logged|login|user_?id|uid|sid_|account")
            .unwrap()
    });
    let cutoff = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        + 86_400.0;
    let mut count = 0;
    list.Count(&mut count)?;
    let mut signed_in = false;
    for index in 0..count.min(4096) {
        let cookie = list.GetValueAtIndex(index)?;
        let mut http_only = BOOL(0);
        cookie.IsHttpOnly(&mut http_only)?;
        if !http_only.as_bool() {
            continue;
        }
        let mut expires = 0.0;
        cookie.Expires(&mut expires)?;
        if expires <= cutoff {
            continue;
        }
        let mut name = PWSTR::null();
        cookie.Name(&mut name)?;
        let name = take_pwstr(name);
        if !name.starts_with("__cf") && !name.starts_with("cf_") && auth.is_match(&name) {
            signed_in = true;
            break;
        }
    }
    Ok(json!({"cookies":count,"signedIn":signed_in}))
}
