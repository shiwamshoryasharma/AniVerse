import { ElectronBlocker } from '@ghostery/adblocker-electron';
import { ipcMain, net, type Session } from 'electron';
import { readFile, stat, writeFile } from 'node:fs/promises';
import type { AdblockStats } from '../app/shared/types';
import { errorMessage } from '../app/core/util';

const LIST_MAX_AGE_MS = 3 * 86400 * 1000;
// Cosmetic-filter preload shipped by Ghostery (resolved at runtime from node_modules).
const PRELOAD_PATH = require.resolve('@ghostery/adblocker-electron-preload');

/**
 * Ad, tracker, annoyance and self-promotion blocking for source sessions.
 * Ghostery's engine does the matching; this class wires it into each
 * partition itself (its built-in helper only supports one session).
 */
export class Adblocker {
  private blocker: ElectronBlocker | null = null;
  private loading: Promise<void> | null = null;
  private attached = new Map<Session, { sourceId: string; preloadId: string | null }>();
  private stats: AdblockStats = { enabled: true, ready: false, listsUpdatedAt: null, blocked: {}, popupsBlocked: {} };
  private dirty = false;

  constructor(
    private cachePath: string,
    private filtersPath: string,
    private emit: (stats: AdblockStats) => void,
  ) {
    setInterval(() => {
      if (!this.dirty) return;
      this.dirty = false;
      this.emit(this.snapshot());
    }, 2000).unref();
  }

  snapshot(): AdblockStats {
    return { ...this.stats, blocked: { ...this.stats.blocked }, popupsBlocked: { ...this.stats.popupsBlocked } };
  }

  setEnabled(enabled: boolean) {
    this.stats.enabled = enabled;
    this.dirty = true;
  }

  countPopup(sourceId: string) {
    this.stats.popupsBlocked[sourceId] = (this.stats.popupsBlocked[sourceId] ?? 0) + 1;
    this.dirty = true;
  }

  /** Loads cached filter lists (refreshing them when older than 3 days). */
  load(): Promise<void> {
    this.loading ??= this.init().catch((err) => {
      console.error('[adblock] failed to initialise:', errorMessage(err));
      this.loading = null;
    });
    return this.loading;
  }

  private async init() {
    const fresh = await stat(this.cachePath)
      .then((s) => Date.now() - s.mtimeMs < LIST_MAX_AGE_MS)
      .catch(() => false);
    const fetchImpl = (url: string) => net.fetch(url);
    const base = fresh
      ? await ElectronBlocker.fromPrebuiltFull(fetchImpl, { path: this.cachePath, read: readFile, write: writeFile })
      : await ElectronBlocker.fromPrebuiltFull(fetchImpl).then(async (engine) => {
          await writeFile(this.cachePath, engine.serialize()).catch(() => undefined);
          return engine;
        });
    // config/filters.txt is applied as a diff: merging a separately parsed engine
    // fails because it lacks the prebuilt engine's redirect resources.
    const custom = await readFile(this.filtersPath, 'utf8').catch(() => '');
    const added = custom
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('!') && !line.startsWith('['));
    if (added.length) base.updateFromDiff({ added });
    this.blocker = base;
    this.stats.ready = true;
    this.stats.listsUpdatedAt = await stat(this.cachePath)
      .then((s) => s.mtimeMs)
      .catch(() => Date.now());

    // Cosmetic filtering IPC is registered once for all sessions.
    ipcMain.removeHandler('@ghostery/adblocker/inject-cosmetic-filters');
    ipcMain.removeHandler('@ghostery/adblocker/is-mutation-observer-enabled');
    ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, url: string, msg) => {
      if (!this.stats.enabled || !this.isAttachedSender(event.sender.session)) return;
      return this.blocker?.onInjectCosmeticFilters(event, url, msg);
    });
    ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (event) => this.blocker?.onIsMutationObserverEnabled(event) ?? false);

    // Sessions that asked for blocking before the lists were ready.
    for (const [ses, info] of this.attached) this.hook(ses, info.sourceId);
    this.dirty = true;
  }

  private isAttachedSender(ses: Session) {
    return this.attached.has(ses);
  }

  attach(ses: Session, sourceId: string) {
    if (!this.attached.has(ses)) this.attached.set(ses, { sourceId, preloadId: null });
    if (this.blocker) this.hook(ses, sourceId);
    else void this.load();
  }

  detach(ses: Session) {
    const info = this.attached.get(ses);
    if (!info) return;
    ses.webRequest.onBeforeRequest(null);
    ses.webRequest.onHeadersReceived(null);
    if (info.preloadId) ses.unregisterPreloadScript(info.preloadId);
    this.attached.delete(ses);
  }

  private hook(ses: Session, sourceId: string) {
    const blocker = this.blocker!;
    const info = this.attached.get(ses)!;
    if (!info.preloadId) info.preloadId = ses.registerPreloadScript({ type: 'frame', filePath: PRELOAD_PATH });
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      if (!this.stats.enabled) return callback({});
      blocker.onBeforeRequest(details, (response) => {
        if (response.cancel || response.redirectURL) {
          this.stats.blocked[sourceId] = (this.stats.blocked[sourceId] ?? 0) + 1;
          this.dirty = true;
        }
        callback(response);
      });
    });
    ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      if (!this.stats.enabled) return callback({});
      blocker.onHeadersReceived(details, callback);
    });
  }
}
