import type { ListStatus, Provider } from '../../shared/types';

/** One list entry as AniVerse and the services see it (score 0–10, null = not scored). */
export interface EntryState {
  status: ListStatus;
  progress: number;
  score: number | null;
}

/** An entry and when it was last edited. `state: null` = removed from the list (tombstone) or never added (updatedAt 0). */
export interface Timed {
  state: EntryState | null;
  updatedAt: number;
}

export interface ReconcileInput {
  local: Timed;
  /** Entries currently on each service (absent = not on that service's list). */
  remotes: Partial<Record<Provider, { state: EntryState; updatedAt: number }>>;
  /** Services taking part (connected, pulled successfully, able to hold this title). */
  targets: Provider[];
  /** When each service was last reconciled; null = never. */
  lastSyncAt: Partial<Record<Provider, number | null>>;
  /** AniVerse has an unsent change for this title. */
  pendingLocal: boolean;
}

export interface ReconcileResult {
  /** Write this service entry into AniVerse. */
  apply: { from: Provider; state: EntryState; updatedAt: number } | null;
  /** Services whose entry must be made to match AniVerse (queued push; no local entry = remove). */
  push: Provider[];
  /** Services whose queued push is stale because their own newer edit won. */
  drop: Provider[];
  /** AniVerse and a service had both changed; the newer edit won. */
  conflict: boolean;
}

/**
 * Whether `want` is already stored as `have` on `provider`. MyAnimeList keeps
 * whole-number scores; AniVerse never clears a service's score just because it
 * has none locally.
 */
export function sameEntry(want: EntryState, have: EntryState, provider: Provider): boolean {
  if (want.status !== have.status || want.progress !== have.progress) return false;
  if (want.score === null) return true;
  if (have.score === null) return false;
  return provider === 'mal' ? Math.round(want.score) === Math.round(have.score) : Math.round(want.score * 10) === Math.round(have.score * 10);
}

/**
 * Two-way merge for one title. The newest edit wins (ties keep AniVerse's
 * version, which is usually the same edit). A service's newer edit replaces an
 * unsent local change instead of being overwritten by it, and the winning
 * version is then pushed to the other services. A title missing from a service
 * is only pushed there if it changed after that service's last sync, so a
 * removal made on the service isn't undone.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { local, remotes, targets } = input;
  let winner: { from: Provider | null; state: EntryState | null; updatedAt: number } = { from: null, ...local };
  for (const p of targets) {
    const r = remotes[p];
    if (r && r.updatedAt > winner.updatedAt) winner = { from: p, state: r.state, updatedAt: r.updatedAt };
  }

  let apply: ReconcileResult['apply'] = null;
  let final = local.state;
  if (winner.from && winner.state) {
    // A service without a score keeps AniVerse's score rather than erasing it.
    const state = { ...winner.state, score: winner.state.score ?? local.state?.score ?? null };
    final = state;
    if (!local.state || !sameEntry(state, local.state, winner.from) || local.state.score !== state.score) apply = { from: winner.from, state, updatedAt: winner.updatedAt };
  }

  const push: Provider[] = [];
  for (const p of targets) {
    if (p === winner.from) continue;
    const r = remotes[p];
    if (!final) {
      if (r) push.push(p); // removed in AniVerse after the service's last edit
    } else if (r) {
      if (!sameEntry(final, r.state, p)) push.push(p);
    } else {
      const last = input.lastSyncAt[p] ?? null;
      if (last === null || winner.updatedAt > last) push.push(p);
    }
  }

  return {
    apply,
    push,
    drop: winner.from ? [winner.from] : [],
    conflict: !!winner.from && input.pendingLocal && !!apply,
  };
}
