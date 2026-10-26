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
const cache = path.join(root, 'test/cache/workspace-ui');
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
store.close();
const reports = [],
  errors = [];
const app = await _electron.launch({
  executablePath: process.env.E2E_EXE ? path.resolve(root, process.env.E2E_EXE) : createRequire(import.meta.url)('electron'),
  args: process.env.E2E_EXE ? [] : [root],
  cwd: root,
  env: { ...process.env, ANIVERSE_HEADLESS: '1', ANIVERSE_DATA_DIR: profile, ANIVERSE_CONFIG_DIR: config, TEMP: temporary, TMP: temporary, TMPDIR: temporary },
  timeout: 60000,
});
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.app', { timeout: 30000 });
  const go = async (hash, selector) => {
    await page.evaluate((h) => (location.hash = h), hash);
    await page.waitForSelector(selector, { timeout: 30000 });
  };
  const capture = async (name) => {
    await page.screenshot({ path: path.join(artifacts, 'workspace-' + name + '.png') });
  };
  const check = (name) => {
    reports.push({ name, passed: true });
    console.log('[PASS] ' + name);
  };
  await go('#/workspace/bookmarks', '.scene-card');
  assert.match(await page.locator('.scene-card').innerText(), /Fixture Series/);
  await page.getByLabel('Edit scene note').fill('Updated local note');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await page.waitForFunction(async () => (await window.aniverse.invoke('toolkit.bookmarks', {}))[0].note === 'Updated local note');
  await page.getByLabel('Search scene bookmarks').fill('Updated');
  assert.equal(await page.locator('.scene-card').count(), 1);
  await capture('bookmarks');
  check('bookmark editing and search through validated IPC');

  await go('#/workspace/planner', '.planner-week, [aria-label="Daily watch budget"]');
  await page.getByRole('button', { name: 'Build week', exact: true }).click();
  await page.waitForSelector('.plan-item');
  const plan = await page.evaluate(() => window.aniverse.invoke('planner.get'));
  assert.equal(plan.days.length, 7);
  assert.ok(plan.days.every((d) => d.minutes <= 48));
  assert.equal(plan.days.flatMap((d) => d.items).length, 3);
  await capture('planner');
  check('weekly budget and available-episode planning');

  await go('#/workspace/collection', '.collection-name');
  assert.ok(!(await page.locator('.collection-list').innerText()).includes(videos), 'No private path in collection UI');
  await page.locator('.workspace').getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('button.btn.primary')?.disabled);
  await capture('collection');
  check('local collection refresh and filename-only UI');

  await go('#/settings/themes', '[aria-label="Theme name"]');
  await page.getByLabel('Theme name').fill('Fixture visual theme');
  await page.getByRole('button', { name: 'Save current', exact: true }).click();
  await page.waitForSelector('.theme-preset');
  const exported = path.join(run, 'exported-theme.json');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, exported);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Theme name"]')?.disabled);
  for (let i = 0; i < 30 && !existsSync(exported); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  const preset = JSON.parse(readFileSync(exported, 'utf8'));
  assert.deepEqual(Object.keys(preset).sort(), ['appearance', 'name', 'player', 'version']);
  preset.appearance.fontFamily = 'serif';
  preset.appearance.accent = 'aqua';
  const imported = path.join(run, 'import-theme.json');
  writeFileSync(imported, JSON.stringify(preset));
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, imported);
  await page.getByRole('button', { name: 'Import JSON', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.theme-preset').length === 2);
  await page.locator('.theme-preset').first().getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.font === 'serif' && document.documentElement.dataset.accent === 'aqua');
  await capture('themes');
  check('theme file export, import and application');

  await go('#/anime/7', '.spoiler-guard');
  assert.equal(await page.getByText('A hidden fixture synopsis.', { exact: true }).count(), 0);
  assert.ok(!(await page.locator('[title]').evaluateAll((items) => items.map((e) => e.title).join(' '))).includes('Secret ending'));
  await page.getByRole('button', { name: 'Reveal', exact: true }).click();
  await page.waitForSelector('.synopsis');
  check('Spoiler Shield prevents synopsis and future episode tooltip leaks');

  await go('#/watch/7/1?local=1', '.episode-toolkit');
  await page.waitForFunction(() => document.querySelector('video')?.duration > 0);
  await page.getByRole('button', { name: 'Play', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('video')?.currentTime > 1);
  await page.waitForFunction(() => !document.querySelector('.episode-toolkit button.btn.primary')?.disabled);
  await page.getByLabel('Scene note').fill('A native clock scene');
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  await page.waitForFunction(async () => (await window.aniverse.invoke('toolkit.bookmarks', {})).some((b) => b.note === 'A native clock scene'));
  assert.equal(await page.locator('.spoiler-guard').count(), 2);
  await capture('toolkit');
  check('local playback and scene capture use the native video clock');

  const srt = path.join(run, 'captions.srt');
  writeFileSync(srt, '1\n00:00:00,000 --> 00:00:50,000\nImported primary caption\n');
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, srt);
  await page.getByRole('button', { name: 'Subtitle Studio', exact: true }).click();
  await page.getByRole('button', { name: 'Import SRT / VTT', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.studio-captions')?.textContent.includes('Imported primary caption'));
  await page.evaluate(() => {
    const v = document.querySelector('video');
    const t = v.addTextTrack('subtitles', 'Secondary fixture', 'ja');
    t.addCue(new VTTCue(0, 50, 'Secondary fixture caption'));
  });
  await page.getByLabel('Secondary captions', { exact: true }).selectOption({ label: 'Secondary fixture' });
  await page.waitForFunction(() => document.querySelector('.studio-captions')?.textContent.includes('Secondary fixture caption'));
  await page.getByLabel('Primary offset', { exact: true }).fill('1.5');
  await page.getByRole('button', { name: 'Save style', exact: true }).click();
  await page.waitForFunction(async () => (await window.aniverse.invoke('settings.get')).player.subtitleStyle.offset === 1.5);
  await capture('subtitles');
  check('SRT import, dual caption display and persisted subtitle style');

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.episode-toolkit summary').click();
  await page.getByLabel('Start (s)', { exact: false }).fill('0');
  await page.getByLabel('End (s)', { exact: false }).fill('20');
  await page.getByLabel('Auto skip', { exact: true }).check();
  await page.getByRole('button', { name: 'Save range', exact: true }).click();
  await page.waitForFunction(async () => (await window.aniverse.invoke('toolkit.skips', { mediaId: 7 })).length === 1);
  await page.evaluate(() => {
    const v = document.querySelector('video');
    v.currentTime = 2;
    void v.play();
  });
  await page.waitForFunction(() => document.querySelector('video')?.currentTime >= 20, undefined, { timeout: 10000 });
  check('opt-in intro map seeks through the native player');

  await go('#/workspace/insights', '.insight-stats');
  await page.getByRole('switch', { name: 'Record local watch insights', exact: true }).click();
  await page.waitForFunction(async () => (await window.aniverse.invoke('settings.get')).privacy.watchInsights === true);
  await go('#/watch/7/1?local=1', '.episode-toolkit');
  await page.waitForFunction(() => document.querySelector('video')?.duration > 0);
  await page.getByRole('button', { name: 'Play', exact: true }).first().click();
  await page.waitForFunction(async () => (await window.aniverse.invoke('toolkit.insights')).watchedSeconds > 0, undefined, { timeout: 15000 });
  await go('#/workspace/insights', '.insight-stats');
  await capture('insights');
  check('opt-in observed watch time reaches local insights');

  await go('#/settings/about', '.disclaimer');
  assert.ok(!(await page.locator('.disclaimer').innerText()).includes('hosts nothing'));
  await capture('notice');
  check('updated browser and privacy notice renders');
  assert.deepEqual(errors, [], 'No renderer crashes');
} finally {
  await app.close();
  writeFileSync(path.join(artifacts, 'workspace-ui.json'), JSON.stringify({ packaged: !!process.env.E2E_EXE, reports, errors }, null, 2) + '\n');
}
