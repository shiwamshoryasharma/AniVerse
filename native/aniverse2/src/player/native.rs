use super::{failure, fixture_source, frames, Bounds, GuestState, Session, AUDIO, PAGE};
use crate::{
    adblocker::{self, Denial},
    RpcError,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::HashMap,
    net::IpAddr,
    sync::{atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Url, Webview};
use tokio::sync::oneshot;
use webview2_com::{
    take_pwstr, CallDevToolsProtocolMethodCompletedHandler, Microsoft::Web::WebView2::Win32::*,
    PermissionRequestedEventHandler, ScreenCaptureStartingEventHandler,
    WebResourceRequestedEventHandler,
};
use windows::{
    core::{w, Interface, HSTRING, PWSTR},
    Win32::System::Com::IStream,
};

use windows_sys::Win32::{
    Foundation::HWND,
    Graphics::Gdi::{CreateRectRgn, DeleteObject, SetWindowRgn},
    UI::{
        HiDpi::GetDpiForWindow,
        WindowsAndMessaging::{GetClassNameW, GetParent, SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER},
    },
};

pub(super) async fn place(view: &Webview, viewport: Bounds, visible: Bounds) -> Result<(), RpcError> {
    let placement_error = || failure("Could not place the source page inside the player.");
    let owner = view.window().hwnd().map_err(|_| placement_error())?.0 as isize;
    let (send, receive) = oneshot::channel();
    view.with_webview(move |platform| {
        let result = place_child(&platform.controller(), owner as HWND, viewport, visible);
        let _ = send.send(result);
    })
    .map_err(|_| placement_error())?;
    if receive.await.unwrap_or(false) {
        Ok(())
    } else {
        Err(placement_error())
    }
}

fn place_child(controller: &ICoreWebView2Controller, owner: HWND, viewport: Bounds, visible: Bounds) -> bool {
    use windows::Win32::Foundation::{HWND as ControllerHwnd, RECT};

    let mut parent = ControllerHwnd::default();
    unsafe {
        if controller.ParentWindow(&mut parent).is_err() || parent.0.is_null() || parent.0 == owner || GetParent(parent.0) != owner {
            return false;
        }
        // Wry creates its own container, which is the WebView2 controller parent.
        // Never set a region on AniVerse's main HWND or an unrelated window.
        let mut class = [0u16; 32];
        let length = GetClassNameW(parent.0, class.as_mut_ptr(), class.len() as i32);
        if length != 11 || !class[..11].iter().copied().eq("WRY_WEBVIEW".encode_utf16()) {
            return false;
        }
        let dpi = GetDpiForWindow(parent.0);
        if dpi == 0 {
            return false;
        }
        let scale = f64::from(dpi) / 96.0;
        let px = |css: f64| (css * scale).round() as i32;
        let x = px(viewport.x);
        let y = px(viewport.y);
        let width = px(viewport.width).max(1);
        let height = px(viewport.height).max(1);
        // Round clipping edges inward so fractional DPI cannot paint outside the host.
        let left = ((visible.x * scale).ceil() as i32 - x).clamp(0, width);
        let top = ((visible.y * scale).ceil() as i32 - y).clamp(0, height);
        let right = (((visible.x + visible.width) * scale).floor() as i32 - x).clamp(left, width);
        let bottom = (((visible.y + visible.height) * scale).floor() as i32 - y).clamp(top, height);
        let region = CreateRectRgn(left, top, right, bottom);
        if region.is_null() {
            return false;
        }
        if SetWindowRgn(parent.0, region, 1) == 0 {
            let _ = DeleteObject(region);
            return false;
        }
        // SetWindowRgn takes ownership of the region on success.
        let mut current = RECT::default();
        let desired = RECT { left: 0, top: 0, right: width, bottom: height };
        if (controller.Bounds(&mut current).is_err() || current != desired) && controller.SetBounds(desired).is_err() {
            return false;
        }
        SetWindowPos(parent.0, std::ptr::null_mut(), x, y, width, height, SWP_NOACTIVATE | SWP_NOZORDER) != 0
    }
}

const EVAL_LIMIT: usize = 512 * 1024;
const DNS_TTL: Duration = Duration::from_secs(20);
type DnsCache = Arc<Mutex<HashMap<String, (Instant, bool)>>>;

struct Deferred {
    args: ICoreWebView2WebResourceRequestedEventArgs,
    deferral: ICoreWebView2Deferral,
    blocked: ICoreWebView2WebResourceResponse,
    source_id: Arc<str>,
    source: Url,
    uri: String,
    record_activity: bool,
}
thread_local! {
    static DEFERRED: RefCell<HashMap<String, Vec<Deferred>>> = RefCell::new(HashMap::new());
}

pub(super) async fn install_guards(
    view: &Webview,
    app: AppHandle,
    source: Url,
    source_id: String,
    cache: DnsCache,
    hidden: bool,
    record_activity: bool,
    frame_scope: Option<(u64, Arc<GuestState>)>,
) -> Result<(), RpcError> {
    let (send, recv) = oneshot::channel();
    view.with_webview(move |platform| {
        let outcome = unsafe {
            platform.controller().CoreWebView2().and_then(|core| {
                install(
                    &core,
                    &platform.environment(),
                    app,
                    source,
                    source_id.into(),
                    cache,
                    hidden,
                    record_activity,
                )?;
                if let Some((id, state)) = frame_scope {
                    let _ = frames::track(&core, id, state);
                }
                Ok(())
            })
        };
        let result = outcome.map_err(|_| failure("Could not install the source network guards."));
        let _ = send.send(result);
    })
    .map_err(|_| failure("Could not configure the source window."))?;
    recv.await
        .map_err(|_| failure("The source window was closed."))?
}

unsafe fn install(
    webview: &ICoreWebView2,
    environment: &ICoreWebView2Environment,
    app: AppHandle,
    source: Url,
    source_id: Arc<str>,
    cache: DnsCache,
    hidden: bool,
    record_activity: bool,
) -> windows::core::Result<()> {
    let settings = webview.Settings()?;
    settings.SetAreDevToolsEnabled(false)?;
    settings.SetAreHostObjectsAllowed(false)?;
    if let Ok(options) = settings.cast::<ICoreWebView2Settings4>() {
        options.SetIsPasswordAutosaveEnabled(false)?;
        options.SetIsGeneralAutofillEnabled(false)?;
    }
    let mut token = 0i64;
    webview.add_PermissionRequested(
        &PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
            }
            Ok(())
        })),
        &mut token,
    )?;
    if let Ok(capture) = webview.cast::<ICoreWebView2_27>() {
        capture.add_ScreenCaptureStarting(
            &ScreenCaptureStartingEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    args.SetCancel(true)?;
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    // Do not issue a source request without coverage for worker and subframe traffic.
    webview
        .cast::<ICoreWebView2_22>()?
        .AddWebResourceRequestedFilterWithRequestSourceKinds(
            w!("*"),
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
        )?;
    let response = environment.CreateWebResourceResponse(
        None::<&IStream>,
        403,
        w!("Blocked by AniVerse2"),
        w!("Cache-Control: no-store"),
    )?;
    webview.add_WebResourceRequested(
        &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                if hidden {
                    let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
                    args.ResourceContext(&mut context)?;
                    if context == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA {
                        return args.SetResponse(&response);
                    }
                }
                intercept(
                    &args,
                    &response,
                    &app,
                    &source,
                    &source_id,
                    &cache,
                    record_activity,
                )?;
            }
            Ok(())
        })),
        &mut token,
    )?;
    Ok(())
}

