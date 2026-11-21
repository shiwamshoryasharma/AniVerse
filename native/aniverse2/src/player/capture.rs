use super::{failure, invalid, native, Service, Session};
use crate::RpcError;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, EventTarget, Manager, Webview};
use tokio::sync::{oneshot, OwnedSemaphorePermit};
use uuid::Uuid;
use webview2_com::{
    take_pwstr, CallDevToolsProtocolMethodCompletedHandler,
    DevToolsProtocolEventReceivedEventHandler, Microsoft::Web::WebView2::Win32::*,
};
use windows::core::{w, HSTRING, PWSTR};

const ENDED: &str = "aniverse:player/captureEnded";
const FRAME: &str = "aniverse:player/captureFrame";
const MAX_IMAGE: usize = 384 * 1024;
const PARAMS: &str =
    r#"{"format":"jpeg","quality":68,"maxWidth":1280,"maxHeight":720,"everyNthFrame":3}"#;

#[derive(Deserialize)]
struct Frame<'a> {
    #[serde(rename = "sessionId")]
    id: u64,
    #[serde(borrow)]
    data: &'a str,
}

// The only capture candidate is a single visible, playing, unencrypted video in the guest.
const ARM: &str = r#"(() => {
  globalThis.__avCapture?.events.abort();
  const videos = document.getElementsByTagName('video');
  const video = videos.length === 1 && videos[0];
  if (!video || document.querySelector('iframe,frame,object,embed') || video.mediaKeys ||
      video.readyState < 2 || !video.checkVisibility({checkVisibilityCSS:true, checkOpacity:true}))
    return false;
  const events = new AbortController();
  const state = {video, events, blocked:false};
  for (const name of ['encrypted', 'loadstart', 'emptied'])
    video.addEventListener(name, () => { state.blocked = true; }, {signal:events.signal});
  globalThis.__avCapture = state;
  return true;
})()"#;
const SAFE: &str = r#"(() => {
  const state = globalThis.__avCapture;
  return !!state && !state.blocked && state.video.isConnected && !state.video.mediaKeys &&
    document.getElementsByTagName('video').length === 1 &&
    !document.querySelector('iframe,frame,object,embed') &&
    state.video.checkVisibility({checkVisibilityCSS:true, checkOpacity:true});
})()"#;

pub(super) struct Grant {
    ticket: Uuid,
    generation: u64,
    owner: String,
    _slot: OwnedSemaphorePermit,
    closed: AtomicBool,
    busy: AtomicBool,
}

struct Listener {
    core: ICoreWebView2,
    receiver: ICoreWebView2DevToolsProtocolEventReceiver,
    token: i64,
}
thread_local! {
    static LISTENERS: RefCell<HashMap<Uuid, Listener>> = RefCell::new(HashMap::new());
}

pub(super) async fn prepare(
    service: &Service,
    owner: &Webview,
    session: &Arc<Session>,
) -> Result<Value, RpcError> {
    if session.browsing_private()
        || !session.visible.load(Ordering::Acquire)
        || !session.ready.load(Ordering::Acquire)
        || session.closed.load(Ordering::Acquire)
    {
        return Err(failure(
            "Open a visible regular source player to start compatibility capture.",
        ));
    }
    let active = native::devtools(
        owner,
        "Runtime.evaluate",
        json!({
            "expression": "navigator.userActivation.isActive", "returnByValue": true,
        }),
    )
    .await?;
    if active["result"]["value"] != true {
        return Err(failure(
            "Start compatibility capture with the player’s button.",
        ));
    }
    let slot = service
        .capture_slot
        .clone()
        .try_acquire_owned()
        .map_err(|_| failure("Stop the current compatibility capture first."))?;
    let grant = Arc::new(Grant {
        ticket: Uuid::new_v4(),
        generation: session.page_generation.load(Ordering::Acquire),
        owner: owner.label().to_owned(),
        _slot: slot,
        closed: AtomicBool::new(false),
        busy: AtomicBool::new(false),
    });
    if native::read(session, ARM).await? != true || !current(session, &grant) {
        return Err(failure(
            "This source does not have one accessible unprotected video for compatibility capture.",
        ));
    }
    *session
        .capture
        .lock()
        .map_err(|_| failure("Could not reserve the source player."))? = Some(grant.clone());
    let started = start(session, &grant).await;
    if started.is_err() || !current(session, &grant) {
        revoke(&session.view, &session.capture, Some(grant.ticket));
        started?;
        return Err(failure(
            "The source changed before compatibility capture could start.",
        ));
    }
    Ok(json!({"ticket":grant.ticket.to_string()}))
}

pub(super) fn stop(service: &Service, owner: &Webview, input: &Value) -> Result<Value, RpcError> {
    let ticket = input["ticket"]
        .as_str()
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(invalid)?;
    for session in service
        .views()
        .values()
        .filter(|session| session.view.window().label() == owner.window().label())
    {
        revoke(&session.view, &session.capture, Some(ticket));
    }
    Ok(Value::Null)
}

