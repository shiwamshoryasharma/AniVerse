import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createServer as createSocket} from 'node:net';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {verifyGuestMirror} from './fixtures/aniverse2-capture-mirror.mjs';

const cache = path.resolve('test/cache/aniverse2');
const run = await mkdtemp(path.join(cache, 'rendered-player-'));
const profile = path.join(run, 'profile');
const clips = Object.fromEntries(await Promise.all(['sub', 'dub'].map(async key =>
  [key, await readFile(path.join(cache, 'player-media-fixtures', key + '.mp4'))])));
const transfers = [];
const checkSession = process.env.ANIVERSE2_CHECK_SOURCE_SESSION === '1';
const checkPrivate = process.env.ANIVERSE2_CHECK_TITLE_LEASE === '1';
const checkIncognito = process.env.ANIVERSE2_CHECK_INCOGNITO === '1';
const checkCapture = process.env.ANIVERSE2_CHECK_PLAYER_CAPTURE === '1';
const checkMirror = process.env.ANIVERSE2_MIRROR_FIXTURE === '1';
const checkSearchFlow = process.env.ANIVERSE2_CHECK_SEARCH_FLOW === '1';
const searchTerms = [];
const fixtureTitle = checkSearchFlow ? 'Fixture Show: Special Edition' : 'Fixture Show';
const privateRequests = [];
const returnedCookies = [];
let privateRun = false;
const checkUpscale = process.env.ANIVERSE2_CHECK_SITE_UPSCALE === '1';
const upscaleStates = [];
let searchRequested = false, protectedFixtureReady = false;
const html = `<!doctype html><meta charset="utf-8"><title>${fixtureTitle}</title>
<style>body{margin:8px;background:#25303d;color:white}button{padding:12px}video{display:block;width:640px;height:360px}</style>
<h1>${fixtureTitle}</h1><main><video controls muted autoplay loop playsinline src="/sub.mp4"></video>
<div class="servers"><button aria-pressed="true">SUB</button><button aria-pressed="false">DUB</button></div>
<div class="episode"><button data-episode="1" aria-selected="true">Episode 1</button></div></main>
<script>
const video = document.querySelector('video');
const buttons = [...document.querySelectorAll('.servers button')];
let selection = 0;
for (const button of buttons) button.addEventListener('click', () => {
  for (const choice of buttons) choice.setAttribute('aria-pressed', String(choice === button));
  video.src = '/' + button.textContent.toLowerCase() + '.mp4?selection=' + (++selection);
  video.play().catch(() => {});
});
</script>`;
function serve(req, res) {
  const [route] = (req.url ?? '').split('?');
  if (checkUpscale && route === '/upscale-fixture-status') {
    const fields = new URL(req.url,'http://fixture.test').searchParams;
    upscaleStates.push(Object.fromEntries(fields));
    res.writeHead(204); res.end(); return;
  }
  const label = route.match(/^\/(sub|dub)\.mp4$/)?.[1];
  if (label) {
    const bytes = clips[label];
    transfers.push(label);
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    if (start > end || start >= bytes.length) {
      res.writeHead(416, {'Content-Range': 'bytes */' + bytes.length}); res.end(); return;
    }
    const headers = {'Content-Type':'video/mp4','Accept-Ranges':'bytes','Cache-Control':'no-store','Content-Length':end-start+1};
    if (match) headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
    res.writeHead(match ? 206 : 200, headers); res.end(bytes.subarray(start, end+1)); return;
  }
  if (route === '/') {
    if (privateRun) privateRequests.push(Boolean(req.headers.cookie?.includes('fixture_auth=neutral')));
    if ((checkSession || checkPrivate || checkIncognito) && !privateRun) res.setHeader('Set-Cookie','fixture_auth=neutral; Max-Age=172800; Path=/; HttpOnly');
    if (checkIncognito && privateRun) res.setHeader('Set-Cookie','fixture_auth=private; Max-Age=172800; Path=/; HttpOnly');
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end('<h1>Fixture Website</h1><a href="/search?q=Suggested+Title">Suggested Title</a>'); return;
  }
  if (route === '/cookie-return') {
    returnedCookies.push(Boolean(req.headers.cookie?.includes('fixture_auth=neutral')));
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end('<h1>Restored regular session</h1>');
    return;
  }
  if (route === '/search') {
    const query = new URL(req.url,'http://fixture.test').searchParams.get('q');
    searchTerms.push(query);
    searchRequested = query === 'Fixture Show';
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    if (!searchRequested) res.end('<h1>No results</h1>');
    else if (checkSearchFlow) res.end('<h1>Search results</h1><a href="/all-results">View all results</a>');
    else res.end('<h1>Search results</h1><a href="/watch/fixture-show/1">Fixture Show</a>');
    return;
  }
  if (route === '/all-results' && checkSearchFlow) {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end('<h1>All results</h1><a href="/watch/fixture-show/1">' + fixtureTitle + '</a>'); return;
  }
  if (checkUpscale && route === '/cors-player') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end('<!doctype html><video muted autoplay loop playsinline width="640" height="360" src="' +
      frameOrigin + '/sub.mp4?cors"></video>');
    return;
  }
  if (route === '/opaque-player' || route === '/ambiguous-player') {
    const frame = '<iframe title="Fixture player" src="' + frameOrigin +
      '/embedded-video?opaque" style="width:640px;height:360px;border:0"></iframe>';
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end('<!doctype html><body style="margin:0">' + frame +
      (route === '/ambiguous-player' ? '<iframe title="Second frame" src="/empty" hidden></iframe>' : ''));
    return;
  }
  if (route === '/empty') {res.writeHead(200, {'Content-Type':'text/html'}); res.end('Second frame'); return;}
  if (route === '/embedded-parent' || route === '/embedded-child') {
    const nested = route === '/embedded-parent' ? '/embedded-child' : '/embedded-video';
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end('<!doctype html><body style="margin:0"><iframe title="Fixture player" src="' +
      nested + '" style="width:640px;height:360px;border:0"></iframe>'); return;
  }
  if (route === '/embedded-video') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    const override = req.url.endsWith('?opaque') ? `<script>
      const video = document.querySelector('video');
      const ownQuality = video.getVideoPlaybackQuality.bind(video);
      video.getVideoPlaybackQuality = () => ({
        totalVideoFrames: ownQuality().totalVideoFrames,
        droppedVideoFrames: 'invalid metric'
      });
    </script>` : '';
    res.end('<!doctype html><body style="margin:0"><video muted autoplay loop playsinline' +
      ' width="640" height="360" src="/sub.mp4?embedded"></video>' + override); return;
  }
  if (checkCapture && route === '/fixture-capture-protected-ready') {
    protectedFixtureReady = true; res.writeHead(204); res.end(); return;
  }
  if (checkCapture && route === '/fixture-protected-capture') {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    res.end(`<!doctype html><video autoplay muted loop src="/sub.mp4" width="640" height="360"></video>
    <script>(async()=> {
      const access = await navigator.requestMediaKeySystemAccess('org.w3.clearkey',[{
        initDataTypes:['cenc'],videoCapabilities:[{contentType:'video/mp4; codecs="avc1.42E01E"'}]
      }]);
      await document.querySelector('video').setMediaKeys(await access.createMediaKeys());
      await fetch('/fixture-capture-protected-ready');
    })();</script>`);
    return;
  }
  if (route === '/watch/fixture-show/1') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    const monitor = checkUpscale ? '<script>(' + upscaleFixtureMonitor.toString() + ')()</script>' : '';
    res.end(html + monitor); return;
  }
  res.writeHead(404); res.end('Missing fixture');
}
// Runs in the owned loopback fixture only and exports no pixel data.
function upscaleFixtureMonitor() {
  let last = '';
  setInterval(() => {
    const canvas = document.querySelector('canvas[data-aniverse-upscale]');
    const state = !canvas ? 'removed' : canvas.style.visibility === 'visible' ? 'visible' : 'hidden';
    if (state === last) return;
    last = state;
    const gl = canvas?.getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '';
    const data = new URLSearchParams({state, width:canvas?.width ?? 0, height:canvas?.height ?? 0, renderer});
    fetch('/upscale-fixture-status?' + data).catch(() => undefined);
  },150);
}

