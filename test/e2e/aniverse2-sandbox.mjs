import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cache = resolve('test/cache/aniverse2');
await mkdir(cache, { recursive: true });
const run = await mkdtemp(join(cache, 'sandbox-'));
const profile = join(run, 'profile');
await mkdir(join(profile, 'config'), { recursive: true });
let result;
const payload = String.raw`(async () => {
  const bridge = typeof window.aniverse !== 'undefined';
  const node = typeof window.require !== 'undefined' || typeof window.process !== 'undefined';
  const invoke = window.__TAURI__?.core?.invoke;
  let harmlessNativeRead = 'unavailable';
  if (typeof invoke === 'function') {
    harmlessNativeRead = await Promise.race([
      invoke('desktop_rpc', { method: 'app.info' }).then(() => 'allowed', () => 'denied'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 2500))
    ]);
  }
  await fetch('/result', { method: 'POST', body: JSON.stringify({ bridge, node, harmlessNativeRead }) });
})();`;
const server = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/result') {
    let content = '';
    for await (const part of request) {
      content += part;
      if (content.length > 1024) return response.writeHead(413).end();
    }
    try { result = JSON.parse(content); } catch { return response.writeHead(400).end(); }
    response.writeHead(204).end();
  } else if (request.url === '/probe.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(payload);
  } else {
    response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Isolated test source</title><script src="/probe.js"></script>');
  }
});
const bound = async server => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};
const origin = 'http://127.0.0.1:' + await bound(server);
await writeFile(join(profile, 'config/streaming-sites.txt'), origin + '/\n');
const reserve = createServer();
const port = await bound(reserve);
await new Promise(resolve => reserve.close(resolve));
const exe = resolve(process.env.ANIVERSE2_TEST_EXE ?? 'test/cache/aniverse2/aniverse2-isolated-test.exe');
const env = { ...process.env, ANIVERSE2_TEST_PROFILE: profile, ANIVERSE2_TEST_SITE_ORIGIN: origin,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-address=127.0.0.1 --remote-debugging-port=' + port,
  TEMP: run, TMP: run, TMPDIR: run };
delete env.ANIVERSE_ELECTRON_HANDOFF;
delete env.WEBVIEW2_USER_DATA_FOLDER;
delete env.WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER;
delete env.ANIVERSE2_TEST_FRAME_ORIGIN;
const child = spawn(exe, [], { windowsHide: true, env, stdio: 'ignore' });
const exited = once(child, 'exit').catch(() => undefined);
let browser, failure;
child.on('error', error => { failure = error; });
const report = { passed: false, executableSha256: createHash('sha256').update(await readFile(exe)).digest('hex') };
try {
  const deadline = Date.now() + 18000;
  while (!browser && Date.now() < deadline) {
    if (failure || child.exitCode !== null) throw failure ?? Error('The isolated desktop failed to start.');
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 450 }); }
    catch { await delay(100); }
  }
  assert.ok(browser, 'The isolated WebView2 could not attach.');
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page');
  await page.waitForURL('https://tauri.localhost/**');
  const invoke = (method, input) => page.evaluate(value => window.aniverse.invoke(value.method, value.input), { method, input });
  assert.ok((await invoke('app.info'))?.version, 'The trusted desktop app could not use its bridge.');
  report.trustedDesktopRead = true;
  const [source] = await invoke('sources.list');
  const attachment = await invoke('site.surface', { action: 'attach', sourceId: source.id, partition: source.partition,
    bounds: { x: 0, y: 0, width: 640, height: 380 } });
  try {
    await invoke('site.surface', { action: 'navigate', webContentsId: attachment.webContentsId, url: origin + '/' });
    const limit = Date.now() + 12000;
    while (!result && Date.now() < limit) await delay(80);
    assert.ok(result, 'The source did not return its sandbox observation.');
    report.source = result;
    assert.equal(result.bridge, false, 'The source page received the AniVerse bridge.');
    assert.equal(result.node, false, 'The source page received Node globals.');
    assert.ok(['unavailable', 'denied'].includes(result.harmlessNativeRead), 'The source page did not deny the desktop read.');
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
      join(root, 'test/e2e/fixtures/aniverse2-sandbox-process.ps1')], { windowsHide: true, timeout: 12000,
      env: { ...env, ANIVERSE2_SANDBOX_PROFILE: profile } });
    const processes = JSON.parse(stdout);
    report.processes = processes;
    for (const group of ['main', 'source']) {
      const matches = processes.filter(process => process.group === group);
      assert.ok(matches.some(process => !process.renderer), 'Expected a separate WebView2 browser for ' + group);
      assert.ok(matches.some(process => process.renderer), 'Expected a WebView2 renderer for ' + group);
      assert.ok(matches.every(process => !process.unsafeFlags), 'Unexpected unsafe browser flags for ' + group);
      const readable = matches.filter(process => process.renderer && (process.integrityRid !== null || process.appContainer !== null));
      assert.ok(readable.length > 0, 'The test could not inspect owned WebView2 renderer restrictions for ' + group);
      assert.ok(readable.every(process => process.appContainer || (process.integrityRid !== null && process.integrityRid <= 0x1000)),
        'Expected low-integrity or application-container renderers for ' + group);
    }
  } finally {
    await invoke('site.surface', { action: 'detach', webContentsId: attachment.webContentsId });
  }
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await mkdir(join(root, 'test/artifacts'), { recursive: true });
  await writeFile(join(root, 'test/artifacts/aniverse2-webview2-sandbox.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close().catch(() => undefined);
  if (child.pid && child.exitCode === null && child.signalCode === null && child.kill()) await exited;
  server.close();
  console.log(JSON.stringify(report, null, 2));
}
