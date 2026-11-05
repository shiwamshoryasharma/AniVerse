// Android tablet runtime checks. Requires the deliberately installed owned debug app/emulator.
// Explicit opt-in prevents accidental device interaction: node test/e2e/android-tablet.mjs --run
// All fixture traffic is local; no third-party source or account is used.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {touchAndroidTarget} from './helpers/android-touch.mjs';

const uiCase=process.argv.find(value=>value.startsWith('--case='))?.slice(7);
if(uiCase&&!['context','resize'].includes(uiCase))throw Error('Supported focused cases: --case=context or --case=resize');
if(!process.argv.includes('--run')){console.log('Prepared only. Run with --run after the owned Android debug app is installed.');process.exit(0);}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const expectedVersion=readFileSync(path.join(root,'android/app/build.gradle.kts'),'utf8').match(/versionName\s*=\s*"([^"]+)"/)?.[1];assert.ok(expectedVersion,'Android Gradle version is declared');
const cache=path.join(root,'test/cache/android-tablet'),artifacts=path.join(root,'test/artifacts');
mkdirSync(cache,{recursive:true});mkdirSync(artifacts,{recursive:true});
const run=mkdtempSync(path.join(cache,'run-')),temporary=path.join(run,'temp');mkdirSync(temporary,{recursive:true});
const serial='emulator-5584',appId='app.aniverse.tablet.fixture';
const adbPath='C:/Users/Admin/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const fixtureOrigin='http://10.0.2.2:18765',appOrigin='https://appassets.androidplatform.net';
const adb=(...args)=>execFileSync(adbPath,['-s',serial,...args],{cwd:root,encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,TEMP:temporary,TMP:temporary,TMPDIR:temporary}}).trim();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const clip=readFileSync(path.join(root,'test/cache/release-1.5.2-ui/sintel-trailer.mp4'));
const poster='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="340"><rect width="240" height="340" fill="#302342"/><circle cx="120" cy="130" r="65" fill="#9b6a35"/><path d="M30 280L120 170L210 280Z" fill="#7355a3"/></svg>').toString('base64');
const original=JSON.parse(readFileSync(path.join(root,'test/fixtures/anilist-home.json'),'utf8')).data.trending.media[0];
const raw=(id,name)=>({...original,id,idMal:null,title:{english:name,romaji:name,native:null,userPreferred:name},synonyms:[],coverImage:{extraLarge:poster,large:poster,color:'#7c5faf'},bannerImage:poster,status:'FINISHED',episodes:12,duration:24,genres:['Adventure','Fantasy'],isAdult:false,nextAiringEpisode:null,streamingEpisodes:[],externalLinks:[],relations:{edges:[]},recommendations:{nodes:[]},characters:{edges:[]},studios:{nodes:[]},tags:[]});
const rawTitles=[raw(7,'Arcadia Story'),raw(8,'Clockwork Road'),raw(9,'Local Journey')];
const graphData=id=>({Media:rawTitles.find(row=>row.id===id)??rawTitles[0],GenreCollection:['Action','Adventure','Ecchi','Fantasy','Mecha','Sci-Fi'],MediaTagCollection:[{name:'Isekai',isAdult:false},{name:'Female Harem',isAdult:false}],Page:{media:rawTitles,pageInfo:{currentPage:1,total:3,hasNextPage:false},airingSchedules:[]},trending:{media:rawTitles},spotlight:{media:rawTitles},popularSeason:{media:rawTitles},upcoming:{media:[]},topRated:{media:rawTitles},recent:{airingSchedules:[]}});
const requests=[],checks=[],errors=[],pageErrors=[],connections=[],forwarded=[];
let forbiddenRequests=0,browser,page,sourcePage,nativeInfo,installedApkSHA256,resizeContinuity,contextMenuEvidence;
const forbidden=createServer((_req,res)=>{forbiddenRequests++;res.writeHead(200,{'Access-Control-Allow-Origin':'*'});res.end('Unexpected private-network transmission');});
const sourceHTML=(current=1,clickEpisodes=false,delayedSearch=false)=>'<!doctype html><html><head><meta charset="utf-8"><title>Arcadia Story · Fixture browser</title><style nonce="fixture-player">body{margin:0;background:#14101c;color:#f7f1eb;font:18px sans-serif;padding:18px}video{display:block;width:min(75vw,960px);aspect-ratio:16/9;height:auto;background:black}button,a,input{font:18px sans-serif;padding:12px;margin:6px;color:inherit;background:#382747;border:1px solid #79559a;border-radius:8px}input{background:#22172d}a{display:inline-block}</style></head><body><h1>Arcadia Story</h1>'+(delayedSearch?'<button class="search-trigger" onclick="clearTimeout(window.pendingSearch);window.pendingSearch=setTimeout(()=>{document.querySelector(\'form\').hidden=false},650)">Search anime</button>':'')+'<form action="/search" '+(delayedSearch?'hidden':'')+'><input aria-label="Search source" name="q" type="search" placeholder="Search source"><button>Search</button></form><a href="/series/arcadia-story">Arcadia Story</a><div class="episodes">'+[1,2,3].map(n=>clickEpisodes?'<button data-episode="'+n+'" onclick="location.href=&quot;/watch/arcadia-story/'+n+'&quot;">Episode '+n+'</button>':'<a href="/watch/arcadia-story/'+n+'" data-episode="'+n+'">Episode '+n+'</a>').join('')+'</div><video id="fixture-video" controls muted playsinline loop preload="auto" src="/video.mp4"></video><button id="play-fixture">Play fixture</button><button id="quality">Switch quality</button><a id="next" href="/watch/arcadia-story/'+(current+1)+'">Next episode</a><script>const v=document.getElementById("fixture-video");window.fixtureOriginalVideo=v;document.getElementById("play-fixture").onclick=()=>v.play();document.getElementById("quality").onclick=()=>{v.src="/video.mp4?quality=low";v.play();};</script></body></html>';
const server=createServer(async(req,res)=>{
 const requestURL=new URL(req.url,'http://localhost'),pathname=requestURL.pathname,request={method:req.method,path:pathname,query:requestURL.search};requests.push(request);res.setHeader('Cache-Control','no-store');
 if(pathname==='/graphql'){
  let bytes=0,body='';for await(const chunk of req){bytes+=chunk.length;if(bytes>256*1024){res.writeHead(413);res.end();return;}body+=chunk.toString();}
  request.bodyBytes=bytes;let parsed;try{parsed=JSON.parse(body||'{}');}catch{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Invalid fixture JSON'}));return;}request.variables=parsed.variables;
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:graphData(parsed.variables?.id)}));return;
 }
 if(pathname==='/video.mp4'){
  const match=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/),start=match?Number(match[1]):0,end=match&&match[2]?Math.min(Number(match[2]),clip.length-1):clip.length-1;
  if(start>=clip.length||end<start){res.writeHead(416,{'Content-Range':'bytes */'+clip.length});res.end();return;}
  res.writeHead(match?206:200,{'Content-Type':'video/mp4','Content-Length':end-start+1,'Accept-Ranges':'bytes',...(match?{'Content-Range':'bytes '+start+'-'+end+'/'+clip.length}:{})});res.end(req.method==='HEAD'?undefined:clip.subarray(start,end+1));return;
 }
 if(pathname.startsWith('/source')||pathname.startsWith('/search')||pathname.startsWith('/series/')||pathname.startsWith('/watch/')){res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"style-src 'nonce-fixture-player'"});res.end(sourceHTML(Number(pathname.match(/\/(\d+)$/)?.[1]??1),pathname.startsWith('/series/'),requestURL.searchParams.get('delayed')==='1'));return;}
 res.writeHead(404);res.end();
});

