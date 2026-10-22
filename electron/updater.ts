import { app } from 'electron';
import { autoUpdater, type NsisUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../app/core/util';
import type { Settings, UpdateState } from '../app/shared/types';
import signing from '../config/signing.json';
import { checkUpdateSignature, readSignature } from './updateSignature';

export const RELEASES_URL = 'https://github.com/shiwamshoryasharma/AniVerse/releases';
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Self-update from GitHub Releases (electron-updater). The release carries the installer,
 * its blockmap and latest.yml; AniVerse compares versions, downloads only the changed blocks
 * when it can (differential download against the installed version's blockmap), checks the
 * download's code signature against the pinned certificate, and installs silently on restart
 * or quit. Only installed Windows builds update themselves.
 */
export class UpdateService {
  private state: UpdateState;
  private checking: Promise<void> | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private settings: () => Settings,
    private onState: (s: UpdateState) => void,
    private log: (message: string) => void,
  ) {
    const reason = disabledReason();
    this.state = { status: reason ? 'disabled' : 'idle', current: app.getVersion(), version: null, releaseDate: null, releaseUrl: null, progress: null, checkedAt: null, error: null, reason };
    if (reason) {
      log(`updates off: ${reason}`);
      return;
    }
    const updater = autoUpdater as NsisUpdater;
    updater.logger = { info: (m) => log(`${m}`), warn: (m) => log(`warn: ${m}`), error: (m) => log(`error: ${m}`), debug: () => undefined };
    updater.autoDownload = settings().updates.autoDownload;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.verifyUpdateCodeSignature = async (_publishers, file) => {
      const verdict = checkUpdateSignature(await readSignature(file), file, signing.updateSigners);
      log(verdict ? `signature rejected: ${verdict}` : `signature ok: ${path.basename(file)}`);
      return verdict;
    };

    updater.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    updater.on('update-available', (info: UpdateInfo) =>
      this.set({ status: updater.autoDownload ? 'downloading' : 'available', ...about(info), progress: null, error: null }),
    );
    updater.on('update-not-available', () => this.set({ status: 'not-available', version: null, releaseDate: null, releaseUrl: null, checkedAt: Date.now() }));
    updater.on('download-progress', (p: ProgressInfo) =>
      this.set({ status: 'downloading', progress: { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond } }),
    );
    updater.on('update-downloaded', (info: UpdateInfo) => this.set({ status: 'downloaded', ...about(info), progress: null, checkedAt: Date.now() }));
    updater.on('error', (err: Error) => this.set({ status: 'error', error: friendly(err), checkedAt: Date.now(), progress: null }));
  }

  snapshot(): UpdateState {
    return this.state;
  }

  /** Background checks: shortly after start-up, then every 6 hours (while automatic checks are on). */
  start() {
    if (this.state.status === 'disabled') return;
    const tick = () => {
      if (this.settings().updates.autoCheck && this.state.status !== 'downloaded' && this.state.status !== 'downloading') void this.check();
    };
    this.timers.push(setTimeout(tick, FIRST_CHECK_MS), setInterval(tick, CHECK_EVERY_MS));
    this.timers.forEach((t) => t.unref());
  }

  applySettings(s: Settings) {
    if (this.state.status !== 'disabled') autoUpdater.autoDownload = s.updates.autoDownload;
  }

  async check(): Promise<UpdateState> {
    if (this.state.status === 'disabled' || this.state.status === 'downloaded') return this.state;
    this.checking ??= autoUpdater
      .checkForUpdates()
      .then(() => undefined)
      .catch((err: Error) => this.set({ status: 'error', error: friendly(err), checkedAt: Date.now() }))
      .finally(() => (this.checking = null));
    await this.checking;
    return this.state;
  }

  async download(): Promise<UpdateState> {
    if (this.state.status !== 'available' && this.state.status !== 'error') return this.state;
    this.set({ status: 'downloading', progress: null, error: null });
    await autoUpdater.downloadUpdate().catch((err: Error) => this.set({ status: 'error', error: friendly(err) }));
    return this.state;
  }

  /** Quits, runs the downloaded installer silently and starts the new version. */
  install() {
    if (this.state.status !== 'downloaded') throw new AppError('invalid-input', 'No update has been downloaded yet.');
    this.log(`installing ${this.state.version} (restart requested)`);
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  }

  stop() {
    this.timers.forEach((t) => clearTimeout(t));
  }

  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }
}

function about(info: UpdateInfo): Pick<UpdateState, 'version' | 'releaseDate' | 'releaseUrl'> {
  return { version: info.version, releaseDate: info.releaseDate ?? null, releaseUrl: `${RELEASES_URL}/tag/v${info.version}` };
}

/** Why this copy can't update itself, or null when it can. */
function disabledReason(): string | null {
  if (process.platform !== 'win32') return 'Automatic updates are available for the Windows installer only.';
  if (!app.isPackaged) return 'This is a development build; it updates through git, not the installer.';
  if (process.env.PORTABLE_EXECUTABLE_DIR) return 'This is the portable copy. Download new versions from the releases page.';
  const feed = path.join(process.resourcesPath, 'app-update.yml');
  if (!existsSync(feed)) return 'This build has no update feed.';
  // electron-updater only checks signatures when the feed names a publisher: never install unchecked.
  if (!/^publisherName:/m.test(readFileSync(feed, 'utf8'))) return 'This build was not signed, so it cannot verify updates.';
  return null;
}

function friendly(err: Error): string {
  const m = err?.message ?? String(err);
  if (/net::ERR_|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(m)) return 'Couldn’t reach the update server. Check your connection and try again.';
  if (/latest\.yml/i.test(m)) return 'The newest release has no update information yet.';
  if (/not signed by the application owner|signature/i.test(m)) return `The downloaded update failed the signature check and was not installed. ${m.split('\n')[0]}`;
  if (/sha512 checksum mismatch/i.test(m)) return 'The download was damaged (checksum mismatch). It will be downloaded again.';
  return m.split('\n')[0].slice(0, 300);
}
