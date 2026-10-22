// Self-update end to end, with real signed installers and a local update server:
//  1. builds AniVerse twice — versions A and B — with a generic update feed on 127.0.0.1
//     (single-range requests, like the GitHub provider);
//  2. installs A silently into test/cache/update-e2e/install with a throwaway profile;
//  3. starts A: it must find B, download it differentially (blockmaps), accept its signature,
//     and install it when the app is closed;
//  4. checks B is installed, shortcuts and profile are intact, then uninstalls.
// Needs `npm run build` first and the signing certificate in the Windows store.
//   npm run test:update            (UPDATE_KEEP=1 keeps the builds for a re-run)
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import builder from 'electron-builder';
import { root, writeReleaseConfig } from '../../scripts/releaseConfig.mjs';

const A = '90.0.0';
const B = '90.0.1';
const base = path.join(root, 'test', 'cache', 'update-e2e');
const feed = path.join(base, 'feed');
const installDir = path.join(base, 'install', 'AniVerse');
const profile = path.join(base, 'profile');
const updaterCache = path.join(process.env.LOCALAPPDATA, 'aniverse-updater');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (command) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).stdout.trim();
const report = {};

// ---- update server: static files with single Range support, every request logged
const requests = [];
const server = http.createServer((req, res) => {
  const file = path.join(feed, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, ''));
  if (!file.startsWith(feed) || !existsSync(file)) {
    requests.push({ url: req.url, status: 404 });
    res.writeHead(404).end();
    return;
  }
  const size = statSync(file).size;
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  const [start, end] = range ? [Number(range[1]), range[2] ? Number(range[2]) : size - 1] : [0, size - 1];
  requests.push({ url: req.url, range: req.headers.range ?? null, bytes: end - start + 1 });
  res.writeHead(range ? 206 : 200, {
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    'Content-Type': file.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
  });
  createReadStream(file, { start, end }).pipe(res);
});
// A fixed port: the feed URL is compiled into the builds (app-update.yml), so kept builds stay valid.
const PORT = 47811;
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const url = `http://127.0.0.1:${PORT}/`;

const build = async (version) => {
  const out = path.join(base, `build-${version}`);
  const installer = path.join(out, `AniVerse-Setup-${version}.exe`);
  if (process.env.UPDATE_KEEP && existsSync(installer)) return out;
  const { file } = writeReleaseConfig({
    extraMetadata: { version },
    directories: { output: out, buildResources: 'build' },
    publish: { provider: 'generic', url, useMultipleRangeRequest: false },
  });
  await builder.build({ projectDir: root, targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64), config: file, publish: 'never' });
  return out;
};

