
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {execFile,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {androidClient} from './helpers/android-cdp.mjs';

if(!process.argv.includes('--run')){console.log('Prepared: --run requires the owned 5584 fixture APK and instrumented test APK.');process.exit(0);}
const hlsOnly=process.argv.includes('--hls-only');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),base=path.join(root,'test/cache/android-playing-download');
mkdirSync(base,{recursive:true});const run=mkdtempSync(path.join(base,'run-')),client=androidClient({root,run,appId:'app.aniverse.tablet.fixture'});
const origin='http://10.0.2.2:18765',delay=ms=>new Promise(r=>setTimeout(r,ms)),hash=data=>createHash('sha256').update(data).digest('hex');
const clipPath=path.join(root,'test/cache/release-1.5.2-ui/sintel-trailer.mp4'),clip=readFileSync(clipPath),clipHash=hash(clip);
const hls=path.join(run,'hls');mkdirSync(hls);
execFileSync(path.join(root,'build/vendor/ffmpeg/ffmpeg.exe'),['-hide_banner','-loglevel','error','-i',clipPath,'-c','copy','-f','hls','-hls_time','2','-hls_playlist_type','vod','-hls_segment_filename',path.join(hls,'part-%03d.ts'),'-y',path.join(hls,'media.m3u8')],{windowsHide:true,timeout:30000});
writeFileSync(path.join(hls,'master.m3u8'),'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000\nmedia.m3u8\n');
const hlsjs=readFileSync(path.join(root,'node_modules/hls.js/dist/hls.min.js'));
const original=JSON.parse(readFileSync(path.join(root,'test/fixtures/anilist-home.json'),'utf8')).data.trending.media[0];
const poster='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#28334c"/></svg>').toString('base64');
const media={...original,coverImage:{extraLarge:poster,large:poster,color:'#28334c'},bannerImage:null,id:6066,idMal:null,title:{english:'Arcadia Playback',romaji:'Arcadia Playback',native:null,userPreferred:'Arcadia Playback'},synonyms:[],episodes:2,status:'FINISHED',duration:24,description:'Authorized local playback download fixture.',nextAiringEpisode:null,streamingEpisodes:[],externalLinks:[],relations:{edges:[]},recommendations:{nodes:[]},characters:{edges:[]},studios:{nodes:[]},tags:[]};
const requests=[],checks=[],failures=[];let delayedManifests=false,server,page,browser,before;
const token=path.basename(run),sourceId='playing-'+token;
function serveBytes(req,res,bytes,type){
 const match=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/),start=match?Number(match[1]):0,end=match&&match[2]?Math.min(Number(match[2]),bytes.length-1):bytes.length-1;
 if(start>=bytes.length||end<start){res.writeHead(416,{'Content-Range':'bytes */'+bytes.length});res.end();return;}
 res.writeHead(match?206:200,{'Content-Type':type,'Content-Length':end-start+1,'Accept-Ranges':'bytes',...(match?{'Content-Range':'bytes '+start+'-'+end+'/'+bytes.length}:{})});res.end(bytes.subarray(start,end+1));
}
const sourcePage=(episode=1)=>'<!doctype html><html><head><title>Arcadia Playback</title><style nonce="fixture">body{margin:0;background:#12141a;color:white;font:18px sans-serif}iframe{width:640px;height:360px;border:0}a,input{display:inline-block;padding:12px;margin:8px}.adsbygoogle{display:block;width:300px;height:70px}</style></head><body><h1>Arcadia Playback</h1><form action="/search"><input type="search" name="q" aria-label="Search anime"><button>Search</button></form><a href="/series/arcadia">Arcadia Playback</a><div class="episodes"><a data-episode="1" href="/watch/arcadia/1">Episode 1</a><a data-episode="2" href="/watch/arcadia/2">Episode 2</a></div><iframe sandbox="allow-scripts'+(episode===1?' allow-same-origin':'')+'" src="/embed?episode='+episode+'"></iframe></body></html>';
const embed=episode=>'<!doctype html><html><head><style nonce="fixture">body{margin:0;background:black}video{display:block;width:100%;height:300px}button{font:18px sans-serif;padding:8px}.adsbygoogle{display:block;height:60px}</style></head><body><div class="adsbygoogle">Controlled advert</div><video controls muted playsinline></video><button id="play">Play fixture</button>'+(episode===2?'<script src="/hls.js"></script>':'')+'<script>const v=document.querySelector("video");window.fixtureVideo=v;document.querySelector("#play").onclick=()=>v.play();'+(episode===2?'const h=new Hls();h.loadSource("/hls/'+token+'/master.m3u8");h.attachMedia(v);':'v.src="/video.mp4?run='+token+'";')+'</script></body></html>';
server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture'),pathname=url.pathname;
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Cache-Control','no-store');
 requests.push({at:Date.now(),path:pathname,referer:!!req.headers.referer,cookie:!!req.headers.cookie,origin:req.headers.origin??null});
 if(pathname==='/graphql'){
  let body='';for await(const chunk of req)body+=chunk;
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:{Media:media,GenreCollection:['Adventure'],MediaTagCollection:[],Page:{media:[media],pageInfo:{currentPage:1,hasNextPage:false,total:1},airingSchedules:[]},trending:{media:[media]},spotlight:{media:[media]},popularSeason:{media:[media]},upcoming:{media:[]},topRated:{media:[media]},recent:{airingSchedules:[]}}}));return;
 }
 if(pathname==='/hls.js'){res.writeHead(200,{'Content-Type':'application/javascript'});res.end(hlsjs);return;}
 if(pathname==='/video.mp4'){
  if(!req.headers.referer?.startsWith(origin)){res.writeHead(403);res.end('Observed player referrer required');return;}
  if(!req.headers.cookie?.includes('capturePermit=1')){res.writeHead(403);res.end('Owned source cookie required');return;}
  serveBytes(req,res,clip,'video/mp4');return;
 }
 if(pathname.startsWith('/hls/')){
  if(req.headers.origin!=='null'){res.writeHead(403);res.end('Observed opaque player Origin required');return;}
  const filename=path.basename(pathname);
  if(!/^(master\.m3u8|media\.m3u8|part-\d+\.ts)$/.test(filename)){res.writeHead(404);res.end();return;}
  if(delayedManifests&&filename==='master.m3u8')await delay(1200);
  serveBytes(req,res,readFileSync(path.join(hls,filename)),filename.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t');return;
 }
 if(pathname==='/embed'){res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"style-src 'nonce-fixture'"});res.end(embed(Number(url.searchParams.get('episode')||1)));return;}
 if(pathname.startsWith('/source')||pathname.startsWith('/search')||pathname.startsWith('/series')||pathname.startsWith('/watch')){
  res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"style-src 'nonce-fixture'",'Set-Cookie':'capturePermit=1; Path=/; SameSite=Lax; HttpOnly'});
  res.end(sourcePage(Number(pathname.match(/\/(\d+)$/)?.[1]||1)));return;
 }
 res.writeHead(404);res.end();
});
const rpc=(method,input={})=>page.evaluate(({method,input})=>window.aniverse.invoke(method,input),{method,input});
async function check(name,body){try{const actual=await body();checks.push({name,passed:true,actual});console.log('[PASS] '+name);}catch(error){failures.push(name);checks.push({name,passed:false,error:String(error.stack||error)});console.log('[FAIL] '+name+': '+error.message);}}
async function connect(){
 const c=await client.connect();page=c.page;
 browser=await chromium.connectOverCDP('http://127.0.0.1:'+c.port,{noDefaults:true,artifactsDir:run});
}
async function startEpisode(episode){
 await page.evaluate(()=>{location.hash='#/';});
 await page.waitForFunction(()=>!document.querySelector('.tablet-player-slot'));
 await delay(200);
 const oldTargets=new Set(browser.contexts().flatMap(c=>c.pages()));
 await page.evaluate(({episode,sourceId})=>{window.__downloadTestStatus=null;addEventListener('tablet-playback',event=>{window.__downloadTestStatus=event.detail;});location.hash='#/watch/6066/'+episode+'?source='+sourceId;},{episode,sourceId});
 await page.waitForSelector('.tablet-player-slot[data-player-state=ready]',{timeout:35000});
 let target;for(const end=Date.now()+12000;Date.now()<end;){target=browser.contexts().flatMap(c=>c.pages()).find(p=>!p.isClosed()&&!oldTargets.has(p)&&p.url().startsWith(origin+'/watch/arcadia/'+episode));if(target)break;await delay(100);}
 assert.ok(target,'Owned original source page acquired');
 let frame;for(const end=Date.now()+12000;Date.now()<end;){frame=target.frames().find(frame=>frame.url().startsWith(origin+'/embed'));if(frame)break;await delay(100);}assert.ok(frame,'Original player frame acquired');
 await frame.getByRole('button',{name:'Play fixture',exact:true}).waitFor();
 await client.touch(frame.getByRole('button',{name:'Play fixture',exact:true}));
 await frame.waitForFunction(()=>{const v=document.querySelector('video');return v&&!v.paused&&v.currentTime>1&&v.videoWidth>0;},undefined,{timeout:15000});
 await delay(650);
 return {target,frame,session:await page.evaluate(()=>window.__downloadTestStatus?.session)};
}
async function newDownload(beforeIds){
 for(const end=Date.now()+20000;Date.now()<end;){const rows=await client.native('downloads.list');const row=rows.find(row=>!beforeIds.has(row.id));if(row)return row;await delay(100);}
 const messages=await page.locator('[role=alert]').allTextContents();throw Error('No queued episode appeared: '+messages.join(' '));
}
async function complete(id){
 for(const end=Date.now()+90000;Date.now()<end;){const row=(await client.native('downloads.list')).find(row=>row.id===id);if(row?.status==='complete')return row;if(row?.status==='failed')throw Error(row.error);await delay(300);}
 const row=(await client.native('downloads.list')).find(row=>row.id===id);throw Error('Download did not complete: '+JSON.stringify({status:row?.status,bytes:row?.bytes,error:row?.error}));
}
async function playLocal(id,expectedSha256){
 const active=await page.evaluate(()=>window.__downloadTestStatus?.session);
 if(active)await client.native('playback.close',{session:active});
 await page.evaluate(()=>{location.hash='#/';});await delay(200);
 const beforeNetwork=requests.filter(row=>row.path==='/video.mp4'||row.path.startsWith('/hls/')).length;
 if(browser){await browser.close().catch(()=>{});browser=undefined;}await client.close();
 const args=['shell','am','instrument','-w','-r','-e','class','app.aniverse.tablet.DownloadedPlaybackTest','-e','downloadId',id,...(expectedSha256?['-e','expectedSha256',expectedSha256]:[]),'app.aniverse.tablet.fixture.test/androidx.test.runner.AndroidJUnitRunner'];
 const output=await new Promise((resolve,reject)=>execFile('C:/Users/Admin/AppData/Local/Android/Sdk/platform-tools/adb.exe',['-s',client.serial,...args],{cwd:root,windowsHide:true,timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,TEMP:path.join(run,'temp'),TMP:path.join(run,'temp')}},(error,stdout,stderr)=>{writeFileSync(path.join(run,'offline-'+id+'.log'),stdout+stderr);if(error)reject(error);else resolve(stdout);}));
 assert.match(output,/OK \(1 test\)/,'Actual downloaded media rendered advancing native offline frames');
 assert.equal(requests.filter(row=>row.path==='/video.mp4'||row.path.startsWith('/hls/')).length,beforeNetwork,'Local watch issues no source-media network request');
 await connect();
}
try{
 await new Promise(resolve=>server.listen(18765,'127.0.0.1',resolve));client.adb('shell','pm','grant',client.appId,'android.permission.POST_NOTIFICATIONS');await connect();
 assert.equal((await client.native('native.info')).fixture,true);
 before=await client.native('storage.load');writeFileSync(path.join(run,'before-state-private.json'),JSON.stringify(before));
 const source={id:sourceId,name:'Authorized playing fixture',url:origin+'/source',host:'10.0.2.2',kind:'web',enabled:true,order:0,adblock:true,autoCloudflare:false,searchTemplate:origin+'/search?q={query}',searchTemplateSource:'user',searchCheckedAt:Date.now(),capabilities:{search:true,streams:false,episodes:false,session:true},partition:'tablet-source-'+sourceId,line:1};
 await client.native('storage.save',{value:{...before,noticeAccepted:true,adBlocking:true,sources:[...before.sources.map(s=>({...s,enabled:false})),source]}});
 await page.reload();await page.waitForFunction(()=>!!window.aniverse);
 let direct;
 if(!hlsOnly)await check('Original playing iframe has no app bridge and strict-CSP ads are blocked',async()=>{
  direct=await startEpisode(1);
  assert.equal(await direct.frame.evaluate(()=>typeof window.AniVerseNative+'|'+typeof window.aniverse),'undefined|undefined');
  assert.equal(await direct.frame.locator('.adsbygoogle').evaluate(el=>getComputedStyle(el).display),'none');
  const response=direct.target.waitForResponse(r=>r.url()==='https://doubleclick.net/aniverse-test.js',{timeout:10000});
  await direct.frame.evaluate(()=>{const s=document.createElement('script');s.src='https://doubleclick.net/aniverse-test.js';document.body.append(s);});
  assert.equal((await response).status(),403);
  assert.equal(await direct.frame.evaluate(()=>document.querySelector('video')===window.fixtureVideo),true);
  return {sandboxedFrame:true,noNativeBridge:true,adStatus:403,originalVideo:true};
 });
 if(!hlsOnly)await check('Watch Download resolves current media and preserves exact bytes plus source context',async()=>{
  assert.ok(direct);const ids=new Set((await client.native('downloads.list')).map(r=>r.id));
  const button=page.getByRole('button',{name:'Download playing episode',exact:true});await button.waitFor();await client.touch(button);
  const queued=await newDownload(ids);const saved=await complete(queued.id);
  assert.equal(client.fileHash(saved.id,'video'),clipHash);
  assert.ok((await client.native('offline.list')).items.some(item=>item.id===saved.id));
  assert.ok(requests.some(r=>r.path==='/video.mp4'&&r.cookie&&r.referer),'Native transfer uses observed source context');
  await playLocal(saved.id,clipHash);
  return {id:saved.id,sha256:clipHash,bytes:saved.bytes,noUrlForm:true};
 });
 if(!hlsOnly)await check('Changing episode during slow HLS resolution cannot publish a stale queue item',async()=>{
  const playing=await startEpisode(2);const ids=new Set((await client.native('downloads.list')).map(r=>r.id));delayedManifests=true;
  const pending=client.native('playback.download',{session:playing.session}).then(value=>({value}),error=>({error:String(error)}));
  await delay(100);await page.evaluate(()=>{location.hash='#/';});
  const result=await pending;await delay(1600);delayedManifests=false;
  assert.ok(result.error,'Navigation cancels the pending source request');
  assert.deepEqual((await client.native('downloads.list')).map(row=>row.id).filter(id=>!ids.has(id)),[]);
  return {cancelled:true,noLatePublication:true};
 });
 await check('Current blob HLS master and segments save and play with no upstream network',async()=>{
  const playing=await startEpisode(2);assert.ok(await playing.frame.locator('video').evaluate(v=>v.currentSrc.startsWith('blob:')));
  const ids=new Set((await client.native('downloads.list')).map(r=>r.id));
  await client.touch(page.getByRole('button',{name:'Download playing episode',exact:true}));
  const queued=await newDownload(ids),saved=await complete(queued.id);
  assert.ok(saved.bytes>0);assert.ok(requests.some(r=>r.path.startsWith('/hls/')&&r.origin==='null'));await playLocal(saved.id);
  return {id:saved.id,bytes:saved.bytes,blobResolved:true,cacheOnlyPlayback:true};
 });
}catch(error){checks.push({name:'Playing-download setup/completion',passed:false,error:String(error.stack||error)});failures.push('setup');console.log('[FAIL] '+error.message);}
finally{
 try{if(before){if(!page||page.isClosed())await connect();const latest=await client.native('storage.load');await client.native('storage.save',{value:{...latest,adBlocking:before.adBlocking??true,sources:latest.sources.filter(s=>s.id!==sourceId).map(s=>({...s,enabled:before.sources.find(old=>old.id===s.id)?.enabled??s.enabled}))}});}}catch(error){checks.push({name:'Restore source configuration',passed:false,error:String(error)});failures.push('restore');}
 if(browser)await browser.close().catch(()=>{});await client.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 const report={passed:!failures.length,checks,run,requests,clipSha256:clipHash,scope:'Owned fixture emulator5584; original direct and opaque-sandboxed HLS source players, actual native queue and bytes, no pasted stream URL, no DRM or challenge bypass.'};
 mkdirSync(path.join(root,'test/artifacts'),{recursive:true});writeFileSync(path.join(run,'report.json'),JSON.stringify(report,null,2));writeFileSync(path.join(root,'test/artifacts/android-playing-download.json'),JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
 console.log('[REPORT] '+run);
}
