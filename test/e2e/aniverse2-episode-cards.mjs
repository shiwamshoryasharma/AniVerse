import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const run = await mkdtemp(resolve('test/cache/episode-cards-'));
const fixture = await build({ stdin: {
  contents: [
    "import { createRoot } from 'react-dom/client';",
    "import { EpisodePanel } from './frontend/src/components/EpisodePanel';",
    "import { pageScript } from './electron/sitePage';",
    "window.readCards=options=>(0,eval)(pageScript({op:'episodeCards',slug:null,...options}));",
    "if (document.querySelector('#panel')) createRoot(document.querySelector('#panel')).render(<EpisodePanel total={24} current={2}",
    "  watched={new Set([1])} available={new Set([1,2])} titles={new Map([[1,'A watched episode'],[2,'An available episode']])}",
    "  thumbs={new Map([1,2,3].map(id=>[id,window.preview]))} audio={new Map(Array.from({length:24},(_,i)=>[i+1,['sub','dub']]))}",
    "  onSelect={()=>{}} spoilerShield />);",
  ].join('\n'), loader: 'tsx', resolveDir: process.cwd(),
}, outdir: run, write: false, bundle: true, jsx: 'automatic' });
const script = fixture.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = (await Promise.all(['frontend/src/styles/app.css', 'frontend/src/styles/layouts.css', 'frontend/src/styles/themes.css']
  .map(file => readFile(file, 'utf8')))).join('\n');
const pageHtml = (body) => '<!doctype html><html data-aniverse-edition="2"><head><meta charset="utf-8"><style>' +
  css + '</style></head><body>' + body + '<script src="/fixture.js"></script></body></html>';
const source = Array.from({ length: 28 }, (_, i) => {
  const host = i === 18 ? 'http://art.example.test' : 'http://episode.example.test';
  const lazy = i === 20 ? ' data-src="/not-yet-loaded.svg"' : '';
  return '<button data-episode="' + (i + 1) + '">Episode ' + (i + 1) +
    ' <b>SUB</b><img src="' + host + '/art.svg"' + lazy + ' alt=""></button>';
}).join('');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#176383"/></svg>';
const report = { passed: false };
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--disable-background-networking'], env: { ...process.env, TEMP: run, TMP: run, TMPDIR: run },
});
try {
  const page = await browser.newPage({ viewport: { width: 750, height: 440 } });
  await page.route('http://*.example.test/**', async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/art.svg') return route.fulfill({ contentType: 'image/svg+xml', body: svg });
    if (pathname === '/fixture.js') return route.fulfill({ contentType: 'application/javascript', body: script });
    const body = pathname === '/panel'
      ? '<main class="layout-classic" style="width:380px"><div id="panel"></div></main>'
      : '<section class="episode-list">' + source + '</section>';
    return route.fulfill({ contentType: 'text/html', body: pageHtml(body) });
  });
  await page.goto('http://episode.example.test/');
  await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
  const cards = await page.evaluate(() => window.readCards({ thumbnailNear: 19 }));
  assert.equal(cards.length, 28);
  const withArtwork = cards.filter(card => card.thumbnail);
  assert.equal(withArtwork.length, 16);
  assert.ok(withArtwork.every(card => card.thumbnail.length <= 10240 && card.thumbnail.startsWith('data:image/jpeg;base64,/9j/')));
  assert.equal(cards[18].thumbnail, null, 'Cross-origin image pixels must stay unreadable');
  assert.equal(cards[20].thumbnail, null, 'A not-yet-loaded real still must not be replaced by its placeholder');
  assert.equal(cards[0].thumbnail, null, 'The call must prioritize cards nearest the current episode');
  assert.deepEqual(cards[19].audio, ['sub']);
  report.sourcePreviews = withArtwork.length;

  await page.addInitScript(preview => { window.preview = preview; }, cards[19].thumbnail);
  await page.goto('http://episode.example.test/panel');
  const exactSize = await page.locator('.ep-thumb img').first().evaluate(async image => {
    await image.decode();
    return [image.naturalWidth, image.naturalHeight];
  });
  assert.deepEqual(exactSize, [192, 108]);
  assert.equal(await page.locator('.ep-row[aria-label="Episode 3 is not available on this source"] img').count(), 0);
  for (const layout of ['classic', 'studio', 'atlas', 'cinema', 'dock']) {
    await page.evaluate(layout => { document.querySelector('main').className = 'layout-' + layout; }, layout);
    const clipped = await page.locator('.ep-row').evaluateAll(rows => rows.some(row =>
      row.querySelector('.ep-state').getBoundingClientRect().bottom > row.getBoundingClientRect().bottom - 1));
    assert.equal(clipped, false, layout + ' must fit the status line after three other lines');
  }
  report.styles = 5;
  report.passed = true;
} finally {
  await browser.close();
  await writeFile(resolve('test/artifacts/aniverse2-episode-cards.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}