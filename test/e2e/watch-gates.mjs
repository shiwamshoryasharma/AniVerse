// Checks the Watch page gates on the built app:
//  - an unreleased / in-cinema title shows the release page instead of a player,
//  - a website source never shows the site before the loader covers it,
//  - the running-cat loader advances ~8 drawings per second (16 fps on twos).
// Run `npm run build` first.   node test/e2e/watch-gates.mjs [unreleasedId] [releasedId]
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [unreleased = '160275', released = '154587'] = process.argv.slice(2);
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [root],
  cwd: root,
  env: { ...process.env, ANIVERSE_HEADLESS: '1', ANIVERSE_DATA_DIR: path.join(root, 'test', 'cache', 'e2e-profile') },
  timeout: 60000,
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
await page.waitForSelector('.app');
const out = {};

await page.evaluate((id) => (location.hash = `#/watch/${id}/1`), unreleased);
await page.waitForSelector('.release, .ep-panel', { timeout: 30000 });
out.release = await page.evaluate(() => ({
  gated: !!document.querySelector('.release'),
  kicker: document.querySelector('.release-kicker')?.textContent?.trim(),
  when: document.querySelector('.release-when')?.textContent?.trim(),
  webview: !!document.querySelector('webview'),
}));
await page.screenshot({ path: path.join(root, 'test', 'artifacts', 'release-gate.png') });

// Sample the Watch page of a released title every 50 ms while the site loads.
await page.evaluate((id) => (location.hash = `#/watch/${id}/1`), released);
// The drawing order as shown on screen (one digit per change) and whether every frame decoded.
await page.waitForSelector('.cat-frame.on', { timeout: 15000 }).catch(() => undefined);
out.catOrder = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const seq = [];
      const end = performance.now() + 3000;
      const step = () => {
        const n = Number(/frame-0?(\d+)/.exec(document.querySelector('.cat-frame.on')?.getAttribute('src') ?? '')?.[1] ?? 0);
        if (n && seq.at(-1) !== n) seq.push(n);
        if (performance.now() < end) requestAnimationFrame(step);
        else resolve({ sequence: seq.join(''), decoded: [...document.querySelectorAll('.cat-frame')].map((i) => i.naturalWidth > 0) });
      };
      requestAnimationFrame(step);
    }),
);
const samples = [];
for (let i = 0; i < 120; i++) {
  samples.push(
    await page.evaluate(() => ({
      t: performance.now(),
      webview: !!document.querySelector('webview'),
      loader: !!document.querySelector('.cat-loader'),
      site: !!document.querySelector('.screen.site'),
      frame: document.querySelector('.cat-frame.on')?.getAttribute('src') ?? null,
    })),
  );
  await page.waitForTimeout(50);
}
const withLoader = samples.filter((s) => s.loader && s.frame);
let changes = 0;
for (let i = 1; i < withLoader.length; i++) if (withLoader[i].frame !== withLoader[i - 1].frame) changes++;
const seconds = withLoader.length > 1 ? (withLoader.at(-1).t - withLoader[0].t) / 1000 : 0;
out.leak = { samples: samples.length, siteVisibleWithoutLoader: samples.filter((s) => s.webview && !s.loader).length };
out.cat = { seconds: +seconds.toFixed(2), drawingsPerSecond: seconds ? +(changes / seconds).toFixed(1) : null };
await app.close();
console.log(JSON.stringify(out, null, 2));
