import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const cache = await mkdtemp(resolve('test/cache/home-startup-'));
const fixture = await build({ stdin: {
  contents: [
    "import { QueryClient, QueryClientProvider } from '@tanstack/react-query';",
    "import { createRoot } from 'react-dom/client';",
    "import { MemoryRouter } from 'react-router';",
    "import { HomePage } from './frontend/src/pages/Home';",
    "import { ToastProvider } from './frontend/src/lib/toast';",
    "const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });",
    "createRoot(document.querySelector('.main')).render(<QueryClientProvider client={client}><MemoryRouter><ToastProvider><HomePage /></ToastProvider></MemoryRouter></QueryClientProvider>);",
  ].join('\n'), loader: 'tsx', resolveDir: process.cwd(),
}, outdir: cache, write: false, bundle: true, minify: true, jsx: 'automatic', define: {'process.env.NODE_ENV': '"production"'} });
const css = (await readFile('frontend/src/styles/app.css', 'utf8')) + (fixture.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '');
const script = fixture.outputFiles.find(file => file.path.endsWith('.js')).text;
const html = '<!doctype html><html data-aniverse-edition="2"><head><meta charset="utf-8"><style>' + css +
  '</style></head><body><div class="app layout-classic"><header class="topbar"></header><nav class="rail"></nav><main class="main"></main></div><script src="/fixture.js"></script></body></html>';
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/rQkAAAAASUVORK5CYII=', 'base64');
const firstBanner = Promise.withResolvers();
const requests = [];
const report = {};
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--disable-background-networking'], env: { ...process.env, TEMP: cache, TMP: cache, TMPDIR: cache } });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, reducedMotion: 'no-preference' });
  page.on('request', request => { if (request.url().includes('/banner-')) requests.push(new URL(request.url()).pathname); });
  await page.addInitScript(() => {
    const card = (id) => ({ id, title: { userPreferred: 'Title ' + id }, cover: '/cover-' + id + '.png',
      banner: '/banner-' + id + '.png', genres: [], episodes: 12, format: 'TV' });
    const cards = Array.from({ length: 36 }, (_, i) => card(i + 1));
    const pending = Promise.withResolvers();
    const intervals = new Set();
    const set = window.setInterval.bind(window);
    const clear = window.clearInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      const timer = set(callback, delay, ...args);
      if (delay === 7000) intervals.add(timer);
      return timer;
    };
    window.clearInterval = timer => { intervals.delete(timer); clear(timer); };
    window.homeFixture = { load: pending.resolve, intervals };
    window.aniverse = { edition: 'aniverse2', platform: 'win32', on: () => () => undefined, invoke: async method => {
      if (method === 'settings.get') return { appearance: {} };
      if (method === 'library.continue') return [];
      await pending.promise;
      if (method === 'meta.home') return {
        spotlight: cards.slice(0, 10), trending: cards.slice(10, 20), popularSeason: cards.slice(16, 30),
        topRated: [], upcoming: [], season: { season: 'WINTER', year: 2026 },
      };
      if (method === 'meta.latest') return { items: cards.map(media => ({ id: media.id, media, episode: 1, airingAt: 1760000000 })), hasNext: false };
      throw new Error('Unexpected mock RPC ' + method);
    } };
  });
  await page.route('http://home.aniverse.test/**', async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (pathname === '/fixture.js') return route.fulfill({ contentType: 'application/javascript', body: script });
    if (pathname === '/banner-1.png') await firstBanner.promise;
    return route.fulfill({ contentType: 'image/png', body: pixel });
  });
  await page.goto('http://home.aniverse.test/');
  const heroSkeleton = page.locator('.hero.skeleton[data-home-shimmer]');
  const latestSkeleton = page.locator('.latest-episodes .skeleton[data-home-shimmer]');
  await heroSkeleton.waitFor();
  await latestSkeleton.waitFor();
  const loadingPaint = () => page.locator('.skeleton').evaluateAll(nodes => ({
    placeholders: nodes.length,
    animated: nodes.filter(node => getComputedStyle(node).animationName !== 'none').length,
  }));
  report.loading = await loadingPaint();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal((await loadingPaint()).animated, 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const popular = page.getByRole('heading', { name: 'Popular this season' });
  const seasonSkeleton = page.locator('.section').filter({ has: popular }).locator('.skeleton[data-home-shimmer]');
  assert.equal(await seasonSkeleton.count(), 0, 'Below-fold loading work should stay static');
  await popular.scrollIntoViewIfNeeded();
  await heroSkeleton.waitFor({ state: 'detached' });
  await seasonSkeleton.waitFor();
  await page.locator('.main').evaluate(main => { main.scrollTop = 0; });
  await heroSkeleton.waitFor();
  await page.evaluate(() => window.homeFixture.load());
  await page.getByRole('heading', { name: 'Title 1' }).waitFor();
  await page.waitForFunction(() => window.homeFixture.intervals.size === 1);
  report.initialBannerNodes = await page.locator('.hero-slide img').count();
  report.initialBannerRequests = [...requests];
  firstBanner.resolve();
  await page.locator('.hero-slide.active img').evaluate(image => image.decode());
  await page.locator('.hero-slide:nth-child(2) img').evaluate(image => image.decode());
  await page.getByRole('button', { name: 'Slide 2', exact: true }).click();
  await page.getByRole('heading', { name: 'Title 2' }).waitFor();
  await page.locator('.hero-slide:nth-child(3) img').evaluate(image => image.decode());
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => window.homeFixture.intervals.size === 1);
  await page.locator('.main').evaluate(main => { main.scrollTop = 1100; });
  await page.waitForFunction(() => window.homeFixture.intervals.size === 0, null, { timeout: 1800 });
  report.offscreenIntervalCount = await page.evaluate(() => window.homeFixture.intervals.size);
  await page.locator('.main').evaluate(main => { main.scrollTop = 0; });
  await page.waitForFunction(() => window.homeFixture.intervals.size === 1);
  await page.getByRole('button', { name: 'Slide 7' }).click();
  await page.getByRole('heading', { name: 'Title 7' }).waitFor();
  await page.locator('.hero-slide.active img').evaluate(image => image.decode());
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('heading', { name: 'Title 8' }).waitFor();
  assert.equal(await page.locator('.hero-slide:nth-child(7) img').count(), 1, 'Keep outgoing artwork during the transition');
  await page.getByRole('button', { name: 'Previous' }).click();
  await page.getByRole('heading', { name: 'Title 7' }).waitFor();
  assert.equal(await page.locator('.latest-episodes .mcard').count(), 36);
  report.navigation = true;
  assert.deepEqual(report.loading, { placeholders: 55, animated: 2 });
  assert.equal(report.initialBannerNodes, 1);
  assert.deepEqual(report.initialBannerRequests, ['/banner-1.png']);
  assert.equal(report.offscreenIntervalCount, 0);
  report.passed = true;
} finally {
  firstBanner.resolve();
  await browser.close();
  await writeFile(resolve('test/artifacts/aniverse2-home-startup-after.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}