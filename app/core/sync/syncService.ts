import type { AccountInfo, MediaSnapshot, Provider, Settings, SyncReport, SyncStatusEvent } from '../../shared/types';
import type { Store, SyncOp } from '../db/store';
import { AppError, errorMessage, nowSec } from '../util';
import type { PullResult, RemoteEntry, SyncProvider } from './providers';
import { reconcile, type EntryState } from './reconcile';

export const PROVIDERS: Provider[] = ['anilist', 'mal'];
const NAME: Record<Provider, string> = { anilist: 'AniList', mal: 'MyAnimeList' };

/** Access tokens for the sync service (owned by the Electron layer: OAuth, refresh, reconnect state). */
export interface TokenSource {
  /** A valid access token (refreshed ahead of expiry where the service supports it). */
  token(provider: Provider): Promise<string>;
  /** The service rejected a token: returns a fresh one to retry with, or null (don't retry). */
  rejected(provider: Provider): Promise<string | null>;
  /** Sign-in availability for the account list. */
  status(provider: Provider): { configured: boolean; signingIn: boolean; secureStorage: boolean };
}

/**
 * Local-first list sync. Every change is written to SQLite immediately, then
 * queued per connected service and pushed with exponential backoff, so progress
 * survives offline periods and restarts. Two-way mode also pulls each service's
 * list and reconciles it with AniVerse's (newest edit wins, see reconcile.ts).
 */
export class SyncService {
  private running = new Set<Provider>();
  private syncing: Promise<SyncReport> | null = null;

  constructor(
    private store: Store,
    private providers: Record<Provider, SyncProvider>,
    private settings: () => Settings,
    private emit: (e: SyncStatusEvent) => void,
    private tokens: TokenSource,
  ) {}

  accounts(): AccountInfo[] {
    return PROVIDERS.map((provider) => {
      const acc = this.store.getAccount(provider);
      const status = this.tokens.status(provider);
      return {
        provider,
        connected: !!acc,
        clientIdConfigured: status.configured,
        signingIn: status.signingIn,
        needsReconnect: !!acc?.needsReconnect,
        userName: acc?.userName ?? null,
        avatar: acc?.avatar ?? null,
        expiresAt: acc?.expiresAt ?? null,
        lastSyncAt: acc?.lastSyncAt ?? null,
        lastError: acc?.lastError ?? (acc && !status.secureStorage ? 'No secure credential store on this system: you’ll need to reconnect after restarting AniVerse.' : null),
        pending: acc ? this.store.pendingSync(provider) : 0,
      };
    });
  }

  /** Connected and not waiting for the user to reconnect. */
  usable(provider: Provider): boolean {
    if(this.store.isIncognito())return false;
    const acc = this.store.getAccount(provider);
    return !!acc && !acc.needsReconnect;
  }

  /** Queues a change for every connected service and pushes it in the background. */
  queue(op: SyncOp, media: MediaSnapshot, favourite?: boolean) {
    if (!this.settings().accounts.autoSync || this.store.isPrivate(media.id)) return;
    for (const provider of PROVIDERS) {
      if (!this.store.getAccount(provider)) continue;
      if (provider === 'mal' && (op === 'favourite' || !media.idMal)) continue;
      this.store.enqueueSync(provider, op, { mediaId: media.id, idMal: media.idMal, ...(op === 'favourite' ? { favourite: !!favourite } : {}) });
      if (this.usable(provider)) void this.flush(provider);
    }
  }