pub(super) fn revoke(
    view: &Webview,
    state: &std::sync::Mutex<Option<Arc<Grant>>>,
    expected: Option<Uuid>,
) {
    let Some(grant) = state.lock().ok().and_then(|mut grant| {
        if grant
            .as_ref()
            .is_some_and(|grant| expected.is_none_or(|ticket| ticket == grant.ticket))
        {
            grant.take()
        } else {
            None
        }
    }) else {
        return;
    };
    grant.closed.store(true, Ordering::Release);
    let ticket = grant.ticket;
    let _ = view.emit_to(
        EventTarget::webview(grant.owner.clone()),
        ENDED,
        json!({"ticket":ticket.to_string(),"purpose":"upscale"}),
    );
    let _ = view.app_handle().run_on_main_thread(move || {
        let listener = LISTENERS.with(|listeners| listeners.borrow_mut().remove(&ticket));
        if let Some(listener) = listener {
            unsafe {
                let _ = listener
                    .receiver
                    .remove_DevToolsProtocolEventReceived(listener.token);
            }
            send_command(&listener.core, "Page.stopScreencast", "{}");
        }
        drop(grant);
    });
}

async fn start(session: &Arc<Session>, grant: &Arc<Grant>) -> Result<(), RpcError> {
    let (send, receive) = oneshot::channel();
    let weak = Arc::downgrade(session);
    let binding = grant.clone();
    session
        .view
        .with_webview(move |platform| {
            if !weak
                .upgrade()
                .is_some_and(|session| current(&session, &binding))
            {
                return;
            }
            let _ = unsafe {
                platform.controller().CoreWebView2().and_then(|core| {
                    let receiver =
                        core.GetDevToolsProtocolEventReceiver(w!("Page.screencastFrame"))?;
                    let mut token = 0;
                    let ticket = binding.ticket;
                    let mut last = Instant::now() - Duration::from_secs(1);
                    let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(
                        move |core, args| {
                            let (Some(core), Some(args)) = (core, args) else {
                                return Ok(());
                            };
                            let mut response = PWSTR::null();
                            args.ParameterObjectAsJson(&mut response)?;
                            let response = take_pwstr(response);
                            if response.len() > MAX_IMAGE * 4 {
                                return Ok(());
                            }
                            let Ok(frame) = serde_json::from_str::<Frame<'_>>(&response) else {
                                return Ok(());
                            };
                            send_command(
                                &core,
                                "Page.screencastFrameAck",
                                &format!("{{\"sessionId\":{}}}", frame.id),
                            );
                            if last.elapsed() >= Duration::from_millis(75) {
                                if let Some(session) = weak.upgrade() {
                                    if current(&session, &binding)
                                        && frame.data.starts_with("/9j/")
                                        && frame.data.len() <= MAX_IMAGE
                                        && !binding.busy.swap(true, Ordering::AcqRel)
                                    {
                                        last = Instant::now();
                                        tauri::async_runtime::spawn(deliver(
                                            session,
                                            binding.clone(),
                                            frame.data.to_owned(),
                                        ));
                                    }
                                }
                            }
                            Ok(())
                        },
                    ));
                    receiver.add_DevToolsProtocolEventReceived(&handler, &mut token)?;
                    LISTENERS.with(|listeners| {
                        listeners.borrow_mut().insert(
                            ticket,
                            Listener {
                                core: core.clone(),
                                receiver,
                                token,
                            },
                        )
                    });
                    core.CallDevToolsProtocolMethod(
                        w!("Page.startScreencast"),
                        &HSTRING::from(PARAMS),
                        &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                            move |status, _| {
                                let _ = send.send(status.is_ok());
                                Ok(())
                            },
                        )),
                    )
                })
            };
        })
        .map_err(|_| failure("The source closed before capture could start."))?;
    match tokio::time::timeout(Duration::from_secs(3), receive).await {
        Ok(Ok(true)) => Ok(()),
        _ => Err(failure("WebView2 did not start the source capture.")),
    }
}

async fn deliver(session: Arc<Session>, grant: Arc<Grant>, data: String) {
    if !current(&session, &grant)
        || !native::read(&session, SAFE)
            .await
            .is_ok_and(|result| result == true)
    {
        revoke(&session.view, &session.capture, Some(grant.ticket));
    } else if current(&session, &grant) {
        let _ = session.view.emit_to(
            EventTarget::webview(grant.owner.clone()),
            FRAME,
            json!({"ticket":grant.ticket.to_string(),"jpeg":data}),
        );
    }
    grant.busy.store(false, Ordering::Release);
}

fn current(session: &Session, grant: &Grant) -> bool {
    !grant.closed.load(Ordering::Acquire)
        && !session.closed.load(Ordering::Acquire)
        && !session.browsing_private()
        && session.visible.load(Ordering::Acquire)
        && session.ready.load(Ordering::Acquire)
        && session.page_generation.load(Ordering::Acquire) == grant.generation
}

fn send_command(core: &ICoreWebView2, method: &str, params: &str) {
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
    unsafe {
        let _ = core.CallDevToolsProtocolMethod(
            &HSTRING::from(method),
            &HSTRING::from(params),
            &handler,
        );
    }
}
