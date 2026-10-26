import assert from 'node:assert/strict';
import { _electron } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = path.join(root, 'test/cache/font-ui/temp');
mkdirSync(temporary, { recursive: true });
const reports = [];
for (const pass of [0, 1]) {
  const app = await _electron.launch({
    executablePath: createRequire(import.meta.url)('electron'), args: [root], cwd: root,
    env: { ...process.env, ANIVERSE_HEADLESS: '1', ANIVERSE_DATA_DIR: path.join(root, 'test/cache/font-ui/profile'),
      TEMP: temporary, TMP: temporary, TMPDIR: temporary },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.app', { timeout: 30000 });
    await page.evaluate(() => { location.hash = '#/settings/general'; });
    await page.waitForSelector('[aria-label="Font preview"]');
    if (pass === 1) {
      const settings = await page.evaluate(() => window.aniverse.invoke('settings.get'));
      assert.equal(settings.appearance.fontFamily, 'serif', 'Font choice must survive app restart');
    }
    const family = pass === 0 ? 'serif' : 'mono';
    await page.getByLabel('UI font', { exact: true }).click();
    await page.getByRole('option', { name: pass === 0 ? 'Georgia · serif' : 'Consolas · monospace', exact: true }).click();
    await page.waitForFunction((font) => document.documentElement.dataset.font === font, family);
    const computed = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    assert.ok(computed.includes(pass === 0 ? 'Georgia' : 'Consolas'));
    await page.locator('[aria-label="Font preview"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'test/artifacts', 'font-' + family + '.png') });
    reports.push({ family, computed, persistedAcrossRestart: pass === 1, passed: true });
    if (pass === 1) {
      await page.getByLabel('UI font', { exact: true }).click();
      await page.getByRole('option', { name: 'Inter · default', exact: true }).click();
      await page.waitForFunction(() => document.documentElement.dataset.font === 'inter');
    }
    console.log('[PASS] UI font: ' + family + (pass ? ' and restart persistence' : ''));
  } finally { await app.close(); }
}
writeFileSync(path.join(root, 'test/artifacts/fonts-ui.json'), JSON.stringify(reports, null, 2) + '\n');