unsafe fn intercept(
    args: &ICoreWebView2WebResourceRequestedEventArgs,
    blocked: &ICoreWebView2WebResourceResponse,
    app: &AppHandle,
    source: &Url,
    source_id: &Arc<str>,
    cache: &DnsCache,
    record_activity: bool,
) -> windows::core::Result<()> {
    let mut raw = PWSTR::null();
    args.Request()?.Uri(&mut raw)?;
    let uri = take_pwstr(raw);
    if matches!(uri.as_str(), "about:blank" | "about:srcdoc")
        || uri.starts_with("blob:")
        || uri.starts_with("data:")
    {
        return Ok(());
    }
    let record_activity = record_activity && !crate::runtime_privacy::active();
    let checked = |allowed| {
        finish_request(
            args,
            blocked,
            app,
            source_id,
            source,
            &uri,
            allowed,
            record_activity,
        )
    };
    let Ok(target) = Url::parse(&uri) else {
        return checked(false);
    };
    #[cfg(feature = "isolated-test")]
    if fixture_source(source)
        && target.scheme() == "http"
        && target.username().is_empty()
        && target.password().is_none()
        && target.host_str() == Some("127.0.0.1")
        && target.port().is_some()
        && std::env::var("ANIVERSE2_TEST_FRAME_ORIGIN")
            .is_ok_and(|origin| origin == target.origin().ascii_serialization())
    {
        return checked(true);
    }
    if !aniverse_security::allows_source_network(&uri, source.as_str()) {
        return checked(false);
    }
    if !aniverse_security::allows_source_network(&uri, "") {
        // Only a literal local origin explicitly written in the user's source list is allowed.
        return checked(target.origin() == source.origin() && fixture_source(source));
    }
    let Some(host) = target.host_str().map(|host| host.trim_matches(['[', ']'])) else {
        return checked(false);
    };
    if let Ok(ip) = host.parse::<IpAddr>() {
        return checked(aniverse_security::allows_public_address(ip));
    }
    if let Some((_, allowed)) = cache
        .lock()
        .ok()
        .and_then(|cache| cache.get(host).copied())
        .filter(|(at, _)| at.elapsed() < DNS_TTL)
    {
        return checked(allowed);
    }
    if DEFERRED.with(|queue| {
        let queue = queue.borrow();
        (!queue.contains_key(host) && queue.len() >= 32)
            || queue.values().map(Vec::len).sum::<usize>() >= 128
    }) {
        return checked(false);
    }
    let deferral = args.GetDeferral()?;
    let first = DEFERRED.with(|queue| {
        let mut queue = queue.borrow_mut();
        let pending = queue.entry(host.to_owned()).or_default();
        let first = pending.is_empty();
        pending.push(Deferred {
            args: args.clone(),
            deferral,
            blocked: blocked.clone(),
            source_id: source_id.clone(),
            source: source.clone(),
            uri,
            record_activity,
        });
        first
    });
    if !first {
        return Ok(());
    }
    let cache = cache.clone();
    let app = app.clone();
    let host = host.to_owned();
    let port = target.port_or_known_default().unwrap_or(443);
    tauri::async_runtime::spawn(async move {
        let allowed = match tokio::time::timeout(
            Duration::from_millis(2500),
            tokio::net::lookup_host((host.as_str(), port)),
        )
        .await
        {
            Ok(Ok(mut addresses)) => addresses.next().is_some_and(|first| {
                aniverse_security::allows_public_address(first.ip())
                    && addresses
                        .all(|address| aniverse_security::allows_public_address(address.ip()))
            }),
            _ => false,
        };
        if let Ok(mut entries) = cache.lock() {
            if entries.len() >= 512 {
                entries.clear();
            }
            entries.insert(host.clone(), (Instant::now(), allowed));
        }
        let owner = app.clone();
        let _ = app.run_on_main_thread(move || complete(&owner, &host, allowed));
    });
    Ok(())
}

