import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationBridge } from '../../electron/migrationBridge';
import type { AppPaths } from '../../electron/paths';
import type { UpdateService } from '../../electron/updater';

const stub = vi.hoisted(() => ({
  find: vi.fn(), download: vi.fn(), confirm: vi.fn(), spawn: vi.fn(), quit: vi.fn(),
  executable: 'C:\\Program Files\\AniVerse\\AniVerse.exe', resume: vi.fn(), pause: vi.fn(), exportWebsiteSessions: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getVersion: () => '9.2.4', getPath: () => stub.executable, quit: stub.quit },
  dialog: { showMessageBox: stub.confirm } }));
vi.mock('node:child_process', () => ({ spawn: stub.spawn }));
vi.mock('../../electron/migrationWebsiteSessions', () => ({ exportWebsiteSessions: stub.exportWebsiteSessions }));
vi.mock('../../electron/migrationRelease', () => ({ findMigrationOffer: stub.find, downloadMigrationInstaller: stub.download }));

describe.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('signed Windows Electron handoff', () => {
  let folder: string;
  let staging: string;
  let bridge: MigrationBridge;
  let paths: AppPaths;
  const evaluate = vi.fn();
  const window = { isDestroyed: () => false, webContents: { mainFrame: { executeJavaScript: evaluate } } } as unknown as BrowserWindow;

  beforeEach(async () => {
    vi.resetAllMocks();
    const base = path.resolve('test/cache/tauri-compat');
    await mkdir(base, { recursive: true });
    folder = await mkdtemp(path.join(base, 'legacy-handoff-'));
    staging = path.join(folder, 'candidate');
    paths = { dataDir: path.join(folder, 'profile'), configDir: path.join(folder, 'external config') } as AppPaths;
    await mkdir(paths.configDir);
    await writeFile(path.join(paths.configDir, 'streaming-sites.txt'), 'https://fixture.test/\r\n');
    bridge = new MigrationBridge(paths, {
      snapshot: () => ({ status: 'idle' }), pauseForMigration: stub.pause,
    } as unknown as UpdateService);
    stub.confirm.mockResolvedValue({ response: 1 });
    stub.pause.mockReturnValue(stub.resume);
    stub.find.mockResolvedValue({ offer: { version: '9.3.0' }, signed: { manifest: 'fixture' } });
    stub.download.mockImplementation(async () => {
      await mkdir(staging);
      return { staging, file: path.join(staging, 'AniVerse2-setup.exe') };
    });
    evaluate.mockResolvedValue(['open', 'midnight', 'list', 'grid', '123']);
  });

  afterEach(async () => {
    if (folder) await rm(folder, { recursive: true, force: true });
  });

  function launch(event: 'spawn' | 'error') {
    stub.spawn.mockImplementation(() => {
      const process = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => process.emit(event, new Error('failed to start fixture')));
      return process;
    });
  }

  it('stays available while there is no stable AniVerse2 release', async () => {
    stub.find.mockResolvedValue(null);
    await expect(bridge.start(window)).resolves.toBe('no-release');
    expect(stub.confirm).not.toHaveBeenCalled();
    expect(stub.download).not.toHaveBeenCalled();
    expect(stub.quit).not.toHaveBeenCalled();
  });

  it('keeps the original installation and only sends the encrypted archive to supported signed versions', async () => {
    stub.find.mockResolvedValue({ offer: { version: '3.0.4' }, signed: { manifest: 'old-fixture' } });
    launch('spawn');
    await expect(bridge.start(window)).resolves.toBe('starting');
    expect(stub.exportWebsiteSessions).not.toHaveBeenCalled();
    expect(stub.confirm.mock.calls[0]?.[1].detail).toContain('AniVerse stays installed');
    await mkdir(path.join(folder, 'next-attempt'));
    stub.download.mockResolvedValue({ staging: path.join(folder, 'next-attempt'), file: path.join(folder, 'setup.exe') });
    stub.find.mockResolvedValue({ offer: { version: '3.0.5' }, signed: { manifest: 'next-fixture' } });
    await expect(bridge.start(window)).resolves.toBe('starting');
    expect(stub.exportWebsiteSessions).toHaveBeenCalledExactlyOnceWith(paths.dataDir, path.join(folder, 'next-attempt'), expect.stringMatching(/^[a-f0-9-]{36}$/), []);
    expect(await readFile(path.join(paths.configDir, 'streaming-sites.txt'), 'utf8')).toBe('https://fixture.test/\r\n');
  });

  it('requires confirmation before downloading', async () => {
    stub.confirm.mockResolvedValue({ response: 0 });
    await expect(bridge.start(window)).resolves.toBe('cancelled');
    expect(stub.download).not.toHaveBeenCalled();
    expect(stub.quit).not.toHaveBeenCalled();
  });

  it('passes the active source folder and trusted app preferences to the candidate before exit', async () => {
    launch('spawn');
    await expect(bridge.start(window)).resolves.toBe('starting');
    const handoff = JSON.parse(await readFile(path.join(staging, 'electron-handoff.json'), 'utf8')) as Record<string, unknown>;
    expect(handoff).toMatchObject({ dataDir: paths.dataDir, configDir: paths.configDir, legacyPid: process.pid,
      legacyExecutable: stub.executable, legacyVersion: '9.2.4', preferences: { 'aniverse.desktop-theme': 'midnight', 'aniverse.historyView': 'list' } });
    expect(await readFile(path.join(paths.configDir, 'streaming-sites.txt'), 'utf8')).toBe('https://fixture.test/\r\n');
    expect(stub.spawn.mock.calls[0][2].env.ANIVERSE_ELECTRON_HANDOFF).toBe(path.join(staging, 'electron-handoff.json'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stub.quit).toHaveBeenCalledOnce();
    expect(stub.resume).not.toHaveBeenCalled();
  });

  it('leaves Electron running and restores regular updates when the installer fails to launch', async () => {
    launch('error');
    await expect(bridge.start(window)).rejects.toThrow('failed to start fixture');
    expect(stub.resume).toHaveBeenCalledOnce();
    expect(stub.quit).not.toHaveBeenCalled();
    await expect(stat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(paths.configDir, 'streaming-sites.txt'), 'utf8')).toBe('https://fixture.test/\r\n');
  });
});
