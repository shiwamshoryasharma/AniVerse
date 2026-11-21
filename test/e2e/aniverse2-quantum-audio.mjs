import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { transform } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
const project = resolve(process.env.ANIVERSE2_TEST_PROJECT_ROOT ?? root);
const cache = join(project, 'test/cache/aniverse2');
await mkdir(cache, { recursive: true });
const run = await mkdtemp(join(cache, 'quantum-audio-'));
const profile = join(run, 'profile');
const local = join(run, 'local');
await mkdir(join(profile, 'config'), { recursive: true });
await mkdir(local);
const videoFile = join(local, '[Fixture] Quantum Audio S01E01.mp4');
const exe = resolve(process.env.ANIVERSE2_TEST_EXE ?? join(cache, 'aniverse2-isolated-test.exe'));
const reportFile = resolve(process.env.ANIVERSE2_TEST_REPORT ?? join(root, 'test/artifacts/aniverse2-quantum-audio.json'));
const report = { passed: false, checks: {}, scope: 'Windows isolated WebView2 Quantum Audio runtime' };
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const tempEnv = { ...process.env, TEMP: run, TMP: run, TMPDIR: run };
let browser, child, childExit, startupError;
const logs = [];
try {
  report.executableSha256 = await sha(exe);
  const encoded = spawnSync(join(root, 'build/vendor/ffmpeg/ffmpeg.exe'), [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24',
    '-f', 'lavfi', '-i', 'aevalsrc=0.09*sin(2*PI*523*t)|0.09*sin(2*PI*659*t):s=48000',
    '-t', '28', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', videoFile,
  ], { windowsHide: true, env: tempEnv, timeout: 25000 });
  assert.equal(encoded.status, 0, encoded.error?.message ?? encoded.stderr?.toString());
  report.fixtureSha256 = await sha(videoFile);
  await writeFile(join(profile, 'config/streaming-sites.txt'), '');
  const source = await readFile(join(project, 'app/core/db/store.ts'), 'utf8');
  const migrations = source.match(/export const MIGRATIONS: string\[\] = \[[\s\S]+?\n\];/)?.[0];
  assert.ok(migrations, 'Could not load the app-owned SQLite fixture schema.');
  const bundle = await transform(migrations, { loader: 'ts', format: 'esm' });
  const { MIGRATIONS } = await import('data:text/javascript;base64,' + Buffer.from(bundle.code).toString('base64'));
  const fixture = new DatabaseSync(join(profile, 'aniverse.db'));
  try {
    for (const migration of MIGRATIONS) fixture.exec(migration);
    fixture.exec('PRAGMA user_version=' + MIGRATIONS.length);
    const set = fixture.prepare('INSERT INTO kv(key,value) VALUES(?,?)');
    set.run('collection:roots', JSON.stringify([local]));
    set.run('settings', JSON.stringify({ player: { autoplay: false, volume: 0.22 } }));
  } finally { fixture.close(); }
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((done, reject) => listener.close(error => error ? reject(error) : done()));
  const env = { ...tempEnv, ANIVERSE2_TEST_PROFILE: profile, WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-address=127.0.0.1 --remote-debugging-port=' + port };
  delete env.ANIVERSE_ELECTRON_HANDOFF;
  child = spawn(exe, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  child.once('error', error => { startupError = error; });
  childExit = once(child, 'exit').catch(() => undefined);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => logs.push(bytes.toString()));
  const deadline = Date.now() + 20000;
  while (!browser && Date.now() < deadline) {
    if (startupError || child.exitCode !== null) throw startupError ?? Error('Isolated app exited with ' + child.exitCode);
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 600 }); }
    catch { await delay(150); }
  }
  assert.ok(browser, 'Could not connect to the test-owned WebView2.');
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 10000 });
  page.on('console', entry => {
    if (entry.type() === 'error' || entry.type() === 'warning') logs.push(entry.text());
  });
  page.on('pageerror', error => logs.push(String(error)));
  await page.waitForURL('https://tauri.localhost/**');
  await page.addInitScript(() => {
    if (window !== window.top || location.origin !== 'https://tauri.localhost') return;
    const capture = window.quantumFixture = { elements: [], output: null };
    const create = AudioContext.prototype.createMediaElementSource;
    AudioContext.prototype.createMediaElementSource = function(video) {
      const node = Reflect.apply(create, this, [video]);
      capture.elements.push(video);
      return node;
    };
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function(destination) {
      const result = Reflect.apply(connect, this, arguments);
      if (this instanceof AudioWorkletNode && this.context instanceof AudioContext &&
          destination === this.context.destination) {
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 2048;
        Reflect.apply(connect, this, [analyser]);
        capture.output = { node: this, analyser };
      }
      return result;
    };
    capture.rms = () => {
      if (!capture.output) return null;
      const samples = new Float32Array(capture.output.analyser.fftSize);
      capture.output.analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, sample) => sum + sample ** 2, 0) / samples.length);
    };
  });
  await page.reload();
  await page.locator('.app').waitFor();
  const call = (method, input) => page.evaluate(({ method, input }) => window.aniverse.invoke(method, input), { method, input });
  const scanned = await call('collection.scan', { choose: false });
  assert.equal(scanned.files.length, 1);
  await page.evaluate(id => { location.hash = '#/player?local=' + id; }, scanned.files[0].id);
  const player = page.getByLabel('Video player', { exact: true });
  const row = player.locator('.player-row');
  const state = () => player.locator('video').evaluate(video => ({
    time: video.currentTime, frames: video.getVideoPlaybackQuality().totalVideoFrames,
    paused: video.paused, muted: video.muted, same: window.quantumFixture.elements[0] === video,
    attached: window.quantumFixture.elements.length, rms: window.quantumFixture.rms(),
    intensity: window.quantumFixture.output?.node.parameters.get('intensity').value,
  }));
  await page.waitForFunction(() => {
    const video = document.querySelector('.player video');
    return video?.currentSrc.startsWith('https://localmedia.localhost/') && video.readyState >= 2;
  }, null, { timeout: 15000 });
  const icon = player.getByRole('button', { name: 'AniVerse Quantum Audio', exact: true });
  assert.equal(await icon.count(), 1);
  assert.equal(await icon.locator('svg').count(), 1);
  await icon.click();
  const enable = player.getByRole('button', { name: 'Enable Quantum Audio', exact: true });
  const intensity = player.getByRole('slider', { name: 'Quantum Audio intensity', exact: true });
  assert.equal(await intensity.inputValue(), '50');
  await enable.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Enable Quantum Audio"]')?.getAttribute('aria-pressed') === 'true',
    null, { timeout: 6500 });
  report.checks.localPlayerAndUi = true;
  if ((await state()).paused) await row.getByRole('button', { name: 'Play', exact: true }).click();
  const rms = async (audible) => {
    await page.waitForFunction(on => {
      const value = window.quantumFixture.rms();
      return value !== null && (on ? value > 0.001 : value < 0.0001);
    }, audible, { timeout: 5000 });
    return (await state()).rms;
  };
  report.audio = { enabledRms: await rms(true) };
  const before = await state();
  await intensity.focus();
  await intensity.press('End');
  assert.equal(await intensity.inputValue(), '100');
  await page.waitForFunction(() => window.quantumFixture.output.node.parameters.get('intensity').value >= 0.999);
  await page.waitForFunction(time => document.querySelector('.player video').currentTime > time + 0.24, before.time);
  const active = await state();
  assert.ok(active.same && active.attached === 1 && active.frames > before.frames, JSON.stringify(active));
  report.checks.intensityAndDecodedFrames = true;
  await player.press('5');
  await page.waitForFunction(() => {
    const video = document.querySelector('.player video');
    return video.currentTime >= 13.8 && video.currentTime < 18 && !video.seeking;
  }, null, { timeout: 8000 });
  assert.ok((await state()).same);
  await rms(true);
  await row.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.player video').paused);
  const stopped = await state();
  await delay(330);
  assert.ok(Math.abs((await state()).time - stopped.time) < 0.04);
  await row.getByRole('button', { name: 'Play', exact: true }).click();
  report.audio.resumedRms = await rms(true);
  await row.getByRole('button', { name: 'Mute', exact: true }).click();
  assert.ok((await state()).muted);
  report.audio.mutedRms = await rms(false);
  await row.getByRole('button', { name: 'Unmute', exact: true }).click();
  await rms(true);
  await enable.click();
  await page.waitForFunction(() => window.quantumFixture.output.node.parameters.get('intensity').value < 0.001);
  assert.equal(await enable.getAttribute('aria-pressed'), 'false');
  report.audio.disabledRms = await rms(true);
  const dry = await state();
  assert.ok(dry.same && dry.attached === 1 && !dry.paused && !dry.muted, JSON.stringify(dry));
  report.checks.seekPauseMuteAndDryPlaybackSameElement = true;

  await row.getByRole('button', { name: 'Pause', exact: true }).click();
  report.worklet = await page.evaluate(offlineQuantum);
  const { dryOnset, wetOnset, surroundFrontOnset, dryError, silencePeak, wetPeak } = report.worklet;
  assert.deepEqual(dryOnset, [1041, 1041]);
  assert.deepEqual(wetOnset, dryOnset);
  assert.deepEqual(surroundFrontOnset, dryOnset);
  assert.ok(dryError < 0.00001 && silencePeak === 0 && wetPeak > 0.1, JSON.stringify(report.worklet));
  report.checks.exactWorkletWasmDryAndFrontLatency = true;

  const opaque = 'https://opaque-quantum.test/fixture.mp4';
  await page.route(opaque, route => route.abort());
  await page.getByRole('textbox', { name: 'Stream URL', exact: true }).fill(opaque);
  await page.getByRole('textbox', { name: 'Stream URL', exact: true }).press('Enter');
  const unavailable = player.getByRole('button', { name: 'AniVerse Quantum Audio unavailable for this source', exact: true });
  await unavailable.waitFor();
  assert.equal(await unavailable.isDisabled(), true);
  assert.equal(await page.evaluate(() => window.quantumFixture.elements.length), 1);
  report.checks.opaqueUrlDoesNotAttachAudioGraph = true;
  report.passed = true;
} catch (error) {
  report.error = error.stack ?? String(error);
  report.diagnostics = logs.slice(-14);
  throw error;
} finally {
  await mkdir(dirname(reportFile), { recursive: true });
  const evidence = JSON.stringify(report, null, 2) + '\n';
  await writeFile(join(run, 'result.json'), evidence);
  await writeFile(reportFile, evidence);
  await browser?.close().catch(() => undefined);
  if (child?.pid && child.exitCode === null && child.signalCode === null && child.kill()) await childExit;
  console.log(evidence);
}

