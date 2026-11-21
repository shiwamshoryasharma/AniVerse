import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
const run = await mkdtemp(join(root, 'test/cache/watch-tools-'));
const bundle = await build({ stdin: {
  resolveDir: root, loader: 'tsx', contents: [
    "import { useState } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { ToastProvider } from './frontend/src/lib/toast';",
    "import { DownloadMp4Button } from './frontend/src/components/DownloadMp4Button';",
    "import { SiteQuantumAudioControl } from './frontend/src/player/SiteQuantumAudioControl';",
    "function Fixture() { const [ready, setReady] = useState(false); const [stream, setStream] = useState(false);",
    "return <ToastProvider><div className='toolbar watch-media-actions' role='group' aria-label='Playback tools'>",
    "<SiteQuantumAudioControl id={1} ready={ready} /><DownloadMp4Button",
    "url={ready && !stream ? 'https://fixture.test/episode.mp4' : null} webContentsId={stream ? 1 : undefined} sourceId='fixture-source'",
    "unavailableReason='This source has no public MP4 available to download.' />",
    "</div><button onClick={() => setReady(true)}>Open fixture episode</button><button onClick={() => setStream(true)}>Open HLS fixture</button></ToastProvider>; }",
    "createRoot(document.querySelector('#root')).render(<Fixture />);",
  ].join('\n'),
}, bundle: true, write: false, jsx: 'automatic' });
const css = (await Promise.all(['app.css', 'controls.css', 'desktop-display.css'].map(file =>
  readFile(join(root, 'frontend/src/styles', file), 'utf8')))).join('\n');
const html = '<!doctype html><html data-aniverse-edition="2"><head><style>' + css +
  '</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--disable-background-networking'], env: { ...process.env, TEMP: run, TMP: run, TMPDIR: run },
});
const report = { passed: false };
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 480 } });
  await page.addInitScript(() => {
    window.saves = [];
    window.aniverse = { edition: 'aniverse2', platform: 'win32', on: () => () => {},
      saveMp4: async (...args) => (window.saves.push(args), true), saveSiteMp4: async id => (window.saves.push([id]), true) };
    window.__TAURI__ = { core: { invoke: async (_command, { input }) =>
      ({ state: input.action === 'enable' || input.action === 'status' ? 'active' : 'off' }) } };
  });
  await page.route('http://watch-tools.test/**', route => route.fulfill(route.request().url().endsWith('/app.js')
    ? { contentType: 'application/javascript', body: bundle.outputFiles[0].text }
    : { contentType: 'text/html', body: html }));
  await page.goto('http://watch-tools.test/');
  const tools = page.getByRole('group', { name: 'Playback tools' });
  const download = tools.getByRole('button', { name: 'Download MP4' });
  assert.equal(await download.getAttribute('aria-disabled'), 'true');
  const hint = await download.getAttribute('aria-describedby');
  assert.equal(await page.locator('[id="' + hint + '"]').textContent(), 'This source has no public MP4 available to download.');
  await download.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.saves), []);
  report.visibleDisabledDownloadWithGuidance = true;

  const quantum = tools.getByRole('button', { name: 'AniVerse Quantum Audio', exact: true });
  assert.match(await quantum.innerText(), /Quantum Audio/);
  await quantum.click();
  const controls = tools.getByRole('group', { name: 'AniVerse Quantum Audio controls' });
  const enable = controls.getByRole('button', { name: 'Enable Quantum Audio' });
  assert.equal(await enable.isDisabled(), true);
  await controls.getByText('Open an episode to use Quantum Audio.').waitFor();
  await page.getByRole('button', { name: 'Open fixture episode' }).click();
  await enable.click();
  await controls.getByText('Quantum Audio active').waitFor();
  report.visibleAudioControlWithExistingToggle = true;

  await download.click();
  await page.getByText('MP4 saved.').waitFor();
  assert.deepEqual(await page.evaluate(() => window.saves), [['https://fixture.test/episode.mp4', 'fixture-source']]);
  const right = await tools.evaluate(node => {
    const frame = node.getBoundingClientRect();
    return [...node.querySelectorAll('button')].every(button => button.getBoundingClientRect().right <= frame.right + 1);
  });
  assert.ok(right, 'Compact Watch actions must fit in their toolbar.');
  report.existingSaveFlowAndCompactLayout = true;
  await page.getByRole('button', { name: 'Open HLS fixture' }).click();
  await download.click();
  assert.deepEqual(await page.evaluate(() => window.saves.at(-1)), [1]);
  report.activePlayerDownloadUsesOpaqueViewId = true;
  report.passed = true;
} finally {
  await browser.close();
  await mkdir(join(root, 'test/artifacts'), { recursive: true });
  await writeFile(join(root, 'test/artifacts/aniverse2-watch-tools.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
