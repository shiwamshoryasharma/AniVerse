import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const withHandoff = process.env.ANIVERSE2_CHECK_HANDOFF === '1';
const cache = path.resolve('test/cache/aniverse2');
await mkdir(cache, { recursive: true });
const run = await mkdtemp(path.join(cache, 'desktop-'));
const legacy = path.join(run, 'legacy');
const profile = path.join(run, 'profile');
await mkdir(legacy);
await mkdir(profile);
const bundle = path.join(run, 'seed.cjs');
await build({ stdin: { contents: 'export { Store } from "./app/core/db/store";', resolveDir: process.cwd() }, outfile: bundle,
  platform: 'node', format: 'cjs', bundle: true, external: ['node:sqlite'] });
const { Store } = createRequire(import.meta.url)(bundle);
const database = path.join(legacy, 'aniverse.db');
const store = new Store(database);
const media = { id: 743, idMal: null, title: 'Saved AniVerse fixture', cover: '', banner: null, format: 'TV', episodes: 8 };
const hidden = { ...media, id: 744, title: 'Private history fixture' };
store.setKv('settings', { profile: { name: 'Saved profile' }, appearance: { style: 'aurora' }, player: { volume: 0.48 } });
store.setKv('windows:mp4-download-folder', 'D:/Saved video location');
store.patchSourceOverride('sample-test', { name: 'Saved custom source' });
store.saveProgress({ media, episode: 3, position: 83, duration: 720, sourceId: 'sample-test' }, 0.85);
store.saveProgress({ media: hidden, episode: 1, position: 18, duration: 720, sourceId: 'sample-test' }, 0.85);
store.setTitlePrivate(hidden.id, true);
store.setLibraryEntry(media, 'CURRENT', 2);
store.setFavourite(media, true);
store.close();
const checksum = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const initialHash = await checksum(database);

const sites = '\uFEFF# Saved source comments\r\n1. https://www.sample.test/catalogue/\r\nhttps://sample.test/alternate\r\nhttps://www.youtube.com/@Example\r\n';
const preferences = { 'aniverse.historyView': 'list', 'aniverse.rail': 'open' };
const config = withHandoff ? path.join(run, 'custom config') : path.join(profile, 'config');
await mkdir(config);
await writeFile(path.join(config, 'streaming-sites.txt'), sites);
if (!withHandoff) {
  await copyFile(database, path.join(profile, 'aniverse.db'));
  await writeFile(path.join(profile, 'renderer-preferences.json'), JSON.stringify(preferences));
}

const temporaryListener = createServer().listen(0, '127.0.0.1');
await once(temporaryListener, 'listening');
const port = temporaryListener.address().port;
await new Promise((resolve, reject) => temporaryListener.close((error) => error ? reject(error) : resolve()));
const endpoint = 'http://127.0.0.1:' + port;
const exe = path.resolve(process.env.ANIVERSE2_TEST_EXE ||
  'test/cache/aniverse2/aniverse2-isolated-test.exe');
