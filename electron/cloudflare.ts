import { BrowserWindow, type Session } from 'electron';
import { isChallengeTitle } from '../app/core/net/cloudflare';
import { AppError } from '../app/core/util';
import type { CloudflareEvent } from '../app/shared/types';

const AUTO_WAIT_MS = 9000;
const USER_WAIT_MS = 180000;

/**
 * Runs a Cloudflare challenge inside a real Chromium window that shares the
 * source's isolated session. Non-interactive challenges complete on their own
 * (the window stays hidden); interactive ones are shown to the user, who
 * completes them. The resulting clearance cookie lives in that session only.
 * Nothing here clicks, solves or fingerprints on the user's behalf.
 */
export class CloudflareSolver {
  private pending = new Map<string, Promise<void>>();

  constructor(
    private parent: () => BrowserWindow | null,
    private emit: (e: CloudflareEvent) => void,
    /** False in automated runs: interactive checks are reported but never shown. */
    private canShow = true,
  ) {}

  solve(sourceId: string, sourceName: string, ses: Session, url: string): Promise<void> {
    const running = this.pending.get(sourceId);
    if (running) return running;
    const job = this.run(sourceId, sourceName, ses, url).finally(() => this.pending.delete(sourceId));
    this.pending.set(sourceId, job);
    return job;
  }

  private run(sourceId: string, sourceName: string, ses: Session, url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const parent = this.parent();
      const win = new BrowserWindow({
        show: false,
        width: 480,
        height: 640,
        parent: parent ?? undefined,
        modal: false,
        title: `Verify — ${sourceName}`,
        autoHideMenuBar: true,
        backgroundColor: '#0b0c10',
        webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      let settled = false;
      let shown = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(showTimer);
        clearTimeout(giveUp);
        if (!win.isDestroyed()) win.destroy();
        if (err) {
          this.emit({ sourceId, state: 'failed', message: err.message });
          reject(err);
        } else {
          this.emit({ sourceId, state: 'cleared', message: `${sourceName} verified.` });
          resolve();
        }
      };

      const check = async () => {
        if (win.isDestroyed() || win.webContents.isLoading()) return;
        const title = win.webContents.getTitle();
        if (!title || isChallengeTitle(title)) return;
        const cookies = await ses.cookies.get({ name: 'cf_clearance' }).catch(() => []);
        // A page that is no longer the interstitial counts as cleared even
        // when the site does not set cf_clearance (e.g. a passive check).
        if (cookies.length || !/cloudflare/i.test(title)) finish();
      };

      this.emit({ sourceId, state: 'checking', message: `Checking ${sourceName} with Cloudflare…` });
      const poll = setInterval(() => void check(), 800);
      const showTimer = setTimeout(() => {
        if (settled || win.isDestroyed()) return;
        if (this.canShow) {
          shown = true;
          win.show();
          win.focus();
        }
        this.emit({ sourceId, state: 'needs-user', message: `${sourceName} needs you to confirm you are human. Complete the check in the window that opened.` });
      }, AUTO_WAIT_MS);
      const giveUp = setTimeout(() => finish(new AppError('cloudflare', `${sourceName}: verification timed out.`)), USER_WAIT_MS);
      win.on('closed', () => finish(new AppError('cloudflare', shown ? `${sourceName}: verification window closed.` : `${sourceName}: verification failed.`)));
      win.webContents.on('did-finish-load', () => void check());
      win.loadURL(url).catch(() => undefined);
    });
  }
}
