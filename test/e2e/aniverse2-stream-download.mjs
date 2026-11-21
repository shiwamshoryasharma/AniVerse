import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createServer as createSocket} from 'node:net';
import {mkdir, mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const cache = path.resolve('test/cache/aniverse2');
await mkdir(cache, {recursive:true});
const run = await mkdtemp(path.join(cache, 'stream-download-'));
const profile = path.join(run, 'profile');
const destination = path.join(run, 'downloads');
const inputDir = path.join(run, 'input');
const reportPath = process.env.ANIVERSE2_TEST_REPORT ?? 'test/artifacts/aniverse2-stream-download.json';
const executable = path.resolve(process.env.ANIVERSE2_TEST_EXE ?? path.join(cache, 'aniverse2-stream-download.exe'));
const codec = fileURLToPath(new URL('../../build/vendor/ffmpeg/', import.meta.url));
const report = {passed:false, checks:{}, output:null};
const toolsEnv = {...process.env, TEMP:run, TMP:run, TMPDIR:run};
const title = 'Stream Fixture';
const playerRoute = '/watch/stream-fixture/1';

function ff(name, args) {
  const result = spawnSync(path.join(codec, name + '.exe'), args, {
    cwd:inputDir, env:toolsEnv, encoding:'utf8', windowsHide:true, timeout:30000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}

async function listening(server) {
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  return 'http://127.0.0.1:' + server.address().port;
}

async function poll(check, message, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(message);
}

let server, child, browser, dialog, childExit;
try {
  await Promise.all([mkdir(path.join(profile, 'config'), {recursive:true}), mkdir(destination), mkdir(inputDir)]);
  report.executableSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
  ff('ffmpeg', [
    '-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24',
    '-f','lavfi','-i','sine=frequency=523:sample_rate=48000','-t','6',
    '-c:v','libx264','-threads','2','-preset','veryfast','-pix_fmt','yuv420p',
    '-g','24','-sc_threshold','0','-c:a','aac','-b:a','96k','-f','hls',
    '-hls_time','1','-hls_playlist_type','vod','-hls_segment_filename','segment-%02d.ts','fixture.m3u8',
  ]);
  const files = new Map();
  for (const name of await readdir(inputDir)) files.set('/' + name, await readFile(path.join(inputDir, name)));
  files.set('/hls.min.js', await readFile(path.resolve('node_modules/hls.js/dist/hls.min.js')));
  const playlist = files.get('/fixture.m3u8').toString();
  assert.match(playlist, /#EXT-X-ENDLIST/);
  assert.ok([...files.keys()].filter(name=>name.endsWith('.ts')).length >= 3);

  const player = '<!doctype html><meta charset="utf-8"><title>'+title+'</title><h1>'+title+'</h1>' +
    '<main><video style="display:block;width:640px;height:360px" controls muted autoplay loop playsinline></video>' +
    '<button data-episode="1" aria-selected="true">Episode 1</button></main>' +
    '<script src="/hls.min.js"></script><script>const video=document.querySelector("video");' +
    'const hls=new Hls({enableWorker:false});hls.loadSource("/fixture.m3u8");hls.attachMedia(video);' +
    'hls.on(Hls.Events.MANIFEST_PARSED,()=>video.play().catch(()=>{}));</script>';
  const mediaHits = new Map();
  server = createServer((request, response) => {
    const route = new URL(request.url, 'http://127.0.0.1').pathname;
    if (files.has(route)) {
      mediaHits.set(route, (mediaHits.get(route) ?? 0) + 1);
      const payload = files.get(route);
      const contentType = route.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
        : route.endsWith('.ts') ? 'video/mp2t' : 'application/javascript';
      response.writeHead(200, {'Content-Type':contentType, 'Content-Length':payload.length, 'Cache-Control':'no-store'});
      response.end(payload);
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (route === '/') response.end('<h1>Fixture source</h1><a href="/search?q=Suggested+Title">Suggested Title</a>');
    else if (route === '/search') response.end('<h1>Search</h1><a href="'+playerRoute+'">'+title+'</a>');
    else if (route === playerRoute) response.end(player);
    else if (route === '/landing') response.end('<h1>Episode list</h1>');
    else {response.statusCode=404;response.end('Fixture route unavailable');}
  });
  const origin = await listening(server);
  await writeFile(path.join(profile, 'config', 'streaming-sites.txt'), origin+'/\r\n');
  await writeFile(path.join(profile, 'mp4-download-folder.json'), JSON.stringify(destination));
  const reservation = createSocket();
  const cdp = await listening(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const env = {...toolsEnv, ANIVERSE2_TEST_PROFILE:profile, ANIVERSE2_TEST_SITE_ORIGIN:origin,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+new URL(cdp).port+
      ' --remote-debugging-address=127.0.0.1 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --autoplay-policy=no-user-gesture-required'};
  delete env.WEBVIEW2_USER_DATA_FOLDER;
  delete env.ANIVERSE_ELECTRON_HANDOFF;
  delete env.ANIVERSE2_TEST_FRAME_ORIGIN;
  child = spawn(executable, [], {env, windowsHide:true, stdio:['ignore','ignore','pipe']});
  childExit = once(child,'exit').catch(() => undefined);
  let stderr = '', launchError;
  child.stderr.on('data', bytes => {stderr += bytes;});
  child.on('error', error => {launchError = error;});
  browser = await poll(async () => {
    if (launchError || child.exitCode !== null) throw launchError ?? new Error(stderr || 'AniVerse2 exited');
    try {
      if ((await fetch(cdp+'/json/version', {signal:AbortSignal.timeout(450)})).ok) {
        return await chromium.connectOverCDP(cdp, {timeout:1500});
      }
    } catch { /* Wait for the isolated WebView2 app. */ }
    return null;
  }, 'The isolated AniVerse2 WebView2 app did not open');
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page');
  await page.waitForURL('https://tauri.localhost/**', {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => Boolean(window.aniverse?.invoke));
  const rpc = (method,input) => page.evaluate(({method,input}) => window.aniverse.invoke(method,input), {method,input});
  const [source] = await rpc('sources.list');
  assert.equal(source.url, origin+'/');
  const bounds = {x:20,y:80,width:780,height:465};
  async function attach(item) {
    const {webContentsId} = await rpc('site.surface', {action:'attach',sourceId:item.id,partition:item.partition,mediaId:1,bounds});
    await rpc('site.surface', {action:'place',webContentsId,bounds,visible:true});
    return webContentsId;
  }
  const downloadState = webContentsId => rpc('site.surface', {action:'downloadMedia',webContentsId,save:false});
  const webContentsId = await attach(source);
  assert.deepEqual(await downloadState(webContentsId), {available:false});
  const opened = await rpc('site.openEpisode',{sourceId:source.id,webContentsId,mediaId:1,episode:1,titles:[title],focus:false});
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const before = await poll(async () => {
    const probe = await rpc('player.probe',{webContentsId});
    return probe?.video?.totalFrames > 0 && probe.currentTime > 0.2 && probe;
  }, 'The HLS fixture video did not decode');
  assert.ok(mediaHits.get('/fixture.m3u8'));
  await poll(async () => (await downloadState(webContentsId)).available, 'No download offer for decoded HLS');
  assert.deepEqual(await readdir(destination), []);
  report.checks.visibleHlsOfferedWithoutWriting = true;

  await page.evaluate(id => {
    const button = document.createElement('button');
    button.id = 'fixture-save-stream';
    button.textContent = 'Save fixture stream';
    button.style = 'position:fixed;top:0;left:0;z-index:99999';
    button.onclick = async () => {
      try {
        window.streamSaveResult = {value:await window.aniverse.invoke('site.surface',{
          action:'downloadMedia',webContentsId:id,save:true,
        })};
      } catch (error) {
        window.streamSaveResult = {error:error.message};
      }
    };
    document.body.append(button);
  },webContentsId);
  dialog = spawn('powershell.exe', [
    '-NoProfile','-NonInteractive','-File',path.resolve('test/e2e/fixtures/aniverse2-submit-save.ps1'),
    '-AppPid',String(child.pid),'-Destination',path.join(destination,'fixture.mp4'),
  ], {windowsHide:true,env,stdio:['ignore','ignore','inherit']});
  const dialogExit = once(dialog, 'exit');
  await page.locator('#fixture-save-stream').click();
  assert.equal((await dialogExit)[0],0,'Native Save As did not submit');
  const saved = await poll(()=>page.evaluate(()=>window.streamSaveResult), 'The MP4 transfer did not finish', 45000);
  assert.deepEqual(saved,{value:true});
  const outputs = await readdir(destination);
  assert.equal(outputs.length,1);
  assert.match(outputs[0],/\.mp4$/i);
  const output = path.join(destination,outputs[0]);
  const measured = JSON.parse(ff('ffprobe',[
    '-v','error','-show_entries','format=duration:stream=codec_type,codec_name,start_time,duration','-of','json',output,
  ]));
  const video = measured.streams.find(stream=>stream.codec_type==='video');
  const audio = measured.streams.find(stream=>stream.codec_type==='audio');
  assert.equal(video?.codec_name,'h264');
  assert.equal(audio?.codec_name,'aac');
  const duration = Number(measured.format.duration);
  const onsetGap = Math.abs(Number(video.start_time)-Number(audio.start_time));
  const endGap = Math.abs(Number(video.start_time)+Number(video.duration)-Number(audio.start_time)-Number(audio.duration));
  assert.ok(duration>=5.9 && duration<=6.2, JSON.stringify(measured));
  assert.ok(onsetGap<=0.12 && endGap<=0.12, JSON.stringify(measured));
  ff('ffmpeg', ['-v','error','-xerror','-i',output,'-f','null','-']);
  await poll(async () => (await rpc('player.probe',{webContentsId}))?.video?.totalFrames>before.video.totalFrames,
    'Video stopped decoding while saving');
  report.output = {bytes:(await readFile(output)).length,duration,onsetGap,endGap,video:video.codec_name,audio:audio.codec_name};
  report.checks.nativeSaveAsRemuxedSyncedAudioVideo = true;

  await rpc('site.surface',{action:'navigate',webContentsId,url:origin+'/landing'});
  await poll(async()=>!(await downloadState(webContentsId)).available,'A stale episode download remained available');
  await rpc('site.surface',{action:'detach',webContentsId});
  await assert.rejects(downloadState(webContentsId));
  report.checks.navigationAndDetachRevokeOffer = true;

  assert.equal((await rpc('privacy.incognito',{on:true})).incognito,true);
  const lease = await rpc('privacy.watchSources',{mediaId:1});
  const privateId = await attach(lease.sources.find(item=>item.id===source.id));
  assert.equal((await rpc('site.openEpisode',{sourceId:source.id,webContentsId:privateId,mediaId:1,episode:1,titles:[title],focus:false})).ok,true);
  await poll(async () => (await rpc('player.probe',{webContentsId:privateId}))?.video?.totalFrames>0, 'Private fixture did not decode');
  assert.deepEqual(await downloadState(privateId),{available:false});
  report.checks.incognitoPlaybackCannotOfferDownload = true;
  report.passed = true;
} catch (error) {
  report.error = String(error?.message ?? error);
  throw error;
} finally {
  dialog?.kill();
  await browser?.close().catch(() => undefined);
  if (child?.pid && child.exitCode === null && child.signalCode === null && child.kill()) await childExit;
  server?.close();
  await mkdir(path.dirname(reportPath),{recursive:true});
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
