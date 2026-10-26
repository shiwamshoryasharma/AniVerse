// Verify real startup GPU preference and the Settings UI in isolated Electron profiles.
import assert from 'node:assert/strict';
import { _electron } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = path.join(root, 'test/cache/gpu-ui/temp');
mkdirSync(temporary, { recursive: true });
const reports = [];
for (const preference of ['high-performance', 'system']) {
  const app = await _electron.launch({
    executablePath: process.env.E2E_EXE ? path.resolve(root, process.env.E2E_EXE) : createRequire(import.meta.url)('electron'), args: process.env.E2E_EXE ? [] : [root], cwd: root,
    env: { ...process.env, ANIVERSE_HEADLESS: '1', ANIVERSE_GPU_PREFERENCE: preference,
      ANIVERSE_DATA_DIR: path.join(root, 'test/cache/gpu-ui', preference),
      TEMP: temporary, TMP: temporary, TMPDIR: temporary },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.app', { timeout: 30000 });
    await page.evaluate(() => { location.hash = '#/settings/graphics'; });
    await page.waitForSelector('.graphics-panel .gpu-device', { timeout: 30000 });
    const iconLayout = await page.evaluate(() => [...document.querySelectorAll('.settings-nav button svg')].every((icon) => {
      const r = icon.getBoundingClientRect(), b = icon.closest('button').getBoundingClientRect();
      return r.left >= b.left && r.right <= b.right && r.top >= b.top && r.bottom <= b.bottom && r.width <= 20 && r.height <= 20;
    }));
    assert.ok(iconLayout, 'Settings icons must stay inside their own menu buttons');
    const info = await page.evaluate(() => window.aniverse.invoke('app.info'));
    const requested = await app.evaluate(({ app }) => app.commandLine.hasSwitch('force_high_performance_gpu'));
    assert.equal(requested, preference === 'high-performance');
    assert.equal(info.graphics.preference, preference);
    assert.ok(info.graphics.activeAdapter, 'Active adapter must be reported on this machine');
    const text = await page.locator('.graphics-panel').innerText();
    assert.ok(text.includes(info.graphics.activeAdapter));
    assert.ok(text.includes('Hardware video decoding'));
    assert.ok(!/[a-z]:[\\/]/i.test(text), 'GPU UI must not display system paths');
    assert.equal(info.graphics.executablePath, undefined, 'GPU response must not expose the executable path');
    await page.locator('.graphics-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'test/artifacts', 'gpu-' + preference + '.png') });
    await page.getByRole('tab', { name: 'Laptop GPU setup' }).click();
    await page.waitForFunction(() => document.querySelector('#gpu-laptop img')?.naturalWidth > 0);
    assert.equal(await page.locator('#gpu-laptop .gpu-steps li').count(), 3);
    await page.screenshot({ path: path.join(root, 'test/artifacts', 'gpu-laptop-setup.png') });
    await page.getByRole('tab', { name: 'NVIDIA RTX Video' }).click();
    await page.waitForFunction(() => document.querySelector('#gpu-rtx img')?.naturalWidth > 0);
    assert.equal(await page.locator('#gpu-rtx .gpu-steps li').count(), 3);
    await page.screenshot({ path: path.join(root, 'test/artifacts', 'gpu-rtx-setup.png') });
    reports.push({ preference, requested, graphics: info.graphics, passed: true });
    console.log('[PASS] GPU startup/UI: ' + preference + ' — ' + info.graphics.activeAdapter);
  } finally { await app.close(); }
}
writeFileSync(path.join(root, 'test/artifacts/gpu-ui.json'), JSON.stringify(reports, null, 2) + '\n');
