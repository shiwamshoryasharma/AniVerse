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
const withBoot = withHandoff && process.env.ANIVERSE2_CHECK_CUTOVER_BOOT === '1';
const withSearch = withHandoff && process.env.ANIVERSE2_CHECK_MIGRATED_SEARCH_TEMPLATES === '1';
const withNativeSave = process.env.ANIVERSE2_CHECK_NATIVE_SAVE === '1';
const cache = path.resolve('test/cache/aniverse2');
await mkdir(cache, { recursive: true });
const run = await mkdtemp(path.join(cache, 'desktop-'));
const legacy = path.join(run, 'legacy');
const profile = path.join(run, 'profile');
await mkdir(legacy);
await mkdir(profile);
const saveFolder = path.join(run, 'chosen-folder');
if (withNativeSave) {
  await mkdir(saveFolder);
  await writeFile(path.join(profile, 'mp4-download-folder.json'), JSON.stringify(saveFolder));
}
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
store.patchSourceOverride('sample-test', { name: 'Saved custom source', ...(withSearch ? {
  searchTemplate: 'https://www.sample.test/preferred?q={query}',
} : {}) });
if (withSearch) store.setKv('discovery:sample-test-2', {
  template: 'https://sample.test/saved-find?q={query}', via: 'opensearch', at: 123,
});
store.saveProgress({ media, episode: 3, position: 83, duration: 720, sourceId: 'sample-test' }, 0.85);
store.saveProgress({ media: hidden, episode: 1, position: 18, duration: 720, sourceId: 'sample-test' }, 0.85);
store.setTitlePrivate(hidden.id, true);
store.setLibraryEntry(media, 'CURRENT', 2);
store.setFavourite(media, true);
store.setPin('sample-test', media.id, 'https://www.sample.test/watch/example');
store.setSiteLink('sample-test', media.id, 3, 'https://www.sample.test/watch/example/3');
store.setSiteLink('sample-test-2', media.id, 3, 'https://sample.test/alternate/3');
store.cacheSet('migration:fixture', { previouslyCached: true }, 3600);
store.close();
const checksum = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const initialHash = await checksum(database);