const launchEnv = {
  ...process.env, ANIVERSE2_TEST_PROFILE: profile, WEBVIEW2_USER_DATA_FOLDER: path.join(profile, 'webview'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-address=127.0.0.1 --remote-debugging-port=' + port,
  TEMP: run, TMP: run, TMPDIR: run,
};
delete launchEnv.ANIVERSE_ELECTRON_HANDOFF;
const staged = withHandoff ? path.join(profile, 'profile-data') : profile;
const nonce = randomUUID();
if (withHandoff) {
  const marker = await prepareHandoffFixture({ run, exe, profile, legacy, preferences, nonce, launchEnv });
  const prepared = spawnSync(exe, ['--prepare-legacy-profile'], {
    windowsHide: true, timeout: 60000, env: { ...launchEnv, ANIVERSE_ELECTRON_HANDOFF: marker },
  });
  assert.equal(prepared.status, 0, prepared.stderr?.toString());
  launchEnv.ANIVERSE2_TEST_PREPARED_MARKER = marker;
}
const child = spawn(exe, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: launchEnv });
let output = '', browser, launchError;
child.on('error', (error) => { launchError = error; });
child.stdout.on('data', (bytes) => { output += bytes; });
child.stderr.on('data', (bytes) => { output += bytes; });
const exited = once(child, 'exit').catch(() => undefined);
const report = { passed: false, tests: {} };
try {
  for (let i = 0; i < 180 && child.exitCode === null && !launchError; i++) {
    try {
      if ((await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(300) })).ok) {
        browser = await chromium.connectOverCDP(endpoint, { timeout: 2000 });
        break;
      }
    } catch { /* owned WebView is still starting */ }
    await delay(150);
  }
  assert.ok(browser, launchError?.message ?? ('AniVerse2 WebView2 is unavailable. ' + output.slice(-2000)));
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 10000 });
  await page.waitForURL('https://tauri.localhost/**', { timeout: 15000 });
  await page.locator('.app').waitFor({ timeout: 15000 });
  report.tests.actualReactShell = true;
  const graphics = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const unmasked = gl?.getExtension('WEBGL_debug_renderer_info');
    return { webgl2: Boolean(gl), renderer: unmasked ? gl.getParameter(unmasked.UNMASKED_RENDERER_WEBGL) : null };
  });
  assert.equal(graphics.webgl2, true);
  report.graphics = graphics;
  const invoke = (method, input) => page.evaluate(({ method, input }) => window.aniverse.invoke(method, input), { method, input });
  const settings = await invoke('settings.get');
  assert.equal(settings.profile.name, 'Saved profile');
  assert.equal(settings.player.volume, 0.48);
  assert.equal(settings.player.autoplay, true);
  assert.equal(await invoke('player.mp4Folder', { action: 'get' }), 'D:/Saved video location');
  report.tests.settings = true;
  await page.evaluate(() => { location.hash = '#/history'; });
  await page.getByRole('heading', { name: 'Watch history', exact: true }).waitFor();
  await page.getByRole('link', { name: media.title, exact: true }).waitFor();
  assert.equal(await page.locator('.history-results').getAttribute('data-view'), 'list');
  assert.equal(await page.getByText(hidden.title, { exact: true }).count(), 0);
  const history = await invoke('library.history', { limit: 200, offset: 0 });
  assert.equal(history.length, 1);
  assert.equal(history[0].position, 83);
  report.tests.historyAndPrivacy = true;
  const entries = await invoke('library.entries', { status: 'CURRENT' });
  assert.equal(entries[0].media.title, media.title);
  assert.equal((await invoke('library.favourites'))[0].media.title, media.title);
  await page.evaluate(() => { location.hash = '#/library'; });
  await page.getByRole('heading', { name: 'Library', exact: true }).waitFor();
  await page.getByText(media.title, { exact: true }).waitFor();
  const watching = await invoke('library.continue');
  assert.deepEqual(watching.map(row => row.media.id), [media.id]);
  assert.equal(watching[0].position, 83);
  report.tests.library = true;
  await page.evaluate(() => { location.hash = '#/sources'; });
  await page.getByRole('heading', { name: 'Sources', exact: true }).waitFor();
  await page.getByText('Saved custom source', { exact: true }).waitFor();
  const sources = await invoke('sources.list');
  assert.deepEqual(sources.map((row) => row.id), ['sample-test', 'sample-test-2', 'yt-example']);
  report.tests.savedSourceIds = true;
  const maximize = page.getByRole('button', { name: 'Maximize window' });
  await maximize.click();
  await page.getByRole('button', { name: 'Restore window' }).waitFor();
  assert.equal(await page.evaluate(() => window.aniverse.windowControls.isMaximized()), true);
  await page.getByRole('button', { name: 'Restore window' }).click();
  await maximize.waitFor();
  assert.equal(await page.evaluate(() => window.aniverse.windowControls.isMaximized()), false);
  assert.equal(await page.getByRole('button', { name: 'Minimize window' }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Close window' }).count(), 1);
  assert.equal(await page.locator('.tauri-topbar .spacer[data-tauri-drag-region]').count(), 1);
  report.tests.customTitleBar = true;
  assert.equal(await page.locator('.brand .word').innerText(), 'AniVerse2');
  await page.waitForFunction(() => document.querySelector('.brand img')?.naturalWidth > 0, null, { polling: 100 });
  await page.evaluate(() => { location.hash = '#/settings/themes'; });
  const copper = page.getByRole('button', { name: 'Copper', exact: true });
  await copper.click();
  assert.equal(await copper.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), '#f6ac78');
  await page.reload();
  await copper.waitFor();
  assert.equal(await copper.getAttribute('aria-pressed'), 'true');
  report.tests.brandingAndSavedPalette = true;
  const unsupported = await page.evaluate(async () => {
    try { await window.aniverse.invoke('site.openEpisode', {}); return null; }
    catch (error) { return error.code; }
  });
  assert.equal(unsupported, 'unavailable');
  report.tests.unportedOperationsFailClosed = true;
  assert.equal(await checksum(database), initialHash);
  assert.equal(await readFile(path.join(staged, 'config/streaming-sites.txt'), 'utf8'), sites);
  report.tests.originalDatabaseAndSourceBytes = true;
  if (withHandoff) {
    assert.deepEqual(JSON.parse(await readFile(path.join(staged, 'migration-stage.json'), 'utf8')), {
      schema: 1, nonce, state: 'profile-copied',
    });
    const existing = await checksum(path.join(staged, 'aniverse.db'));
    const repeated = spawnSync(exe, ['--prepare-legacy-profile'], { windowsHide: true, timeout: 10000, env: { ...launchEnv, ANIVERSE_ELECTRON_HANDOFF: launchEnv.ANIVERSE2_TEST_PREPARED_MARKER } });
    assert.equal(repeated.status, 1, repeated.stderr?.toString());
    assert.equal(await checksum(path.join(staged, 'aniverse.db')), existing);
    assert.equal(await readFile(path.join(config, 'streaming-sites.txt'), 'utf8'), sites);
    report.tests.verifiedHandoffProfileCopy = true;
    report.tests.tamperedHandoffRejected = true;
    report.tests.repeatDidNotReplaceProfile = true;
  }
  report.runtime = await page.evaluate(() => ({ origin: location.origin, userAgent: navigator.userAgent }));
  report.passed = true;
  console.log(report);
} finally {
  await mkdir('test/artifacts', { recursive: true });
  await writeFile(withHandoff ? 'test/artifacts/aniverse2-handoff-windows.json' : 'test/artifacts/aniverse2-desktop-windows.json', JSON.stringify(report, null, 2) + '\n');
  await browser?.close().catch(() => undefined);
  if (child.exitCode === null && child.signalCode === null && child.pid && child.kill()) await exited;
}