const frameServer = createServer(serve);
frameServer.listen(0, '127.0.0.1');
await once(frameServer, 'listening');
const frameOrigin = 'http://127.0.0.1:' + frameServer.address().port;
const server = createServer(serve);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const sourceURL = origin + '/';
await mkdir(path.join(profile, 'config'), {recursive: true});
await writeFile(path.join(profile,'config','streaming-sites.txt'), sourceURL + '\r\n');

const temporary = createSocket().listen(0, '127.0.0.1');
await once(temporary, 'listening');
const port = temporary.address().port;
await new Promise(resolve => temporary.close(resolve));
const endpoint = 'http://127.0.0.1:' + port;
const executable = path.resolve(process.env.ANIVERSE2_TEST_EXE ?? 'test/cache/aniverse2/aniverse2-player-test.exe');
const executableSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
const env = {...process.env, ANIVERSE2_TEST_PROFILE: profile, ANIVERSE2_TEST_SITE_ORIGIN: origin, ANIVERSE2_TEST_FRAME_ORIGIN: frameOrigin,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-address=127.0.0.1 --remote-debugging-port=' + port +
    ' --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --autoplay-policy=no-user-gesture-required',
  TEMP:run,TMP:run,TMPDIR:run};
delete env.ANIVERSE_ELECTRON_HANDOFF;
delete env.WEBVIEW2_USER_DATA_FOLDER;
const child = spawn(executable, [], {windowsHide: true, stdio:['ignore','pipe','pipe'], env});
let stderr = '', browser, launchError;
child.on('error', error => { launchError = error; });
child.stderr.on('data', bytes => {stderr += bytes;});
const exit = once(child, 'exit').catch(() => undefined);
const report = {passed:false, checks:{}, frames:[], executableSha256};
const poll = async (fn, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(150);
  }
  return null;
};
try {
  browser = await poll(async () => {
    if (launchError || child.exitCode !== null) throw launchError ?? Error(stderr);
    try {
      if ((await fetch(endpoint + '/json/version', {signal: AbortSignal.timeout(400)})).ok) {
        return await chromium.connectOverCDP(endpoint, {timeout: 1500});
      }
    } catch { /* wait for owned test window */ }
    return null;
  });
  assert.ok(browser, 'The test window did not attach');
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page');
  await page.waitForURL('https://tauri.localhost/**', {timeout: 15000});
  await page.locator('.app').waitFor();
  const rpc = (method, input) => page.evaluate(({method,input}) =>
    window.__TAURI__.core.invoke('desktop_rpc',{method,input}), {method,input});
  const [source] = await rpc('sources.list');
  assert.equal(source.url, sourceURL);
  const bounds = {x: 20, y: 80, width: 780, height: 465};
  const {webContentsId} = await rpc('site.surface', {action:'attach', sourceId:source.id,partition:source.partition,bounds});
  await rpc('site.surface',{action:'place',webContentsId,bounds,visible:true});
  const opened = await rpc('site.openEpisode',{sourceId:source.id, webContentsId, mediaId:1, episode:1, titles:[fixtureTitle], focus:false});
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(searchRequested,true,'The source did not receive the search shown by its rendered link');
  report.checks.correctRenderedEpisode = true;
  if (checkSearchFlow) {
    assert.deepEqual(searchTerms.slice(0,2), ['Fixture Show Special Edition','Fixture Show']);
    report.checks.shortQueryAndFullResultsOpened = true;
  }

  for (const [index, audio] of ['sub','dub','sub'].entries()) {
    const before = transfers.length;
    const options = index === 0 ? await rpc('site.options',{webContentsId}) :
      (await rpc('site.choose',{webContentsId,sourceId:source.id,kind:'type',value:audio})).options;
    assert.equal(options.types.find(choice => choice.active)?.value,audio,JSON.stringify(options));
    if (index > 0) assert.ok(await poll(() => transfers.slice(before).includes(audio)), 'The source did not request the selected audio clip');
    const sample = await poll(async () => {
      const probe = await rpc('player.probe',{webContentsId});
      return probe?.video?.width === (audio === 'dub' ? 352 : 320) && probe.video.totalFrames > 0 && probe.currentTime > 0 ? probe : null;
    });
    assert.ok(sample, 'No decoded frames for '+audio);
    assert.ok(Number.isFinite(sample.video.bufferedAhead) && sample.video.bufferedAhead>=0);
    assert.ok(Number.isFinite(sample.video.playbackRate));
    await delay(750);
    const after = await rpc('player.probe',{webContentsId});
    assert.ok(after?.currentTime > sample.currentTime && after.video.totalFrames > sample.video.totalFrames,
      JSON.stringify({audio, before:sample?.video?.totalFrames, after:after?.video?.totalFrames}));
    report.frames.push({audio,frames:after.video.totalFrames-sample.video.totalFrames,clock:after.currentTime-sample.currentTime});
  }
  report.checks.subDubSubDecoded = true;
  if (checkCapture) {
    const blocked = await page.evaluate(async webContentsId => {
      // Playwright evaluation itself grants transient activation. Wait for it to expire.
      await new Promise(resolve => setTimeout(resolve, 5200));
      if (navigator.userActivation.isActive) throw new Error('Fixture activation did not expire');
      try { return await window.__TAURI__.core.invoke('desktop_rpc', {method:'player.capturePrepare',input:{webContentsId}}); }
      catch (error) { return {error:error.message ?? String(error)}; }
    }, webContentsId);
    assert.match(blocked.error, /player’s button/);
    await page.evaluate(async () => {
      window.fixtureCapture = { frames:0, ended:[], result:null };
      const events = window.__TAURI__.event;
      await events.listen('aniverse:player/captureFrame', async ({payload}) => {
        const state = window.fixtureCapture;
        if (payload.ticket !== state.result?.ticket || state.decoding) return;
        state.decoding = true;
        try {
          const bytes = Uint8Array.from(atob(payload.jpeg), c=>c.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));
          state.frames++;
          state.size = [bitmap.width,bitmap.height];
          bitmap.close();
        } finally { state.decoding = false; }
      });
      await events.listen('aniverse:player/captureEnded', ({payload}) => window.fixtureCapture.ended.push(payload.ticket));
      const button = document.createElement('button');
      button.id = 'fixture-start-capture';
      button.style = 'position:fixed;left:0;top:0;z-index:99999';
      button.textContent = 'Start fixture capture';
      button.onclick = async () => {
        window.fixtureCapture.result = null;
        try {
          window.fixtureCapture.result = await window.__TAURI__.core.invoke('desktop_rpc', {
            method:'player.capturePrepare',input:{webContentsId:window.fixtureCapture.guest}
          });
        } catch(error) {window.fixtureCapture.result = {error:error.message ?? String(error)};}
      };
      document.body.append(button);
    });
    const clickCapture = async (guest) => {
      await page.evaluate(id => { window.fixtureCapture.guest = id; window.fixtureCapture.result = null; },guest);
      await page.locator('#fixture-start-capture').click();
      return poll(() => page.evaluate(() => window.fixtureCapture.result));
    };
    const wrong = await clickCapture(0);
    assert.match(wrong.error,/closed/);
    const firstCapture = await clickCapture(webContentsId);
    assert.ok(firstCapture.ticket,JSON.stringify(firstCapture));
    const sampled = await poll(() => page.evaluate(() => window.fixtureCapture.size),5000);
    assert.ok(sampled && sampled[0] <= 1280 && sampled[1] <= 720,'Source compositor did not deliver a bounded decoded frame');
    const initial = await page.evaluate(() => window.fixtureCapture.frames);
    const startedAt = performance.now();
    await delay(1500);
    const beforeStop = await page.evaluate(() => window.fixtureCapture.frames);
    report.capture = {frames:beforeStop-initial,milliseconds:Math.round(performance.now()-startedAt),width:sampled[0],height:sampled[1]};
    assert.ok(report.capture.frames >= 7,JSON.stringify(report.capture));
    await rpc('player.captureStop',{ticket:'00000000-0000-0000-0000-000000000000'});
    assert.ok(await poll(() => page.evaluate(before => window.fixtureCapture.frames > before,beforeStop)));
    await rpc('player.captureStop',{ticket:firstCapture.ticket});
    assert.ok(await poll(() => page.evaluate(ticket => window.fixtureCapture.ended.includes(ticket),firstCapture.ticket)));
    const afterStop = await page.evaluate(() => window.fixtureCapture.frames);
    await delay(450);
    assert.ok((await page.evaluate(() => window.fixtureCapture.frames)) <= afterStop + 1);
    const nextCapture = await clickCapture(webContentsId);
    assert.ok(nextCapture.ticket,JSON.stringify(nextCapture));
    await rpc('site.surface',{action:'navigate',webContentsId,url:origin+'/fixture-protected-capture'});
    assert.ok(await poll(() => page.evaluate(ticket => window.fixtureCapture.ended.includes(ticket),nextCapture.ticket)));
    assert.ok(await poll(() => protectedFixtureReady),'Clear Key media keys were unavailable in the fixture runtime');
    const refused = await clickCapture(webContentsId);
    assert.match(refused.error,/unprotected video/);
    report.checks.sourceOnlyCaptureFramesAndRevocation = true;
    report.checks.captureRejectsMediaKeys = true;
  }
  if (checkUpscale) {
    const setUpscale = options => rpc('player.upscale',{webContentsId,options});
    await assert.rejects(setUpscale({enabled:true,mode:'unknown'}));
    await page.evaluate(() => { location.hash = '#/settings/player'; });
    await page.getByRole('button',{name:/Mode B/}).click();
    assert.ok(await poll(async () => (await rpc('settings.get').catch(() => null))?.player.upscale.mode === 'B'), 'Mode B did not persist');
    await page.getByRole('switch',{name:'Enable Anime4K Upscale',checked:false}).click();
    assert.ok(await poll(async () => (await rpc('settings.get').catch(() => null))?.player.upscale.enabled), 'Anime4K enable setting did not persist');
    const options = (await rpc('settings.get')).player.upscale;
    assert.deepEqual(options,{enabled:true,mode:'B',darken:false,thin:false});
    report.checks.upscaleSettingsAndNestedPresetMerge = true;
    const before = await rpc('player.probe',{webContentsId});
    const active = await poll(async () => {
      const status = await setUpscale(options);
      if (status.state === 'unavailable') throw Error(status.message);
      return status.state === 'active' ? status : null;
    }, 20000);
    assert.ok(active,'Anime4K did not report a completed GPU frame');
    const visible = await poll(() => upscaleStates.find(state => state.state === 'visible'));
    assert.ok(visible,'Anime4K output was not visible in the source view');
    assert.equal(Number(visible.width),active.width);
    assert.equal(Number(visible.height),active.height);
    assert.ok(visible.renderer && !/swiftshader|software|basic render/i.test(visible.renderer));
    await delay(1000);
    assert.ok((await rpc('player.probe',{webContentsId})).video.totalFrames > before.video.totalFrames);
    const previous = upscaleStates.length;
    assert.equal((await setUpscale({enabled:false})).state,'off');
    assert.ok(await poll(() => upscaleStates.slice(previous).some(state => state.state === 'removed')));
    report.upscale = {width:active.width,height:active.height,renderer:visible.renderer};
    report.checks.ownedVideoAnime4kGpuAndCleanup = true;
    await rpc('site.surface',{action:'navigate',webContentsId,url:origin+'/cors-player'});
    const readable = await poll(async () => {
      const probe = await rpc('player.probe',{webContentsId});
      return probe?.url?.endsWith('/cors-player') && probe.video.totalFrames > 0 ? probe : null;
    });
    assert.ok(readable,'Origin-restricted fixture video did not decode');
    const refused = await poll(async () => {
      const status = await setUpscale(options);
      assert.notEqual(status.state,'active','Origin-restricted video pixels must remain unavailable');
      return status.state === 'unavailable' ? status : null;
    });
    assert.ok(refused);
    await delay(750);
    assert.ok((await rpc('player.probe',{webContentsId})).video.totalFrames > readable.video.totalFrames);
    report.checks.originRestrictedVideoStillPlayingUnfiltered = true;
  }
  const media={id:1,idMal:null,title:'Fixture Show',cover:'',banner:null,format:'TV',episodes:1};
  const saved = await rpc('library.saveProgress',{media,episode:1,sourceId:source.id,position:15,duration:16});
  assert.equal(saved.completedNow,true);
  assert.equal((await rpc('library.state',{mediaId:1})).progress[0].completed,true);
  report.checks.localPlaybackProgress = true;
  if (checkMirror) {
    if (checkCapture) {
      await rpc('site.surface',{action:'navigate',webContentsId,url:origin + '/watch/fixture-show/1'});
      assert.ok(await poll(() => rpc('player.probe',{webContentsId})));
    }
    report.mirror = await verifyGuestMirror(page, rpc, poll, webContentsId, origin + '/watch/fixture-show/1');
    report.checks.ownedSiteVideoOnlyMirroredAndRevoked = true;
  }
  await rpc('site.surface',{action:'navigate',webContentsId,url:origin + '/embedded-parent'});
  const embedded = await poll(async () => {
    const info = await rpc('site.surface',{action:'probeDiagnostics',webContentsId}).catch(() => null);
    if (info?.topVideos !== 0 || info.sameOriginFrames !== 2) return null;
    const probe = await rpc('player.probe',{webContentsId});
    return probe?.video?.totalFrames > 0 && probe.currentTime > 0 ? probe : null;
  });
  assert.ok(embedded,'Nested same-origin player did not yield decoded playback');
  await delay(750);
  const next = await rpc('player.probe',{webContentsId});
  assert.ok(next?.currentTime > embedded.currentTime && next.video.totalFrames > embedded.video.totalFrames);
  report.checks.nestedSameOriginPlaybackMetrics = true;
  await rpc('site.surface',{action:'navigate',webContentsId,url:origin + '/opaque-player'});
  const opaque = await poll(async () => {
    const info = await rpc('site.surface',{action:'probeDiagnostics',webContentsId}).catch(() => null);
    if (!info?.uniqueOpaquePlayer || info.topVideos !== 0 || info.sameOriginFrames !== 0) return null;
    const probe = await rpc('player.probe',{webContentsId});
    return probe?.video?.totalFrames > 0 && probe.currentTime > 0 ? probe : null;
  });
  assert.ok(opaque,'Unique cross-origin player did not yield decoded playback');
  assert.equal(opaque.url,origin + '/opaque-player','The probe must expose only the existing top-level URL');
  assert.equal(opaque.video.droppedFrames,null,'A page-provided nonnumeric metric must be discarded');
  await delay(750);
  const crossOrigin = await rpc('player.probe',{webContentsId});
  assert.ok(crossOrigin?.currentTime > opaque.currentTime && crossOrigin.video.totalFrames > opaque.video.totalFrames);
  report.checks.crossOriginPlaybackMetrics = true;
  if (checkUpscale) {
    assert.equal((await rpc('player.upscale',{webContentsId,options:{enabled:true,mode:'A'}})).state,'waiting');
    report.checks.crossOriginFrameWasNotCapturedForUpscale = true;
  }
  await rpc('site.surface',{action:'navigate',webContentsId,url:origin + '/ambiguous-player'});
  assert.ok(await poll(async () => {
    const info = await rpc('site.surface',{action:'probeDiagnostics',webContentsId}).catch(() => null);
    return info?.opaqueFrames === 1 && !info.uniqueOpaquePlayer;
  }));
  assert.equal(await rpc('player.probe',{webContentsId}),null,'Ambiguous frames must not be probed');
  report.checks.ambiguousFramesSkipped = true;
  if (checkSession) {
    assert.deepEqual(await rpc('sources.session',{id:source.id}),{cookies:1,signedIn:true});
    await rpc('sources.clearSession',{id:source.id});
    assert.deepEqual(await rpc('sources.session',{id:source.id}),{cookies:0,signedIn:false});
    report.checks.sourceSessionSummaryAndClear = true;
  }
  if (checkPrivate) {
    if (!checkSession) assert.deepEqual(await rpc('sources.session',{id:source.id}),{cookies:1,signedIn:true});
    await rpc('privacy.title',{mediaId:1,on:true});
    await assert.rejects(rpc('site.surface',{action:'attach',sourceId:source.id,partition:source.partition,mediaId:1,bounds}));
    privateRun = true;
    const leased=await rpc('privacy.watchSources',{mediaId:1});
    const partition=leased.sources.find(row=>row.id===source.id)?.partition;
    assert.ok(partition?.startsWith('private-')&&leased.leaseId);
    const guest=await rpc('site.surface',{action:'attach',sourceId:source.id,partition,bounds});
    await rpc('site.surface',{action:'place',webContentsId:guest.webContentsId,bounds,visible:true});
    const open = {webContentsId:guest.webContentsId, sourceId:source.id, episode:1, titles:[fixtureTitle], focus:false};
    await assert.rejects(rpc('site.openEpisode',{...open,mediaId:2}));
    assert.equal((await rpc('site.openEpisode',{...open,mediaId:1})).ok,true);
    assert.ok(privateRequests.length>0 && privateRequests.every(value=>!value),'Private source inherited a public source cookie');
    const oldProgress=(await rpc('library.state',{mediaId:1})).progress;
    await rpc('library.saveProgress',{media,episode:1,sourceId:source.id,position:1,duration:16});
    assert.deepEqual((await rpc('library.state',{mediaId:1})).progress,oldProgress);
    await rpc('privacy.releaseSources',{leaseId:leased.leaseId});
    await assert.rejects(rpc('site.surface',{action:'attach',sourceId:source.id,partition,bounds}));
    report.checks.privateLeaseStorageTitleAndRevocation=true;
  } else if (checkIncognito) {
    assert.deepEqual(await rpc('sources.session',{id:source.id}),{cookies:1,signedIn:true});
    report.checks.regularCookieBeforeIncognito=true;
  } else {
    await rpc('site.surface',{action:'detach',webContentsId});
  }
  if (checkIncognito) {
    const before=(await rpc('library.state',{mediaId:1})).progress;
    assert.equal((await rpc('privacy.incognito',{on:true})).incognito,true);
    assert.equal((await rpc('library.history',{limit:50,offset:0})).length,0);
    const browserPartition=(await rpc('sources.list')).find(row=>row.id===source.id)?.partition;
    assert.ok(browserPartition.startsWith('private-'));
    await assert.rejects(rpc('site.surface',{action:'attach',sourceId:source.id,partition:source.partition,bounds}));
    await assert.rejects(rpc('sources.session',{id:source.id}));
    await assert.rejects(rpc('sources.clearSession',{id:source.id}));
    privateRun=true;
    const lease=await rpc('privacy.watchSources',{mediaId:1});
    const scoped=lease.sources.find(row=>row.id===source.id);
    const attached=await rpc('site.surface',{action:'attach',sourceId:source.id,partition:scoped.partition,mediaId:1,bounds});
    await rpc('site.surface',{action:'place',webContentsId:attached.webContentsId,bounds,visible:true});
    assert.equal((await rpc('site.openEpisode',{webContentsId:attached.webContentsId,sourceId:source.id,mediaId:1,episode:1,titles:['Fixture Show'],focus:false})).ok,true);
    assert.ok(privateRequests.length && privateRequests.every(value=>!value),'Incognito reused the baseline cookie');
    assert.deepEqual(await rpc('sources.audio'),{});
    await rpc('library.saveProgress',{media,episode:1,sourceId:source.id,position:1,duration:16});
    assert.equal((await rpc('privacy.incognito',{on:false})).incognito,false);
    assert.equal((await rpc('library.history',{limit:50,offset:0})).length,1);
    assert.deepEqual((await rpc('library.state',{mediaId:1})).progress,before);
    const regular=await rpc('site.surface',{action:'attach',sourceId:source.id,partition:source.partition,bounds});
    await rpc('site.surface',{action:'navigate',webContentsId:regular.webContentsId,url:origin+'/cookie-return'});
    assert.ok(await poll(()=>returnedCookies.length>0));
    assert.equal(returnedCookies.at(-1),true,'The regular view lost its baseline source cookie.');
    assert.deepEqual(await rpc('sources.session',{id:source.id}),{cookies:1,signedIn:true});
    await rpc('site.surface',{action:'detach',webContentsId:regular.webContentsId});
    await assert.rejects(rpc('site.surface',{action:'attach',sourceId:source.id,partition:scoped.partition,bounds}));
    report.checks.incognitoHistoryCookiesAndRevoke=true;
  }
  report.passed = true;
} catch (error) {
  report.error = String(error?.message ?? error);
  throw error;
} finally {
  await mkdir('test/artifacts',{recursive:true});
  await writeFile(process.env.ANIVERSE2_TEST_REPORT ?? 'test/artifacts/aniverse2-rendered-player.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  await browser?.close().catch(() => undefined);
  if (child.pid && child.exitCode === null && child.signalCode === null && child.kill()) await exit;
  server.close();
  frameServer.close();
}