async function offlineQuantum() {
  const base = document.baseURI;
  const wasm = await fetch(new URL('./quantum-audio.wasm', base));
  if (!wasm.ok) throw new Error('Packaged Quantum Audio WASM returned ' + wasm.status);
  const bytes = await wasm.arrayBuffer();
  const wasmSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  const module = await WebAssembly.compile(bytes);
  const inputSample = 1041;
  async function render(channels, intensity, impulse) {
    const context = new OfflineAudioContext(2, 1536, 48000);
    await context.audioWorklet.addModule(new URL('./quantum-worklet.js', base).href);
    const node = new AudioWorkletNode(context, 'aniverse-quantum-audio', {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 8, channelCountMode: 'max',
      channelInterpretation: 'discrete', outputChannelCount: [2], processorOptions: { module },
    });
    node.parameters.get('intensity').value = intensity;
    const signal = context.createBufferSource();
    signal.buffer = context.createBuffer(channels, 1536, 48000);
    if (impulse) {
      signal.buffer.getChannelData(0)[inputSample] = 0.25;
      signal.buffer.getChannelData(1)[inputSample] = -0.125;
    }
    signal.connect(node);
    node.connect(context.destination);
    signal.start();
    const output = await context.startRendering();
    return [output.getChannelData(0), output.getChannelData(1)];
  }
  const [dry, wet, surround, silent] = await Promise.all([
    render(2, 0, true), render(2, 1, true), render(6, 1, true), render(2, 1, false),
  ]);
  const onset = output => output.map(samples => samples.findIndex(value => Math.abs(value) > 0.00001));
  const peak = output => Math.max(...output.map(channel => Math.max(...channel.map(Math.abs))));
  const dryError = Math.max(...dry.map((channel, ear) =>
    Math.max(...channel.map((value, index) => Math.abs(value - (index === inputSample ? [0.25, -0.125][ear] : 0))))));
  return { wasmSha256, dryOnset: onset(dry), wetOnset: onset(wet), surroundFrontOnset: onset(surround),
    dryError, wetPeak: peak(wet), silencePeak: peak(silent), additionalDryAndFrontSamples: 0 };
}