fn complete(app: &AppHandle, host: &str, allowed: bool) {
    let batch = DEFERRED
        .with(|queue| queue.borrow_mut().remove(host))
        .unwrap_or_default();
    for item in batch {
        unsafe {
            let _ = finish_request(
                &item.args,
                &item.blocked,
                app,
                &item.source_id,
                &item.source,
                &item.uri,
                allowed,
                item.record_activity,
            );
            let _ = item.deferral.Complete();
        }
    }
}

unsafe fn finish_request(
    args: &ICoreWebView2WebResourceRequestedEventArgs,
    blocked: &ICoreWebView2WebResourceResponse,
    app: &AppHandle,
    source_id: &str,
    source: &Url,
    uri: &str,
    allowed: bool,
    record_activity: bool,
) -> windows::core::Result<()> {
    let service = app.try_state::<adblocker::Service>();
    let denial = if !allowed {
        Some(Denial::Security)
    } else if service
        .as_ref()
        .is_some_and(|engine| matches_filter(engine, args, source_id, source, uri))
    {
        Some(Denial::Network)
    } else {
        None
    };
    if let Some(denial) = denial {
        args.SetResponse(blocked)?;
        if let Some(service) =
            service.filter(|_| record_activity && !crate::runtime_privacy::active())
        {
            service.count(source_id, denial);
        }
    }
    Ok(())
}

