// Real Electron renderer/main integration using neutral metadata and a public test clip.
// Every profile, cache, chosen file, export and screenshot stays under test/.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cache = path.join(root, 'test/cache/release-1.5.2-ui');
const artifacts = path.join(root, 'test/artifacts');
mkdirSync(cache, { recursive: true });
mkdirSync(artifacts, { recursive: true });
const run = mkdtempSync(path.join(cache, 'run-'));
const profile = path.join(run, 'profile'),
  config = path.join(run, 'config'),
  videos = path.join(run, 'videos'),
  temporary = path.join(run, 'temp');
for (const folder of [profile, config, videos, temporary]) mkdirSync(folder, { recursive: true });
writeFileSync(path.join(config, 'streaming-sites.txt'), '# Neutral isolated test; no website sources\n');
writeFileSync(path.join(config, 'filters.txt'), '! Test filters\n');
const clip = path.join(cache, 'sintel-trailer.mp4');
if (!existsSync(clip)) {
  const response = await fetch('https://media.w3.org/2010/05/sintel/trailer.mp4');
  assert.ok(response.ok, 'Public test clip is available');
  writeFileSync(clip, Buffer.from(await response.arrayBuffer()));
}
const videoFile = path.join(videos, 'Fixture Series - 01.mp4');
writeFileSync(videoFile, readFileSync(clip));
await build({
  stdin: {
    contents:
      "export { Store } from './app/core/db/store';export { WorkspaceService } from './app/core/workspace';export { AniListClient } from './app/core/metadata/anilist';",
    resolveDir: root,
  },
  outfile: path.join(run, 'seed.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['node:sqlite'],
  logLevel: 'warning',
});
const { Store, WorkspaceService, AniListClient } = createRequire(import.meta.url)(path.join(run, 'seed.cjs'));
const store = new Store(path.join(profile, 'aniverse.db'));
const media = { id: 7, idMal: null, title: 'Fixture Series', cover: '', banner: null, format: 'TV', episodes: 3 };
const raw = {
  id: 7,
  idMal: null,
  type: 'ANIME',
  title: { romaji: 'Fixture Series', english: 'Fixture Series', native: null, userPreferred: 'Fixture Series' },
  coverImage: { extraLarge: '', large: '', color: null },
  bannerImage: null,
  format: 'TV',
  status: 'FINISHED',
  episodes: 3,
  duration: 24,
  averageScore: 80,
  season: 'FALL',
  seasonYear: 2020,
  genres: ['Adventure'],
  isAdult: false,
  nextAiringEpisode: null,
  startDate: { year: 2020, month: 1, day: 1 },
  description: 'A hidden fixture synopsis.',
  streamingEpisodes: [
    { title: 'Episode 3 - Secret ending', thumbnail: 'https://image.example.test/spoiler.jpg', url: 'https://video.example.test', site: 'Fixture' },
  ],
  externalLinks: [],
};
const data = {
  Media: raw,
  Page: { media: [raw] },
  spotlight: { media: [] },
  trending: { media: [raw] },
  popularSeason: { media: [raw] },
  upcoming: { media: [] },
  topRated: { media: [raw] },
  recent: { airingSchedules: [] },
};
const client = new AniListClient(async () => new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } }), store, {
  showAdult: () => false,
  token: () => null,
});
await client.details(7);
await client.search('Fixture Series');
await client.home();
store.setLibraryEntry(media, 'CURRENT', 0);
store.setKv('settings', { privacy: { adblock: false, watchInsights: false }, updates: { autoCheck: false, autoDownload: false }, player: { autoplay: false } });
store.setKv('collection:roots', [videos]);
store.db
  .prepare('INSERT INTO local_media(path,name,bytes,query,episode,media_id,missing) VALUES(?,?,?,?,?,?,0)')
  .run(videoFile, path.basename(videoFile), readFileSync(videoFile).length, 'Fixture Series', 1, 7);
const workspace = new WorkspaceService(store);
workspace.saveBookmark({ media, episode: 1, position: 12, duration: 52, sourceId: null, note: 'A fixture scene', tags: ['test'] });
store.setKv('changelog:lastSeen', JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version);
store.close();

