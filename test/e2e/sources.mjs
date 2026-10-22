// Live source checks against the real sites in config/streaming-sites.txt:
// YouTube channel episodes (RSS), website search discovery, isolated web
// sessions and Cloudflare handling. Needs network access; run `npm run build` first.
import { _electron as electron } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifacts = path.join(root, 'test', 'artifacts');
mkdirSync(artifacts, { recursive: true });

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [root],
  cwd: root,
  env: { ...process.env, ANIVERSE_HEADLESS: '1', ANIVERSE_DATA_DIR: path.join(root, 'test', 'cache', 'e2e-profile') },
  timeout: 60000,
});
const page = await app.firstWindow();
await page.waitForSelector('.app');
await page.evaluate(() => {
  window.__events = [];
  for (const e of ['cloudflare.status', 'app.notice', 'adblock.stats']) window.aniverse.on(e, (p) => window.__events.push({ e, p: e === 'adblock.stats' ? { ready: p.ready, blocked: p.blocked } : p }));
});

const rpc = (method, input) => page.evaluate(([m, i]) => window.aniverse.invoke(m, i).catch((e) => ({ error: e.message, code: e.code })), [method, input]);
const shot = (name) => page.screenshot({ path: path.join(artifacts, `${name}.png`) });
const report = {};

const query = process.env.SOURCES_QUERY ?? 'Sasaki and Peeps Season 2';
const hits = await rpc('meta.search', { q: query });
const media = hits[0];
report.media = media ? { id: media.id, title: media.title.english ?? media.title.romaji } : hits;
const ref = { id: media.id, idMal: media.idMal, titles: [media.title.english, media.title.romaji].filter(Boolean), episodes: media.episodes, format: media.format, seasonYear: media.seasonYear };

// 0. AniList browse filters (each combination must return results, not a 500).
report.browse = {};
for (const [label, q] of Object.entries({
  genre: { genres: ['Action'], sort: 'SCORE_DESC' },
  country: { country: 'KR' },
  format: { formats: ['MOVIE'], minScore: 80 },
  airing: { status: 'RELEASING', season: 'FALL', year: 2026 },
  search: { search: 'frieren' },
  excludeLibrary: { excludeLibrary: true, excludedGenres: ['Comedy'], minEpisodes: 2, maxEpisodes: 13 },
})) {
  const r = await rpc('meta.browse', q);
  report.browse[label] = r.error ? `ERROR ${r.error}` : `${r.total} results`;
}

// 1. Official YouTube channel via RSS.
const yt = await rpc('sources.match', { sourceId: 'yt-museasia', media: ref });
report.youtube = yt.error ? yt : { episodes: yt.episodes.map((e) => `${e.number}: ${e.title}`), note: yt.note };
if (!yt.error && yt.episodes.length) {
  const ep = yt.episodes[yt.episodes.length - 1].number;
  await page.evaluate(([id, n]) => (location.hash = `#/watch/${id}/${n}?source=yt-museasia`), [media.id, ep]);
  await page.waitForSelector('.websession', { timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(9000);
  await shot('src-youtube');
}

// Website checks use source ids from your own config/streaming-sites.txt (the host with
// dots as dashes: https://example.to → example-to), each optional:
//   FORM_SOURCE  a site with a GET search form
//   SPA_SOURCE   a single-page-app site (no discoverable search → homepage + note)
//   CF_SOURCE    a Cloudflare-protected site
const { FORM_SOURCE, SPA_SOURCE, CF_SOURCE } = process.env;

// 2. Website with a GET search form.
if (FORM_SOURCE) {
  const form = await rpc('sources.match', { sourceId: FORM_SOURCE, media: ref });
  report.form = form.error ? form : { pageUrl: form.pageUrl, note: form.note };
  await page.evaluate(([id, src]) => (location.hash = `#/watch/${id}/1?source=${src}`), [media.id, FORM_SOURCE]);
  await page.waitForSelector('.websession', { timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(10000);
  await shot('src-form');
}

// 3. Single-page-app website.
if (SPA_SOURCE) {
  const spa = await rpc('sources.match', { sourceId: SPA_SOURCE, media: ref });
  report.spa = spa.error ? spa : { pageUrl: spa.pageUrl, note: spa.note };
}

// 4. Cloudflare-protected site: discovery triggers the verification flow.
if (CF_SOURCE) {
  const cf = await Promise.race([rpc('sources.discover', { id: CF_SOURCE }), new Promise((r) => setTimeout(() => r({ timeout: '75s' }), 75000))]);
  report.cloudflare = cf.error || cf.timeout ? cf : { searchTemplate: cf.searchTemplate, via: cf.searchTemplateSource };
}

report.events = await page.evaluate(() => window.__events.filter((e) => e.e !== 'adblock.stats').slice(0, 12));
report.adblock = await rpc('adblock.stats');
await app.close();
console.log(JSON.stringify(report, null, 2));