// Temporarily chain, then restore, the native receiver so the real typed wrapper keeps
// receiving its own outstanding replies. Never install a bridge into source pages.
const native=(target,method,input,timeout=12000)=>target.evaluate(({method,input,timeout})=>new Promise((resolve,reject)=>{
 const bridge=window.AniVerseNative;if(!bridge){reject(Error('Trusted native bridge unavailable'));return;}
 const id='android-test-'+crypto.randomUUID(),previous=bridge.onmessage;
 const restore=()=>{if(bridge.onmessage===receive)bridge.onmessage=previous;};
 const timer=setTimeout(()=>{restore();reject(Error('Native reply timed out: '+method));},timeout);
 const receive=event=>{let message;try{message=JSON.parse(event.data);}catch{previous?.call(bridge,event);return;}if(message.id!==id){previous?.call(bridge,event);return;}clearTimeout(timer);restore();if(message.error){const error=Error(message.error.message);error.code=message.error.code;reject(error);}else resolve(message.result);};
 bridge.onmessage=receive;try{bridge.postMessage(JSON.stringify({id,method,input}));}catch(error){clearTimeout(timer);restore();reject(error);}
}),{method,input,timeout});
const rpc=(method,input)=>page.evaluate(({method,input})=>window.aniverse.invoke(method,input),{method,input});
const touch=touchAndroidTarget;
const test=async(name,body)=>{if(uiCase==='context'&&!name.startsWith('Touch context menu'))return;if(uiCase==='resize'&&!name.startsWith('Active playback survives'))return;if(!uiCase&&name.startsWith('Active playback survives')&&!process.argv.includes('--resize-continuity'))return;try{const result=await body();checks.push({name,passed:true,...(result===undefined?{}:{actual:result})});console.log('[PASS] '+name);}catch(error){if(name.startsWith('Touch context menu')&&contextMenuEvidence){Object.assign(contextMenuEvidence,{status:'failed',error:String(error.stack||error)});writeFileSync(path.join(artifacts,'android-context-progress.json'),JSON.stringify(contextMenuEvidence,null,2));}if(name.startsWith('Active playback survives')&&resizeContinuity){Object.assign(resizeContinuity,{status:'failed',error:String(error.stack||error)});writeFileSync(path.join(artifacts,'android-resize-progress.json'),JSON.stringify(resizeContinuity,null,2));}checks.push({name,passed:false,error:String(error.stack||error)});errors.push(name+': '+error.message);console.error('[FAIL] '+name+': '+error.message);await (sourcePage&&!sourcePage.isClosed()?sourcePage:page)?.screenshot({path:path.join(artifacts,'android-tablet-'+(uiCase?uiCase+'-':'')+'failure-'+checks.length+'.png')}).catch(()=>{});}};
async function attach(){
 adb('shell','am','start','-n',appId+'/app.aniverse.tablet.MainActivity');
 let pid,socket;
 for(const until=Date.now()+25000;Date.now()<until;){
  try{pid=adb('shell','pidof',appId).split(/\s+/)[0];}catch(error){if(error.status===1&&!error.stdout&&!error.stderr)pid='';else throw error;}
  if(pid){socket=adb('shell','cat','/proc/net/unix').split(/\r?\n/).map(line=>line.trim().split(/\s+/).at(-1)).find(name=>name==='@webview_devtools_remote_'+pid);if(socket)break;}
  await delay(250);
 }
 assert.ok(pid&&socket,'Owned app exposes its debug WebView CDP socket');
 const port=adb('forward','tcp:0','localabstract:'+socket.substring(1));assert.match(port,/^\d+$/);forwarded.push(port);
 browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true,artifactsDir:run});connections.push(browser);
 for(const until=Date.now()+20000;Date.now()<until;){page=browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().startsWith(appOrigin+'/assets/'));if(page)break;await delay(150);}
 assert.ok(page,'Trusted local-assets WebView discovered');page.setDefaultTimeout(8000);page.on('pageerror',error=>pageErrors.push(error.message));
 await page.waitForFunction(()=>!!window.AniVerseNative);return {pid,socket,port};
}
async function sourceTarget(expectedProfile){
 for(const until=Date.now()+20000;Date.now()<until;){const target=browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().startsWith(fixtureOrigin)&&(!expectedProfile||new URL(target.url()).searchParams.get('profile')===expectedProfile));if(target){target.setDefaultTimeout(8000);return target;}await delay(150);}
 throw Error('Separate source WebView did not appear in the owned app CDP session');
}
async function mainActivity(){adb('shell','am','start','-n',appId+'/app.aniverse.tablet.MainActivity');sourcePage=undefined;await page.waitForFunction(()=>!!window.aniverse);}
// Resolve navigation only from actual accessible UI elements; do not inject a route
// to claim touch navigation passed. Adjust names only when the shipped UI defines them.
async function nav(name){
 let target=page.getByRole('navigation',{name:'Main',exact:true}).getByRole('link',{name,exact:true});
 if(!await target.count()){
  await touch(page.getByRole('navigation',{name:'Main',exact:true}).getByRole('button',{name:'More',exact:true}));
  target=page.getByRole('dialog',{name:'More',exact:true}).getByRole('link',{name:new RegExp('^'+name+'(?:\\s|$)')});
 }
 assert.equal(await target.count(),1,'Visible navigation action '+name);await touch(target);
}

