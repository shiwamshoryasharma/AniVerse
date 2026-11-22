// Hidden Electron restart regression. Build first: npm run build
// Run: node test/e2e/theme-startup.mjs
// Profiles, neutral config, temporary files, screenshots and reports stay under test/.
import assert from 'node:assert/strict';
import { _electron } from 'playwright-core';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cache = path.join(root, 'test/cache/theme-startup-3.1.0');
mkdirSync(cache, { recursive: true });
const run = mkdtempSync(path.join(cache, 'run-'));
const artifacts = path.join(root, 'test/artifacts/theme-startup-3.1.0', path.basename(run));
const profile = path.join(run, 'profile');
const config = path.join(run, 'config');
const temporary = path.join(run, 'temp');
for (const folder of [artifacts, profile, config, temporary]) mkdirSync(folder, { recursive: true });
writeFileSync(path.join(config, 'streaming-sites.txt'), '# Isolated theme fixture; no website sources\n');
writeFileSync(path.join(config, 'filters.txt'), '! Isolated theme fixture\n');
writeFileSync(path.join(config, 'site-recipes.json'), '{}\n');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const reports = [], errors = [];
const result = { version, packaged: false, run, artifacts, startedAt: new Date().toISOString(), passed: false, reports, errors };
let app = null;
let activePage = null;
let stage = 'seed';

