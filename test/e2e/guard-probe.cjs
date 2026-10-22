// Loads a URL in a <webview> inside a hidden window WITHOUT automation flags
// (Playwright's --remote-debugging-port makes navigator.webdriver true, which
// some sites' anti-bot guards react to), and reports where the page ends up.
// Mirrors AniVerse: browser user agent, webview smaller than its window.
// Run: PROBE_URL=<url> npx electron test/e2e/guard-probe.cjs [webviewWidth webviewHeight] [--wait=10000]
// (the URL goes in an env var: npx's Windows shim rejects arguments containing '?').
const { app, BrowserWindow, session } = require('electron');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--') && !a.endsWith('guard-probe.cjs') && a !== '.');
const url = process.env.PROBE_URL ?? args.find((a) => /^https?:/.test(a));
const [w = 1180, h = 660] = args.filter((a) => /^\d+$/.test(a)).map(Number);
const wait = Number(process.argv.find((a) => a.startsWith('--wait='))?.slice(7) ?? 10000);

// Never hang: report whatever is known after the wait plus a grace period.
setTimeout(() => {
  console.log(JSON.stringify({ url, error: 'timed out' }));
  app.exit(1);
}, wait + 25000);

app.whenReady().then(async () => {
  const ua = app.userAgentFallback.replace(/\s(aniverse|AniVerse|Electron)\/\S+/g, '');
  const partition = `guard-probe-${Date.now()}`;
  session.fromPartition(partition).setUserAgent(ua);
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, opacity: 0, webPreferences: { webviewTag: true } });
  win.setIgnoreMouseEvents(true);
  win.showInactive();
  const navs = [];
  win.webContents.on('did-attach-webview', (_e, guest) => {
    guest.setUserAgent(ua);
    guest.on('did-navigate', (_e2, u, code) => navs.push(`${code} ${u}`));
    guest.on('did-navigate-in-page', (_e2, u, main) => main && navs.push(`spa ${u}`));
  });
  const html = `<body style="margin:0;background:#000"><webview id="v" partition="${partition}" src="${url}" style="width:${w}px;height:${h}px;display:inline-flex"></webview></body>`;
  await win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, wait));
  const guest = require('electron').webContents.getAllWebContents().find((c) => c.getType() === 'webview');
  const page = guest
    ? await Promise.race([guest.executeJavaScript('({ webdriver: navigator.webdriver, outer: [outerWidth, outerHeight], inner: [innerWidth, innerHeight], dpr: devicePixelRatio })'), new Promise((r) => setTimeout(() => r('no answer'), 4000))])
    : 'no webview';
  const state = { final: guest?.getURL() ?? null, title: guest?.getTitle() ?? null, page };
  console.log(JSON.stringify({ url, webview: [w, h], navs, ...state }));
  app.quit();
});