const reports = [], errors = [];
const app = await _electron.launch({
  executablePath: process.env.E2E_EXE ? path.resolve(root, process.env.E2E_EXE) : createRequire(import.meta.url)('electron'),
  args: process.env.E2E_EXE ? [] : [root], cwd: root,
  env: { ...process.env, ANIVERSE_HEADLESS: '1', ANIVERSE_DATA_DIR: profile, ANIVERSE_CONFIG_DIR: config, TEMP: temporary, TMP: temporary, TMPDIR: temporary },
  timeout: 60000,
});
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.app');
  const go = async (hash, selector) => { await page.evaluate((h) => location.hash = h, hash); await page.waitForSelector(selector); };
  const capture = async (name) => page.screenshot({ path: path.join(artifacts, 'release-1.5.2-' + name + '.png') });
  const check = (name, detail = {}) => { reports.push({ name, passed: true, ...detail }); console.log('[PASS] ' + name); };
  await go('#/settings/themes', '.theme-styles');
  for (const [style, label] of [['classic','Classic'],['aurora','Aurora'],['paper','Paper']]) {
    await page.locator('.theme-style.' + style).click();
    await page.waitForFunction((s) => document.documentElement.dataset.style === s, style);
    assert.equal(await page.locator('.theme-style.' + style).getAttribute('aria-pressed'), 'true');
    await capture('theme-' + style);
    check(label + ' interface theme applies through IPC');
  }
  await page.locator('.theme-style.classic').click();
  await page.waitForFunction(() => document.documentElement.dataset.style === 'classic');

  const oauthFile = path.join(run, 'desktop-oauth-fixture.json');
  writeFileSync(oauthFile, JSON.stringify({ installed: { client_id: '123-fixture.apps.googleusercontent.com', client_secret: 'fixture-secret' } }));
  await app.evaluate(({ dialog, session, shell }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    const original = session.defaultSession.fetch.bind(session.defaultSession);
    let folder = false, backup = null;
    const resource = () => ({ id: 'fixtureBackup123', name: 'aniverse-backup.v1.json', mimeType: 'application/json', capabilities: { canEdit: true } });
    const folderResource = () => ({ id: 'fixtureFolder123', name: 'AniVerse Sync', mimeType: 'application/vnd.google-apps.folder', capabilities: { canEdit: true } });
    session.defaultSession.fetch = async (input, options = {}) => {
      const url = new URL(String(input));
      const json = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      if (url.hostname === 'oauth2.googleapis.com') return url.pathname === '/token' ? json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 }) : new Response('');
      if (url.hostname !== 'www.googleapis.com') return original(input, options);
      if (url.pathname.startsWith('/upload/')) {
        const body = String(options.body), marker = 'Content-Type: application/json\r\n\r\n';
        const start = body.lastIndexOf(marker) + marker.length;
        backup = JSON.parse(body.slice(start, body.lastIndexOf('\r\n--')));
        return json(resource());
      }
      if (url.searchParams.get('alt') === 'media') return new Response(JSON.stringify(backup), { headers: { 'Content-Type': 'application/json', ETag: 'fixture-revision-1' } });
      if (options.method === 'POST') { folder = true; return json(folderResource()); }
      if (url.pathname.endsWith('/fixtureFolder123')) return json(folderResource());
      const query = url.searchParams.get('q') ?? '';
      if (query.includes('mimeType=')) return json({ files: folder ? [folderResource()] : [] });
      return json({ files: backup ? [resource()] : [] });
    };
    shell.openExternal = async (input) => {
      const auth = new URL(input);
      if (auth.hostname !== 'accounts.google.com') return;
      const callback = new URL(auth.searchParams.get('redirect_uri'));
      callback.search = new URLSearchParams({ code: 'fixture-code', state: auth.searchParams.get('state') }).toString();
      const result = await fetch(callback);
      if (!result.ok) throw new Error('Fixture OAuth callback failed');
    };
  }, oauthFile);
  await go('#/settings/drive', '.drive-panel');
  await page.getByRole('button', { name: 'Upload OAuth JSON', exact: true }).click();
  await page.waitForFunction(async () => (await window.aniverse.invoke('drive.state')).configured);
  await page.getByRole('button', { name: 'Connect Google', exact: true }).click();
  await page.waitForFunction(async () => (await window.aniverse.invoke('drive.state')).connected);
  const state = await page.evaluate(() => window.aniverse.invoke('drive.state'));
  assert.ok(!JSON.stringify(state).match(/fixture-secret|fixture-access|fixture-refresh|clientId/));
  assert.equal(state.folderName, 'AniVerse Sync');
  await page.getByRole('button', { name: 'EXPORT', exact: true }).click();
  await page.waitForFunction(async () => !!(await window.aniverse.invoke('drive.state')).lastExport);
  await page.getByRole('button', { name: 'IMPORT · preview', exact: true }).click();
  await page.waitForSelector('.drive-preview');
  await page.locator('.drive-preview').scrollIntoViewIfNeeded();
  await capture('drive-import-preview');
  await page.getByRole('button', { name: 'Confirm import', exact: true }).click();
  await page.waitForFunction(async () => !!(await window.aniverse.invoke('drive.state')).lastImport);
  await capture('drive');
  check('Drive upload JSON, OAuth, export, preview and confirmed merge through real IPC', { transport: 'Controlled Google API responses; no real Google account used' });
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.waitForFunction(async () => !(await window.aniverse.invoke('drive.state')).connected);

  await go('#/watch/7/1?local=1', 'video');
  await page.waitForFunction(() => document.querySelector('video')?.duration > 0);
  await page.getByRole('button', { name: 'Play', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('video')?.currentTime > 1);
  await page.getByRole('button', { name: 'Anime4K Upscale', exact: true }).click();
  await page.getByRole('switch', { name: 'Enable Anime4K Upscale', exact: true }).click();
  await page.waitForSelector('.anime4k-status.active', { timeout: 45000 });
  const toggleBox = await page.getByRole('switch', { name: 'Enable Anime4K Upscale', exact: true }).boundingBox();
  assert.ok(toggleBox.width <= 45 && toggleBox.height <= 25, 'Menu styles preserve compact switch geometry');
  for (const [index, mode] of ['A','B','C','A+A','B+B','C+A'].entries()) {
    if (!(await page.locator('.anime4k-panel').count())) await page.getByRole('button', { name: 'Anime4K Upscale', exact: true }).click();
    console.log('[GPU] Selecting ' + mode);
    await page.locator('.anime4k-modes button').nth(index).click();
    await page.waitForFunction((m) => document.querySelector('.anime4k-status.active')?.textContent.includes('Anime4K ' + m + ' ·'), mode, { timeout: 15000 }).catch(async (error) => {
      console.log(JSON.stringify(await page.evaluate(async () => ({ status: document.querySelector('.anime4k-status')?.textContent, className: document.querySelector('.anime4k-status')?.className, prefs: (await window.aniverse.invoke('settings.get')).player.upscale, video: { time: document.querySelector('video')?.currentTime, paused: document.querySelector('video')?.paused, ended: document.querySelector('video')?.ended }, canvases: [...document.querySelectorAll('.anime4k-canvas')].map(c => ({ width:c.width,height:c.height,visibility:getComputedStyle(c).visibility })) }))));
      await capture('gpu-failure'); throw error;
    });
    console.log('[GPU] Active ' + mode);
  }
  const canvas = await page.locator('.anime4k-canvas').evaluate((c) => ({ width: c.width, height: c.height, visibility: getComputedStyle(c).visibility }));
  assert.equal(canvas.width, 3840); assert.ok(canvas.height <= 2160 && canvas.height > 2000); assert.equal(canvas.visibility, 'visible');
  await capture('native-anime4k');
  check('All six Anime4K modes process real local playback on the GPU', canvas);
  await page.getByRole('switch', { name: 'Enable Anime4K Upscale', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.anime4k-status'));
  await page.getByRole('button', { name: 'Anime4K Upscale', exact: true }).click();
  await page.getByRole('button', { name: 'Cast to a TV', exact: true }).click();
  await page.waitForSelector('.cast-4k-choice');
  const capabilities = await page.evaluate(() => window.aniverse.invoke('cast.capabilities'));
  assert.equal(capabilities.available, true);
  assert.equal(capabilities.version, '9.0.2');
  await capture('cast-options');
  check('Embedded 4K cast option is available without a system FFmpeg dependency', capabilities);
  assert.deepEqual(errors, [], 'No renderer crashes');
} catch (error) {
  errors.push(String(error)); throw error;
} finally {
  await app.close();
  writeFileSync(path.join(artifacts, 'release-1.5.2-ui.json'), JSON.stringify({ packaged: !!process.env.E2E_EXE, reports, errors }, null, 2) + '\n');
}
