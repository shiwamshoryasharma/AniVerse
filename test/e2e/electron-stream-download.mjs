import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,readdir,copyFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {build} from 'esbuild';
const require=createRequire(import.meta.url), root=process.cwd();
const helper=path.resolve(process.argv[2]), proof=JSON.parse(await readFile(path.resolve(process.argv[3]),'utf8'));
const {workerSourceDigest}=require('./fixtures/media-transfer-source-digest.cjs');
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
assert.equal(workerSourceDigest(root).sha256,proof.workerSourceSha256,'Isolated helper source differs');
assert.equal(await hash(helper),proof.fixtureHelperSha256,'Isolated helper bytes differ');
await mkdir('test/cache/electron-stream',{recursive:true});
const run=await mkdtemp(path.resolve('test/cache/electron-stream/run-'));
const inputDir=path.join(run,'input'),destination=path.join(run,'downloads'),appRoot=path.join(run,'app');
await Promise.all([inputDir,destination,appRoot,path.join(run,'profile'),path.join(appRoot,'build/vendor/ffmpeg')].map(folder=>mkdir(folder,{recursive:true})));
const codec=path.resolve('build/vendor/ffmpeg'), title='Stream Fixture',playerRoute='/watch/stream-fixture/7';
const env={...process.env,TEMP:run,TMP:run,TMPDIR:run};
function ff(name,args){const r=spawnSync(path.join(codec,name+'.exe'),args,{cwd:inputDir,env,encoding:'utf8',windowsHide:true,timeout:45000});assert.equal(r.status,0,r.stderr);return r.stdout;}
let child,server;
const report={passed:false,checks:{},run,workerSourceSha256:proof.workerSourceSha256,testFlags:['isolated-test'],productionTransportFixtures:false};
try {  for (const [name, input, codecArgs] of [
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
    'hls.on(Hls.Events.MANIFEST_PARSED,()=>video.play().catch(()=>{}));'+
    'let tick=0;window.startChurn=()=>setInterval(()=>{if(video.currentTime>0)fetch("/audio.m3u8?audio=fixture&inspection="+(++tick)).then(response=>response.text()).catch(()=>{});},600);</script>';
  const hits=[],churn=[];
  server=createServer((request,response)=>{
    const incoming=new URL(request.url,'http://fixture.test'),name=incoming.pathname;
    if(incoming.searchParams.has('inspection'))churn.push(Date.now());
    if(!request.headers['user-agent']){assert.equal(request.headers.cookie,undefined);assert.equal(request.headers.authorization,undefined);hits.push(name);}
    const bytes=files.get(name)??(name===playerRoute?Buffer.from(player):null);
    if(!bytes){response.writeHead(404).end();return;}
    const type=name===playerRoute?'text/html':name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':name.endsWith('.png')?'image/png':name.endsWith('.webp')?'image/webp':'application/javascript';
    response.writeHead(200,{'Content-Type':type,'Content-Length':bytes.length,'Cache-Control':'no-store'});response.end(bytes);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  await copyFile(helper,path.join(appRoot,'build/vendor/ffmpeg/aniverse-media-transfer.exe'));
  for(const tool of ['ffmpeg.exe','ffprobe.exe'])await copyFile(path.join(codec,tool),path.join(appRoot,'build/vendor/ffmpeg',tool));
  await writeFile(path.join(appRoot,'package.json'),JSON.stringify({name:'aniverse-download-service-fixture',version:'1.0.0',main:'main.cjs'}));
  await build({entryPoints:['test/e2e/fixtures/electron-stream-main.cjs'],outfile:path.join(appRoot,'main.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],define:{__ANIVERSE_DOWNLOAD_SCRIPT__:JSON.stringify(await readFile('electron/sourceMp4Guest.js','utf8'))}});
  report.serviceSourceSha256=await hash('electron/sourceMp4Download.ts');report.guestSourceSha256=await hash('electron/sourceMp4Guest.js');report.testHelperSha256=await hash(helper);
  report.ffmpegSha256=await hash(path.join(codec,'ffmpeg.exe'));report.ffprobeSha256=await hash(path.join(codec,'ffprobe.exe'));
  const mainReport=path.join(run,'service-report.json');
  child=spawn(require('electron'),[appRoot],{cwd:root,windowsHide:true,env:{...env,ANIVERSE_TEST_PROFILE:'1',ANIVERSE_TEST_MEDIA_ORIGIN:origin,AV_STREAM_RUN:run,AV_STREAM_ROOT:root,AV_STREAM_URL:origin+playerRoute,AV_STREAM_REPORT:mainReport},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  const timer=setTimeout(()=>child.kill(),90000);const [code]=await once(child,'exit');clearTimeout(timer);
  await writeFile(path.join(run,'electron.stdout.log'),stdout);await writeFile(path.join(run,'electron.stderr.log'),stderr);
  const service=JSON.parse(await readFile(mainReport,'utf8'));report.service=service;report.churnHits=churn;report.nativeHits=hits;assert.equal(code,0,JSON.stringify(service));assert.equal(service.passed,true,JSON.stringify(service));
  const output=path.join(destination,'Stream Fixture - S02E07.mp4');
  assert.deepEqual(await readdir(destination),['Stream Fixture - S02E07.mp4']);
  const media=JSON.parse(ff('ffprobe',['-v','error','-show_entries','stream=codec_type,codec_name,start_time,duration:format=duration','-of','json',output]));
  assert.ok(media.streams.some(s=>s.codec_type==='video'&&s.codec_name==='h264'));
  assert.ok(media.streams.some(s=>s.codec_type==='audio'&&s.codec_name==='aac'));
  assert.ok(media.streams.some(s=>s.codec_type==='subtitle'&&s.codec_name==='mov_text'));
  const subtitles=ff('ffmpeg',['-nostdin','-v','error','-i',output,'-map','0:s:0','-f','srt','-']);
  assert.match(subtitles,/Synthetic caption 1 世界/);assert.match(subtitles,/00:00:00,250/);
  const during=churn.filter(at=>at>=Date.parse(service.dialog.openedUtc)&&at<=Date.parse(service.dialog.submittedUtc));assert.ok(during.length>=2);
  assert.ok(hits.some(url=>url.endsWith('.png'))&&hits.some(url=>url.endsWith('.webp')));
  report.checks={actualDecodedVideo:true,realSaveAsDelayed3500ms:true,rollingAudioObservationsPreserveVideo:true,defaultSeriesSeasonEpisodeFilename:true,realRustTransferWithSplitAudioAndTimedSubtitles:true,cancelPreservesExistingFile:true,episodeLeaseChangeRejectsBeforeTransfer:true,anonymousFixtureTransport:true};
  report.output={...media,file:output,sha256:await hash(output),changesWhileDialogOpen:during.length};report.passed=true;
} catch(error){report.error=error.stack??String(error);throw error;}
finally{if(child?.exitCode===null)child.kill();server?.closeAllConnections();await new Promise(resolve=>server?server.close(resolve):resolve());await writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}