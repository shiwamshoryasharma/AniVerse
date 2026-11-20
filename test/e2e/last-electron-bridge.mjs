import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const base = path.resolve('test/cache/last-electron-smoke');
await mkdir(base, { recursive: true });
const run = await mkdtemp(path.join(base, 'run-'));
const profile = path.join(run, 'profile');
const config = path.join(run, 'custom config');
await mkdir(profile);
await mkdir(config);
const source = path.join(config, 'streaming-sites.txt');
const sourceText = '# fixture source\r\nhttps://preserve.test/\r\n';
await writeFile(source, sourceText);
const app = spawn(path.resolve('release/win-unpacked/AniVerse.exe'), ['--remote-debugging-port=0'], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ANIVERSE_HEADLESS: '1', ANIVERSE_DATA_DIR: profile, ANIVERSE_CONFIG_DIR: config, TEMP: run, TMP: run, TMPDIR: run },
});
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
let browser;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const stop = setTimeout(() => reject(new Error('The signed Electron app did not open its renderer.')), 40_000);
    let output = '';
    const consume = (buffer) => {
      output += buffer.toString();
      const match = output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/);
      if (match) { clearTimeout(stop); resolve(match[1]); }
    };
    app.stdout.on('data', consume);
    app.stderr.on('data', consume);
    app.once('error', (error) => { clearTimeout(stop); reject(error); });
    app.once('exit', (code) => { clearTimeout(stop); reject(new Error('Signed app exited early: ' + code)); });
  });
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 30_000 });
  await page.waitForURL('app://aniverse/**');
  await page.waitForSelector('.app');
  const disclaimer = page.getByRole('button', { name: 'Got it', exact: true });
  if (await disclaimer.isVisible()) await disclaimer.click();
  await page.evaluate(() => { location.hash = '#/settings/about'; });
  const update = page.getByRole('button', { name: 'Update AniVerse to AniVerse2', exact: true });
  await update.click();
  await page.getByText('A signed AniVerse2 Windows release is not available yet.', { exact: true }).waitFor({ timeout: 35_000 });
  const info = await page.evaluate(() => window.aniverse.invoke('app.info'));
  assert.equal(info.version, version);
  assert.equal(await readFile(source, 'utf8'), sourceText);
  assert.equal(app.exitCode, null);
  await mkdir('test/artifacts', { recursive: true });
  await writeFile('test/artifacts/last-electron-bridge.json', JSON.stringify({
    version, signedApplicationLaunched: true, updateButtonClicked: true,
    separateReleaseChannelChecked: true, absentCandidateReported: true, originalSourceUnchanged: true,
  }, null, 2) + '\n');
} finally {
  await browser?.close().catch(() => undefined);
  if (app.exitCode === null && app.signalCode === null && app.pid) {
    const exit = once(app, 'exit').catch(() => undefined);
    if (app.kill()) await exit;
  }
}
