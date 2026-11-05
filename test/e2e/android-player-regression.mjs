// Exactly two user-authorized runtime cases. Preparing this file never runs either case.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile,execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
import {androidClient} from './helpers/android-cdp.mjs';

if(!process.argv.includes('--run')){console.log('Prepared only. --run requires frozen0.4.7 fixture/test APKs and owned emulator5584.');process.exit(0);}
const selected=process.argv.find(arg=>arg.startsWith('--case='))?.slice(7);
assert.ok(selected===undefined||['player','download'].includes(selected),'Choose only the existing player or download case.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),cache=path.join(root,'test/cache/android-player-regression');mkdirSync(cache,{recursive:true});
const run=mkdtempSync(path.join(cache,'run-')),artifacts=path.join(root,'test/artifacts');mkdirSync(artifacts,{recursive:true});mkdirSync(path.join(run,'temp'));
const client=androidClient({root,run}),origin='http://10.0.2.2:18765',cdnOrigin='http://10.0.2.2:18766',delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const checks=[],errors=[],requests=[],created=[],fixtureErrors=[],touchDiagnostics=[],recovery=[];let cachedAppBounds=null;let page,browser,sourceTarget,before,display,installedApkSHA256,offline=false;
const originalRoot=path.resolve(root,'../../../..');
const clipPath=[path.join(root,'test/cache/release-1.5.2-ui/sintel-trailer.mp4'),path.join(originalRoot,'test/cache/release-1.5.2-ui/sintel-trailer.mp4')].find(existsSync);assert.ok(clipPath,'Previously verified public test clip must be staged locally; no media download is performed');
const ffmpeg=[path.join(root,'build/vendor/ffmpeg/ffmpeg.exe'),path.join(originalRoot,'build/vendor/ffmpeg/ffmpeg.exe')].find(existsSync);assert.ok(ffmpeg,'Existing bundled FFmpeg is required');
const clip=readFileSync(clipPath),hls=path.join(run,'hls');mkdirSync(hls);
execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-i',clipPath,'-t','8','-c','copy','-f','hls','-hls_time','2','-hls_playlist_type','vod','-hls_segment_filename',path.join(hls,'part-%03d.ts'),'-y',path.join(hls,'media.m3u8')],{windowsHide:true,timeout:30000,env:{...process.env,TEMP:path.join(run,'temp'),TMP:path.join(run,'temp')}});
const hlsjs=readFileSync(path.join(root,'node_modules/hls.js/dist/hls.min.js'));
const base=JSON.parse(readFileSync(path.join(root,'test/fixtures/anilist-home.json'),'utf8')).data.trending.media[0];
const poster='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="340"><rect width="240" height="340" fill="#29485e"/></svg>').toString('base64');
const media={...base,id:6066,idMal:null,title:{english:'Arcadia Playback',romaji:'Arcadia Playback',native:null,userPreferred:'Arcadia Playback'},synonyms:[],coverImage:{extraLarge:poster,large:poster,color:'#29485e'},bannerImage:poster,status:'FINISHED',format:'TV',episodes:2,duration:24,season:'FALL',seasonYear:2024,startDate:{year:2024,month:1,day:1},endDate:{year:2024,month:2,day:1},genres:['Adventure'],isAdult:false,nextAiringEpisode:null,streamingEpisodes:[],externalLinks:[],relations:{edges:[]},recommendations:{nodes:[]},characters:{edges:[]},studios:{nodes:[]},tags:[]};
const graph={Media:media,Page:{media:[media],pageInfo:{currentPage:1,total:1,hasNextPage:false},airingSchedules:[]},spotlight:{media:[media]},trending:{media:[media]},popularSeason:{media:[media]},upcoming:{media:[]},topRated:{media:[media]},recent:{airingSchedules:[]},GenreCollection:['Adventure'],MediaTagCollection:[]};
const viewport='<meta name="viewport" content="width=device-width,initial-scale=1">';
function sourceHTML(episode){return '<!doctype html><html><head>'+viewport+'<title>Arcadia Playback — Episode '+episode+'</title><style nonce="fixture">body{margin:0;background:#17202b;color:white;font:16px sans-serif}header{background:#ed00c9;height:72px}a,input,button{padding:8px;margin:4px;font:inherit}iframe{display:block;width:100%;height:auto;aspect-ratio:16/9;border:0}footer{background:#00e674;height:72px}</style></head><body><header data-site-chrome="root-header">SOURCE WEBSITE HEADER<form action="/search"><input type="search" name="q" aria-label="Search anime"><button>Search</button></form></header><h1>Arcadia Playback</h1><a href="/series/arcadia">Arcadia Playback</a><a href="/watch/arcadia/1" data-episode="1">Episode 1</a><a href="/watch/arcadia/2" data-episode="2">Episode 2</a><div class="audio-controls"><button data-type="sub" class="active" aria-pressed="true">SUB</button><button data-type="dub" aria-pressed="false">DUB</button></div><iframe id="website-frame" title="Original embedded website" sandbox="allow-scripts" referrerpolicy="no-referrer" src="'+cdnOrigin+'/site-frame?episode='+episode+'&audio=sub"></iframe><footer data-site-chrome="root-footer">SOURCE WEBSITE FOOTER</footer><script>for(const b of document.querySelectorAll("[data-type]"))b.onclick=()=>{for(const a of document.querySelectorAll("[data-type]")){a.setAttribute("aria-pressed",String(a===b));a.classList.toggle("active",a===b)}document.querySelector("iframe").src="'+cdnOrigin+'/site-frame?episode='+episode+'&audio="+b.dataset.type};</script></body></html>';}
function hostHTML(episode,audio){return '<!doctype html><html><head>'+viewport+'<title>Embedded source host</title><style nonce="fixture">body{margin:0;color:white;background:#141921;font:16px sans-serif}header{height:64px;background:#ed00c9}aside{height:45px;background:#ff9b00}iframe{display:block;width:100%;height:auto;aspect-ratio:16/9;border:0}footer{height:64px;background:#00e674}</style></head><body><header data-site-chrome="inner-header">EMBEDDED WEBSITE HEADER</header><aside data-site-chrome="inner-chat">WEBSITE CHAT / COMMENTS</aside><iframe title="Actual original player" sandbox="allow-scripts" referrerpolicy="no-referrer" src="'+origin+'/media-frame?episode='+episode+'&audio='+audio+'"></iframe><footer data-site-chrome="inner-footer">EMBEDDED WEBSITE FOOTER</footer></body></html>';}
function playerHTML(episode,audio){return '<!doctype html><html><head>'+viewport+'<style nonce="fixture">body{margin:0;background:#10151d;color:white}header,footer{height:38px;background:#ed00c9}.player-shell{position:relative;width:100%;height:auto;aspect-ratio:16/9;background:black}video{display:block;width:100%;height:100%;object-fit:contain}.player-controls{position:absolute;bottom:10px;left:10px;z-index:9}button{min-width:90px;min-height:48px;font:16px sans-serif}</style></head><body><header data-site-chrome="media-header">PLAYER HOST HEADER</header><div class="player-shell"><video controls loop muted playsinline '+(episode===1?'src="/video.mp4"':'')+'></video><div class="player-controls"><button id="play">Play original video</button><button id="pause">Pause original video</button><button id="reparent">Rebuild player layout</button></div></div><footer data-site-chrome="media-footer">PLAYER HOST FOOTER</footer>'+(episode===2?'<script src="/hls.js"></script>':'')+'<script>const v=document.querySelector("video");window.originalFixtureVideo=v;document.querySelector("#play").onclick=()=>v.play();document.querySelector("#pause").onclick=()=>v.pause();window.fixtureMediaEvents=[];for(const name of ["emptied","loadstart","loadedmetadata","pause","playing"])v.addEventListener(name,()=>window.fixtureMediaEvents.push({event:name,at:performance.now(),time:v.currentTime}));document.querySelector("#reparent").onclick=()=>{window.fixtureMove={beforeTime:v.currentTime,beforeSource:v.getAttribute("src"),beforeCurrentSrc:v.currentSrc,at:performance.now()};const old=v.closest(".player-shell"),mount=document.createElement("section"),replacement=document.createElement("div");mount.className="spa-mount";replacement.className="player-shell replacement-player";document.body.append(mount);mount.append(replacement);replacement.append(v,old.querySelector(".player-controls"));old.remove();Object.assign(window.fixtureMove,{afterTime:v.currentTime,afterSource:v.getAttribute("src"),afterCurrentSrc:v.currentSrc,sameNode:v===window.originalFixtureVideo});window.fixtureReparented=true;};'+(episode===2?'const hls=new Hls({xhrSetup:(xhr,url)=>{if(xhr.readyState===0)xhr.open("GET",url,true);const cdn=new URL(url,location.href).port==="18766";xhr.setRequestHeader("Accept","application/vnd.apple.mpegurl");xhr.setRequestHeader("Authorization",cdn?"Bearer fixture-cdn-b":"Bearer fixture-master-a");xhr.setRequestHeader(cdn?"X-Fixture-CDN":"X-Fixture-Playback",cdn?"variant-b":"master-a")}});hls.loadSource("/hls/'+audio+'/master.m3u8");hls.attachMedia(v);':'')+'</script></body></html>';}
function bytes(req,res,data,type){const match=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/),start=match?Number(match[1]):0,end=match&&match[2]?Math.min(Number(match[2]),data.length-1):data.length-1;res.writeHead(match?206:200,{'Content-Type':type,'Content-Length':end-start+1,'Accept-Ranges':'bytes',...(match?{'Content-Range':`bytes ${start}-${end}/${data.length}`}:{})});res.end(data.subarray(start,end+1));}
function handler(cdn){return async(req,res)=>{try{
 const u=new URL(req.url,'http://fixture');res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Accept,Authorization,X-Fixture-Playback,X-Fixture-CDN');res.setHeader('Cache-Control','no-store');
 const row={at:Date.now(),cdn,path:u.pathname,method:req.method,origin:req.headers.origin??null,referer:req.headers.referer??null,accept:req.headers.accept??null,authA:req.headers.authorization==='Bearer fixture-master-a',authB:req.headers.authorization==='Bearer fixture-cdn-b',a:req.headers['x-fixture-playback']==='master-a',b:req.headers['x-fixture-cdn']==='variant-b',cookie:!!req.headers.cookie};requests.push(row);
 if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
 if(offline&&(u.pathname==='/video.mp4'||u.pathname.startsWith('/hls/'))){res.writeHead(503);res.end('Offline fixture');return;}
 if(u.pathname==='/graphql'){for await(const chunk of req){}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:graph}));return;}
 if(u.pathname==='/hls.js'){res.writeHead(200,{'Content-Type':'application/javascript'});res.end(hlsjs);return;}
 if(u.pathname==='/video.mp4'){bytes(req,res,clip,'video/mp4');return;}
 if(u.pathname.startsWith('/hls/')){
  const name=path.basename(u.pathname),audio=u.pathname.includes('/dub/')?'dub':'sub',valid=req.headers.accept==='application/vnd.apple.mpegurl'&&(cdn?row.authB&&row.b&&!row.authA&&!row.a:row.authA&&row.a&&!row.authB&&!row.b);
  if(!valid){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Actual observed headers required</title>');return;}
  if(name.endsWith('.m3u8')){await delay(2200);row.respondedAt=Date.now();row.responseDelayMs=row.respondedAt-row.at;}
  if(name==='master.m3u8'){res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl'});res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000\n'+cdnOrigin+'/hls/'+audio+'/media.m3u8\n');return;}
  if(name==='media.m3u8'||/^part-\d+\.ts$/.test(name)){bytes(req,res,readFileSync(path.join(hls,name)),name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t');return;}
 }
 const episode=Number(u.searchParams.get('episode')??u.pathname.match(/\/watch\/arcadia\/(\d+)/)?.[1]??1),audio=u.searchParams.get('audio')==='dub'?'dub':'sub';
 res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"style-src 'nonce-fixture'",'Set-Cookie':(cdn?'fixtureCdnPermit':'fixtureSourcePermit')+'=1; Path=/; SameSite=Lax; HttpOnly'});
 res.end(u.pathname==='/site-frame'?hostHTML(episode,audio):u.pathname==='/media-frame'?playerHTML(episode,audio):sourceHTML(episode));
 }catch(error){fixtureErrors.push(String(error.message));if(!res.headersSent)res.writeHead(500);res.end('Fixture failure');}};}
