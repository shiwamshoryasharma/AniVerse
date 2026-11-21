#[derive(Clone, Debug, PartialEq)]
pub(super) struct Entry {
    pub(super) status: String,
    pub(super) progress: i32,
    pub(super) score: Option<f64>,
}

pub(super) struct Timed<'a> {
    pub(super) entry: Option<&'a Entry>,
    pub(super) at: i64,
}

pub(super) struct Target<'a> {
    pub(super) provider: &'a str,
    pub(super) entry: Option<Timed<'a>>,
    pub(super) last_sync: Option<i64>,
}

pub(super) struct Plan {
    pub(super) apply: Option<(Entry, i64)>,
    pub(super) winner: Option<usize>,
    pub(super) push: Vec<usize>,
}

pub(super) fn reconcile(local: Timed<'_>, targets: &[Target<'_>]) -> Plan {
    let winner =
        targets
            .iter()
            .enumerate()
            .fold(None, |winner: Option<(usize, i64)>, (index, target)| {
                let Some(timed) = target.entry.as_ref() else {
                    return winner;
                };
                if timed.at > winner.map_or(local.at, |(_, time)| time) {
                    Some((index, timed.at))
                } else {
                    winner
                }
            });
    let applied = winner.and_then(|(index, time)| {
        let remote = targets[index].entry.as_ref()?.entry?;
        let mut copied = remote.clone();
        copied.score = copied
            .score
            .or_else(|| local.entry.and_then(|entry| entry.score));
        (!local.entry.is_some_and(|entry| {
            same(&copied, entry, targets[index].provider) && entry.score == copied.score
        }))
        .then_some((copied, time))
    });
    let desired = applied.as_ref().map(|(entry, _)| entry).or(local.entry);
    let changed = winner.map_or(local.at, |(_, time)| time);
    let push = targets
        .iter()
        .enumerate()
        .filter_map(|(index, target)| {
            if winner.map(|(idx, _)| idx) == Some(index) {
                return None;
            }
            let remote = target.entry.as_ref().and_then(|timed| timed.entry);
            let needs_update = match (desired, remote) {
                (None, None) => false,
                (None, Some(_)) => true,
                (Some(desired), Some(known)) => !same(desired, known, target.provider),
                (Some(_), None) => target.last_sync.is_none_or(|last| changed > last),
            };
            needs_update.then_some(index)
        })
        .collect();
    Plan {
        apply: applied,
        winner: winner.map(|(index, _)| index),
        push,
    }
}

fn same(desired: &Entry, known: &Entry, provider: &str) -> bool {
    if desired.status != known.status || desired.progress != known.progress {
        return false;
    }
    let Some(left) = desired.score else {
        return true;
    };
    let factor = if provider == "mal" { 1.0 } else { 10.0 };
    known
        .score
        .is_some_and(|right| (left * factor).round() == (right * factor).round())
}