unsafe fn matches_filter(
    engine: &adblocker::Service,
    args: &ICoreWebView2WebResourceRequestedEventArgs,
    source_id: &str,
    source: &Url,
    uri: &str,
) -> bool {
    if !engine.enabled_for(source_id) {
        return false;
    }
    let Ok(request) = args.Request() else {
        return false;
    };
    let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_OTHER;
    if args.ResourceContext(&mut context).is_err() {
        return false;
    }
    let mut raw = PWSTR::null();
    if request.Method(&mut raw).is_err() {
        return false;
    }
    let method = take_pwstr(raw);
    let mut raw = PWSTR::null();
    let referring = request
        .Headers()
        .ok()
        .and_then(|headers| {
            headers
                .GetHeader(w!("Referer"), &mut raw)
                .ok()
                .map(|_| take_pwstr(raw))
        })
        .filter(|value| {
            value.len() <= 8192 && (value.starts_with("https://") || value.starts_with("http://"))
        });
    let document = if referring.is_some() {
        "subdocument"
    } else {
        "document"
    };
    let kind = match context {
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => document,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "stylesheet",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_TEXT_TRACK => {
            "media"
        }
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST
        | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH
        | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_EVENT_SOURCE => "xmlhttprequest",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "websocket",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING => "ping",
        _ => "other",
    };
    engine.blocks(
        source_id,
        referring.as_deref().unwrap_or(source.as_str()),
        uri,
        kind,
        &method,
    )
}

pub(super) async fn devtools(
    view: &Webview,
    method: &'static str,
    params: Value,
) -> Result<Value, RpcError> {
    devtools_for(view, None, method, params).await
}

async fn devtools_for(
    view: &Webview,
    session: Option<String>,
    method: &'static str,
    params: Value,
) -> Result<Value, RpcError> {
    let (send, recv) = oneshot::channel();
    view.with_webview(move |platform| {
        let result = unsafe {
            platform.controller().CoreWebView2().and_then(|core| {
                let method = HSTRING::from(method);
                let params = HSTRING::from(params.to_string());
                let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |status, reply| {
                        let result = status
                            .map_err(|_| failure("The source page changed."))
                            .and_then(|_| {
                                if reply.len() > EVAL_LIMIT {
                                    return Err(failure("Source page result is too large."));
                                }
                                serde_json::from_str(&reply)
                                    .map_err(|_| failure("Could not inspect the source page."))
                            });
                        let _ = send.send(result);
                        Ok(())
                    },
                ));
                if let Some(id) = session {
                    core.cast::<ICoreWebView2_11>()?
                        .CallDevToolsProtocolMethodForSession(
                            &HSTRING::from(id),
                            &method,
                            &params,
                            &callback,
                        )
                } else {
                    core.CallDevToolsProtocolMethod(&method, &params, &callback)
                }
            })
        };
        let _ = result;
    })
    .map_err(|_| failure("Could not inspect the source page."))?;
    tokio::time::timeout(Duration::from_secs(4), recv)
        .await
        .map_err(|_| failure("Source page inspection timed out."))?
        .map_err(|_| failure("The source page changed."))?
}

pub(super) async fn evaluate(session: &Session, expression: String) -> Result<Value, RpcError> {
    evaluate_script(session, expression, true).await
}

pub(super) async fn evaluate_without_activation(
    session: &Session,
    expression: String,
) -> Result<Value, RpcError> {
    evaluate_script(session, expression, false).await
}

pub(super) async fn read(session: &Session, expression: &'static str) -> Result<Value, RpcError> {
    evaluate_script(session, expression.to_owned(), false).await
}

async fn evaluate_script(
    session: &Session,
    expression: String,
    user_gesture: bool,
) -> Result<Value, RpcError> {
    let context = site_world(session).await?;
    let result = devtools(&session.view, "Runtime.evaluate", json!({
        "expression": expression, "contextId": context, "returnByValue": true, "userGesture": user_gesture,
    })).await?;
    if !result["exceptionDetails"].is_null() || result["result"].is_null() {
        if let Ok(mut stored) = session.world.lock() {
            *stored = None;
        }
        return Err(failure("The source page changed."));
    }
    Ok(result["result"]["value"].clone())
}