// Seed only this disposable profile; disable account sync, updates and playback.
await build({
  stdin: { contents: "export { Store } from './app/core/db/store';", resolveDir: root },
  outfile: path.join(run, 'seed.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['node:sqlite'], logLevel: 'warning',
});
const { Store } = createRequire(import.meta.url)(path.join(run, 'seed.cjs'));
const seed = new Store(path.join(profile, 'aniverse.db'));
seed.setKv('settings', {
  appearance: { style: 'classic', accent: 'ember' },
  accounts: { autoSync: false, twoWay: false },
  privacy: { adblock: false, watchInsights: false },
  updates: { autoCheck: false, autoDownload: false },
  player: { autoplay: false },
});
seed.setKv('theme:festival-2026', { previous: 'ember', automatic: false });
seed.setKv('changelog:lastSeen', version);
seed.close();

async function launch(pass) {
  stage = `launch-${pass}`;
  app = await _electron.launch({
    executablePath: createRequire(import.meta.url)('electron'), args: [root], cwd: root, timeout: 60000,
    env: { ...process.env, ANIVERSE_HEADLESS: '1', ANIVERSE_DATA_DIR: profile, ANIVERSE_CONFIG_DIR: config,
      TEMP: temporary, TMP: temporary, TMPDIR: temporary },
  });
  // Best-effort early renderer observation. A missing sample does not prove
  // anything about the first native window paint, which this harness cannot see.
  await app.context().addInitScript(() => {
    const samples = [];
    Object.defineProperty(window, '__themeStartupSamples', { value: samples });
    const capture = reason => {
      const element = document.documentElement;
      if (!element || samples.length >= 40) return;
      const css = getComputedStyle(element);
      samples.push({ reason, at: Math.round(performance.now()), theme: element.dataset.aniverse2Theme ?? null,
        style: element.dataset.style ?? null, layout: element.dataset.layout ?? null,
        accent: css.getPropertyValue('--accent').trim(), background: css.getPropertyValue('--bg').trim(),
        header: element.style.getPropertyValue('--av2-header'), appPresent: !!document.querySelector('.app') });
    };
    const start = () => {
      capture('initial');
      new MutationObserver(() => capture('root attributes')).observe(document.documentElement, { attributes: true });
      requestAnimationFrame(() => capture('animation frame'));
      document.addEventListener('DOMContentLoaded', () => capture('DOMContentLoaded'), { once: true });
    };
    if (document.documentElement) start();
    else new MutationObserver((_, observer) => { if (document.documentElement) { observer.disconnect(); start(); } }).observe(document, { childList: true });
  });
  activePage = await app.firstWindow();
  activePage.on('pageerror', error => errors.push({ pass, message: error.message }));
  await activePage.waitForSelector('.app', { timeout: 30000 });
  await activePage.waitForFunction(() => !!document.documentElement.dataset.style);
  await activePage.evaluate(() => document.fonts.ready);
  assert.ok(!new URL(activePage.url()).hash.includes('settings'), 'Relaunch must start on Home, before importing Settings');
  reports.push({ name: `launch-${pass}`, pid: app.process().pid,
    earlyObservation: await activePage.evaluate(() => window.__themeStartupSamples ?? null) });
  return activePage;
}

async function close() {
  activePage = null;
  const current = app; app = null;
  await current?.close();
}

async function themes(page) {
  await page.evaluate(() => { location.hash = '#/settings/themes'; });
  await page.waitForSelector('.av2-theme-grid');
}

async function home(page) {
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('.home-page');
}

async function inspect(page, name) {
  stage = name;
  const observed = await page.evaluate(async () => {
    const settings = await window.aniverse.invoke('settings.get');
    const element = document.documentElement;
    const css = getComputedStyle(element);
    const topbar = document.querySelector('.topbar');
    return { persisted: { style: settings.appearance.style, accent: settings.appearance.accent },
      savedPalette: localStorage.getItem('aniverse2.palette'),
      savedColours: JSON.parse(localStorage.getItem('aniverse2.colours.v1') || '{}'),
      savedLayout: localStorage.getItem('aniverse2.layout'),
      rendered: { theme: element.dataset.aniverse2Theme ?? null, style: element.dataset.style, layout: element.dataset.layout,
        accent: element.dataset.accent, header: element.style.getPropertyValue('--av2-header'), buttons: element.style.getPropertyValue('--av2-buttons') },
      tokens: { accent: css.getPropertyValue('--accent').trim().toLowerCase(), background: css.getPropertyValue('--bg').trim().toLowerCase() },
      topbarBackground: topbar ? getComputedStyle(topbar).backgroundColor : null,
      bodyBackground: getComputedStyle(document.body).backgroundColor };
  });
  reports.push({ name, ...observed });
  return observed;
}

function verify(observed, expected, message) {
  assert.equal(observed.savedPalette, expected.theme, `${message}: saved palette`);
  assert.deepEqual(observed.savedColours, expected.colours, `${message}: saved layer colours`);
  assert.equal(observed.rendered.theme, expected.theme, `${message}: root theme must be restored on Home before Settings loads`);
  assert.equal(observed.persisted.style, 'paper', `${message}: persisted Cinema layout`);
  assert.equal(observed.rendered.style, 'paper', `${message}: root style`);
  assert.equal(observed.rendered.layout, expected.layout, `${message}: selected navigation layout`);
  assert.equal(observed.rendered.header, expected.colours.header, `${message}: custom header token`);
  assert.equal(observed.rendered.buttons, expected.colours.buttons, `${message}: custom button token`);
  assert.deepEqual(observed.tokens, expected.tokens, `${message}: effective palette colours`);
  assert.equal(observed.topbarBackground, expected.topbarBackground, `${message}: effective custom header surface`);
}

async function chooseColour(page, layer, swatch) {
  await page.getByRole('group', { name: 'Colour layer', exact: true }).getByRole('button', { name: layer, exact: true }).click();
  await page.getByRole('group', { name: `${layer} colour palette`, exact: true }).getByRole('button', { name: swatch, exact: true }).click();
}

try {
  let page = await launch(0);
  stage = 'select-light-and-custom-colours';
  await themes(page);
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await page.locator('.av2-colour-editor > summary').click();
  await chooseColour(page, 'Header', 'Ocean');
  await chooseColour(page, 'Buttons', 'Rose');
  await page.locator('.theme-style.paper').click();
  await page.waitForFunction(() => document.documentElement.dataset.layout === 'cinema');
  await home(page);
  const light = await inspect(page, 'selected-light-before-restart');
  const expectedLight = { theme: 'light', colours: { header: '#234d73', buttons: '#c44575' }, layout: 'cinema',
    tokens: light.tokens, topbarBackground: light.topbarBackground };
  verify(light, expectedLight, 'Selection');
  await page.screenshot({ path: path.join(artifacts, 'before-restart-light.png') });
  await close();

  page = await launch(1);
  const initial = await inspect(page, 'home-after-restart-light');
  await page.screenshot({ path: path.join(artifacts, 'after-restart-light.png') });
  // Give settings hydration an opportunity, but never import Settings first.
  await page.waitForTimeout(1200);
  const hydrated = await inspect(page, 'home-after-delayed-hydration-light');
  try {
    verify(initial, expectedLight, 'First Home after restart');
    verify(hydrated, expectedLight, 'Home after delayed hydration');
  } catch (error) {
    // Diagnostic evidence: visiting Settings used to repair the very same saved
    // profile. Keep the Home failure immutable even if this lazy import repairs it.
    await themes(page);
    await inspect(page, 'diagnostic-restored-after-visiting-settings');
    await page.screenshot({ path: path.join(artifacts, 'diagnostic-settings-restoration.png') });
    throw error;
  }

  stage = 'select-dark-atlas-and-close-immediately';
  await themes(page);
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.locator('.theme-style.atlas').click();
  await page.waitForFunction(() => document.documentElement.dataset.layout === 'atlas');
  const dark = await inspect(page, 'selected-dark-before-fast-close');
  await page.locator('.av2-colour-editor > summary').click();
  // No sleeps, IPC acknowledgement or screenshot follows the last selection.
  // This exercises synchronous renderer preference persistence on a quick quit.
  await chooseColour(page, 'Buttons', 'Turquoise');
  await close();

  page = await launch(2);
  const expectedDark = { theme: 'dark', colours: { header: '#234d73', buttons: '#249985' }, layout: 'atlas',
    tokens: dark.tokens, topbarBackground: dark.topbarBackground };
  const restartedDark = await inspect(page, 'home-after-fast-close-dark');
  verify(restartedDark, expectedDark, 'Fast close and restart');
  await page.waitForTimeout(1200);
  verify(await inspect(page, 'home-after-delayed-hydration-dark'), expectedDark, 'Fast-close delayed hydration');
  await page.screenshot({ path: path.join(artifacts, 'after-fast-close-dark.png') });
  assert.deepEqual(errors, [], 'No renderer errors during appearance selection/restart');
  result.passed = true;
  console.log('[PASS] Saved Light/Dark palettes, custom header/button colours, Cinema/Atlas layouts and fast-close persistence');
} catch (error) {
  result.failure = { stage, message: error instanceof Error ? error.message : String(error) };
  if (activePage) await activePage.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await close();
  result.finishedAt = new Date().toISOString();
  writeFileSync(path.join(artifacts, 'theme-startup.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`Theme restart evidence: ${artifacts}`);
}
