import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
const release = join(root, 'test/cache/aniverse2/release-3.0.8');
const { values: options } = parseArgs({ options: {
  baseline: { type: 'string', default: join(release, 'aniverse2-3.0.8-isolated.exe') },
  'baseline-project': { type: 'string', default: join(release, 'source') },
  candidate: { type: 'string' }, 'candidate-project': { type: 'string', default: root },
  runs: { type: 'string', default: '3' }, duration: { type: 'string', default: '8000' },
  report: { type: 'string', default: 'aniverse2-startup-bench.json' }, 'early-guard': { type: 'boolean' },
} });
assert.equal(process.platform, 'win32', 'This benchmark requires Windows and WebView2.');
assert.match(options.report, /^[a-z0-9.-]+\.json$/i, 'Choose a report filename under test/artifacts.');
const runs = Number(options.runs), duration = Number(options.duration);
assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 12);
assert.ok(Number.isInteger(duration) && duration >= 4000 && duration <= 30000);
const variants = [{ name: 'baseline', exe: resolve(options.baseline), project: resolve(options['baseline-project']) }];
if (options.candidate) variants.push({ name: 'candidate', exe: resolve(options.candidate), project: resolve(options['candidate-project']) });

const count = 35000;
const filterList = ['[Adblock Plus 2.0]', '/startup-blocked.js$script',
  ...Array.from({ length: count }, (_, i) => '||startup-ad-' + i + '.invalid^')].join('\n');
const proxyDelayMs = 1800;
let denied = 0;
const proxy = createServer((_message, response) => response.writeHead(503).end());
proxy.on('connect', (_message, socket) => {
  denied++;
  socket.on('error', () => socket.destroy());
  setTimeout(() => socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n'), proxyDelayMs);
});
const hits = new Map();
const site = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const token = encodeURIComponent(url.searchParams.get('run') ?? '');
  if (url.pathname === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>AniVerse2 startup fixture</title><h1>Source playback site</h1>' +
      '<script src="/startup-blocked.js?run=' + token + '"></script><script src="/startup-allowed.js?run=' + token + '"></script>');
  } else {
    const item = hits.get(token) ?? new Set();
    item.add(url.pathname);
    hits.set(token, item);
    response.setHeader('Content-Type', 'text/javascript');
    response.end('void 0;');
  }
});
const portOf = async server => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};
const byDeadline = (promise, ms, reason) => {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Error(reason)), ms);
  })]).finally(() => clearTimeout(timer));
};
const stamp = () => performance.now();
const rounded = n => Math.round(n * 100) / 100;
const pct = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null;
const cpuAt = (samples, ms) => {
  const i = samples.findIndex(sample => sample.t >= ms);
  if (i < 0) return samples.at(-1).cpu;
  if (i === 0) return samples[0].cpu;
  const a = samples[i - 1], b = samples[i];
  return rounded(a.cpu + (b.cpu - a.cpu) * ((ms - a.t) / (b.t - a.t)));
};

