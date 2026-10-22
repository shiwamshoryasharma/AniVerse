// End-to-end smoke test: launches the built Electron app with an isolated
// profile, visits every screen, checks for crashes/console errors and saves
// screenshots to test/artifacts/. Run `npm run build` first.
//
//   node test/e2e/smoke.mjs            all screens
//   node test/e2e/smoke.mjs home watch only the named steps
import { _electron as electron } from 'playwright-core';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifacts = path.join(root, 'test', 'artifacts');
const profile = path.join(root, 'test', 'cache', 'e2e-profile');
const only = new Set(process.argv.slice(2));
if (process.env.E2E_FRESH === '1') rmSync(profile, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });

// E2E_EXE=release/win-unpacked/AniVerse.exe tests the packaged app instead of dist/.
const exe = process.env.E2E_EXE ? path.resolve(root, process.env.E2E_EXE) : null;
const app = await electron.launch({
  executablePath: exe ?? createRequire(import.meta.url)('electron'),
  args: exe ? [] : [root],
  cwd: root,
  env: { ...process.env, ANIVERSE_HEADLESS: '1', ANIVERSE_DATA_DIR: profile },
  timeout: 60000,
});

const page = await app.firstWindow();
await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
const errors = [];
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error' && !/favicon|ERR_|net::|Failed to load resource/i.test(msg.text())) errors.push(`console: ${msg.text()}`);
});

const results = [];
if (process.env.E2E_WAIT) await page.waitForTimeout(Number(process.env.E2E_WAIT));
async function step(name, hash, waitFor, extra) {
  if (only.size && !only.has(name)) return;
  const started = Date.now();
  try {
    await page.evaluate((h) => (window.location.hash = h), hash);
    await page.waitForSelector(waitFor, { timeout: 30000 });
    if (extra) await extra();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
    results.push({ name, ok: true, ms: Date.now() - started });
  } catch (err) {
    await page.screenshot({ path: path.join(artifacts, `${name}-FAILED.png`) }).catch(() => undefined);
    results.push({ name, ok: false, error: err.message.split('\n')[0] });
  }
}

await page.waitForSelector('.app', { timeout: 30000 });

await step('home', '#/', '.hero-title', () => page.waitForSelector('.grid.six .mcard img, .rank-item', { timeout: 30000 }));
await step('home-latest', '#/', '.grid.six .mcard img', () => page.evaluate(() => document.querySelector('.grid.six')?.scrollIntoView({ block: 'start' })));
await step('context-menu', '#/', '.grid.six .mcard', async () => {
  await page.click('.grid.six .mcard', { button: 'right' });
  await page.waitForSelector('.ctx-menu', { timeout: 5000 });
});
await page.keyboard.press('Escape');
const firstId = await page.evaluate(() => {
  const el = document.querySelector('.rank-item');
  el?.click();
  return location.hash;
});
await step('details', firstId.startsWith('#/anime/') ? firstId : '#/anime/21', '.details-title');
await step('browse', '#/browse?genres=Action&sort=SCORE_DESC', '.mcard img');
await step('schedule', '#/schedule', '.days', () => page.waitForSelector('.slot, .state h3', { timeout: 45000 }));
await step('sources', '#/sources', '.source-tile');
const watchHash = `${(firstId.startsWith('#/anime/') ? firstId : '#/anime/21').replace('/anime/', '/watch/')}/1`;
await step('watch-loading', watchHash, '.ep-panel', () => page.waitForSelector('.cat-loader, .player, .state', { timeout: 30000 }));
await step('watch', watchHash, '.ep-panel', () => page.waitForSelector('.cat-loader', { state: 'detached', timeout: 120000 }).catch(() => undefined));
await step('profile', '#/profile', '.profile-head');
// A title that hasn't premiered shows its release date instead of a player.
const upcomingId = await page.evaluate(() => window.aniverse.invoke('meta.home', undefined).then((h) => h.upcoming[0]?.id ?? null)).catch(() => null);
if (upcomingId) await step('release', `#/watch/${upcomingId}/1`, '.release', () => page.waitForSelector('.release-when strong'));
await step('library', '#/library', '.tabs');
await step('player', '#/player', '.screen');
await step('settings-sources', '#/settings/sources', '.source-row');
await step('settings-accounts', '#/settings/accounts', '.setting');
await step('settings-privacy', '#/settings/privacy', '.setting');
await step('about', '#/settings/about', '.card-pad.help');

// Native player: public Big Buck Bunny / Sintel test streams (Creative Commons).
const STREAMS = {
  'player-hls': 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  'player-dash': 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd',
  'player-mp4': 'https://media.w3.org/2010/05/sintel/trailer.mp4',
};
for (const [name, url] of Object.entries(STREAMS)) {
  await step(name, '#/player', '.screen', async () => {
    await page.fill('input[aria-label="Stream URL"]', url);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForSelector('video', { timeout: 15000 });
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && v.currentTime > 2 && !v.paused;
    }, undefined, { timeout: 30000 });
    const state = await page.evaluate(() => {
      const v = document.querySelector('video');
      return { t: Math.round(v.currentTime), w: v.videoWidth, quality: !!document.querySelector('[aria-label="Quality"]') };
    });
    if (!state.w) throw new Error(`no video frames (${JSON.stringify(state)})`);
    if (name !== 'player-mp4' && !state.quality) throw new Error('no quality levels exposed');
    await page.mouse.move(700, 500);
  });
}

const info = await page.evaluate(() => window.aniverse?.invoke('app.info', undefined)).catch((e) => ({ error: e.message }));
const adblock = await page.evaluate(() => window.aniverse?.invoke('adblock.stats', undefined)).catch((e) => ({ error: e.message }));
await app.close();

console.log(JSON.stringify({ info, adblock, results, errors: errors.slice(0, 20) }, null, 2));
process.exit(results.every((r) => r.ok) && errors.length === 0 ? 0 : 1);