async fn site_world(session: &Session) -> Result<i64, RpcError> {
    let generation = session.page_generation.load(Ordering::Relaxed);
    let cached = session.world.lock().ok().and_then(|entry| *entry);
    let context = if let Some((_, context)) = cached.filter(|(seen, _)| *seen == generation) {
        context
    } else {
        let frames = devtools(&session.view, "Page.getFrameTree", json!({})).await?;
        let frame = frames["frameTree"]["frame"]["id"]
            .as_str()
            .ok_or_else(|| failure("The source has no main frame."))?;
        let world = devtools(
            &session.view,
            "Page.createIsolatedWorld",
            json!({"frameId": frame, "worldName": "aniverse-site"}),
        )
        .await?;
        let context = world["executionContextId"]
            .as_i64()
            .ok_or_else(|| failure("Could not isolate source page inspection."))?;
        let initialized = devtools(&session.view, "Runtime.evaluate", json!({
            "expression": format!("globalThis.__avSiteAudio = {AUDIO};void(globalThis.__avSitePage = {PAGE})"),
            "contextId": context, "returnByValue": true,
        })).await?;
        if !initialized["exceptionDetails"].is_null() || initialized["result"].is_null() {
            return Err(failure("Could not initialize isolated source inspection."));
        }
        if let Ok(mut stored) = session.world.lock() {
            *stored = Some((generation, context));
        }
        context
    };
    Ok(context)
}

pub(super) struct AudioFrameWorld {
    generation: u64,
    frame: String,
    target: Option<String>,
    context: i64,
}

fn audio_generation(session: &Session, generation: u64) -> bool {
    !session.closed.load(Ordering::Acquire)
        && session.page_generation.load(Ordering::Acquire) == generation
}

async fn audio_eval(
    session: &Session,
    generation: u64,
    target: Option<String>,
    context: i64,
    expression: String,
    user_gesture: bool,
) -> Result<Value, RpcError> {
    if !audio_generation(session, generation) {
        return Err(failure("The source page changed."));
    }
    let result = devtools_for(
        &session.view,
        target,
        "Runtime.evaluate",
        json!({
            "expression": expression, "contextId": context, "returnByValue": true,
            "awaitPromise": true, "userGesture": user_gesture, "allowUnsafeEvalBlockedByCSP": false,
        }),
    )
    .await?;
    if !audio_generation(session, generation)
        || !result["exceptionDetails"].is_null()
        || result["result"].is_null()
    {
        return Err(failure(
            "Could not run Quantum Audio in the selected player.",
        ));
    }
    Ok(result["result"]["value"].clone())
}

pub(super) async fn evaluate_audio_top(
    session: &Session,
    generation: u64,
    expression: String,
    user_gesture: bool,
) -> Result<Value, RpcError> {
    let context = site_world(session).await?;
    audio_eval(session, generation, None, context, expression, user_gesture).await
}

async fn marked_audio_frame(session: &Session, generation: u64) -> Result<String, RpcError> {
    let context = site_world(session).await?;
    let selected = devtools(&session.view, "Runtime.evaluate", json!({
        "expression": "(() => { const items=document.querySelectorAll('[data-aniverse-media]'); const item=items[0]; return items.length===1 && item instanceof HTMLIFrameElement && item.isConnected && item.contentWindow ? item : null; })()",
        "contextId": context, "allowUnsafeEvalBlockedByCSP": false,
    })).await?;
    let object = selected["result"]["objectId"]
        .as_str()
        .filter(|id| id.len() <= 160)
        .ok_or_else(|| failure("There is no selected source player frame."))?;
    let result = devtools(
        &session.view,
        "DOM.describeNode",
        json!({"objectId":object,"depth":0}),
    )
    .await;
    let _ = devtools(
        &session.view,
        "Runtime.releaseObject",
        json!({"objectId":object}),
    )
    .await;
    let description = result?;
    let node = &description["node"];
    let marked = node["attributes"].as_array().is_some_and(|attrs| {
        attrs
            .iter()
            .step_by(2)
            .any(|name| name == "data-aniverse-media")
    });
    if !audio_generation(session, generation) || !marked || node["nodeName"] != "IFRAME" {
        return Err(failure("The selected source player frame changed."));
    }
    protocol_id(&node["frameId"])
        .ok_or_else(|| failure("Could not identify the selected source frame."))
}