async function measure(variant, origin, proxyUrl, earlyGuard = false) {
  const cache = join(variant.project, 'test/cache/aniverse2');
  await mkdir(cache, { recursive: true });
  const run = await mkdtemp(join(cache, 'startup-bench-'));
  const profile = join(run, 'profile');
  await mkdir(join(profile, 'config'), { recursive: true });
  await Promise.all([
    writeFile(join(profile, 'config/streaming-sites.txt'), origin + '/\n'),
    writeFile(join(profile, 'rust-network-filters.txt'), filterList),
  ]);
  const reserve = createServer();
  const port = await portOf(reserve);
  await new Promise(resolve => reserve.close(resolve));
  const env = { ...process.env, TEMP: run, TMP: run, TMPDIR: run, ANIVERSE2_TEST_PROFILE: profile,
    ANIVERSE2_TEST_SITE_ORIGIN: origin,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      '--disable-background-networking --remote-debugging-address=127.0.0.1 --remote-debugging-port=' + port,
    HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, NO_PROXY: '127.0.0.1,localhost,tauri.localhost',
  };
  delete env.ANIVERSE_ELECTRON_HANDOFF;
  delete env.ANIVERSE2_TEST_FRAME_ORIGIN;
  delete env.WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER;
  delete env.WEBVIEW2_USER_DATA_FOLDER;
  const sampler = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    join(root, 'test/e2e/fixtures/aniverse2-startup-cpu.ps1'), '-DurationMs', String(duration)],
  { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const samplerExit = once(sampler, 'exit').catch(() => undefined);
  const lines = createInterface({ input: sampler.stdout });
  const output = lines[Symbol.asyncIterator]();
  let browser, child, childExit;
  const errors = [];
  sampler.stderr.on('data', bytes => errors.push(bytes.toString()));
  try {
    const ready = await byDeadline(output.next(), 15000, 'The Windows process sampler could not start.');
    assert.equal(ready.value, 'ready', errors.join('\n'));
    const before = denied;
    const started = stamp();
    child = spawn(variant.exe, [], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    childExit = once(child, 'exit').catch(() => undefined);
    child.stderr.on('data', bytes => errors.push(bytes.toString()));
    child.stdout.resume();
    sampler.stdin.end(String(child.pid) + '\n');
    const samples = [];
    const sampling = (async () => {
      for await (const line of output) {
        const [t, cpu, processes, working, privateBytes, live, measured] = line.split(',').map(Number);
        if ([t, cpu, processes, working, privateBytes, live, measured].every(Number.isFinite)) {
          samples.push({ t, cpu, processes, working, privateBytes, live, measured });
        }
      }
    })();
    const limit = started + 18000;
    while (!browser && stamp() < limit) {
      if (child.exitCode !== null) throw Error('The isolated candidate exited. ' + errors.join('\n'));
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 400 }); }
      catch { await delay(65); }
    }
    assert.ok(browser, 'Could not attach to the isolated Windows app.');
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.waitForEvent('page');
    await page.waitForURL('https://tauri.localhost/**', { timeout: 18000 });
    await page.getByRole('combobox', { name: 'Search anime' }).waitFor({ timeout: 15000 });
    const shellMs = rounded(stamp() - started);
    // The extra early-attach trial is excluded from all benchmark medians.
    if (earlyGuard) return { shellMs, ...(await verifyFeatures(page, origin, started)) };
    await page.evaluate(() => {
      if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) return;
      const durations = [];
      const observer = new PerformanceObserver(list => list.getEntries().forEach(entry => durations.push(entry.duration)));
      observer.observe({ type: 'longtask', buffered: true });
      window.__startupTimings = { durations, observer };
    });
    const pings = [];
    while (stamp() - started < duration) {
      const sent = stamp();
      await byDeadline(page.evaluate(() => document.readyState), 8000, 'The renderer stopped answering during startup.');
      pings.push(rounded(stamp() - sent));
      await delay(150);
    }
    await byDeadline(sampling, duration + 5000, 'The Windows process sampler stopped returning data.');
    assert.ok(samples.length >= Math.floor(duration / 250) && samples.some(sample => sample.processes >= 2),
      'The sampler did not observe enough WebView2 process data. ' + errors.join('\n'));
    const web = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0];
      const timing = window.__startupTimings;
      timing?.observer.disconnect();
      return { documentLoadedMs: navigation?.domContentLoadedEventEnd ?? null, observedRendererLongTasks: timing?.durations ?? null };
    });
    const verify = await verifyFeatures(page, origin, started);
    const memorySamples = samples.filter(sample => sample.measured === sample.live);
    const peaks = samples.slice(1).map((s, index) => (s.cpu - samples[index].cpu) / Math.max(1, s.t - samples[index].t));
    return {
      shellMs, startupCpuMs: cpuAt(samples, duration), first2sCpuMs: cpuAt(samples, 2000),
      peakSampleLogicalCores: rounded(Math.max(...peaks)), maxProcessesObserved: Math.max(...samples.map(x => x.processes)),
      peakWorkingSetMiB: memorySamples.length ? rounded(Math.max(...memorySamples.map(x => x.working)) / 1048576) : null,
      peakPrivateCommitMiB: memorySamples.length ? rounded(Math.max(...memorySamples.map(x => x.privateBytes)) / 1048576) : null,
      fullProcessMemorySamples: memorySamples.length,
      rendererProbeP95Ms: pct(pings, 0.95), rendererProbeMaxMs: pct(pings, 1), rendererProbes: pings.length,
      deniedNativeTunnels: denied - before, ...web, verify, samples,
    };
  } finally {
    lines.close();
    await browser?.close().catch(() => undefined);
    if (child?.pid && child.exitCode === null && child.signalCode === null && child.kill()) await childExit;
    if (sampler.pid && sampler.exitCode === null && sampler.signalCode === null && sampler.kill()) await samplerExit;
  }
}

