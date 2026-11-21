use std::{collections::HashMap, sync::Mutex};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Lease {
    pub(super) token: Uuid,
    pub(super) media_id: i64,
}

#[derive(Default)]
pub(super) struct Registry(Mutex<HashMap<Uuid, i64>>);

impl Registry {
    pub(super) fn issue(&self, media_id: i64) -> Option<Lease> {
        if !(1..=i32::MAX as i64).contains(&media_id) {
            return None;
        }
        let mut entries = self.0.lock().ok()?;
        if entries.len() >= 64 {
            return None;
        }
        let token = Uuid::new_v4();
        entries.insert(token, media_id);
        Some(Lease { token, media_id })
    }

    pub(super) fn browse(&self) -> Option<Lease> {
        let mut entries = self.0.lock().ok()?;
        if let Some((&token, _)) = entries.iter().find(|(_, media)| **media == 0) {
            return Some(Lease { token, media_id: 0 });
        }
        if entries.len() >= 64 {
            return None;
        }
        let token = Uuid::new_v4();
        entries.insert(token, 0);
        Some(Lease { token, media_id: 0 })
    }

    pub(super) fn resolve(&self, partition: &str, source: &str) -> Option<Lease> {
        let token = partition
            .strip_prefix("private-")?
            .strip_suffix(source)?
            .strip_suffix('-')?;
        let token = Uuid::parse_str(token).ok()?;
        let media_id = *self.0.lock().ok()?.get(&token)?;
        Some(Lease { token, media_id })
    }

    pub(super) fn contains(&self, lease: Lease) -> bool {
        self.0
            .lock()
            .is_ok_and(|entries| entries.get(&lease.token) == Some(&lease.media_id))
    }

    pub(super) fn revoke(&self, token: Uuid) {
        if let Ok(mut entries) = self.0.lock() {
            entries.remove(&token);
        }
    }

    pub(super) fn clear(&self) {
        if let Ok(mut entries) = self.0.lock() {
            entries.clear();
        }
    }
}

#[cfg(test)]
#[path = "../../../../test/tauri-compat/private-lease.rs"]
mod tests;