  /** Runs `fn` with a token; on rejection retries once with a refreshed token, else marks the session for reconnect. */
  private async authed<T>(provider: Provider, fn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.tokens.token(provider);
    try {
      return await fn(token);
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'unauthorised')) throw err;
      const fresh = await this.tokens.rejected(provider);
      if (!fresh) throw err;
      return fn(fresh);
    }
  }

  /** Pushes due queue items for one service. */
  async flush(provider: Provider): Promise<{ pushed: number; failed: number; errors: string[] }> {
    const result = { pushed: 0, failed: 0, errors: [] as string[] };
    if (this.running.has(provider) || !this.usable(provider)) return result;
    const account = this.store.getAccount(provider)!;
    this.running.add(provider);
    try {
      if (!this.store.dueSyncJobs(provider, nowSec(), 1).length) return result;
      this.emit({ provider, state: 'syncing', message: `Syncing ${this.store.pendingSync(provider)} change(s)…` });
      // Batches of 25 until nothing is due (failed jobs are rescheduled into the future).
      for (let batch = 0; batch < 40 && this.usable(provider); batch++) {
        const jobs = this.store.dueSyncJobs(provider);
        if (!jobs.length) break;
        for (const job of jobs) {
          if(this.store.isIncognito())break;
          if(this.store.isPrivate(job.payload.mediaId)){this.store.completeSyncJob(job.id);continue;}
          try {
            let privateBeforeSend=false;
            await this.authed(provider, (token) => {
              if(this.store.isPrivate(job.payload.mediaId)){privateBeforeSend=true;return Promise.resolve('skipped' as const);}
              if (job.op === 'favourite') return this.providers[provider].pushFavourite(token, job.payload, !!job.payload.favourite);
              // Push AniVerse's entry as it is *now*: later edits since queuing are included.
              const local = this.store.getLibraryEntry(job.payload.mediaId);
              const entry: EntryState | null = local ? { status: local.status, progress: local.progress, score: local.score } : null;
              return this.providers[provider].pushEntry(token, job.payload, entry, account.userId);
            });
            if(!this.store.isIncognito())this.store.completeSyncJob(job.id);
            if(!privateBeforeSend)result.pushed++;
          } catch (err) {
            result.failed++;
            result.errors.push(errorMessage(err));
            this.store.failSyncJob(job.id, errorMessage(err), job.attempts);
            if (!this.usable(provider)) break; // session gone: keep the rest queued for after reconnecting
          }
        }
      }
      this.store.patchAccount(provider, { lastError: result.errors[0] ?? null });
      this.emit({
        provider,
        state: result.failed ? 'error' : 'ok',
        message: result.failed ? `${result.failed} change(s) will retry: ${result.errors[0]}` : `Synced ${result.pushed} change(s) to ${NAME[provider]}.`,
      });
    } catch (err) {
      result.errors.push(errorMessage(err));
      this.store.patchAccount(provider, { lastError: errorMessage(err) });
      this.emit({ provider, state: 'error', message: errorMessage(err) });
    } finally {
      this.running.delete(provider);
    }
    return result;
  }

  /**
   * Manual / scheduled sync for one service or all. Two-way mode pulls the
   * lists, reconciles them with AniVerse, then pushes; otherwise only pending
   * changes are pushed. Concurrent calls share one run.
   */
  sync(only: Provider | null = null): Promise<SyncReport> {
    this.syncing ??= this.run(only).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async run(only: Provider | null): Promise<SyncReport> {
    const report: SyncReport = { pushed: 0, failed: 0, pulled: 0, resolved: 0, errors: [] };
    const selected = PROVIDERS.filter((p) => (!only || p === only) && this.usable(p));
    const startedAt = nowSec();
    const pulled = new Map<Provider, PullResult>();
    if (this.settings().accounts.twoWay) {
      for (const provider of selected) {
        if(this.store.isIncognito())break;
        const account = this.store.getAccount(provider)!;
        try {
          this.emit({ provider, state: 'syncing', message: `Fetching your ${NAME[provider]} list…` });
          pulled.set(provider, await this.authed(provider, (token) => this.providers[provider].pull(token, account.userId ?? 0)));
        } catch (err) {
          report.errors.push(`${NAME[provider]}: ${errorMessage(err)}`);
          this.store.patchAccount(provider, { lastError: errorMessage(err) });
          this.emit({ provider, state: 'error', message: errorMessage(err) });
        }
      }
      if (pulled.size && !this.store.isIncognito()) this.merge(pulled, report);
    }
    for (const provider of selected) {
      if(this.store.isIncognito())break;
      const pushed = await this.flush(provider);
      report.pushed += pushed.pushed;
      report.failed += pushed.failed;
      report.errors.push(...pushed.errors.map((e) => `${NAME[provider]}: ${e}`));
      // "Last sync" marks a completed reconcile; edits after `startedAt` count as newer next time.
      if (pulled.has(provider) || !this.settings().accounts.twoWay) this.store.patchAccount(provider, { lastSyncAt: startedAt });
      this.emit({ provider, state: report.errors.length ? 'error' : 'ok', message: report.errors[0] ?? `${NAME[provider]} is up to date.` });
    }
    return report;
  }

  /** Reconciles every title AniVerse or a pulled service knows about. */
  private merge(pulled: Map<Provider, PullResult>, report: SyncReport) {
    const targets = [...pulled.keys()];
    const remote = new Map<Provider, Map<number, RemoteEntry>>();
    const media = new Map<number, MediaSnapshot>();
    for (const [provider, result] of pulled) {
      remote.set(provider, new Map(result.entries.map((e) => [e.media.id, e])));
      for (const e of result.entries) if (!media.has(e.media.id)) media.set(e.media.id, e.media);
    }
    const lastSyncAt = Object.fromEntries(targets.map((p) => [p, this.store.getAccount(p)?.lastSyncAt ?? null]));
    const ids = new Set<number>([...this.store.libraryIds(), ...this.store.listTombstones().map((t) => t.mediaId), ...media.keys()]);

    this.store.tx(() => {
      for (const id of ids) {
        if(this.store.isPrivate(id))continue;
        const local = this.store.getLibraryEntry(id);
        const snapshot = local?.media ?? media.get(id);
        if (!snapshot) continue;
        const can = targets.filter((p) => p !== 'mal' || !!snapshot.idMal || remote.get('mal')?.has(id));
        if (!can.length) continue;
        const remotes: Partial<Record<Provider, { state: EntryState; updatedAt: number }>> = {};
        for (const p of can) {
          const r = remote.get(p)?.get(id);
          if (r) remotes[p] = { state: { status: r.status, progress: r.progress, score: r.score }, updatedAt: r.updatedAt };
        }
        const plan = reconcile({
          local: local ? { state: { status: local.status, progress: local.progress, score: local.score }, updatedAt: local.updatedAt } : { state: null, updatedAt: this.store.getTombstone(id) ?? 0 },
          remotes,
          targets: can,
          lastSyncAt,
          pendingLocal: can.some((p) => this.store.hasSyncJob(p, 'entry', id)),
        });
        if (plan.apply) {
          this.store.setLibraryEntry(snapshot, plan.apply.state.status, plan.apply.state.progress, plan.apply.state.score, plan.apply.updatedAt);
          report.pulled++;
        }
        for (const p of plan.drop) this.store.dropSyncJob(p, 'entry', id);
        for (const p of plan.push) this.store.enqueueSync(p, 'entry', { mediaId: id, idMal: snapshot.idMal });
        if (plan.conflict) report.resolved++;
      }
      for (const fav of pulled.get('anilist')?.favourites ?? []) {
        if (!this.store.isPrivate(fav.id) && !this.store.isFavourite(fav.id)) {
          this.store.setFavourite(fav, true);
          report.pulled++;
        }
      }
    });
  }
}