async function verifyFeatures(page, origin, started) {
  const settings = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' });
  const tap = stamp();
  await settings.click({ timeout: 10000 });
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor({ timeout: 10000 });
  const settingsNavigationMs = rounded(stamp() - tap);
  const rpc = (method, input) => page.evaluate(value => window.aniverse.invoke(value.method, value.input), { method, input });
  const [source] = await rpc('sources.list');
  assert.ok(source?.id && source?.partition);
  const filtersReadyBeforeAttach = (await rpc('adblock.stats')).ready;
  const startedAttachMs = rounded(stamp() - started);
  const attachment = await rpc('site.surface', { action: 'attach', sourceId: source.id, partition: source.partition,
    bounds: { x: 0, y: 0, width: 640, height: 380 } });
  const token = randomUUID();
  try {
    await rpc('site.surface', { action: 'navigate', webContentsId: attachment.webContentsId, url: origin + '/?run=' + token });
    const deadline = stamp() + 8000;
    while (!(hits.get(token)?.has('/startup-allowed.js')) && stamp() < deadline) {
      await delay(80);
    }
    assert.ok(hits.get(token)?.has('/startup-allowed.js'), 'The fixture source did not finish loading.');
    assert.ok(!hits.get(token)?.has('/startup-blocked.js'), 'The first source load escaped its cached network filter.');
  } finally {
    await rpc('site.surface', { action: 'detach', webContentsId: attachment.webContentsId });
    hits.delete(token);
  }
  return { settingsNavigationMs, startedAttachMs, filtersReadyBeforeAttach, firstSourceRequestStayedBlocked: true };
}

const report = {
  passed: false, durationMs: duration, runs, logicalCores: cpus().length, ruleCount: count + 1, proxyDelayMs,
  scope: 'Fresh hidden WebView2 and seeded network filters per run. Loopback denies outside Rust HTTPS traffic. ' +
    'CPU uses Win32 process time from the app and sampled descendants, at ~150 ms intervals. ' +
    'Aggregate working set can count shared pages more than once, and private commit measures a different quantity. ' +
    'Memory peaks use samples that covered every live tracked process. ' +
    'Short-lived descendants between samples, GPU duration, successful online metadata and periodic production upkeep are excluded. ' +
    'Renderer timings include CDP overhead and long-task support depends on WebView2 buffering.',
  variants: {},
};
const file = join(root, 'test/artifacts', options.report);
try {
  const [sitePort, proxyPort] = await Promise.all([portOf(site), portOf(proxy)]);
  for (const variant of variants) report.variants[variant.name] = {
    executableSha256: createHash('sha256').update(await readFile(variant.exe)).digest('hex'), runs: [],
  };
  for (let i = 0; i < runs; i++) {
    for (const variant of i % 2 ? [...variants].reverse() : variants) {
      const result = await measure(variant, 'http://127.0.0.1:' + sitePort, 'http://127.0.0.1:' + proxyPort);
      report.variants[variant.name].runs.push(result);
      console.log(variant.name, i + 1, 'shell', result.shellMs, 'ms; CPU', result.startupCpuMs, 'ms');
    }
  }
  for (const value of Object.values(report.variants)) {
    value.median = Object.fromEntries(['shellMs', 'startupCpuMs', 'first2sCpuMs', 'peakSampleLogicalCores', 'rendererProbeP95Ms']
      .concat(['peakWorkingSetMiB', 'peakPrivateCommitMiB'])
      .map(metric => [metric, pct(value.runs.map(row => row[metric]).filter(x => x !== null), 0.5)]));
  }
  if (options['early-guard']) {
    const variant = variants.at(-1);
    const verify = await measure(variant, 'http://127.0.0.1:' + sitePort, 'http://127.0.0.1:' + proxyPort, true);
    report.earlyGuard = { variant: variant.name, ...verify };
  }
  report.passed = true;
} catch (error) {
  report.error = String(error.stack ?? error);
  throw error;
} finally {
  await mkdir(join(root, 'test/artifacts'), { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2) + '\n');
  site.close();
  proxy.close();
}
