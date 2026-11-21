use super::{GuestState, Session};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tauri::{Manager, Webview};
use webview2_com::{
    ExecuteScriptCompletedHandler, FrameCreatedEventHandler, FrameDestroyedEventHandler,
    Microsoft::Web::WebView2::Win32::*,
};
use windows::core::{Interface, BOOL, HSTRING};

const PROBE: &str = r#"(() => {
  if (window.parent !== window.top || window === window.top) return null;
  const video = document.querySelector('video');
  if (!video || !video.videoWidth || !Number.isFinite(video.duration) || video.duration <= 0) return null;
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
})()"#;

#[derive(Default)]
struct Frames {
    generation: u64,
    entries: Vec<ICoreWebView2Frame>,
    uncertain: bool,
}

// WebView2 frame objects stay in their creating STA, never in Session or an async task.
thread_local! {
    static FRAMES: RefCell<HashMap<u64, Frames>> = RefCell::new(HashMap::new());
}

impl Frames {
    fn prune(&mut self) {
        self.entries.retain(|frame| {
            let mut destroyed = BOOL(0);
            if unsafe { frame.IsDestroyed(&mut destroyed) }.is_err() {
                self.uncertain = true;
            }
            !destroyed.as_bool()
        });
    }
}

pub(super) unsafe fn track(
    core: &ICoreWebView2,
    id: u64,
    state: Arc<GuestState>,
) -> windows::core::Result<()> {
    let mut token = 0;
    core.cast::<ICoreWebView2_4>()?.add_FrameCreated(
        &FrameCreatedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            if state.closed.load(Ordering::Acquire) {
                return Ok(());
            }
            let generation = state.page_generation.load(Ordering::Acquire);
            let frame = args.Frame()?;
            let tracked = frame
                .add_Destroyed(
                    &FrameDestroyedEventHandler::create(Box::new(move |sender, _| {
                        if let Some(sender) = sender {
                            FRAMES.with(|all| {
                                if let Some(active) = all
                                    .borrow_mut()
                                    .get_mut(&id)
                                    .filter(|active| active.generation == generation)
                                {
                                    active.entries.retain(|frame| frame != &sender);
                                }
                            });
                        }
                        Ok(())
                    })),
                    &mut 0,
                )
                .is_ok();
            FRAMES.with(|all| {
                let mut all = all.borrow_mut();
                let active = all.entry(id).or_default();
                if active.generation != generation {
                    *active = Frames {
                        generation,
                        ..Frames::default()
                    };
                }
                active.prune();
                if tracked && active.entries.len() < 8 {
                    active.entries.push(frame);
                } else {
                    active.uncertain = true;
                }
            });
            Ok(())
        })),
        &mut token,
    )
}

pub(super) fn clear(view: &Webview, id: u64) {
    let _ = view.app_handle().run_on_main_thread(move || {
        FRAMES.with(|frames| {
            frames.borrow_mut().remove(&id);
        });
    });
}

pub(super) async fn probe(session: &Session, generation: u64) -> Option<Value> {
    let (send, recv) = tokio::sync::oneshot::channel();
    let state = session.atomic.clone();
    let id = session.id;
    session
        .view
        .with_webview(move |_| {
            if !current(&state, generation) {
                return;
            }
            let frame = FRAMES.with(|frames| {
                let mut frames = frames.borrow_mut();
                let active = frames
                    .get_mut(&id)
                    .filter(|active| active.generation == generation)?;
                active.prune();
                (!active.uncertain && active.entries.len() == 1).then(|| active.entries[0].clone())
            });
            let Some(frame) = frame.and_then(|frame| frame.cast::<ICoreWebView2Frame2>().ok())
            else {
                return;
            };
            let handler = ExecuteScriptCompletedHandler::create(Box::new(move |status, reply| {
                if status.is_ok() && reply.len() <= 2048 {
                    let _ = send.send(metrics(&reply));
                }
                Ok(())
            }));
            // The runtime returns null until its own ContentLoading event has fired.
            let _ = unsafe { frame.ExecuteScript(&HSTRING::from(PROBE), &handler) };
        })
        .ok()?;
    let result = tokio::time::timeout(Duration::from_millis(900), recv)
        .await
        .ok()?
        .ok()?;
    result.filter(|_| current(&session.atomic, generation))
}

fn metrics(reply: &str) -> Option<Value> {
    let raw: Value = serde_json::from_str(reply).ok()?;
    let seconds = |field: &str| {
        raw[field]
            .as_f64()
            .filter(|value| (0.0..=31_536_000.0).contains(value))
    };
    let time = seconds("currentTime")?;
    let duration = seconds("duration").filter(|value| *value > 0.0 && time <= *value + 0.5)?;
    let video = &raw["video"];
    let dimension = |field: &str| {
        video[field]
            .as_u64()
            .filter(|value| (1..=16_384).contains(value))
    };
    let count = |field: &str| {
        video[field]
            .as_u64()
            .filter(|value| *value <= 2_147_483_647)
    };
    Some(
        json!({"currentTime":time, "duration":duration, "paused":raw["paused"].as_bool()?,
        "ended":raw["ended"].as_bool()?, "video":{
            "width":dimension("width")?, "height":dimension("height")?,
            "readyState":video["readyState"].as_u64().filter(|value| *value <= 4)?,
            "bufferedAhead":video["bufferedAhead"].as_f64()
                .filter(|value| (0.0..=duration + 0.5).contains(value)).unwrap_or(0.0),
            "playbackRate":video["playbackRate"].as_f64()
                .filter(|value| (0.0..=16.0).contains(value)).unwrap_or(1.0),
            "totalFrames":count("totalFrames"), "droppedFrames":count("droppedFrames")
        }}),
    )
}

fn current(state: &GuestState, generation: u64) -> bool {
    !state.closed.load(Ordering::Acquire)
        && state.ready.load(Ordering::Acquire)
        && state.page_generation.load(Ordering::Acquire) == generation
}