const serverA=createServer(handler(false)),serverB=createServer(handler(true));
async function adbAsync(args,timeout=15000){return new Promise((resolve,reject)=>execFile('C:/Users/Admin/AppData/Local/Android/Sdk/platform-tools/adb.exe',['-s',client.serial,...args],{cwd:root,windowsHide:true,timeout,maxBuffer:4*1024*1024},(error,stdout)=>error?reject(error):resolve(stdout)));}
async function connect(afterOffline=false){
 const start=['shell','am','start','-n',client.appId+'/app.aniverse.tablet.MainActivity'];
 try{await adbAsync(start);const connected=await client.connect();page=connected.page;browser=page.context().browser();}
 catch(error){
  if(!afterOffline||!(error.killed||error.code==='ETIMEDOUT'||/timed? ?out/i.test(error.message)))throw error;
  assert.equal(client.serial,'emulator-5584');assert.equal(client.appId,'app.aniverse.tablet.fixture');
  recovery.push({stage:'post-offline-reconnect',action:'force-stop-disposable-fixture-only',error:error.message});
  await adbAsync(['shell','am','force-stop',client.appId],10000);await adbAsync(start);
  const connected=await client.connect();page=connected.page;browser=page.context().browser();
 }
}
async function cacheBounds(){
 const file='/sdcard/aniverse-player-regression.xml';
 try{
  await adbAsync(['shell','uiautomator','dump',file],10000);const xml=await adbAsync(['shell','cat',file],5000);
  const nodes=[...xml.matchAll(/<node\b[^>]*class="android.webkit.WebView"[^>]*>/g)].map(match=>match[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)).filter(Boolean).map(m=>({left:+m[1],top:+m[2],right:+m[3],bottom:+m[4]})).sort((a,b)=>(b.right-b.left)*(b.bottom-b.top)-(a.right-a.left)*(a.bottom-a.top));
  assert.ok(nodes.length);cachedAppBounds=nodes[0];
 }catch(error){touchDiagnostics.push({stage:'cache-before-media',error:error.message,method:'real-CDP-touch-fallback'});}
 finally{await adbAsync(['shell','rm','-f',file],5000).catch(()=>{});}
}
async function screenshot(name){const file=path.join(run,name+'.png');const png=execFileSync('C:/Users/Admin/AppData/Local/Android/Sdk/platform-tools/adb.exe',['-s',client.serial,'exec-out','screencap','-p'],{cwd:root,windowsHide:true,maxBuffer:16*1024*1024});writeFileSync(file,png);return file;}
async function openEpisode(episode){
 await page.evaluate(()=>{location.hash='#/';});await page.waitForFunction(()=>!document.querySelector('.tablet-player-slot'));await delay(200);
 await page.evaluate(episode=>{location.hash='#/watch/6066/'+episode+'?source=player-regression-fixture'},episode);
 await page.waitForSelector('.tablet-player-slot[data-player-state=ready]',{timeout:35000});
 for(const end=Date.now()+15000;Date.now()<end;){sourceTarget=browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().startsWith(origin+'/watch/arcadia/'+episode));if(sourceTarget)break;await delay(100);}
 assert.ok(sourceTarget,'Owned original source WebView acquired');
 return sourceTarget;
}
async function mediaFrame(episode,audio='sub'){
 for(const end=Date.now()+20000;Date.now()<end;){const frame=sourceTarget.frames().find(item=>!item.isDetached()&&item.url().startsWith(origin+'/media-frame?')&&new URL(item.url()).searchParams.get('episode')===String(episode)&&new URL(item.url()).searchParams.get('audio')===audio);if(frame)return frame;await delay(100);}
 throw Error('Owned nested original player frame was not acquired');
}
async function sample(frame){assert.ok(!frame.isDetached());return frame.locator('video').evaluate(video=>({time:video.currentTime,duration:video.duration,frames:video.getVideoPlaybackQuality?.().totalVideoFrames??0,width:video.videoWidth,height:video.videoHeight,paused:video.paused,blob:video.currentSrc.startsWith('blob:'),sameElement:window.originalFixtureVideo===video}));}
async function physicalSourceTap(frame,name){
 const button=frame.getByRole('button',{name,exact:true});await button.waitFor({state:'visible'});const box=await button.boundingBox();assert.ok(box);
 const metrics=await page.locator('.tablet-player-slot').evaluate(element=>{const r=element.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,appWidth:innerWidth,appHeight:innerHeight}}),sourceWidth=await sourceTarget.evaluate(()=>innerWidth);
 if(!cachedAppBounds){touchDiagnostics.push({name,method:'real-CDP-touch-fallback'});await client.touch(button);return}
 touchDiagnostics.push({name,method:'ADB-screen-tap-cached-bounds'});
 const app=cachedAppBounds,scale=(app.right-app.left)/metrics.appWidth,sourceScale=metrics.width/sourceWidth;
 const x=app.left+(metrics.left+(box.x+box.width/2)*sourceScale)*scale,y=app.top+(metrics.top+(box.y+box.height/2)*sourceScale)*scale;
 assert.ok(x>app.left&&x<app.right&&y>app.top&&y<app.bottom,'Original control has an actual on-screen tap point');client.adb('shell','input','tap',String(Math.round(x)),String(Math.round(y)));
}
async function startPlaying(frame){await frame.waitForFunction(()=>{const video=document.querySelector('video');return video&&video.readyState>=2},undefined,{timeout:30000});await physicalSourceTap(frame,'Play original video');await frame.waitForFunction(()=>{const video=document.querySelector('video');return video&&!video.paused&&video.currentTime>.3&&video.videoWidth>0},undefined,{timeout:15000});const first=await sample(frame);await delay(700);const second=await sample(frame);assert.ok(second.frames>first.frames&&second.sameElement,'Original nested media decodes advancing frames');return {first,second};}
async function focusedViewportNow(frame){
 const markers=[];
 for(let owned=frame;owned;owned=owned.parentFrame()){
  const marker=await owned.evaluate(()=>{const player=document.querySelector('[data-aniverse-player]');if(!player)return null;const r=player.getBoundingClientRect();return {tag:player.tagName,left:r.left,top:r.top,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight}});
  assert.ok(marker&&Math.abs(marker.left)<3&&Math.abs(marker.top)<3&&Math.abs(marker.width-marker.viewportWidth)<3&&Math.abs(marker.height-marker.viewportHeight)<3,'Every owned document confirms its own full-viewport player marker: '+JSON.stringify(marker));markers.push(marker);
 }
 const chain=[];
 for(let child=frame;child.parentFrame();child=child.parentFrame()){
  const element=await child.frameElement();const geometry=await element.evaluate(el=>{const r=el.getBoundingClientRect(),css=getComputedStyle(el);return {left:r.left,top:r.top,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,visibility:css.visibility,opacity:css.opacity}});await element.dispose();
  assert.ok(Math.abs(geometry.left)<3&&Math.abs(geometry.top)<3&&Math.abs(geometry.width-geometry.viewportWidth)<3&&Math.abs(geometry.height-geometry.viewportHeight)<3,'Each actual player iframe fills its parent viewport, not an outer website wrapper alone: '+JSON.stringify(geometry));chain.push(geometry);
 }
 const video=await frame.locator('video').evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight}});
 assert.ok(video.width>=video.viewportWidth*.9&&video.height>=video.viewportHeight*.75,'Actual original video occupies the focused native viewport');
 return {markers,chain,video,appSlot:await page.locator('.tablet-player-slot').boundingBox()};
}
async function focusedViewport(frame){
 let last;
 for(const end=Date.now()+10000;Date.now()<end;){try{return await focusedViewportNow(frame)}catch(error){last=error;await delay(150)}}
 throw last??Error('Original player did not recover its focused viewport');
}
async function sourceChrome(){
 const result=[];
 for(const frame of sourceTarget.frames().filter(frame=>!frame.isDetached())){
  const rows=await frame.evaluate(()=>[...document.querySelectorAll('[data-site-chrome]')].map(element=>{const r=element.getBoundingClientRect(),style=getComputedStyle(element);return {id:element.getAttribute('data-site-chrome'),visible:r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth&&style.visibility==='visible'&&style.display!=='none'&&Number(style.opacity)>0&&(!element.checkVisibility||element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))}}));
  result.push({frame:frame.url().includes('/site-frame')?'website-host':frame.url().includes('/media-frame')?'actual-player':'root',rows});
 }
 return result;
}
async function isolation(){for(const end=Date.now()+15000;Date.now()<end;){const rows=await sourceChrome();if(rows.reduce((n,item)=>n+item.rows.length,0)>=7&&rows.every(item=>item.rows.every(row=>!row.visible)))return rows;await delay(150);}throw Error('Source website header/chat/footer remain visible inside player-only frame: '+JSON.stringify(await sourceChrome()));}
async function recordDownload(){await page.evaluate(()=>{window.__playerDownloadEvidence=[];const channel=window.AniVerseNative,send=channel.postMessage.bind(channel),receive=channel.onmessage,ids=new Map();channel.postMessage=raw=>{try{const q=JSON.parse(raw);if(q.method==='playback.download'){const event={id:q.id,started:Date.now()};ids.set(q.id,event);window.__playerDownloadEvidence.push(event)}}catch{}return send(raw)};channel.onmessage=event=>{try{const q=JSON.parse(event.data),record=ids.get(q.id);if(record){record.finished=Date.now();record.error=q.error?.message??null;record.queuedId=q.result?.id??null;ids.delete(q.id)}}catch{}receive?.call(channel,event)}});}
async function playOffline(id){
 await client.touch(page.getByRole('link',{name:'Watch saved episodes offline',exact:true}));await page.waitForFunction(()=>!document.querySelector('.tablet-player-slot'));await delay(500);
 const previous=requests.filter(row=>row.path.startsWith('/hls/')).length;offline=true;await client.close();
 const args=['-s',client.serial,'shell','am','instrument','-w','-r','-e','class','app.aniverse.tablet.DownloadedPlaybackTest','-e','downloadId',id,'app.aniverse.tablet.fixture.test/androidx.test.runner.AndroidJUnitRunner'];
 const log=await new Promise((resolve,reject)=>execFile('C:/Users/Admin/AppData/Local/Android/Sdk/platform-tools/adb.exe',args,{cwd:root,windowsHide:true,timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,TEMP:path.join(run,'temp'),TMP:path.join(run,'temp')}},(error,stdout,stderr)=>{writeFileSync(path.join(run,'offline-native.log'),stdout+stderr);if(error)reject(error);else resolve(stdout)}));
 assert.match(log,/OK \(1 test\)/,'Existing native decoder assertion proves this downloaded item plays offline');assert.equal(requests.filter(row=>row.path.startsWith('/hls/')).length,previous,'Cache-only offline playback makes zero upstream media requests');offline=false;await connect(true);
 return {nativeDecoded:true,upstreamMediaRequests:0,log:path.join(run,'offline-native.log')};
}
async function caseRun(key,name,body){if(selected&&selected!==key)return;try{const actual=await body();checks.push({key,name,passed:true,actual});console.log('[PASS] '+name)}catch(error){checks.push({key,name,passed:false,error:String(error.stack??error)});errors.push(error.message);await screenshot('failure-'+key).catch(()=>{});console.error('[FAIL] '+name+': '+error.message)}finally{writeFileSync(path.join(run,'progress.json'),JSON.stringify({checks,errors,installedApkSHA256},null,2))}}
try{
 await Promise.all([new Promise(resolve=>serverA.listen(18765,'127.0.0.1',resolve)),new Promise(resolve=>serverB.listen(18766,'127.0.0.1',resolve))]);await connect();client.adb('shell','pm','grant',client.appId,'android.permission.POST_NOTIFICATIONS');
 display={size:client.adb('shell','wm','size').match(/Override size: (\d+x\d+)/)?.[1],density:client.adb('shell','wm','density').match(/Override density: (\d+)/)?.[1]};client.adb('shell','wm','size','2800x1752');client.adb('shell','wm','density','320');await delay(500);
 const apkPath=client.adb('shell','pm','path',client.appId).split(/\r?\n/).find(line=>line.startsWith('package:')).slice(8),installedBytes=execFileSync('C:/Users/Admin/AppData/Local/Android/Sdk/platform-tools/adb.exe',['-s',client.serial,'exec-out','cat',apkPath],{maxBuffer:40*1024*1024,windowsHide:true});installedApkSHA256=createHash('sha256').update(installedBytes).digest('hex');
 const info=await client.native('native.info');assert.equal(info.version,process.argv.find(arg=>arg.startsWith('--expected-version='))?.split('=')[1]??'0.4.7');assert.equal(info.fixture,true);
 before=await client.native('storage.load');writeFileSync(path.join(run,'before-state-private.json'),JSON.stringify(before));await build({stdin:{contents:"export {DEFAULT_SETTINGS_FALLBACK} from './frontend/src/lib/settingsFallback';",resolveDir:root},outfile:path.join(run,'seed.cjs'),bundle:true,platform:'node',format:'cjs',logLevel:'silent'});const {DEFAULT_SETTINGS_FALLBACK}=createRequire(import.meta.url)(path.join(run,'seed.cjs'));
 await client.native('storage.save',{value:{noticeAccepted:true,navigation:'tabs',railVisible:true,surface:'light',settings:{...DEFAULT_SETTINGS_FALLBACK,appearance:{...DEFAULT_SETTINGS_FALLBACK.appearance,spoilerShield:false},player:{...DEFAULT_SETTINGS_FALLBACK.player,autoplay:false},updates:{autoCheck:false,autoDownload:false}},library:{},metadata:{},sources:[{id:'player-regression-fixture',name:'Neutral nested source',url:origin+'/source',host:'10.0.2.2',kind:'web',enabled:true,order:0,adblock:true,autoCloudflare:false,searchTemplate:origin+'/search?q={query}',searchTemplateSource:'user',searchCheckedAt:1,capabilities:{search:true,episodes:true,streams:false,session:true},partition:'tablet-source-player-regression-fixture',line:1}],privateMediaIds:[]}});await page.reload({waitUntil:'domcontentloaded',timeout:25000});await page.waitForSelector('.tablet-app');await delay(800);await cacheBounds();
 await caseRun('player','Player-only recursively hides website chrome while preserving original nested video and controls',async()=>{
  await openEpisode(1);const frame=await mediaFrame(1),decoded=await startPlaying(frame),hidden=await isolation(),viewport=await focusedViewport(frame);const focusedShot=await screenshot('player-only');
  await physicalSourceTap(frame,'Pause original video');await frame.waitForFunction(()=>document.querySelector('video').paused);const paused=await sample(frame);await delay(350);assert.ok(Math.abs((await sample(frame)).time-paused.time)<.2);await physicalSourceTap(frame,'Play original video');await frame.waitForFunction(()=>!document.querySelector('video').paused);
  const beforeReparent=await sample(frame);await physicalSourceTap(frame,'Rebuild player layout');
  await frame.waitForFunction(()=>window.fixtureReparented&&document.querySelector('.replacement-player')?.contains(window.originalFixtureVideo));
  await isolation();const reparentedViewport=await focusedViewport(frame),afterReparent=await sample(frame);
  assert.ok(afterReparent.sameElement,'Website SPA mount retained the original video node');
  const fixtureMove=await frame.evaluate(()=>({...window.fixtureMove,events:window.fixtureMediaEvents}));
  assert.ok(fixtureMove.sameNode&&fixtureMove.beforeSource===fixtureMove.afterSource,'Website SPA kept the original node/source; record any browser-owned detach reset without blaming app CSS');
  // DOM media moves can pause Chromium itself. Any resume uses the same visible original control.
  const pausedBySiteMove=afterReparent.paused;
  if(pausedBySiteMove){await physicalSourceTap(frame,'Play original video');await frame.waitForFunction(()=>!document.querySelector('video').paused);}
  const reparentFirst=await sample(frame);await delay(700);const reparentSecond=await sample(frame);
  assert.ok(reparentSecond.frames>reparentFirst.frames&&reparentSecond.sameElement,'Original media still decodes after automatic focus recovery');
  const reparentedShot=await screenshot('player-spa-reparented');
  const modeBefore=await sample(frame),modeEvents=await frame.evaluate(()=>window.fixtureMediaEvents.filter(e=>['emptied','loadstart'].includes(e.event)).length);
  await client.touch(page.getByRole('button',{name:'Show website',exact:true}));await page.getByRole('button',{name:'Player only',exact:true}).waitFor();await sourceTarget.locator('[data-site-chrome="root-header"]').waitFor({state:'visible'});const websiteShot=await screenshot('website-mode');
  await client.touch(page.getByRole('button',{name:'Player only',exact:true}));await page.waitForSelector('.tablet-player-slot[data-player-state=ready]',{timeout:30000});await isolation();await focusedViewport(frame);await frame.waitForFunction(frames=>{const v=document.querySelector('video');return v===window.originalFixtureVideo&&!v.paused&&(v.getVideoPlaybackQuality?.().totalVideoFrames??0)>frames},modeBefore.frames,{timeout:10000});await delay(200);const resumed=await sample(frame);assert.ok(resumed.sameElement&&resumed.frames>modeBefore.frames&&resumed.time>=modeBefore.time-.25,'App mode switch keeps original media and playback position');assert.equal(await frame.evaluate(()=>window.fixtureMediaEvents.filter(e=>['emptied','loadstart'].includes(e.event)).length),modeEvents,'App CSS mode changes do not reload original media');const refocusedShot=await screenshot('player-only-restored');
  return {decoded,hidden,viewport,reparent:{before:beforeReparent,after:afterReparent,decoded:reparentSecond,viewport:reparentedViewport,fixtureMove,pausedBySiteMove,automaticIsolation:true},originalControlsPausedAndResumed:true,originalElementRetained:true,restoredNativeReady:true,restoredDecoded:resumed,screenshots:[focusedShot,reparentedShot,websiteShot,refocusedShot]};
 });
 await caseRun('download','Delayed valid source HLS manifests queue with observed context and play from native offline cache',async()=>{
  await openEpisode(2);await page.getByRole('button',{name:'Play DUB',exact:true}).waitFor();await client.touch(page.getByRole('button',{name:'Play DUB',exact:true}));await page.waitForSelector('.tablet-audio-selector[data-selected-audio=dub]');const frame=await mediaFrame(2,'dub'),decoded=await startPlaying(frame);assert.ok(decoded.second.blob,'Original source really uses MSE/HLS');await isolation();
  const observedA=requests.findLast(row=>row.path.endsWith('/dub/master.m3u8')&&row.authA),observedB=requests.findLast(row=>row.path.endsWith('/dub/media.m3u8')&&row.authB);assert.ok(observedA&&observedB);
  const beforeIds=new Set((await client.native('downloads.list')).map(row=>row.id));await recordDownload();const started=Date.now();await client.touch(page.getByRole('button',{name:'Download playing episode',exact:true}));let item;
  for(const end=Date.now()+70000;Date.now()<end;){const evidence=await page.evaluate(()=>window.__playerDownloadEvidence.at(-1));if(evidence?.error)throw Error('Actual Watch download failed after '+(evidence.finished-evidence.started)+'ms: '+evidence.error);item=(await client.native('downloads.list')).find(row=>!beforeIds.has(row.id));if(item&&!created.includes(item.id))created.push(item.id);if(item?.status==='failed')throw Error(item.error);if(item?.status==='complete')break;await delay(150)}
  assert.equal(item?.status,'complete');assert.equal(item.audio,'dub');assert.ok(item.bytes>0);const evidence=await page.evaluate(()=>window.__playerDownloadEvidence.at(-1));assert.equal(evidence.queuedId,item.id);assert.equal(evidence.error,null);assert.ok(evidence.finished>evidence.started&&evidence.finished-evidence.started<35000,'Real renderer RPC received its native reply before its own deadline');
  const nativeManifests=requests.filter(row=>row.at>=started&&row.method==='GET'&&row.path.endsWith('.m3u8'));assert.ok(nativeManifests.some(row=>!row.cdn&&row.authA&&row.a&&!row.authB&&!row.b&&row.responseDelayMs>=2100));assert.ok(nativeManifests.some(row=>row.cdn&&row.authB&&row.b&&!row.authA&&!row.a&&row.responseDelayMs>=2100));
  for(const row of nativeManifests){const observed=row.cdn?observedB:observedA;assert.equal(row.origin,observed.origin);assert.equal(row.referer,observed.referer);assert.equal(row.accept,observed.accept)}
  const saved=(await client.native('offline.list')).items.find(row=>row.id===item.id);assert.equal(saved.audio,'dub');const completeShot=await screenshot('download-completed'),offlineProof=await playOffline(item.id);
  return {decoded,manifestDelayMilliseconds:2200,watchReplyMilliseconds:evidence.finished-evidence.started,totalMilliseconds:Date.now()-started,bytes:item.bytes,audio:item.audio,independentObservedOriginContexts:true,actualMissingReferrerPreserved:observedA.referer===null,offline:offlineProof,screenshot:completeShot};
 });
}catch(error){errors.push(String(error.stack??error));console.error(error)}
finally{
 if(before&&(!client.page||client.page.isClosed()))await connect().catch(error=>errors.push('Cleanup reconnect: '+error.message));
 if(client.page&&!client.page.isClosed())for(const id of created){try{const row=(await client.native('downloads.list')).find(item=>item.id===id);if(row?.status==='complete'){await client.native('offline.remove',{id});await client.native('downloads.control',{id,action:'remove'})}else if(row)await client.native('downloads.control',{id,action:'cancel'})}catch(error){errors.push('Fixture cleanup: '+error.message)}}
 if(before&&client.page&&!client.page.isClosed())await client.native('storage.save',{value:before}).catch(error=>errors.push('State restore: '+error.message));if(display)try{client.adb('shell','wm','size',display.size??'reset');client.adb('shell','wm','density',display.density??'reset')}catch(error){errors.push('Display restore: '+error.message)}
 await client.close();serverA.closeAllConnections();serverB.closeAllConnections();await Promise.all([serverA.listening?new Promise(resolve=>serverA.close(resolve)):null,serverB.listening?new Promise(resolve=>serverB.close(resolve)):null]);
 const report={passed:checks.length===(selected?1:2)&&checks.every(item=>item.passed)&&errors.length===0,scope:'Exactly two focused runtime cases; neutral nested original player and delayed real MSE HLS download. Existing native offline assertion is a step inside the download case.',caseSelection:selected??'both',checks,errors,fixtureErrors,touchDiagnostics,recovery,installedApkSHA256,run,requests,limits:['Owned emulator5584 fixture/test APKs only. No physical Samsung/DeX/BlueStacks certification.','No source credentials or real websites used; all playback uses the public sample clip. No media.play/debugger resume bypass.']};writeFileSync(path.join(run,'report.json'),JSON.stringify(report,null,2));writeFileSync(path.join(artifacts,'android-player-regression.json'),JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
}
