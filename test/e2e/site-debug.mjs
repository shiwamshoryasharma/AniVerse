// Debugs how a website behaves inside its AniVerse session: loads a URL in the
// source's webview and logs every top-level navigation with its initiator
// (script URL + line, via the DevTools protocol), requests the ad blocker
// cancelled, and console errors. Run `npm run build` first.
// Caveat: this runs through Playwright, so navigator.webdriver is true here; a
// site that only misbehaves under this script may be reacting to that — compare
// with `PROBE_URL=<url> npx electron test/e2e/guard-probe.cjs` (no automation).
//
//   node test/e2e/site-debug.mjs <sourceId> <url> [--no-adblock] [--wait=10000]
import { _electron as electron } from 'playwright-core';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const [sourceId, url] = args.filter((a) => !a.startsWith('--'));
const noAdblock = args.includes('--no-adblock');
const wait = Number(args.find((a) => a.startsWith('--wait='))?.slice(7) ?? 10000);
if (!sourceId || !url) {
  console.error('usage: node test/e2e/site-debug.mjs <sourceId> <url> [--no-adblock] [--wait=ms]');
  process.exit(2);
}
const profile = path.join(root, 'test', 'cache', 'debug-profile');
rmSync(profile, { recursive: true, force: true });

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [root],
  cwd: root,
  env: { ...process.env, ANIVERSE_HEADLESS: '1', ANIVERSE_DATA_DIR: profile },
  timeout: 60000,
});
const page = await app.firstWindow();
await page.waitForSelector('.app');
const rpc = (method, input) => page.evaluate(([m, i]) => window.aniverse.invoke(m, i), [method, input]);
if (noAdblock) await rpc('sources.update', { id: sourceId, patch: { adblock: false } });

await page.evaluate((id) => (location.hash = `#/sources/${id}`), sourceId);
await page.waitForSelector('webview', { timeout: 20000 });
await page.waitForFunction(() => {
  try {
    return document.querySelector('webview').getWebContentsId() > 0;
  } catch {
    return false;
  }
}, undefined, { timeout: 30000 });
const wcId = await page.evaluate(() => document.querySelector('webview').getWebContentsId());
await page.waitForTimeout(3000);

const log = await app.evaluate(
  async ({ webContents }, { id, target, ms }) => {
    const wc = webContents.fromId(id);
    const out = { navigations: [], documents: [], blocked: {}, failed: [], console: [], scheduled: [] };
    const top = (stack) => {
      const frames = [];
      for (let s = stack; s && frames.length < 4; s = s.parent) for (const f of s.callFrames) if (frames.length < 4) frames.push(`${f.url.slice(0, 90)}:${f.lineNumber}:${f.columnNumber} ${f.functionName || '(anon)'}`);
      return frames;
    };
    wc.on('did-navigate', (_e, u, code) => out.navigations.push(`${code} ${u}`));
    wc.on('did-navigate-in-page', (_e, u, main) => main && out.navigations.push(`spa ${u}`));
    wc.debugger.attach('1.3');
    const requests = new Map();
    wc.debugger.on('message', (_e, method, p) => {
      if (method === 'Network.requestWillBeSent') {
        requests.set(p.requestId, p.request.url);
        if (p.type === 'Document' && p.frameId === p.loaderId ? true : p.type === 'Document') {
          out.documents.push({ url: p.request.url, initiator: p.initiator.type, from: p.initiator.url ?? null, stack: p.initiator.stack ? top(p.initiator.stack) : [], referrer: p.request.headers.Referer ?? null });
        }
      } else if (method === 'Network.loadingFailed') {
        const u = requests.get(p.requestId) ?? '';
        if (/BLOCKED_BY_CLIENT/.test(p.errorText)) {
          let host = u;
          try {
            host = new URL(u).host;
          } catch {}
          out.blocked[host] = (out.blocked[host] ?? 0) + 1;
        } else if (p.type === 'Document' || p.type === 'Script') out.failed.push(`${p.type} ${p.errorText} ${u.slice(0, 120)}`);
      } else if (method === 'Page.frameRequestedNavigation' || method === 'Page.frameScheduledNavigation') {
        out.scheduled.push(`${method.split('.')[1]} ${p.reason} ${p.url}`);
      } else if (method === 'Runtime.consoleAPICalled' && out.console.length < 25) {
        out.console.push(`${p.type}: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160)}`);
      } else if (method === 'Runtime.exceptionThrown' && out.console.length < 25) {
        out.console.push(`exception: ${(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).slice(0, 200)}`);
      }
    });
    await wc.debugger.sendCommand('Network.enable');
    await wc.debugger.sendCommand('Page.enable');
    await wc.debugger.sendCommand('Runtime.enable');
    await wc.loadURL(target).catch((e) => out.failed.push(`loadURL ${e.message}`));
    await new Promise((r) => setTimeout(r, ms));
    out.final = { url: wc.getURL(), title: wc.getTitle() };
    out.cookies = (await wc.session.cookies.get({})).map((c) => `${c.domain} ${c.name}`).slice(0, 20);
    wc.debugger.detach();
    return out;
  },
  { id: wcId, target: url, ms: wait },
);
await app.close();
console.log(JSON.stringify({ sourceId, url, adblock: !noAdblock, ...log }, null, 2));
