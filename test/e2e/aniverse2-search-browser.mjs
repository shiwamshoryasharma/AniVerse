import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = process.cwd();
const run = await mkdtemp(resolve('test/cache/search-browser-'));
const report = { passed: false, checks: {}, consoleErrors: [] };
const built = await build({ stdin: {
  contents: [
    "import { QueryClient, QueryClientProvider } from '@tanstack/react-query';",
    "import { createRoot } from 'react-dom/client';",
    "import { MemoryRouter, useLocation } from 'react-router';",
    "import { DesktopSearch } from './frontend/src/components/DesktopSearch';",
    "import { useBridgeEvents } from './frontend/src/lib/queries';",
    "const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });",
    "function Fixture() { useBridgeEvents(client); const { pathname } = useLocation();",
    "return <><header className='topbar tauri-topbar'><div className='brand'>AniVerse2</div><DesktopSearch /><div className='spacer' /><button>Outside search</button></header><main className='main' data-path={pathname} /></>; }",
    "createRoot(document.querySelector('.app')).render(<QueryClientProvider client={client}><MemoryRouter><Fixture /></MemoryRouter></QueryClientProvider>);",
  ].join('\n'), loader: 'tsx', resolveDir: root, sourcefile: 'search-browser-fixture.tsx',
}, outdir: run, write: false, bundle: true, jsx: 'automatic' });
const css = (await Promise.all(['frontend/src/styles/app.css', 'frontend/src/styles/desktop-display.css'].map(
  file => readFile(join(root, file), 'utf8'),
))).join('\n') + built.outputFiles.find(file => file.path.endsWith('.css')).text;
const script = built.outputFiles.find(file => file.path.endsWith('.js')).text;
const html = '<!doctype html><html data-aniverse-edition="2" lang="en"><head><meta charset="utf-8"><style>' + css +
  '</style></head><body><div class="app"></div><script src="/fixture.js"></script></body></html>';

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--disable-background-networking'], env: { ...process.env, TEMP: run, TMP: run, TMPDIR: run },
});
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => report.consoleErrors.push(String(error)));
  await page.addInitScript(() => {
    const card = (id, title, genres) => ({
      id, title: { userPreferred: title, english: title, native: null, romaji: null }, genres,
      cover: '', banner: null, format: 'TV', status: 'FINISHED', episodes: 3, score: 85, seasonYear: 2025,
    });
    const watched = card(11, 'Forest Signal', ['Adventure']);
    const similar = card(12, 'River Expedition', ['Adventure']);
    const trending = card(13, 'City Melody', ['Music']);
    const privateTitle = card(14, 'Hidden Expedition', ['Adventure']);
    const requests = [];
    const listeners = new Map();
    let privacy = { incognito: false, privateMediaIds: [privateTitle.id] };
    window.fixture = {
      requests,
      incognito: () => {
        privacy = { ...privacy, incognito: true };
        for (const listener of listeners.get('privacy.changed') ?? []) listener(privacy);
      },
    };
    window.aniverse = {
      edition: 'aniverse2', platform: 'win32',
      on: (event, handler) => {
        const handlers = listeners.get(event) ?? new Set();
        listeners.set(event, handlers);
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      invoke: async (method, input) => {
        requests.push({ method, input });
        if (method === 'privacy.state') return privacy;
        if (method === 'meta.home') return { trending: [trending, watched, similar, privateTitle], popularSeason: [], topRated: [], spotlight: [] };
        if (method === 'library.history') return [{ media: { id: watched.id, title: 'Forest Signal' } }];
        if (method === 'meta.search') return [watched, privateTitle];
        if (method === 'library.state' && input.mediaId === watched.id) return {
          entry: null, favourite: false, pinned: {}, progress: [1, 2, 3].map(episode => ({ episode, completed: true })),
        };
        if (method === 'settings.get') return { appearance: { titleLanguage: 'english' } };
        throw Error('Unexpected fixture call ' + method);
      },
    };
  });
  await page.route('http://search.aniverse.test/**', route => route.fulfill(route.request().url().endsWith('/fixture.js')
    ? { contentType: 'application/javascript', body: script }
    : { contentType: 'text/html', body: html }));
  await page.goto('http://search.aniverse.test/');
  const search = page.getByRole('combobox', { name: 'Search anime' });
  await search.waitFor();
  assert.equal(await page.evaluate(() => window.fixture.requests.filter(rpc => rpc.method.startsWith('library.')).length), 0);
  await search.click();
  await page.getByText('For you', { exact: true }).waitFor();
  await page.getByRole('option', { name: /River Expedition/ }).waitFor();
  assert.deepEqual(await page.getByRole('option').allTextContents(), ['River ExpeditionAdventure · 2025']);
  const bounds = await page.getByRole('listbox').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 641);
  report.checks.focusTasteAndWatchedExclusion = true;
  report.checks.compactViewport = true;

  await search.press('Escape');
  assert.equal(await search.getAttribute('aria-expanded'), 'false');
  await page.getByRole('button', { name: 'Outside search' }).focus();
  await page.keyboard.press('Control+k');
  assert.equal(await search.evaluate(input => input === document.activeElement), true);
  assert.equal(await search.getAttribute('aria-expanded'), 'true');
  await search.fill('forest');
  const seen = page.getByRole('option', { name: /Forest Signal/ });
  await seen.getByText('Completed', { exact: true }).waitFor();
  assert.equal(await page.getByRole('option', { name: /Hidden Expedition/ }).getByText('Completed').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.fixture.requests.filter(rpc => rpc.method === 'library.state').map(rpc => rpc.input.mediaId)), [11]);
  await search.press('Enter');
  await page.locator('main[data-path="/anime/11"]').waitFor();
  report.checks.shortcutTypedWatchedAndCompleted = true;

  await page.evaluate(() => { window.fixture.requests.length = 0; window.fixture.incognito(); });
  await search.click();
  await page.getByText('Trending anime', { exact: true }).waitFor();
  await page.getByRole('option', { name: /City Melody/ }).waitFor();
  await search.fill('forest');
  await seen.waitFor();
  assert.equal(await seen.getByText('Completed', { exact: true }).count(), 0);
  assert.deepEqual(await page.evaluate(() => window.fixture.requests.map(rpc => rpc.method).filter(
    method => method.startsWith('library.') || method === 'meta.details',
  )), []);
  assert.deepEqual(report.consoleErrors, []);
  report.checks.incognitoNoPersonalRequests = true;
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await browser.close();
  await mkdir('test/artifacts', { recursive: true });
  await writeFile('test/artifacts/aniverse2-search-browser.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
