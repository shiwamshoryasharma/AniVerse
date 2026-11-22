import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createServer as createSocket} from 'node:net';
import {mkdir, mkdtemp, readFile, readdir, rename, writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
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
let stallDownloads=false, nativeSegmentWaiting;
try {
  await Promise.all([mkdir(path.join(profile, 'config'), {recursive:true}), mkdir(destination), mkdir(inputDir)]);
  const hashFile=async file=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
  report.executableSha256=await hashFile(executable);
  report.testExecutablePath=executable;
  report.features=['isolated-test'];
  report.scope='Actual owned-player and native service; exact loopback origin is enabled only in the isolated-test build.';
  report.tools={
    ffmpegSha256:await hashFile(path.join(codec,'ffmpeg.exe')),
    ffprobeSha256:await hashFile(path.join(codec,'ffprobe.exe')),
  };
  if(process.env.ANIVERSE2_TEST_SOURCE_DIGEST){
    const proof=JSON.parse(await readFile(process.env.ANIVERSE2_TEST_SOURCE_DIGEST,'utf8'));
    report.nativeDownloadSourceSha256=proof.sha256;
    report.sourceFileSha256=proof.sourceFileSha256;
    report.sourceDigestAlgorithm=proof.algorithm;
  }

  // Generated colour bars and sine only. Video/audio share a rewritten HLS
  // master; every media path has an image suffix and an opaque fixture query.
  for (const [name, input, codecArgs] of [
    ['video', ['-f','lavfi','-i','testsrc2=size=320x180:rate=24'], ['-an','-c:v','libx264','-bf','0','-threads','2','-g','24']],
    ['audio', ['-f','lavfi','-i','sine=frequency=523:sample_rate=48000'], ['-vn','-c:a','aac','-b:a','96k']],
  ]) ff('ffmpeg', ['-nostdin','-v','error',...input,'-t','6',...codecArgs,
    '-f','hls','-hls_time','1','-hls_list_size','0','-hls_segment_filename',name+'-%02d.ts',name+'.m3u8']);
  await writeFile(path.join(inputDir,'probe-master.m3u8'),
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n'+
    '#EXT-X-STREAM-INF:BANDWIDTH=600000,AUDIO="audio"\nvideo.m3u8\n');
  const av = JSON.parse(ff('ffprobe', ['-v','error','-protocol_whitelist','file','-allowed_extensions','m3u8,ts,m4s,mp4',
    '-f','hls','-show_entries','format=start_time','-of','json','probe-master.m3u8']));
  const mediaOrigin = Math.round(Number(av.format.start_time) * 90000);
  const files = new Map();
  for (const name of ['video','audio']) {
    let manifest = await readFile(path.join(inputDir,name+'.m3u8'),'utf8');
    const parts = (await readdir(inputDir)).filter(file=>file.startsWith(name+'-')&&file.endsWith('.ts')).sort();
    for (const [index,file] of parts.entries()) {
      const alias=name+'-'+index+(index%2?'.png':'.webp');
      files.set('/'+alias,await readFile(path.join(inputDir,file)));
      manifest=manifest.replaceAll(file,alias+'?part=fixture');
    }
    files.set('/'+name+'.m3u8',Buffer.from(manifest));
  }
  for (let index=0;index<6;index++) {
    const local=String(10+index).padStart(2,'0');
    files.set('/caption-'+index+(index%2?'.png':'.webp'),Buffer.from(
      'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:'+local+'.000,MPEGTS:'+(mediaOrigin+index*90000)+
      '\n\n00:00:'+local+'.250 --> 00:00:'+local+'.750\nSynthetic caption '+(index+1)+' 世界\n\n'));
  }
  files.set('/captions.m3u8',Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:1\n'+
    Array.from({length:6},(_,index)=>'#EXTINF:1,\ncaption-'+index+(index%2?'.png':'.webp')+'?caption=fixture\n').join('')+
    '#EXT-X-ENDLIST\n'));
  files.set('/fixture.m3u8',Buffer.from('#EXTM3U\n'+
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8?audio=fixture"\n'+
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="captions.m3u8?sub=fixture"\n'+
    '#EXT-X-STREAM-INF:BANDWIDTH=600000,AUDIO="audio",SUBTITLES="subs"\nvideo.m3u8?video=fixture\n'));
  files.set('/hls.min.js',await readFile(path.resolve('node_modules/hls.js/dist/hls.min.js')));
  const player = '<!doctype html><meta charset="utf-8"><title>'+title+'</title><h1>'+title+'</h1>' +
    '<main><video style="display:block;width:640px;height:360px" controls muted autoplay loop playsinline></video>' +
    '<button data-episode="1" aria-selected="true">Episode 1</button></main>' +
    '<script src="/hls.min.js"></script><script>const video=document.querySelector("video");' +
    'const hls=new Hls({enableWorker:false});hls.loadSource("/fixture.m3u8?master=fixture");hls.attachMedia(video);' +
    'hls.on(Hls.Events.MANIFEST_PARSED,()=>video.play().catch(()=>{}));</script>';
  const mediaHits = new Map();
  server = createServer((request, response) => {
    const route = new URL(request.url, 'http://127.0.0.1').pathname;
    if(stallDownloads && /^\/(?:video|audio)-/.test(route) && !request.headers["user-agent"]){nativeSegmentWaiting?.();return;}
    if (files.has(route)) {
      mediaHits.set(route, (mediaHits.get(route) ?? 0) + 1);
      const payload = files.get(route);
      const contentType = route.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
        : route.endsWith('.png') ? 'image/png' : route.endsWith('.webp') ? 'image/webp' : 'application/javascript';
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
  report.version=(await rpc('app.info')).version;
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
  const subtitle = measured.streams.find(stream=>stream.codec_type==='subtitle');
  assert.equal(subtitle?.codec_name,'mov_text','Selected clear subtitles must be embedded');
  const cues=ff('ffmpeg',['-nostdin','-v','error','-i',output,'-map','0:s:0','-c:s','webvtt','-f','webvtt','pipe:1']);
  for (let index=1;index<=6;index++) assert.ok(cues.includes('Synthetic caption '+index+' 世界'),cues);
  const cueStarts=[...cues.matchAll(/(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})\s+-->/g)]
    .map(match=>Number(match[1]||0)*3600+Number(match[2])*60+Number(match[3])+Number(match[4])/1000);
  assert.equal(cueStarts.length,6);
  cueStarts.forEach((value,index)=>assert.ok(Math.abs(value-(index+.25))<.06,'Subtitle timing mismatch'));
  report.checks.selectedSubtitleContentAndTiming=true;
  report.checks.mixedImageSuffixesAndOpaqueQueries=true;

  const duration = Number(measured.format.duration);
  const onsetGap = Math.abs(Number(video.start_time)-Number(audio.start_time));
  const endGap = Math.abs(Number(video.start_time)+Number(video.duration)-Number(audio.start_time)-Number(audio.duration));
  assert.ok(duration>=5.9 && duration<=6.2, JSON.stringify(measured));
  assert.ok(onsetGap<=0.12 && endGap<=0.12, JSON.stringify(measured));
  ff('ffmpeg', ['-v','error','-xerror','-i',output,'-f','null','-']);
  await poll(async () => (await rpc('player.probe',{webContentsId}))?.video?.totalFrames>before.video.totalFrames,
    'Video stopped decoding while saving');
  report.output = {bytes:(await readFile(output)).length,duration,onsetGap,endGap,video:video.codec_name,audio:audio.codec_name,subtitle:subtitle.codec_name,cueStarts};
  report.checks.nativeSaveAsRemuxedSyncedAudioVideo = true;

  // Revoke a real in-flight native request while its first segment is stalled.
  // The already verified file is retained outside the destination during this case.
  const verifiedBackup=path.join(inputDir,'verified-before-revocation.mp4');
  await rename(output,verifiedBackup);
  const blocked=new Promise(resolve=>{nativeSegmentWaiting=resolve;});
  stallDownloads=true;
  await page.evaluate(()=>{delete window.streamSaveResult;});
  dialog=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',
    path.resolve('test/e2e/fixtures/aniverse2-submit-save.ps1'),'-AppPid',String(child.pid),
    '-Destination',path.join(destination,'fixture.mp4')],{windowsHide:true,env,stdio:['ignore','ignore','inherit']});
  const cancelDialogExit=once(dialog,'exit');
  await page.locator('#fixture-save-stream').click();
  assert.equal((await cancelDialogExit)[0],0,'Cancellation-case Save As did not submit');
  await Promise.race([blocked,delay(10000).then(()=>{throw Error('Native segment did not enter the controlled stall');})]);
  await rpc('site.surface',{action:'navigate',webContentsId,url:origin+'/landing'});
  const cancelled=await poll(()=>page.evaluate(()=>window.streamSaveResult),'Revoked native transfer did not cancel',5000);
  assert.match(cancelled.error,/cancelled/);
  assert.deepEqual(await readdir(destination),[],'Revoked download left a final or temporary file');
  stallDownloads=false;
  await rename(verifiedBackup,output);
  report.checks.navigationDuringDownloadCancelsAndCleans=true;

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
  server?.closeAllConnections();
  server?.close();
  await mkdir(path.dirname(reportPath),{recursive:true});
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
