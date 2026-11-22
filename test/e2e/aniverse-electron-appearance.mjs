import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright-core';
import { checkAppearance } from './fixtures/aniverse-electron-appearance.mjs';

const run = await mkdtemp(resolve('test/cache/electron-appearance-'));
await build({ configFile: 'frontend/vite.config.ts', logLevel: 'error', build: { outDir: run } });
const types = { html: 'text/html', css: 'text/css', js: 'application/javascript', svg: 'image/svg+xml', woff2: 'font/woff2', webp: 'image/webp' };
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--disable-background-networking'], env: { ...process.env, TEMP: run, TMP: run, TMPDIR: run },
});
const report = { passed: false };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    const appearance = JSON.parse(localStorage.getItem('fixture-appearance') ?? '{}');
    let settings = {
      appearance: { style: 'classic', accent: 'ember', density: 'compact', titleLanguage: 'english', fontFamily: 'inter', ...appearance },
      profile: { name: 'Viewer' }, privacy: { adblock: true, blockPopups: true }, updates: {},
      player: { upscale: { enabled: false, mode: 'A', darken: false, thin: false } },
    };
    window.aniverse = {
      modernWindows: true, platform: 'win32', on: () => () => undefined,
      async invoke(method, input) {
        if (method === 'settings.get') return settings;
        if (method === 'settings.set') {
          settings = { ...settings, appearance: { ...settings.appearance, ...input.appearance } };
          localStorage.setItem('fixture-appearance', JSON.stringify(settings.appearance));
          return settings;
        }
        if (method === 'app.info') return { platform: 'win32', version: '2.3.0' };
        if (method === 'adblock.stats') return { enabled: true, ready: true, blocked: { example: 5 }, securityBlocked: { example: 2 }, popupsBlocked: { example: 1 } };
        if (method === 'privacy.state') return { incognito: false, privateMediaIds: [] };
        return [];
      },
    };
  });
  await page.route('http://appearance.aniverse.test/**', async route => {
    const part = new URL(route.request().url()).pathname;
    const file = resolve(run, part === '/' ? 'index.html' : '.' + part);
    try {
      return await route.fulfill({ contentType: types[file.split('.').at(-1)], body: await readFile(file) });
    } catch {
      return route.fulfill({ status: 404 });
    }
  });
  await page.goto('http://appearance.aniverse.test/#/settings/themes');
  await page.getByRole('group', { name: 'AniVerse themes' }).waitFor();
  assert.equal(await page.locator('.brand .word').textContent(), 'AniVerse');
  assert.equal(await page.locator('html').getAttribute('data-aniverse-edition'), null);
  await page.getByRole('button', { name: 'Original colours', pressed: true }).waitFor();
  report.appearance = await checkAppearance(context, page);
  await page.evaluate(() => { location.hash = '#/settings/graphics'; });
  await page.getByRole('heading', { name: 'Display & window' }).waitFor();
  await page.getByRole('combobox', { name: 'Interface scale' }).click();
  await page.getByRole('option', { name: '115% interface scale' }).click();
  assert.equal(await page.locator('html').getAttribute('data-display-scale'), '115');
  await page.reload();
  await page.getByRole('heading', { name: 'Display & window' }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-display-scale'), '115');
  await page.getByRole('tab', { name: 'Compatibility video' }).click();
  await page.getByRole('heading', { name: 'Video on GTX and integrated GPUs' }).waitFor();
  await page.evaluate(() => { location.hash = '#/settings/privacy'; });
  await page.getByRole('button', { name: 'View report' }).click();
  await page.getByText('8 blocked actions').waitFor();
  assert.deepEqual(errors, []);
  report.displayAndBlocking = true;
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await browser.close();
  await mkdir(resolve('test/artifacts'), { recursive: true });
  await writeFile(resolve('test/artifacts/aniverse-electron-appearance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}