const sites = '\uFEFF# Saved source comments\r\n1. https://www.sample.test/catalogue/\r\nhttps://sample.test/alternate\r\nhttps://www.youtube.com/@Example\r\n' + (withSearch ? 'https://recipe.test/home\r\n' : '');
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
const stagedFiles = new Map([
  ['adblock-engine.bin', Buffer.from('compatible offline blocker cache')],
  ['config/filters.txt', Buffer.from('! legacy custom filter\r\n')],
  ['config/site-recipes.json', Buffer.from(withSearch ? JSON.stringify({
    'recipe.test': {search:'https://recipe.test/saved-search?q={query}'},
    'sample.test': {search:'https://www.sample.test/recipe?q={query}'},
  }) : '{}')],
  ['graphics.json', Buffer.from('{"mode":"stable"}')],
  ['profile/avatar.webp', Buffer.from('profile fixture bytes')],
]);
const legacyEncryptedKey = Buffer.from('DPAPI fixture ciphertext').toString('base64');
const nonce = randomUUID();
if (withHandoff) {
  for (const [relative, contents] of stagedFiles) {
    const target = relative.startsWith('config/') ? path.join(config, relative.slice(7)) : path.join(legacy, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await writeFile(path.join(legacy, 'Local State'), JSON.stringify({
    os_crypt: { encrypted_key: legacyEncryptedKey }, profile: { unrelated: 'exclude this information' },
  }));
  await writeFile(path.join(run, 'AniVerse.exe'), 'original application sentinel');
  const marker = await prepareHandoffFixture({ run, exe, profile, legacy, preferences, nonce, launchEnv });
  if (withBoot) await rejectUnreadableHistory({ run, legacy, exe, marker, launchEnv });
  const prepared = spawnSync(exe, ['--prepare-legacy-profile'], {
    windowsHide: true, timeout: 60000, env: { ...launchEnv, ANIVERSE_ELECTRON_HANDOFF: marker },
  });
  assert.equal(prepared.status, 0, prepared.stderr?.toString());
  launchEnv.ANIVERSE2_TEST_PREPARED_MARKER = marker;
  const inventory = path.join(staged, 'migration-inventory.json');
  const originalInventory = await readFile(inventory);
  if (withBoot) {
    const journal = JSON.parse(await readFile(path.join(staged, 'migration-stage.json'), 'utf8'));
    assert.equal(journal.state, 'renderer-verified');
    await assert.rejects(stat(path.join(profile, 'webview')), { code: 'ENOENT' });
  }
  const verification = JSON.parse(originalInventory);
  assert.equal(verification.nonce, nonce);
  assert.equal(verification.application_sha256, await checksum(exe));
  for (const [file, hash] of Object.entries(verification.files)) {
    assert.equal(await checksum(path.join(staged, file)), hash);
  }
  for (const [file, content] of stagedFiles) assert.deepEqual(await readFile(path.join(staged, file)), content);
  assert.equal(JSON.parse(await readFile(path.join(staged, 'chromium-encrypted-key.json'), 'utf8')), legacyEncryptedKey);
  await assert.rejects(stat(path.join(staged, 'Local State')), { code: 'ENOENT' });
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const stagedDb = new DatabaseSync(path.join(staged, 'aniverse.db'), { readOnly: true });
  try {
    const cached = stagedDb.prepare('SELECT value FROM http_cache WHERE key=?').get('migration:fixture');
    assert.deepEqual(JSON.parse(cached.value), { previouslyCached: true });
  }
  finally { stagedDb.close(); }
  const receipt = path.join(staged, 'migration-copy-verified');
  const originalReceipt = await readFile(receipt);
  await writeFile(receipt, 'invalid test receipt');
  try {
    const rejected = spawnSync(exe, [], { windowsHide: true, timeout: 10000, env: launchEnv });
    assert.equal(rejected.status, 1, rejected.stderr?.toString());
    assert.equal(await checksum(database), initialHash);
    assert.equal(await readFile(path.join(run, 'AniVerse.exe'), 'utf8'), 'original application sentinel');
  } finally {
    await writeFile(receipt, originalReceipt);
  }
}
const child = spawn(exe, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: launchEnv });
let output = '', browser, launchError;
child.on('error', (error) => { launchError = error; });
child.stdout.on('data', (bytes) => { output += bytes; });
child.stderr.on('data', (bytes) => { output += bytes; });
const exited = once(child, 'exit').catch(() => undefined);
const report = {
  passed: false, tests: {},
  evidence: { executableSha256: await checksum(exe), scope: withHandoff ? 'Windows x64 isolated signed-descriptor handoff' : 'Windows x64 isolated desktop smoke' },
};
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
  if (process.env.ANIVERSE2_CHECK_METADATA === '1') {
    const home = await invoke('meta.home');
    const latest = await invoke('meta.latest', { page: 1 });
    assert.ok(home.trending.length && home.popularSeason.length && home.topRated.length);
    assert.ok(latest.items.length);
    assert.ok(home.trending.every((entry) => !entry.isAdult && entry.title.userPreferred));
    assert.ok(latest.items.every((item) => !item.media.isAdult && item.episode > 0));
    await page.locator('.rank-list .rank-item').first().waitFor({ timeout: 15000 });
    await page.getByRole('heading', { name: 'Latest episodes' }).waitFor();
    assert.equal(await page.getByText('Couldn’t load AniList', { exact: true }).count(), 0);
    const badPage = await page.evaluate(async () => {
      try { await window.aniverse.invoke('meta.latest', { page: 0 }); }
      catch (error) { return error.code; }
    });
    assert.equal(badPage, 'invalid-input');
    report.tests.liveHomeAndLatestEpisodes = true;
    await page.evaluate(() => { location.hash = '#/anime/1'; });
    await page.getByRole('heading', { name: 'Cowboy Bebop', exact: true }).waitFor();
    assert.equal(await page.getByText('Something went wrong', { exact: true }).count(), 0);
    const details = await invoke('meta.details', {id: 1});
    assert.equal(details.id, 1);
    report.tests.liveTitleDetails = true;
  }
  const settings = await invoke('settings.get');
  assert.equal(settings.profile.name, 'Saved profile');
  assert.equal(settings.player.volume, 0.48);
  assert.equal(settings.player.autoplay, true);
  assert.equal(await invoke('player.mp4Folder', { action: 'get' }), withNativeSave ? saveFolder : 'D:/Saved video location');
  report.tests.settings = true;
  await page.evaluate(() => { location.hash = '#/player'; });
  const streamUrl = page.getByRole('textbox', { name: 'Stream URL' });
  const downloadMp4 = page.getByRole('button', { name: 'Download MP4' });
  await streamUrl.fill('https://media.example.test/master.m3u8');
  assert.equal(await downloadMp4.count(), 0);
  await streamUrl.fill('https://media.example.test/episode.mp4');
  await downloadMp4.waitFor();
  assert.equal(await downloadMp4.isEnabled(), true);
  report.tests.explicitMp4DownloadAction = true;
  if (withNativeSave) {
    const url = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
    const destination = path.join(saveFolder, 'AniVerse - flower.mp4');
    const response = await fetch(url, {signal: AbortSignal.timeout(15000)});
    assert.ok(response.ok);
    const reference = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
    await streamUrl.fill(url);
    const dialog = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-File',
      path.resolve('test/e2e/fixtures/aniverse2-submit-save.ps1'),'-AppPid',String(child.pid),'-Destination',destination],
      {windowsHide:true, env:launchEnv, stdio:['ignore','ignore','inherit']});
    const ended = once(dialog,'exit');
    await downloadMp4.click();
    assert.equal((await ended)[0], 0, 'Native Save As did not submit');
    await page.getByText('MP4 saved.',{exact:true}).waitFor({timeout:30000});
    assert.equal(await checksum(destination), reference);
    report.tests.nativeSaveAsAndExactBytes = true;
  }
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
  assert.deepEqual(sources.map((row) => row.id), ['sample-test', 'sample-test-2', 'yt-example', ...(withSearch ? ['recipe-test'] : [])]);
  if (withSearch) {
    assert.equal(sources[0].searchTemplate, 'https://www.sample.test/preferred?q={query}');
    assert.equal(sources[0].searchTemplateSource, 'user');
    assert.equal(sources[1].searchTemplate, 'https://sample.test/saved-find?q={query}');
    assert.equal(sources[1].searchTemplateSource, 'opensearch');
    assert.equal(sources[1].searchCheckedAt, 123);
    assert.equal(sources[3].searchTemplate, 'https://recipe.test/saved-search?q={query}');
    assert.equal(sources[3].searchTemplateSource, 'recipe');
    report.tests.migratedUserRecipeAndDiscoveredTemplates = true;
  }
  report.tests.savedSourceIds = true;
  assert.equal((await invoke('library.state', {mediaId: media.id})).pinned['sample-test'], 'https://www.sample.test/watch/example');
  await invoke('site.forget', {sourceId: 'sample-test', mediaId: media.id});
  assert.deepEqual((await invoke('library.state', {mediaId: media.id})).pinned, {});
  const stagedStore = new Store(path.join(staged, 'aniverse.db'));
  try {
    assert.deepEqual(stagedStore.getSiteLinks('sample-test', media.id), {});
    assert.equal(stagedStore.getSiteLinks('sample-test-2', media.id)[3], 'https://sample.test/alternate/3');
  } finally { stagedStore.close(); }
  report.tests.refindClearsOnlySelectedSource = true;
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
  if (process.env.ANIVERSE2_CHECK_UPDATER === '1') {
    await page.evaluate(() => { location.hash = '#/settings/about'; });
    await page.getByRole('button', { name: 'Check for updates' }).waitFor();
    await page.getByText(/Version [\d.]+ · Tauri [\d.]+ · WebView2 /).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Update AniVerse to AniVerse2' }).count(), 0);
    const automatic = page.getByRole('switch', { name: 'Download updates automatically' });
    assert.equal(await automatic.getAttribute('aria-checked'), 'true');
    await automatic.click();
    await page.waitForFunction(async () => !(await window.aniverse.invoke('settings.get')).updates.autoDownload);
    assert.equal((await invoke('update.state')).status, 'idle');
    const prefs = JSON.parse(await readFile(path.join(profile, 'update-preferences.json'), 'utf8'));
    assert.equal(prefs.autoDownload, false);
    await page.reload();
    await page.getByRole('switch', { name: 'Download updates automatically', checked: false }).waitFor();
    assert.equal(await automatic.getAttribute('aria-checked'), 'false');
    report.tests.ownUpdaterControlsAndPreferences = true;
  }
  if (process.env.ANIVERSE2_CHECK_DESKTOP_PORTS === '1') {
    assert.deepEqual(await invoke('sources.streams',{sourceId:'sample-test',ref:'episode-1'}),[]);
    assert.deepEqual((await invoke('sources.streams',{sourceId:'yt-example',ref:'abcDEF_01-2'}))[0],
      {type:'youtube',videoId:'abcDEF_01-2',label:'YouTube · official embed'});
    await assert.rejects(invoke('sources.streams',{sourceId:'yt-example',ref:'https://example.test/unsafe'}),/Invalid YouTube video ID/);
    const before=await invoke('changelog.state');
    const seen=await invoke('changelog.markSeen',{version:before.version});
    assert.equal(seen.seen,before.version);
    assert.equal((await invoke('changelog.state')).unread,false);
    await assert.rejects(invoke('changelog.markSeen',{version:'0.0.0'}),/Only this app version/);
    const db=new Store(path.join(staged,'aniverse.db'));
    db.cacheSet('isolation:retained-cache-fixture',{value:'to be purged'},3600);
    db.close();
    await invoke('app.cacheClear');
    const after=new Store(path.join(staged,'aniverse.db'));
    try {
      assert.equal(after.cacheGet('isolation:retained-cache-fixture'),null);
      assert.ok(after.listHistory(200,0).some(entry=>entry.media.id===media.id));
    } finally {after.close();}
    const next=await invoke('privacy.title',{mediaId:media.id,on:true});
    assert.ok(next.privateMediaIds.includes(media.id));
    assert.equal((await invoke('library.history',{limit:200,offset:0})).length,0);
    const privateSources=await invoke('privacy.watchSources',{mediaId:media.id});
    assert.ok(privateSources.leaseId && privateSources.sources.every(source=>source.partition.startsWith('private-')));
    await invoke('privacy.releaseSources',{leaseId:privateSources.leaseId});
    await invoke('privacy.title',{mediaId:media.id,on:false});
    assert.equal((await invoke('library.history',{limit:200,offset:0})).length,1);
    assert.equal((await invoke('settings.get')).profile.name,'Saved profile');
    report.tests.desktopPortsCacheChangelogAndPrivacy=true;
  }
  const unsupported = await page.evaluate(async () => {
    try { await window.aniverse.invoke('test.unknownOperation', {}); return null; }
    catch (error) { return error.code; }
  });
  assert.equal(unsupported, 'unavailable');
  report.tests.unportedOperationsFailClosed = true;
  assert.equal(await checksum(database), initialHash);
  assert.equal(await readFile(path.join(staged, 'config/streaming-sites.txt'), 'utf8'), sites);
  report.tests.originalDatabaseAndSourceBytes = true;
  if (withHandoff) {
    assert.deepEqual(JSON.parse(await readFile(path.join(staged, 'migration-stage.json'), 'utf8')), {
      schema: 2, nonce, state: 'renderer-verified',
    });
    const existing = await checksum(path.join(staged, 'aniverse.db'));
    const repeated = spawnSync(exe, ['--prepare-legacy-profile'], { windowsHide: true, timeout: 10000, env: { ...launchEnv, ANIVERSE_ELECTRON_HANDOFF: launchEnv.ANIVERSE2_TEST_PREPARED_MARKER } });
    assert.equal(repeated.status, 1, repeated.stderr?.toString());
    assert.equal(await checksum(path.join(staged, 'aniverse.db')), existing);
    assert.equal(await readFile(path.join(config, 'streaming-sites.txt'), 'utf8'), sites);
    report.tests.verifiedHandoffProfileCopy = true;
    report.tests.tamperedHandoffRejected = true;
    report.tests.inventoryAndCompatibleFilesVerified = true;
    report.tests.encryptedWindowsKeyOnly = true;
    report.tests.committedHttpCachePreserved = true;
    report.tests.badReceiptBlockedCandidateWithoutTouchingElectron = true;
    report.tests.repeatDidNotReplaceProfile = true;
    if (withBoot) report.tests.firstRendererVerifiedWithDisposalAndRollback = true;
  }
  report.runtime = await page.evaluate(() => ({ origin: location.origin, userAgent: navigator.userAgent }));
  report.passed = true;
  console.log(report);
} finally {
  await mkdir('test/artifacts', { recursive: true });
  await writeFile(process.env.ANIVERSE2_TEST_REPORT ?? (withHandoff ? 'test/artifacts/aniverse2-handoff-windows.json' : 'test/artifacts/aniverse2-desktop-windows.json'), JSON.stringify(report, null, 2) + '\n');
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

async function rejectUnreadableHistory({ run, legacy, exe, marker, launchEnv }) {
  const failure = path.join(run, 'unreadable-history');
  const source = path.join(failure, 'legacy');
  const target = path.join(failure, 'profile');
  const config = path.join(source, 'config');
  const attempt = path.join(source, 'windows-migration', 'attempt-fixture');
  await Promise.all([mkdir(attempt, { recursive: true }), mkdir(config, { recursive: true }), mkdir(target, { recursive: true })]);
  const descriptor = JSON.parse(await readFile(marker, 'utf8'));
  await copyFile(path.join(legacy, 'profile.id'), path.join(source, 'profile.id'));
  await copyFile(path.join(descriptor.configDir, 'streaming-sites.txt'), path.join(config, 'streaming-sites.txt'));
  const database = path.join(source, 'aniverse.db');
  await copyFile(path.join(legacy, 'aniverse.db'), database);
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const bad = new DatabaseSync(database);
  bad.exec('DROP TABLE history; PRAGMA wal_checkpoint(TRUNCATE);');
  bad.close();
  const digest = createHash('sha256').update(await readFile(database)).digest('hex');
  const brokenMarker = path.join(attempt, 'electron-handoff.json');
  await writeFile(brokenMarker, JSON.stringify({
    ...descriptor, nonce: randomUUID(), dataDir: source, configDir: config,
  }));
  const rejected = spawnSync(exe, ['--prepare-legacy-profile'], { windowsHide: true, timeout: 60000, env: {
    ...launchEnv, ANIVERSE2_TEST_PROFILE: target, ANIVERSE2_TEST_LEGACY_PROFILE: source, ANIVERSE_ELECTRON_HANDOFF: brokenMarker,
  } });
  assert.equal(rejected.status, 1, rejected.stderr?.toString());
  assert.match(rejected.stderr?.toString() ?? '', /did not verify the copied profile/);
  await assert.rejects(stat(path.join(target, 'profile-data')), { code: 'ENOENT' });
  assert.equal(createHash('sha256').update(await readFile(database)).digest('hex'), digest);
  assert.equal(await readFile(path.join(run, 'AniVerse.exe'), 'utf8'), 'original application sentinel');
}