try{
 assert.equal(adb('get-state'),'device','Only the explicitly owned emulator may run this harness');
 await Promise.all([new Promise(resolve=>server.listen(18765,'127.0.0.1',resolve)),new Promise(resolve=>forbidden.listen(0,'127.0.0.1',resolve))]);
 const privateURL='http://10.0.2.2:'+forbidden.address().port+'/private';
 const transport=await attach();console.log('[DEVICE] '+JSON.stringify({serial,appId,...transport}));
 nativeInfo=await native(page,'native.info');const installedPath=adb('shell','pm','path',appId).split(/\r?\n/).find(value=>value.endsWith('/base.apk'))?.replace(/^package:/,'');assert.match(installedPath,/^\/data\/app\/[A-Za-z0-9_~+\/=.-]+\/base\.apk$/);installedApkSHA256=adb('shell','sha256sum',installedPath).split(/\s+/)[0];assert.match(installedApkSHA256,/^[a-f0-9]{64}$/);
 await test('Native tablet information exposes Android version patch WebView and isolation capabilities',async()=>{
  assert.equal(nativeInfo.platform,'android');assert.equal(nativeInfo.version,expectedVersion);assert.ok(nativeInfo.sdkInt>=35);assert.equal(nativeInfo.tablet,true);assert.ok(nativeInfo.smallestWidthDp>=600);assert.match(nativeInfo.securityPatch,/^\d{4}-\d{2}-\d{2}$/);assert.match(nativeInfo.webViewVersion,/\d/);assert.equal(nativeInfo.sandbox.appPrivateStorage,true);assert.equal(nativeInfo.sandbox.originRestrictedBridge,true);assert.equal(nativeInfo.sandbox.websiteNativeBridge,false);assert.equal(nativeInfo.sandbox.multiProfile,true);assert.equal(nativeInfo.upscaling,false);return nativeInfo;
 });
 await test('Unknown native methods and unofficial API URLs are denied without network transmission',async()=>{
  await assert.rejects(()=>native(page,'__proto__',{}));await assert.rejects(()=>native(page,'api.request',{url:privateURL,method:'GET'}));assert.equal(forbiddenRequests,0);assert.equal((await native(page,'native.info')).version,expectedVersion);
 });
 await test('Oversized ordinary bridge messages are rejected before API transmission and bridge remains responsive',async()=>{
  await assert.rejects(()=>native(page,'api.request',{url:'https://graphql.anilist.co',method:'POST',body:'x'.repeat(70*1024)},5000));assert.equal(requests.filter(request=>request.path==='/graphql'&&request.bodyBytes>64*1024).length,0);assert.equal((await native(page,'native.info')).platform,'android');
 });

 await build({stdin:{contents:"export {TabletLibrary} from './frontend/src/android/library';export {DEFAULT_SETTINGS_FALLBACK} from './frontend/src/lib/settingsFallback';",resolveDir:root},outfile:path.join(run,'seed.cjs'),bundle:true,platform:'node',format:'cjs',logLevel:'warning'});
 const {TabletLibrary,DEFAULT_SETTINGS_FALLBACK}=createRequire(import.meta.url)(path.join(run,'seed.cjs'));
 const now=Math.floor(Date.now()/1000),library=new TabletLibrary(undefined,()=>now);
 const snapshot=raw=>({id:raw.id,idMal:null,title:raw.title.english,cover:raw.coverImage.large,banner:null,format:'TV',episodes:12});
 for(const [index,title]of rawTitles.entries())library.saveProgress({media:snapshot(title),episode:index+1,position:120+index*100,duration:600,sourceId:'tablet-fixture'});
 library.saveProgress({media:snapshot(rawTitles[0]),episode:4,position:450,duration:600,sourceId:'tablet-fixture'});
 const makeSource=id=>({id,name:id==='tablet-fixture'?'Fixture library':'Second fixture profile',url:fixtureOrigin+'/source?profile='+encodeURIComponent(id),host:'10.0.2.2',kind:'web',enabled:true,order:0,adblock:false,autoCloudflare:false,searchTemplate:fixtureOrigin+'/search?q={query}',searchTemplateSource:'user',searchCheckedAt:now,capabilities:{search:true,streams:false,episodes:false,session:true},partition:'tablet-source-'+id,line:1});
 const formSource={...makeSource('tablet-form-'+Date.now()),name:'Form search fixture',url:fixtureOrigin+'/source?profile=delayed&delayed=1',searchTemplate:null,searchTemplateSource:null};
 const saved={noticeAccepted:true,settings:{...DEFAULT_SETTINGS_FALLBACK,appearance:{...DEFAULT_SETTINGS_FALLBACK.appearance,spoilerShield:false},player:{...DEFAULT_SETTINGS_FALLBACK.player,autoplay:false},updates:{autoCheck:false,autoDownload:false}},library:library.exportData(),sources:[makeSource('tablet-fixture'),makeSource('tablet-fixture-two'),formSource],privateMediaIds:[]};
 await native(page,'storage.save',{value:saved});await page.reload({waitUntil:'domcontentloaded',timeout:25000});await page.waitForFunction(()=>!!window.aniverse&&!!document.querySelector('.tablet-app'),{},{timeout:25000});

 // UI checks are completed against the actual Android shell once its source/build is ready.
 await test('Android app opens a landscape tablet viewport with touch navigation',async()=>{
  const metrics=await page.evaluate(()=>({width:innerWidth,height:innerHeight,landscape:matchMedia('(orientation: landscape)').matches,dpr:devicePixelRatio}));assert.ok(metrics.width>metrics.height);assert.equal(metrics.landscape,true);
  await nav('History');await page.getByRole('heading',{name:'Watch history',exact:true}).waitFor();await page.screenshot({path:path.join(artifacts,'android-tablet-history.png')});return metrics;
 });
 await test('Shared history Grid and List work by touch and retain layout after reload',async()=>{
  assert.equal(await page.locator('.history-entry').count(),4);await touch(page.getByRole('button',{name:'List',exact:true}));await page.waitForFunction(()=>document.querySelector('.history-results')?.dataset.view==='list');await page.reload();await page.waitForFunction(()=>document.querySelector('.history-results')?.dataset.view==='list');
  await touch(page.getByRole('button',{name:'Grid',exact:true}));await page.waitForFunction(()=>document.querySelector('.history-results')?.dataset.view==='grid');await page.screenshot({path:path.join(artifacts,'android-tablet-history-grid.png')});
 });
 await test('Tablet settings expose no unsupported 4K or upscaling controls',async()=>{
  await nav('Settings');await page.getByRole('heading',{name:/Settings/,exact:false}).first().waitFor();
  const unsupported=page.getByRole('button',{name:/4K|Anime4K|upscal/i}).or(page.getByRole('switch',{name:/4K|Anime4K|upscal/i})).or(page.getByRole('combobox',{name:/4K|Anime4K|upscal/i}));assert.equal(await unsupported.count(),0);await page.screenshot({path:path.join(artifacts,'android-tablet-settings.png')});
 });
 await test('Fixture builds cannot download or launch release updates',async()=>{
  const foreground=()=>{
   const lines=adb('shell','dumpsys','activity','activities').split(/\r?\n/);
   const row=lines.find(line=>line.includes('topResumedActivity='))??lines.find(line=>line.includes('mResumedActivity'))??lines.find(line=>/^\s*Resumed:/.test(line));
   const match=row?.match(/\bu\d+\s+([\w.]+)\/([\w.$]+)/);
   assert.ok(match,'Android reports a resumed activity component');
   const component=match[2].startsWith('.')?match[1]+match[2]:match[2];
   return {package:match[1],component};
  };
  const before=foreground();assert.equal(before.package,appId,'Owned fixture activity is in the foreground');assert.equal(before.component,'app.aniverse.tablet.MainActivity');
  const result=await native(page,'updates.check');assert.equal(result.state,'unavailable');
  await assert.rejects(()=>native(page,'updates.install',{tag:'android-v9.9.9'}),/unavailable in debug or fixture builds/i);
  assert.deepEqual(foreground(),before,'No installer or unknown-sources settings activity was launched');
 });
 await test('Glass appearance persists and motion respects the app and OS preferences',async()=>{
  await nav('Settings');
  assert.equal(await page.locator('html').getAttribute('data-tablet-surface'),'light','New Android profiles default to light glass');
  for(const [mode,label]of [['dark','Dark glass'],['light','Light glass']]){
   const choice=page.getByRole('combobox',{name:'Glass appearance',exact:true});await touch(choice);await touch(page.getByRole('option',{name:label,exact:true}));
   await page.waitForFunction(mode=>document.documentElement.dataset.tabletSurface===mode,mode);
   await page.reload();await page.waitForFunction(mode=>document.documentElement.dataset.tabletSurface===mode,mode);
   assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),mode);await page.screenshot({path:path.join(artifacts,'android-tablet-surface-'+mode+'.png')});
  }
  const colourInfo=await native(page,'native.info');
  const system=page.getByRole('checkbox',{name:'Use Android colours',exact:true});
  if(!await system.isChecked())await touch(system.locator('..'));
  await page.waitForFunction(accent=>getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase()===accent.toLowerCase(),colourInfo.systemAccentLight);
  for(const [preset,colour]of [['ember','rgb(255, 122, 26)'],['festival','rgb(255, 156, 66)']]){
   const swatch=page.locator('.tablet-colour[data-accent='+preset+'] > span');
   assert.equal(await swatch.evaluate(element=>getComputedStyle(element).backgroundColor),colour,'Named palette preview stays accurate while Android colours are enabled');
  }
  await touch(page.getByRole('button',{name:'festival',exact:true}));
  await page.waitForFunction(()=>document.documentElement.dataset.accent==='festival');
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),'light','Festival cannot override Light glass');
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()),'#eaf0fa');
  await touch(system.locator('..'));await page.waitForFunction(accent=>getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase()===accent.toLowerCase(),colourInfo.systemAccentLight);
  await page.emulateMedia({reducedMotion:'no-preference'});
  const reduced=page.getByRole('checkbox',{name:'Reduce animations',exact:true});
  if(await reduced.isChecked())await touch(reduced.locator('..'));
  await page.waitForFunction(()=>document.documentElement.dataset.motion==='full');
  const duration=()=>page.locator('.tablet-nav-indicator').evaluate(element=>Math.max(...getComputedStyle(element).transitionDuration.split(',').map(value=>parseFloat(value))));
  assert.ok(await duration()>0,'The active navigation pill has an actual motion transition');
  await touch(reduced.locator('..'));await page.waitForFunction(()=>document.documentElement.dataset.motion==='reduce');
  assert.equal(await duration(),0,'App reduced motion removes indicator transitions');
  assert.equal(await page.locator('.tablet-route').evaluate(element=>getComputedStyle(element).animationName),'none');
  await touch(reduced.locator('..'));await page.waitForFunction(()=>document.documentElement.dataset.motion==='full');
  await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await duration(),0,'OS reduced motion removes indicator transitions');
  await page.emulateMedia({reducedMotion:'no-preference'});
 });
 await test('Floating rail and bottom navigation retain every destination and persist the tablet preference',async()=>{
  for(const [mode,label]of [['tabs','Bottom navigation'],['rail','Navigation rail']]){
   await nav('Settings');const choice=page.getByRole('combobox',{name:'Navigation layout',exact:true});await touch(choice);
   await touch(page.getByRole('option',{name:label,exact:true}));
   await page.waitForFunction(mode=>document.querySelector('.tablet-app')?.getAttribute('data-navigation')===mode,mode);
   await page.reload();await page.waitForFunction(mode=>document.querySelector('.tablet-app')?.getAttribute('data-navigation')===mode,mode);
   assert.equal(await page.getByRole('navigation',{name:'Main',exact:true}).getByRole('link').count(),4);
   const chrome=await page.evaluate(()=>{
    const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const main=rect(document.querySelector('.tablet-main')),search=rect(document.querySelector('.tablet-search-dock')),nav=rect(document.querySelector('.tablet-nav'));
    return {main,search,nav,logo:rect(document.querySelector('.tablet-brand')),profile:rect(document.querySelector('.tablet-profile-pill')),header:getComputedStyle(document.querySelector('.tablet-topbar')).backgroundColor,glass:[...document.querySelectorAll('.tablet-brand,.tablet-profile-pill,.tablet-nav,.tablet-search-dock .tablet-search')].map(element=>({blur:getComputedStyle(element).backdropFilter,background:getComputedStyle(element).backgroundImage})),viewport:{width:innerWidth,height:innerHeight}};
   });
   assert.equal(chrome.header,'rgba(0, 0, 0, 0)','There is no painted full-width app bar');
   assert.ok(chrome.logo.width<=60&&chrome.profile.right>chrome.viewport.width-40&&chrome.profile.width<300,'Logo and account controls are separate floating groups');
   assert.ok(chrome.search.width>=320&&chrome.search.width<=362&&chrome.main.bottom<=chrome.search.top-4,'Bottom search has a reserved safe gutter');
   if(mode==='tabs')assert.ok(chrome.search.bottom<=chrome.nav.top-4&&chrome.nav.width<=chrome.viewport.width*.73,'Search floats above a proportionate bottom capsule');
   else assert.ok(chrome.nav.width>=84&&chrome.nav.width<=96&&chrome.nav.right<=chrome.main.left,'Vertical capsule retains the main canvas');
   for(const surface of chrome.glass)assert.ok(surface.blur.includes('blur(24px)')&&surface.blur.includes('saturate(1.3)'),'Floating chrome has actual bounded backdrop frosting: '+JSON.stringify(surface));
   const floating=await page.getByRole('navigation',{name:'Main',exact:true}).evaluate(element=>{const rect=element.getBoundingClientRect(),main=document.querySelector('.tablet-main').getBoundingClientRect(),style=getComputedStyle(element);return {left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:innerWidth,height:innerHeight,radius:parseFloat(style.borderRadius),gap:document.querySelector('.tablet-app').dataset.navigation==='rail'?main.left-rect.right:rect.top-main.bottom};});
   assert.ok(floating.left>=8&&floating.top>=8&&floating.right<=floating.width-8&&floating.bottom<=floating.height-8,'Navigation capsule floats away from every viewport edge');
   assert.ok(floating.radius>=28&&floating.gap>=6,'Floating capsule has rounded corners and a separate content gutter');
   if(mode==='tabs')assert.ok(floating.top>floating.height*.65&&floating.bottom<=floating.height-16,'Bottom capsule sits above the screen edge with reserved space for its controls');
   for(const [name,route]of [['Home','/'],['Browse','/browse'],['Library','/library'],['Sources','/sources'],['Local watch','/local'],['Downloads','/downloads'],['History','/history'],['Schedule','/schedule'],['Settings','/settings']]){
    await nav(name);await page.waitForFunction(route=>location.hash.split('?')[0]==='#'+route,route);
    assert.equal(await page.getByRole('dialog',{name:'More',exact:true}).count(),0);
    if(name==='Home'){await page.locator('.hero-thumbs .hero-thumb').first().waitFor();await page.screenshot({path:path.join(artifacts,'android-tablet-home-'+mode+'.png')});}
   }
   const more=page.getByRole('navigation',{name:'Main',exact:true}).getByRole('button',{name:'More',exact:true});
   assert.equal(await more.getAttribute('class').then(value=>value.includes('active')),true);
   await touch(more);const dialog=page.getByRole('dialog',{name:'More',exact:true});await dialog.waitFor();
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
   assert.equal(await more.evaluate(element=>document.activeElement===element),true);
   await page.screenshot({path:path.join(artifacts,'android-tablet-navigation-'+mode+'.png')});
  }
 });
 await test('Pull-to-refresh arms only on a long vertical pull at the main scroll origin',async()=>{
  await nav('Settings');
  const saved=await native(page,'storage.load'),expires=Date.now()+600000;
  saved.metadata??={};saved.metadata['pull-refresh-probe']={value:null,expires,at:Date.now()};
  await native(page,'storage.save',{value:saved});await page.reload();await page.waitForSelector('.tablet-settings');
  await page.locator('.tablet-main').evaluate(element=>element.scrollTo({top:0}));
  const main=await page.locator('.tablet-main').boundingBox();assert.ok(main);
  const gesture=async(dx,dy)=>{
   const session=await page.context().newCDPSession(page),x=main.x+44,y=main.y+25;
   try{
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for(let i=1;i<=8;i++){await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*i/8,y:y+dy*i/8}]});await delay(18);}
    await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   }finally{await session.detach();}
  };
  await gesture(130,45);await delay(100);assert.equal((await native(page,'storage.load')).metadata['pull-refresh-probe'].expires,expires,'Horizontal intent must not refresh');
  await gesture(0,65);await delay(100);assert.equal((await native(page,'storage.load')).metadata['pull-refresh-probe'].expires,expires,'A short pull must not refresh');
  await gesture(0,165);
  let refreshed=false;for(const end=Date.now()+5000;Date.now()<end;){if((await native(page,'storage.load')).metadata['pull-refresh-probe'].expires===0){refreshed=true;break;}await delay(100);}
  assert.ok(refreshed,'A released armed gesture reaches the real metadata invalidation path');
  assert.equal(await page.getByRole('button',{name:'Refresh',exact:true}).count(),1,'Manual refresh remains available next to search');
 });
 await test('Touch context menu stays above the dock without a hover tooltip and remains scrollable',async()=>{
  await nav('Home');await page.locator('.tablet-main[aria-busy=false]').waitFor();
  await page.waitForFunction(()=>!document.querySelector('.hero.skeleton')&&!document.querySelector('.latest-episodes .skeleton')&&[...document.querySelectorAll('section.section')].some(section=>section.querySelector('h2')?.textContent.trim()==='Continue watching'&&section.querySelector('.mcard[role=link]')),{},{timeout:20000});
  const token='context-'+Date.now(),attempts=[];let target,previous,stableSince=0;
  contextMenuEvidence={status:'finding-stable-card',installedApkSHA256,attempts};
  for(const until=Date.now()+12000;Date.now()<until;){
   const actual=await page.evaluate(token=>{
    const main=document.querySelector('.tablet-main'),clip=main.getBoundingClientRect();
    const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const section=[...main.querySelectorAll('section.section')].find(element=>element.querySelector('h2')?.textContent.trim()==='Continue watching');
    const candidates=[...new Set([...(section?.querySelectorAll('.mcard[role=link]')??[]),...main.querySelectorAll('.mcard[role=link]')])];
    const diagnostics=candidates.slice(0,8).map(card=>({title:card.querySelector('.mcard-title')?.textContent.trim(),bounds:rect(card)}));
    const card=candidates.find(card=>getComputedStyle(card).display!=='none'&&card.getBoundingClientRect().width>48);
    if(!card)return {ready:false,reason:'No current media card',scrollTop:main.scrollTop,clip:rect(main),cards:diagnostics};
    const poster=card.querySelector('.mcard-poster')??card,r=poster.getBoundingClientRect(),track=card.closest('.rail-track')?.getBoundingClientRect();
    const left=Math.max(r.left,clip.left,track?.left??clip.left),right=Math.min(r.right,clip.right,track?.right??clip.right);
    const top=Math.max(r.top,clip.top),bottom=Math.min(r.bottom,clip.bottom);
    if(right-left>=50&&bottom-top>=50){
     const x=(left+right)/2,y=Math.min(bottom-25,Math.max(top+25,r.top+40));
     if(document.elementFromPoint(x,y)?.closest('.mcard')===card){
      card.setAttribute('data-context-target',token);
      card.__contextIdentity??=crypto.randomUUID();
      return {ready:true,identity:card.__contextIdentity,x,y,scrollTop:main.scrollTop,scrollLeft:card.closest('.rail-track')?.scrollLeft??0,clip:rect(main),card:rect(card),poster:rect(poster),title:card.querySelector('.mcard-title')?.textContent.trim()};
     }
    }
    main.scrollTo({top:main.scrollTop+r.top-clip.top-Math.max(30,(clip.height-Math.min(r.height,clip.height-40))/2),behavior:'instant'});
    if(track&&(r.right<=track.left||r.left>=track.right))card.scrollIntoView({block:'nearest',inline:'center',behavior:'instant'});
    return {ready:false,reason:'Bringing current card into the main clip',scrollTop:main.scrollTop,clip:rect(main),cards:diagnostics};
   },token);
   attempts.push(actual);if(attempts.length>10)attempts.shift();
   if(actual.ready){
    const current=await page.evaluate(({token,x,y})=>document.querySelector('[data-context-target="'+token+'"]')===document.elementFromPoint(x,y)?.closest('.mcard'),{token,x:actual.x,y:actual.y});
    const stable=current&&previous?.identity===actual.identity&&['x','y','scrollTop','scrollLeft'].every(key=>Math.abs(previous[key]-actual[key])<.5)&&['left','top','right','bottom'].every(key=>Math.abs(previous.card[key]-actual.card[key])<.5);
    if(!stable)stableSince=Date.now();
    if(stable&&Date.now()-stableSince>=200){target={...actual,stableMilliseconds:Date.now()-stableSince};break;}
    previous=current?actual:undefined;
   }else{previous=undefined;stableSince=0;}
   await delay(50);
  }
  assert.ok(target,'No stable card touch point inside the main clip: '+JSON.stringify(attempts));
  assert.ok(target.x>=target.clip.left+24&&target.x<=target.clip.right-24&&target.y>=target.clip.top+24&&target.y<=target.clip.bottom-24,'Long press stays at least24px inside the main canvas: '+JSON.stringify(target));
  contextMenuEvidence={...contextMenuEvidence,status:'holding',target};
  writeFileSync(path.join(artifacts,'android-context-progress.json'),JSON.stringify(contextMenuEvidence,null,2));
  const session=await page.context().newCDPSession(page);
  await page.evaluate(({token,x,y})=>{
   const card=document.querySelector('[data-context-target="'+token+'"]'),main=document.querySelector('.tablet-main');
   if(document.elementFromPoint(x,y)?.closest('.mcard')!==card)throw Error('Stable long-press target changed before touchStart');
   window.__contextTrace=[];
   const log=event=>{const target=event.target instanceof Element?event.target:null;window.__contextTrace.push({type:event.type,time:performance.now(),trusted:event.isTrusted,pointerType:event.pointerType,primary:event.isPrimary,button:event.button,x:event.clientX,y:event.clientY,target:target?.tagName+' '+target?.className,cardIdentity:target?.closest('.mcard')?.__contextIdentity,scrollTop:main.scrollTop,hash:location.hash});};
   window.__contextTraceListener=log;
   for(const type of ['pointerdown','pointerup','pointercancel','pointermove','touchstart','touchend','touchcancel','contextmenu','click','scroll'])addEventListener(type,log,true);
  },{token,x:target.x,y:target.y});
  try{
   await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:target.x,y:target.y}]});
   await delay(750);await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(120);
  }finally{
   await session.detach();
   const actual=await page.evaluate(()=>{
    const trace=window.__contextTrace??[];
    for(const type of ['pointerdown','pointerup','pointercancel','pointermove','touchstart','touchend','touchcancel','contextmenu','click','scroll'])removeEventListener(type,window.__contextTraceListener,true);
    delete window.__contextTraceListener;
    return {trace,hash:location.hash,menuVisible:!!document.querySelector('.ctx-menu')};
   });
   contextMenuEvidence={...contextMenuEvidence,status:'released',...actual};
   writeFileSync(path.join(artifacts,'android-context-progress.json'),JSON.stringify(contextMenuEvidence,null,2));
  }
  const down=contextMenuEvidence.trace.find(event=>event.type==='pointerdown'),up=contextMenuEvidence.trace.find(event=>event.type==='touchend');
  assert.ok(down?.pointerType==='touch'&&down.primary&&down.cardIdentity===target.identity,'Real primary touch reaches the stable media card: '+JSON.stringify(contextMenuEvidence));
  assert.ok(up&&up.time-down.time>=700,'Hold input remains pressed for at least700ms: '+JSON.stringify(contextMenuEvidence));
  assert.ok(!contextMenuEvidence.trace.some(event=>event.type==='scroll'&&event.time>=down.time&&event.time<=up.time),'No setup scroll continues during the long press: '+JSON.stringify(contextMenuEvidence));
  const menu=page.getByRole('menu');await menu.waitFor();
  await page.waitForFunction(()=>{const m=document.querySelector('.ctx-menu').getBoundingClientRect(),r=document.querySelector('.tablet-main').getBoundingClientRect();return m.top>=r.top&&m.bottom<=r.bottom+1;});
  const geometry=await menu.evaluate(element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,scrollHeight:element.scrollHeight,items:[...element.querySelectorAll('.ctx-item')].map(item=>item.getBoundingClientRect().height)};});
  assert.ok(geometry.items.every(height=>height>=48),'Context actions retain tablet touch targets');
  assert.equal(await page.locator('.hovercard:visible').count(),0,'Automatic hover previews stay hidden during touch menus');
  await menu.evaluate(element=>{element.scrollTop=element.scrollHeight;});await delay(100);assert.equal(await menu.isVisible(),true,'Scrolling inside the menu must not trigger its outside-scroll dismissal');
  await touch(menu.getByRole('menuitem',{name:'Settings',exact:true}));await page.waitForSelector('.tablet-settings');
  contextMenuEvidence.status='passed';writeFileSync(path.join(artifacts,'android-context-progress.json'),JSON.stringify(contextMenuEvidence,null,2));return {target,geometry,trace:contextMenuEvidence.trace};
 });
 await test('Sources screen presents the configured browser source',async()=>{
  await nav('Sources');await page.getByText('Fixture library',{exact:true}).waitFor();await page.screenshot({path:path.join(artifacts,'android-tablet-sources.png')});
 });

 await test('Source URL dialog validates and adds a browser to the saved source list',async()=>{
  await touch(page.getByRole('button',{name:'Add source',exact:true}));const dialog=page.getByRole('dialog',{name:'Add source URL',exact:true});await dialog.waitFor();await dialog.getByRole('textbox',{name:'Source URL',exact:true}).fill(fixtureOrigin+'/source?added=ui');await dialog.getByRole('textbox',{name:'Source name',exact:true}).fill('Added fixture browser');await touch(dialog.getByRole('button',{name:'Save source',exact:true}));await dialog.waitFor({state:'hidden'});await page.getByText('Added fixture browser',{exact:true}).waitFor();const persisted=await native(page,'storage.load');assert.ok(persisted.sources.some(source=>source.name==='Added fixture browser'&&source.url===fixtureOrigin+'/source?added=ui'));await page.screenshot({path:path.join(artifacts,'android-tablet-sources-added.png')});
 });

 await test('Delayed untemplated source submits one real form, discovers source episodes and decodes inline video',async()=>{
  const requestStart=requests.length,started=Date.now();
  await page.evaluate(({source})=>{location.hash='#/watch/7/2?source='+encodeURIComponent(source);},{source:formSource.id});
  try{
   await page.waitForSelector('.tablet-player-slot[data-player-state=ready]',{timeout:30000});
   sourcePage=await sourceTarget();
   assert.match(sourcePage.url(),/\/watch\/arcadia-story\/2$/);
   const searches=requests.slice(requestStart).filter(request=>request.path==='/search');
   assert.equal(searches.length,1,'Commit/finish callbacks must not submit the source form twice');
   assert.equal(new URLSearchParams(searches[0].query).get('q'),'Arcadia Story');
   await page.waitForFunction(()=>[...document.querySelectorAll('.tablet-episode-list .tablet-episode')].map(el=>el.getAttribute('aria-label')).join(',')==='Episode 1,Episode 2,Episode 3');
   assert.equal(await page.getByText('Episodes found on this source.',{exact:true}).count(),1);
   assert.equal(await sourcePage.evaluate(()=>typeof window.AniVerseNative+'|'+typeof window.aniverse),'undefined|undefined');
   assert.equal(await sourcePage.evaluate(()=>document.querySelector('video')===window.fixtureOriginalVideo),true);
   const video=sourcePage.locator('video');await touch(video);
   await sourcePage.waitForFunction(()=>{const v=document.querySelector('video');return v&&!v.paused&&v.readyState>=2&&v.videoWidth>0;});
   await video.evaluate(v=>{v.currentTime=6;});
   await sourcePage.waitForFunction(()=>{
    const v=document.querySelector('video');if(!v||v.paused||v.currentTime<6||v.readyState<2)return false;
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;const c=canvas.getContext('2d');c.drawImage(v,0,0,64,36);
    return c.getImageData(0,0,64,36).data.some((value,index)=>index%4!==3&&value>20);
   });
   const before=await video.evaluate(v=>({time:v.currentTime,frames:v.getVideoPlaybackQuality?.().totalVideoFrames??v.webkitDecodedFrameCount??0}));
   await delay(900);
   const after=await video.evaluate(v=>({time:v.currentTime,frames:v.getVideoPlaybackQuality?.().totalVideoFrames??v.webkitDecodedFrameCount??0}));
   assert.ok(after.time>before.time+.2&&after.frames>before.frames,'Original website video clock and decoded frames advance');
   await page.screenshot({path:path.join(artifacts,'android-tablet-form-inline.png')});
   return {milliseconds:Date.now()-started,formRequests:searches.length,sourceEpisodes:[1,2,3],advanced:after.time-before.time,decodedFrames:after.frames-before.frames};
  }finally{
   await nav('Sources');
   if(sourcePage&&!sourcePage.isClosed())await sourcePage.waitForEvent('close',{timeout:8000});
   sourcePage=undefined;
  }
 });
 await test('Active playback survives compact, medium, large and portrait window changes',async()=>{
  const progress=(phase,values={})=>{resizeContinuity={...resizeContinuity,phase,...values};writeFileSync(path.join(artifacts,'android-resize-progress.json'),JSON.stringify(resizeContinuity,null,2));console.log('[RESIZE phase] '+phase);};
  progress('settings-navigation',{status:'running',serial,appId,installedApkSHA256,startedAt:new Date().toISOString(),samples:[]});
  await nav('Settings');await page.waitForFunction(()=>location.hash.startsWith('#/settings'));await page.waitForSelector('.tablet-settings');progress('choose-navigation');const layout=page.getByRole('combobox',{name:'Navigation layout',exact:true});await touch(layout);await touch(page.getByRole('option',{name:'Navigation rail',exact:true}));
  const beforeSize=adb('shell','wm','size').match(/Override size:\s*(\d+x\d+)/)?.[1],beforeDensity=adb('shell','wm','density').match(/Override density:\s*(\d+)/)?.[1];
  const rotation=adb('shell','settings','get','system','user_rotation'),autoRotate=adb('shell','settings','get','system','accelerometer_rotation');
  const marker='resize-'+Date.now(),pid=adb('shell','pidof',appId).split(/\s+/)[0],samples=[];
  let activeSession,primaryError;const cleanupErrors=[];
  progress('open-player',{pid,marker,samples,previousDisplay:{size:beforeSize,density:beforeDensity,rotation,autoRotate}});
  try{
   await page.evaluate(marker=>{window.__resizeMainMarker=marker;window.__resizeSessions=[];window.__resizeListener=event=>{if(event.detail?.session&&!window.__resizeSessions.includes(event.detail.session))window.__resizeSessions.push(event.detail.session);};addEventListener('tablet-playback',window.__resizeListener);location.hash='#/watch/7/2?source=tablet-fixture';},marker);
   await page.waitForSelector('.tablet-player-slot[data-player-state=ready]',{timeout:30000});sourcePage=await sourceTarget();
   progress('start-website-video');
   await sourcePage.evaluate(marker=>{window.__resizeSourceMarker=marker;const v=document.querySelector('video');v.muted=true;},marker);
   if(await sourcePage.locator('video').evaluate(video=>video.paused))await touch(sourcePage.locator('video'));
   await sourcePage.waitForFunction(()=>{const v=document.querySelector('video');return v&&!v.paused&&v.currentTime>.1&&v.videoWidth>0;});
   const session=await page.evaluate(()=>window.__resizeSessions[0]);assert.match(session,/^[a-f0-9-]{36}$/);activeSession=session;progress('playing',{session});console.log('[RESIZE] active session '+session+' pid '+pid);
   let frames=await sourcePage.locator('video').evaluate(video=>video.getVideoPlaybackQuality?.().totalVideoFrames??video.webkitDecodedFrameCount??0);
   const profiles=[{id:'compact',width:1200,height:912,density:320},{id:'medium',width:1600,height:1312,density:320},{id:'large',width:2560,height:1712,density:320},{id:'portrait',width:840,height:1632,density:320}];
   adb('shell','settings','put','system','accelerometer_rotation','0');adb('shell','settings','put','system','user_rotation','0');
   for(const profile of profiles){
    progress('profile:'+profile.id+':applying',{currentProfile:profile});console.log('[RESIZE] applying '+profile.id);
    adb('shell','wm','size',profile.width+'x'+profile.height);adb('shell','wm','density',String(profile.density));await delay(900);
    assert.equal(adb('shell','pidof',appId).split(/\s+/)[0],pid,'Window change retains the application process');
    assert.equal(await page.evaluate(()=>window.__resizeMainMarker),marker,'Trusted WebView is not reloaded');
    assert.equal(await sourcePage.evaluate(()=>window.__resizeSourceMarker),marker,'Source WebView is not recreated');
    assert.equal(await sourcePage.evaluate(()=>document.querySelector('video')===window.fixtureOriginalVideo),true);
    const actual=await page.evaluate(()=>{
     const main=document.querySelector('.tablet-main').getBoundingClientRect(),slot=document.querySelector('.tablet-player-slot').getBoundingClientRect(),app=document.querySelector('.tablet-app');
     return {width:innerWidth,height:innerHeight,navigation:app.dataset.navigation,preference:app.dataset.navigationPreference,sessions:window.__resizeSessions,overflow:document.documentElement.scrollWidth-innerWidth,clipHeight:Math.min(main.bottom,slot.bottom)-Math.max(main.top,slot.top)};
    });
    samples.push({requested:profile,...actual});progress('profile:'+profile.id+':measured');
    assert.equal(actual.navigation,actual.width<600?'tabs':'rail','Compact window adapts navigation without changing the preference');assert.equal(actual.preference,'rail');assert.deepEqual(actual.sessions,[session]);
    assert.ok(actual.overflow<=1&&actual.clipHeight>20,'Player retains a visible main-canvas clip: '+JSON.stringify(actual));
    await delay(500);
    const video=await sourcePage.locator('video').evaluate(video=>({time:video.currentTime,paused:video.paused,frames:video.getVideoPlaybackQuality?.().totalVideoFrames??video.webkitDecodedFrameCount??0}));
    assert.ok(!video.paused&&video.frames>frames,'Decoded playback continues after resize: '+JSON.stringify({profile,video,frames}));frames=video.frames;
    Object.assign(samples.at(-1),{video});progress('profile:'+profile.id+':passed');console.log('[RESIZE] passed '+profile.id+' '+actual.width+'x'+actual.height);await page.screenshot({path:path.join(artifacts,'android-resize-'+profile.id+'.png')});
   }
   assert.equal((await native(page,'storage.load')).navigation,'rail','Adaptive navigation never rewrites the saved layout choice');
   progress('complete',{status:'passed'});return {pid,session,marker,samples};
  }catch(error){
   primaryError=error;
   console.error('[RESIZE primary failure] '+String(error.stack??error));throw error;
  }finally{
   const cleanups=[
    ()=>adb('shell','wm','size',beforeSize??'reset'),
    ()=>adb('shell','wm','density',beforeDensity??'reset'),
    ()=>/^[0-3]$/.test(rotation)&&adb('shell','settings','put','system','user_rotation',rotation),
    ()=>/^[01]$/.test(autoRotate)&&adb('shell','settings','put','system','accelerometer_rotation',autoRotate),
    async()=>{if(!page.isClosed()&&activeSession)await native(page,'playback.close',{session:activeSession});},
    async()=>{if(!page.isClosed())await page.evaluate(()=>{if(window.__resizeListener)removeEventListener('tablet-playback',window.__resizeListener);location.hash='#/sources';});},
   ];
   for(const cleanup of cleanups)try{await cleanup();}catch(error){cleanupErrors.push(error.message);console.error('[RESIZE cleanup] '+error.message);}
   resizeContinuity.cleanup={displayRestoreAttempted:true,errors:cleanupErrors};writeFileSync(path.join(artifacts,'android-resize-progress.json'),JSON.stringify(resizeContinuity,null,2));
   sourcePage=undefined;
   if(cleanupErrors.length&&!primaryError)throw Error('Resize cleanup failed: '+cleanupErrors.join('; '));
  }
 });
 await test('Episode click opens a focused inline player under strict source CSP and leaving closes it', async () => {
  await page.evaluate(() => { location.hash = '#/watch/7/2?source=tablet-fixture'; });
  try {
   await page.waitForSelector('.tablet-player-slot[data-player-state=ready]', { timeout: 30000 });
   sourcePage = await sourceTarget();
   assert.match(sourcePage.url(), /\/watch\/arcadia-story\/2$/);
   assert.equal(await page.locator('.tablet-player-slot').getAttribute('data-confirmed-episode'),'2','Native source confirmation identifies the actual selected episode');

   assert.equal(await sourcePage.evaluate(() => typeof window.AniVerseNative + '|' + typeof window.aniverse), 'undefined|undefined');
   assert.equal(await sourcePage.locator('h1').isVisible(), false);
   assert.equal(await sourcePage.evaluate(() => document.querySelector('video') === window.fixtureOriginalVideo), true);
   const resumed = adb('shell', 'dumpsys', 'activity', 'activities').split('\n').find(line => /topResumedActivity/.test(line));
   assert.ok(resumed?.includes(appId) && resumed.includes('MainActivity'));
   await touch(page.getByRole('button', { name: 'Show website', exact: true }));
   await page.waitForSelector('.tablet-player-slot[data-player-state=website]');
   await sourcePage.locator('h1').waitFor({ state: 'visible' });
   await touch(page.getByRole('button', { name: 'Player only', exact: true }));
   await page.waitForSelector('.tablet-player-slot[data-player-state=ready]');
  } finally {
   await nav('Sources');
   if (sourcePage && !sourcePage.isClosed()) await sourcePage.waitForEvent('close', { timeout: 8000 });
   sourcePage = undefined;
  }
 });
 if(!uiCase){
 await native(page,'sources.open',{id:'tablet-fixture'});sourcePage=await sourceTarget('tablet-fixture');
 await test('Website WebView has neither native nor trusted application bridge',async()=>{
  assert.equal(await sourcePage.evaluate(()=>typeof window.AniVerseNative+'|'+typeof window.aniverse),'undefined|undefined');assert.ok(sourcePage.url().startsWith(fixtureOrigin));await sourcePage.getByRole('heading',{name:'Arcadia Story',exact:true}).waitFor();
 });
 await test('Original website video decodes and advances after a real touch',async()=>{
  await touch(sourcePage.getByRole('button',{name:'Play fixture',exact:true}));await sourcePage.waitForFunction(()=>{const video=document.getElementById('fixture-video');return video?.readyState>=2&&video.videoWidth>0&&!video.paused&&video.currentTime>.1;});
  const before=await sourcePage.locator('video').evaluate(video=>({time:video.currentTime,width:video.videoWidth,height:video.videoHeight}));await delay(1400);const after=await sourcePage.locator('video').evaluate(video=>video.currentTime);assert.ok(after>before.time+.4);assert.equal(await sourcePage.evaluate(()=>document.querySelector('video')===window.fixtureOriginalVideo),true);
  // The sample starts with dark frames and Android can composite video outside CDP's
  // bitmap. Seek to a known scene and verify decoded image pixels, not only a clock.
  await sourcePage.locator('video').evaluate(video=>{video.currentTime=6;});
  await sourcePage.waitForFunction(()=>{const video=document.querySelector('video');if(!video||video.currentTime<6||video.paused||video.readyState<2)return false;const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;const context=canvas.getContext('2d');context.drawImage(video,0,0,64,36);const pixels=context.getImageData(0,0,64,36).data;return pixels.some((value,index)=>index%4!==3&&value>20);});
  const decoded=await sourcePage.locator('video').evaluate(video=>{const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;const context=canvas.getContext('2d');context.drawImage(video,0,0,64,36);const data=context.getImageData(0,0,64,36).data;let coloredPixels=0;for(let i=0;i<data.length;i+=4)if(Math.max(data[i],data[i+1],data[i+2])>20)coloredPixels++;return {time:video.currentTime,decodedFrames:video.getVideoPlaybackQuality?.().totalVideoFrames??video.webkitDecodedFrameCount??0,coloredPixels};});
  assert.ok(decoded.decodedFrames>0&&decoded.coloredPixels>0);await sourcePage.screenshot({path:path.join(artifacts,'android-tablet-source-playback.png')});
  writeFileSync(path.join(artifacts,'android-tablet-source-native-screen.png'),execFileSync(adbPath,['-s',serial,'exec-out','screencap','-p'],{cwd:root,windowsHide:true,timeout:20000,maxBuffer:16*1024*1024,env:{...process.env,TEMP:temporary,TMP:temporary,TMPDIR:temporary}}));
  return {...before,advanced:after-before.time,decoded};
 });
 await test('Source private-network requests are blocked before transmission while video continues',async()=>{
  const before=await sourcePage.locator('video').evaluate(video=>video.currentTime);const denied=await sourcePage.evaluate(url=>fetch(url).then(()=>false,()=>true),privateURL);assert.equal(denied,true);await delay(1000);assert.equal(forbiddenRequests,0);assert.ok(await sourcePage.locator('video').evaluate(video=>!video.paused&&video.currentTime>0));const after=await sourcePage.locator('video').evaluate(video=>video.currentTime);assert.ok(after>before+.3);return {denied,forbiddenRequests,advanced:after-before};
 });
 await test('Quality controls preserve original video and source search/episode navigation remains available',async()=>{
  await touch(sourcePage.getByRole('button',{name:'Switch quality',exact:true}));await sourcePage.waitForFunction(()=>document.querySelector('video')===window.fixtureOriginalVideo&&!document.querySelector('video').paused&&document.querySelector('video').currentTime>.1);
  await sourcePage.getByRole('searchbox',{name:'Search source',exact:true}).fill('Arcadia Story');await touch(sourcePage.getByRole('button',{name:'Search',exact:true}));await sourcePage.waitForURL(url=>url.pathname==='/search'&&url.searchParams.get('q')==='Arcadia Story');
  await touch(sourcePage.getByRole('link',{name:'Episode 2',exact:true}));await sourcePage.waitForURL('**/watch/arcadia-story/2');assert.equal(await sourcePage.evaluate(()=>typeof window.AniVerseNative+'|'+typeof window.aniverse),'undefined|undefined');
 });
 await test('Same-origin websites in separate source profiles do not share cookies',async()=>{
  const marker='profile-'+Date.now(),firstURL=sourcePage.url();await sourcePage.evaluate(value=>document.cookie='aniverseFixtureProfile='+value+'; path=/; SameSite=Lax',marker);assert.ok((await sourcePage.evaluate(()=>document.cookie)).includes('aniverseFixtureProfile='+marker));await mainActivity();await native(page,'sources.open',{id:'tablet-fixture-two'});sourcePage=await sourceTarget('tablet-fixture-two');await sourcePage.waitForLoadState('domcontentloaded');const secondURL=sourcePage.url();assert.notEqual(firstURL,secondURL,'Must inspect the newly opened source WebView, not a retiring CDP target');assert.ok(!(await sourcePage.evaluate(()=>document.cookie)).includes('aniverseFixtureProfile='+marker));assert.equal(await sourcePage.evaluate(()=>typeof window.AniVerseNative+'|'+typeof window.aniverse),'undefined|undefined');return {firstURL,secondURL,sharedCookie:false};
 });
 }
 await mainActivity();assert.deepEqual(pageErrors,[]);
}catch(error){errors.push(String(error.stack||error));console.error(error);}
finally{
 if(page&&!page.isClosed())try{adb('shell','am','start','-n',appId+'/app.aniverse.tablet.MainActivity');}catch{}
 for(const connection of connections)await connection.close().catch(()=>{});
 for(const port of forwarded)try{adb('forward','--remove','tcp:'+port);}catch{}
 server.closeAllConnections();forbidden.closeAllConnections();await Promise.all([server.listening?new Promise(resolve=>server.close(resolve)):Promise.resolve(),forbidden.listening?new Promise(resolve=>forbidden.close(resolve)):Promise.resolve()]);
 const report={passed:!errors.length,scope:uiCase??'full-suite',serial,appId,run,nativeInfo,installedApkSHA256,resizeContinuity,contextMenuEvidence,environment:{hostRendering:process.env.ANDROID_TEST_BACKEND??'unspecified'},checks,errors,pageErrors,forbiddenRequests,requests,limits:['Debug application on the explicitly owned emulator, not a physical Galaxy Tab S10+.','Real source playback uses a neutral local fixture and public sample video. No remote website attack, account action or installed release profile was used.','No native picker/file-transfer or physical casting/audio certification is implied.']};
 writeFileSync(path.join(artifacts,uiCase?'android-tablet-'+uiCase+'.json':'android-tablet.json'),JSON.stringify(report,null,2)+'\n');if(errors.length)process.exitCode=1;
}
