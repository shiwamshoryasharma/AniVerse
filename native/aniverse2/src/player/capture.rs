use super::{failure, invalid, native, Service, Session};
use crate::{cast::mirror::Ingress, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
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
const MIRROR_FRAME: &str = "aniverse:cast/mirrorFrame";
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
const ARM: &str = r#"(focused => {
  globalThis.__avCapture?.events.abort();
  const videos = document.getElementsByTagName('video');
  const video = videos.length === 1 && videos[0];
  const frames = () => document.querySelector('iframe,frame,object,embed');
  if (!video || frames() || video.mediaKeys || video.readyState < 2) return false;
  const events = new AbortController();
  const state = {events, blocked:false, safe: () => {
    if (state.blocked || !video.isConnected || video.mediaKeys || videos.length !== 1 || frames() ||
        !video.checkVisibility({checkVisibilityCSS:true, checkOpacity:true})) return false;
    if (!focused) return true;
    const player = video.closest('[data-aniverse-player]');
    const sheet = globalThis.__avSiteFocusSheet;
    if (!video.hasAttribute('data-aniverse-media') || !player || !sheet || sheet.disabled || !document.adoptedStyleSheets.includes(sheet)) return false;
    const fills = (element) => {
      const rect = element.getBoundingClientRect();
      return innerWidth >= 240 && innerHeight >= 135 && Math.abs(rect.left) < 2 &&
        Math.abs(rect.top) < 2 && Math.abs(rect.right - innerWidth) < 2 &&
        Math.abs(rect.bottom - innerHeight) < 2;
    };
    return fills(player) && fills(video);
  }};
  if (!state.safe()) return false;
  for (const name of ['encrypted', 'loadstart', 'emptied'])
    video.addEventListener(name, () => { state.blocked = true; }, {signal:events.signal});
  globalThis.__avCapture = state;
  return true;
})"#;
const SAFE: &str = "globalThis.__avCapture?.safe() === true";
static LOCAL_ARM: OnceLock<String> = OnceLock::new();
static MIRROR_ARM: OnceLock<String> = OnceLock::new();

pub(super) struct Grant {
    ticket: Uuid,
    generation: u64,
    owner: String,
    _slot: OwnedSemaphorePermit,
    closed: AtomicBool,
    busy: AtomicBool,
    mirror: Option<Arc<Ingress>>,
}

struct Listener {
    core: ICoreWebView2,
    receiver: ICoreWebView2DevToolsProtocolEventReceiver,
    token: i64,
}
thread_local! {
    static LISTENERS: RefCell<HashMap<Uuid, Listener>> = RefCell::new(HashMap::new());
}

impl Service {
    pub(crate) async fn prepare_mirror(
        &self,
        owner: &Webview,
        id: u64,
        ingress: Arc<Ingress>,
    ) -> Result<(), RpcError> {
        let session = self
            .views()
            .get(&id)
            .cloned()
            .filter(|session| session.view.window().label() == owner.window().label())
            .ok_or_else(|| failure("Choose a player owned by this window."))?;
        let _guard = session.command.lock().await;
        prepare_owned(self, owner, &session, Some(ingress)).await?;
        Ok(())
    }
}

pub(super) async fn prepare(
    service: &Service,
    owner: &Webview,
    session: &Arc<Session>,
) -> Result<Value, RpcError> {
    let ticket = prepare_owned(service, owner, session, None).await?;
    Ok(json!({"ticket":ticket.to_string()}))
}

async fn prepare_owned(
    service: &Service,
    owner: &Webview,
    session: &Arc<Session>,
    mirror: Option<Arc<Ingress>>,
) -> Result<Uuid, RpcError> {
    if session.browsing_private()
        || !session.visible.load(Ordering::Acquire)
        || !session.ready.load(Ordering::Acquire)
        || session.closed.load(Ordering::Acquire)
    {
        return Err(failure(
            "Open a visible regular source player to start compatibility capture.",
        ));
    }
    if mirror.is_some() && !session.focus.load(Ordering::Acquire) {
        return Err(failure("Turn on player-only mode to mirror this source."));
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
        mirror,
    });
    let arm = if grant.mirror.is_some() {
        MIRROR_ARM.get_or_init(|| format!("{ARM}(true)"))
    } else {
        LOCAL_ARM.get_or_init(|| format!("{ARM}(false)"))
    };
    if !current(session, &grant)
        || native::read(session, arm).await? != true
        || !current(session, &grant)
    {
        return Err(failure(if grant.mirror.is_some() {
            "Mirroring needs one accessible unprotected video filling the focused source view."
        } else {
            "This source does not have one accessible unprotected video for compatibility capture."
        }));
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
    if let Some(ingress) = grant.mirror.clone() {
        let guest = Arc::downgrade(session);
        let ticket = grant.ticket;
        tauri::async_runtime::spawn(async move {
            ingress.closed().await;
            if let Some(guest) = guest.upgrade() {
                revoke(&guest.view, &guest.capture, Some(ticket));
            }
        });
    }
    Ok(grant.ticket)
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

pub(super) fn revoke_mirror(session: &Session) {
    let ticket = session.capture.lock().ok().and_then(|active| {
        active
            .as_ref()
            .filter(|grant| grant.mirror.is_some())
            .map(|grant| grant.ticket)
    });
    if let Some(ticket) = ticket {
        revoke(&session.view, &session.capture, Some(ticket));
    }
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
    let (public_ticket, purpose) = if let Some(ingress) = &grant.mirror {
        ingress.close();
        (ingress.ticket(), "mirror")
    } else {
        (ticket, "upscale")
    };
    let _ = view.emit_to(
        EventTarget::webview(grant.owner.clone()),
        ENDED,
        json!({"ticket":public_ticket.to_string(),"purpose":purpose}),
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
                                    if !current(&session, &binding) {
                                        revoke(
                                            &session.view,
                                            &session.capture,
                                            Some(binding.ticket),
                                        );
                                    } else if frame.data.starts_with("/9j/")
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
        let target = EventTarget::webview(grant.owner.clone());
        if let Some(ingress) = &grant.mirror {
            if let Some(sequence) = ingress.offer(&data) {
                let _ = session.view.emit_to(
                    target,
                    MIRROR_FRAME,
                    json!({"ticket":ingress.ticket().to_string(),"sequence":sequence}),
                );
            }
        } else {
            let _ = session.view.emit_to(
                target,
                FRAME,
                json!({"ticket":grant.ticket.to_string(),"jpeg":data}),
            );
        }
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
        && grant
            .mirror
            .as_ref()
            .is_none_or(|ingress| !ingress.is_closed() && session.focus.load(Ordering::Acquire))
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
