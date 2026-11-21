use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

static INCOGNITO: AtomicBool = AtomicBool::new(false);
static EPOCH: AtomicU64 = AtomicU64::new(0);

pub(crate) fn active() -> bool {
    INCOGNITO.load(Ordering::Acquire)
}
pub(crate) fn set_active(on: bool) {
    INCOGNITO.store(on, Ordering::Release);
    advance();
}

pub(crate) fn epoch() -> u64 {
    EPOCH.load(Ordering::Acquire)
}
pub(crate) fn advance() {
    EPOCH.fetch_add(1, Ordering::AcqRel);
}
