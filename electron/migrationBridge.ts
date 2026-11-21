import { app, dialog, type BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import type { SourceInfo } from '../app/shared/types';
import type { AppPaths } from './paths';
import { compareMigrationVersions } from './migrationVerification';
import { exportWebsiteSessions } from './migrationWebsiteSessions';
import type { UpdateService } from './updater';
import { downloadMigrationInstaller, findMigrationOffer } from './migrationRelease';

const preferenceKeys = ['aniverse.rail', 'aniverse.desktop-theme', 'aniverse.historyView', 'aniverse.scheduleView', 'aniverse.latestSeen'];

async function preferences(window: BrowserWindow) {
  const script = `(() => {
    if (window !== window.top || location.protocol !== 'app:' || location.hostname !== 'aniverse') return null;
    return ${JSON.stringify(preferenceKeys)}.map(key => localStorage.getItem(key));
  })()`;
  const values: unknown = await window.webContents.mainFrame.executeJavaScript(script);
  if (!Array.isArray(values) || values.length !== preferenceKeys.length ||
      values.some((value) => value !== null && (typeof value !== 'string' || value.length > 128))) {
    throw new Error('Could not read the current AniVerse interface settings.');
  }
  return Object.fromEntries(preferenceKeys.flatMap((key, index) => values[index] === null ? [] : [[key, values[index]]]));
}

export class MigrationBridge {
  private running = false;

  constructor(
    private readonly paths: AppPaths,
    private readonly updates: UpdateService,
    private readonly websiteSources: () => readonly SourceInfo[] = () => [],
  ) {}

  async start(window: BrowserWindow | null): Promise<'no-release' | 'cancelled' | 'starting'> {
    if (process.platform !== 'win32' || process.arch !== 'x64' || this.updates.snapshot().status === 'disabled' ||
        !window || window.isDestroyed()) throw new Error('AniVerse2 migration requires the signed Windows x64 installer.');
    if (this.running) throw new Error('An AniVerse2 update is already running.');
    this.running = true;
    try {
      const candidate = await findMigrationOffer(app.getVersion());
      if (!candidate) return 'no-release';
      const confirmation = await dialog.showMessageBox(window, {
        type: 'question', title: 'Update AniVerse to AniVerse2',
        message: `Install AniVerse2 ${candidate.offer.version}?`,
        detail: 'AniVerse will close while setup copies your saved sources, library, history, and settings. AniVerse stays installed and you can choose whether to remove it later.',
        buttons: ['Cancel', 'Download and update'], cancelId: 0, defaultId: 0, noLink: true,
      });
      if (confirmation.response !== 1) return 'cancelled';
      const { staging, file } = await downloadMigrationInstaller(candidate, path.join(this.paths.dataDir, 'windows-migration'));
      try {
        const handoff = path.join(staging, 'electron-handoff.json');
        const descriptor = {
          schema: 1, nonce: randomUUID(), legacyPid: process.pid, legacyVersion: app.getVersion(),
          legacyExecutable: app.getPath('exe'), dataDir: this.paths.dataDir, configDir: this.paths.configDir,
          preferences: await preferences(window), signedRelease: candidate.signed,
        };
        if (compareMigrationVersions(candidate.offer.version, '3.0.5') >= 0) {
          await exportWebsiteSessions(this.paths.dataDir, staging, descriptor.nonce, this.websiteSources());
        }
        const marker = await open(handoff, 'wx', 0o600);
        try {
          await marker.writeFile(JSON.stringify(descriptor), 'utf8');
          await marker.sync();
        } finally {
          await marker.close();
        }
        const resume = this.updates.pauseForMigration();
        try {
          const child = spawn(file, [], {
            cwd: staging, detached: true, stdio: 'ignore',
            env: { ...process.env, ANIVERSE_ELECTRON_HANDOFF: handoff },
          });
          await new Promise<void>((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', reject);
          });
          child.unref();
        } catch (error) {
          resume();
          throw error;
        }
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      setImmediate(() => app.quit());
      return 'starting';
    } finally {
      this.running = false;
    }
  }
}