// The installer stores itself in %LOCALAPPDATA%\aniverse-updater as the differential base:
// set an existing cache aside and put it back afterwards.
const parkedCache = `${updaterCache}.before-e2e`;
if (existsSync(updaterCache)) renameSync(updaterCache, parkedCache);
let app = null;
try {
  if (!process.env.UPDATE_KEEP) rmSync(base, { recursive: true, force: true });
  mkdirSync(feed, { recursive: true });
  const outA = await build(A);
  const outB = await build(B);
  // The feed: B's installer, blockmap and latest.yml, plus A's blockmap (the differential base).
  for (const f of [`AniVerse-Setup-${B}.exe`, `AniVerse-Setup-${B}.exe.blockmap`, 'latest.yml']) copyFileSync(path.join(outB, f), path.join(feed, f));
  copyFileSync(path.join(outA, `AniVerse-Setup-${A}.exe.blockmap`), path.join(feed, `AniVerse-Setup-${A}.exe.blockmap`));
  report.feedConfig = readFileSync(path.join(outA, 'win-unpacked', 'resources', 'app-update.yml'), 'utf8').trim().split(/\r?\n/);

  // ---- install A
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(profile, 'keep-me.txt'), 'profile data must survive the update');
  const setupA = spawnSync(path.join(outA, `AniVerse-Setup-${A}.exe`), ['/S', `/D=${installDir}`], { stdio: 'ignore' });
  report.installA = setupA.status;
  const exe = path.join(installDir, 'AniVerse.exe');
  // Windows file versions have four parts: 90.0.1.0 → 90.0.1
  const fileVersion = () => ps(`(Get-Item -LiteralPath '${exe}').VersionInfo.ProductVersion`).replace(/^(\d+\.\d+\.\d+)\.0$/, '$1');
  report.installedBefore = fileVersion();
  report.differentialBase = existsSync(path.join(updaterCache, 'installer.exe'));
  const startMenuLink = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'AniVerse.lnk');
  report.startMenuBefore = existsSync(startMenuLink);

  // ---- run A against the local feed until B is downloaded and verified
  app = spawn(exe, [], { env: { ...process.env, ANIVERSE_DATA_DIR: profile, ANIVERSE_HEADLESS: '1' }, stdio: 'ignore' });
  const log = path.join(profile, 'logs', 'updates.log');
  const until = async (re, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(1000)) if (existsSync(log) && re.test(readFileSync(log, 'utf8'))) return true;
    return false;
  };
  report.downloaded = await until(/has been downloaded/i, 240_000);
  report.updateLog = existsSync(log) ? readFileSync(log, 'utf8').trim().split(/\r?\n/).map((l) => l.slice(25, 220)) : [];
  if (!report.downloaded) throw new Error('the update was not downloaded');

  // ---- close the app: the update installs on quit
  spawnSync('taskkill', ['/PID', String(app.pid)], { stdio: 'ignore' });
  for (let i = 0; i < 30 && app.exitCode === null; i++) await sleep(1000);
  report.appClosed = app.exitCode !== null;
  for (let i = 0; i < 180 && fileVersion() !== B; i++) await sleep(1000);
  await sleep(5000); // let the silent installer finish writing the registry and shortcuts
  report.installedAfter = fileVersion();
  report.registryVersion = ps(
    "(Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | Get-ItemProperty | Where-Object DisplayName -like 'AniVerse*' | Select-Object -First 1).DisplayVersion",
  );
  report.startMenuAfter = existsSync(startMenuLink);
  report.profileKept = existsSync(path.join(profile, 'keep-me.txt'));

  const full = statSync(path.join(feed, `AniVerse-Setup-${B}.exe`)).size;
  const exeRequests = requests.filter((r) => r.url.endsWith(`${B}.exe`));
  report.download = {
    installerSize: full,
    bytesFetched: exeRequests.reduce((n, r) => n + (r.bytes ?? 0), 0),
    rangeRequests: exeRequests.filter((r) => r.range).length,
    fullRequests: exeRequests.filter((r) => !r.range).length,
    blockmaps: requests.filter((r) => r.url.endsWith('.blockmap')).map((r) => `${r.url} ${r.status ?? 200}`),
  };
  report.download.differential = report.download.fullRequests === 0 && report.download.bytesFetched < full / 2;
  report.pass =
    report.installedBefore === A &&
    report.installedAfter === B &&
    report.registryVersion === B &&
    report.download.differential &&
    report.updateLog.some((l) => /signature ok/.test(l)) &&
    report.startMenuAfter === report.startMenuBefore &&
    report.profileKept;
} catch (err) {
  report.error = String(err?.stack ?? err);
} finally {
  if (app && app.exitCode === null) spawnSync('taskkill', ['/F', '/T', '/PID', String(app.pid)], { stdio: 'ignore' });
  const uninstaller = path.join(installDir, 'Uninstall AniVerse.exe');
  if (existsSync(uninstaller)) {
    spawnSync(uninstaller, ['/S'], { stdio: 'ignore' });
    for (let i = 0; i < 60 && existsSync(path.join(installDir, 'AniVerse.exe')); i++) await sleep(1000);
    report.uninstalled = !existsSync(path.join(installDir, 'AniVerse.exe'));
  }
  rmSync(updaterCache, { recursive: true, force: true });
  if (existsSync(parkedCache)) renameSync(parkedCache, updaterCache);
  if (!process.env.UPDATE_KEEP) for (const v of [A, B]) rmSync(path.join(base, `build-${v}`), { recursive: true, force: true });
  server.close();
}
writeFileSync(path.join(root, 'test', 'artifacts', 'updater.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