fn protocol_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
        .map(str::to_owned)
}

async fn player_world(
    session: &Session,
    generation: u64,
    frame: String,
    world_name: &str,
) -> Result<AudioFrameWorld, RpcError> {
    let options = json!({"frameId":frame,"worldName":world_name});
    let method = "Page.createIsolatedWorld";
    if let Some(context) = devtools(&session.view, method, options.clone())
        .await
        .ok()
        .and_then(|world| world["executionContextId"].as_i64())
    {
        return Ok(AudioFrameWorld {
            generation,
            frame,
            target: None,
            context,
        });
    }
    let targets = devtools(&session.view, "Target.getTargets", json!({})).await?;
    if !audio_generation(session, generation)
        || !targets["targetInfos"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|target| target["targetId"] == frame && target["type"] == "iframe")
        })
    {
        return Err(failure("The selected source player frame is unavailable."));
    }
    let attached = devtools(
        &session.view,
        "Target.attachToTarget",
        json!({"targetId":frame,"flatten":true}),
    )
    .await?;
    let target = protocol_id(&attached["sessionId"])
        .ok_or_else(|| failure("Could not attach to the selected source player frame."))?;
    match devtools_for(&session.view, Some(target.clone()), method, options)
        .await
        .ok()
        .and_then(|world| world["executionContextId"].as_i64())
    {
        Some(context) => Ok(AudioFrameWorld {
            generation,
            frame,
            target: Some(target),
            context,
        }),
        None => {
            detach_audio_target(session, Some(target)).await;
            Err(failure(
                "Could not isolate the selected source player frame.",
            ))
        }
    }
}

async fn detach_audio_target(session: &Session, target: Option<String>) {
    if let Some(target) = target {
        let _ = devtools(
            &session.view,
            "Target.detachFromTarget",
            json!({"sessionId":target}),
        )
        .await;
    }
}

pub(super) async fn evaluate_audio_frame(
    session: &Session,
    generation: u64,
    expression: String,
    user_gesture: bool,
) -> Result<Value, RpcError> {
    let mut pinned = session.audio_frame.lock().await;
    let frame = marked_audio_frame(session, generation).await?;
    if pinned
        .as_ref()
        .is_some_and(|world| world.generation != generation)
    {
        let target = pinned.take().and_then(|world| world.target);
        detach_audio_target(session, target).await;
    }
    if let Some(world) = pinned.as_ref() {
        if world.frame != frame {
            return Err(failure("The selected source player frame changed."));
        }
    } else {
        *pinned = Some(player_world(session, generation, frame, "aniverse-quantum-audio").await?);
    }
    let world = pinned
        .as_ref()
        .ok_or_else(|| failure("The source player frame is unavailable."))?;
    audio_eval(
        session,
        generation,
        world.target.clone(),
        world.context,
        expression,
        user_gesture,
    )
    .await
}

pub(super) async fn inspect_player_frame(
    session: &Session, generation: u64, expression: &'static str,
) -> Result<Value, RpcError> {
    let frame = marked_audio_frame(session, generation).await?;
    let world = player_world(session, generation, frame, "aniverse-download").await?;
    let result = audio_eval(
        session, generation, world.target.clone(), world.context, expression.into(), false,
    ).await;
    detach_audio_target(session, world.target).await;
    result
}

// Teardown uses only the previously approved context, even after its DOM mark is removed.
pub(super) async fn release_audio_frame(
    session: &Session,
    generation: u64,
    expression: String,
) -> Result<Value, RpcError> {
    let mut pinned = session.audio_frame.lock().await;
    let Some(world) = pinned
        .as_ref()
        .filter(|world| world.generation == generation)
    else {
        return Ok(Value::Null);
    };
    let result = audio_eval(
        session,
        generation,
        world.target.clone(),
        world.context,
        expression,
        false,
    )
    .await;
    if result.is_ok() || !audio_generation(session, generation) {
        let target = pinned.take().and_then(|world| world.target);
        detach_audio_target(session, target).await;
    }
    result
}