async function prepareHandoffFixture({ run, exe, profile, legacy, preferences, nonce, launchEnv }) {
  const signer = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File',
    path.resolve('test/e2e/fixtures/aniverse2-sign-offer.ps1'), '-Application', exe],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'], env: launchEnv });
  const completed = once(signer, 'exit');
  const output = [];
  for await (const chunk of signer.stdout) output.push(chunk);
  assert.equal((await completed)[0], 0);
  const { pin, release } = JSON.parse(Buffer.concat(output).toString('utf8'));
  const attempt = path.join(legacy, 'windows-migration', 'attempt-desktop');
  await mkdir(attempt, { recursive: true });
  const marker = path.join(attempt, 'electron-handoff.json');
  const descriptor = {
    schema: 1, nonce, legacyPid: signer.pid, legacyVersion: '2.2.4',
    legacyExecutable: path.join(run, 'AniVerse.exe'), dataDir: legacy, configDir: path.join(run, 'custom config'),
    preferences, signedRelease: release,
  };
  await writeFile(path.join(legacy, 'profile.id'), 'isolated-old-profile');
  launchEnv.ANIVERSE2_TEST_LEGACY_PROFILE = legacy;
  launchEnv.ANIVERSE2_TEST_SIGNER_PIN = pin;
  await writeFile(marker, JSON.stringify({ ...descriptor, signedRelease: { ...release, manifest: 'e30=' } }));
  const rejected = spawnSync(exe, ['--prepare-legacy-profile'], { windowsHide: true, timeout: 10000, env: { ...launchEnv, ANIVERSE_ELECTRON_HANDOFF: marker } });
  assert.equal(rejected.status, 1, rejected.stderr?.toString());
  await assert.rejects(stat(path.join(profile, 'profile-data')), { code: 'ENOENT' });
  await writeFile(marker, JSON.stringify(descriptor));
  return marker;
}
