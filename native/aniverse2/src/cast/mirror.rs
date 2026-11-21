use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::watch;
use uuid::Uuid;

const MAX_JPEG: usize = 288 * 1024;
const FRAME_TTL: Duration = Duration::from_secs(20);

pub(crate) struct Ingress {
    ticket: Uuid,
    frame: Mutex<Frames>,
    stopped: watch::Sender<bool>,
    cancel: AtomicBool,
}

struct Frames {
    next: u64,
    pending: Option<Frame>,
    accepted: Option<Frame>,
    last: Instant,
}

#[derive(Clone)]
pub(super) struct Frame {
    pub(super) sequence: u64,
    pub(super) jpeg: Arc<[u8]>,
}

impl Ingress {
    pub(super) fn new() -> Self {
        let (stopped, _) = watch::channel(false);
        Self {
            ticket: Uuid::new_v4(),
            frame: Mutex::new(Frames {
                next: 1,
                pending: None,
                accepted: None,
                last: Instant::now(),
            }),
            stopped,
            cancel: AtomicBool::new(false),
        }
    }

    pub(crate) fn ticket(&self) -> Uuid {
        self.ticket
    }

    pub(crate) fn offer(&self, jpeg_base64: &str) -> Option<u64> {
        if self.is_closed()
            || !jpeg_base64.starts_with("/9j/")
            || jpeg_base64.len() > MAX_JPEG * 4 / 3
        {
            return None;
        }
        let jpeg = STANDARD.decode(jpeg_base64).ok()?;
        if jpeg.len() > MAX_JPEG
            || !jpeg.starts_with(&[0xff, 0xd8, 0xff])
            || !jpeg.ends_with(&[0xff, 0xd9])
        {
            return None;
        }
        let mut frames = self.frame.lock().ok()?;
        if self.is_closed() {
            return None;
        }
        let sequence = frames.next;
        frames.next = sequence.checked_add(1)?;
        frames.pending = Some(Frame {
            sequence,
            jpeg: jpeg.into(),
        });
        Some(sequence)
    }

    pub(super) fn acknowledge(&self, sequence: u64) -> bool {
        let Ok(mut frames) = self.frame.lock() else {
            return false;
        };
        if self.is_closed()
            || sequence == 0
            || sequence >= frames.next
            || frames
                .accepted
                .as_ref()
                .is_some_and(|frame| sequence <= frame.sequence)
        {
            return false;
        }
        if frames
            .pending
            .as_ref()
            .is_some_and(|frame| frame.sequence == sequence)
        {
            frames.accepted = frames.pending.take();
            frames.last = Instant::now();
        }
        // A late acknowledgment may refer to a frame superseded by the latest one.
        true
    }

    pub(super) fn latest(&self, after: u64) -> Option<Frame> {
        let frames = self.frame.lock().ok()?;
        if self.is_closed() {
            return None;
        }
        frames
            .accepted
            .as_ref()
            .filter(|frame| frame.sequence > after)
            .cloned()
    }

    pub(super) fn expired(&self) -> bool {
        self.frame
            .lock()
            .map_or(true, |frames| frames.last.elapsed() > FRAME_TTL)
    }

    pub(super) fn cancellation(&self) -> &AtomicBool {
        &self.cancel
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }

    pub(crate) async fn closed(&self) {
        let mut stopped = self.stopped.subscribe();
        let _ = stopped.wait_for(|closed| *closed).await;
    }

    pub(crate) fn close(&self) {
        if self.cancel.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Ok(mut frames) = self.frame.lock() {
            frames.pending = None;
            frames.accepted = None;
        }
        self.stopped.send_replace(true);
    }
}
