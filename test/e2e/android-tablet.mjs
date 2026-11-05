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
const raw=(id,name)=>({...original,id,idMal:null,title:{english:name,romaji:name,native:null,userPreferred:name},synonyms:[],coverImage:{extraLarge:poster,large:poster,color:'#7c5faf'},bannerImage:null,status:'FINISHED',episodes:12,duration:24,genres:['Adventure','Fantasy'],isAdult:false,nextAiringEpisode:null,streamingEpisodes:[],externalLinks:[],relations:{edges:[]},recommendations:{nodes:[]},characters:{edges:[]},studios:{nodes:[]},tags:[]});
const rawTitles=[raw(7,'Arcadia Story'),raw(8,'Clockwork Road'),raw(9,'Local Journey')];
const graphData=id=>({Media:rawTitles.find(row=>row.id===id)??rawTitles[0],GenreCollection:['Action','Adventure','Ecchi','Fantasy','Mecha','Sci-Fi'],MediaTagCollection:[{name:'Isekai',isAdult:false},{name:'Female Harem',isAdult:false}],Page:{media:rawTitles,pageInfo:{currentPage:1,total:3,hasNextPage:false},airingSchedules:[]},trending:{media:rawTitles},spotlight:{media:rawTitles},popularSeason:{media:rawTitles},upcoming:{media:[]},topRated:{media:rawTitles},recent:{airingSchedules:[]}});
const requests=[],checks=[],errors=[],pageErrors=[],connections=[],forwarded=[];
let forbiddenRequests=0,browser,page,sourcePage,nativeInfo,installedApkSHA256;
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
const touch=async locator=>{
 await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();assert.ok(box,'Tap target has a real visible rectangle');
 const session=await locator.page().context().newCDPSession(locator.page());
 try{await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2,radiusX:1,radiusY:1,force:1}]});await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}finally{await session.detach();}
};
const test=async(name,body)=>{try{const result=await body();checks.push({name,passed:true,...(result===undefined?{}:{actual:result})});console.log('[PASS] '+name);}catch(error){checks.push({name,passed:false,error:String(error.stack||error)});errors.push(name+': '+error.message);console.error('[FAIL] '+name+': '+error.message);await (sourcePage&&!sourcePage.isClosed()?sourcePage:page)?.screenshot({path:path.join(artifacts,'android-tablet-failure-'+checks.length+'.png')}).catch(()=>{});}};
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
 await native(page,'storage.save',{value:saved});await page.reload();await page.waitForFunction(()=>!!window.aniverse);

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
   assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),mode);
  }
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
   const floating=await page.getByRole('navigation',{name:'Main',exact:true}).evaluate(element=>{const rect=element.getBoundingClientRect(),main=document.querySelector('.tablet-main').getBoundingClientRect(),style=getComputedStyle(element);return {left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:innerWidth,height:innerHeight,radius:parseFloat(style.borderRadius),gap:document.querySelector('.tablet-app').dataset.navigation==='rail'?main.left-rect.right:rect.top-main.bottom};});
   assert.ok(floating.left>=8&&floating.top>=8&&floating.right<=floating.width-8&&floating.bottom<=floating.height-8,'Navigation capsule floats away from every viewport edge');
   assert.ok(floating.radius>=28&&floating.gap>=6,'Floating capsule has rounded corners and a separate content gutter');
   if(mode==='tabs')assert.ok(floating.top>floating.height*.65&&floating.bottom<=floating.height-16,'Bottom capsule sits above the screen edge with reserved space for its controls');
   for(const [name,route]of [['Home','/'],['Browse','/browse'],['Library','/library'],['Sources','/sources'],['Local watch','/local'],['Downloads','/downloads'],['History','/history'],['Schedule','/schedule'],['Settings','/settings']]){
    await nav(name);await page.waitForFunction(route=>location.hash.split('?')[0]==='#'+route,route);
    assert.equal(await page.getByRole('dialog',{name:'More',exact:true}).count(),0);
   }
   const more=page.getByRole('navigation',{name:'Main',exact:true}).getByRole('button',{name:'More',exact:true});
   assert.equal(await more.getAttribute('class').then(value=>value.includes('active')),true);
   await touch(more);const dialog=page.getByRole('dialog',{name:'More',exact:true});await dialog.waitFor();
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
   assert.equal(await more.evaluate(element=>document.activeElement===element),true);
   await page.screenshot({path:path.join(artifacts,'android-tablet-navigation-'+mode+'.png')});
  }
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
 await mainActivity();assert.deepEqual(pageErrors,[]);
}catch(error){errors.push(String(error.stack||error));console.error(error);}
finally{
 if(page&&!page.isClosed())try{adb('shell','am','start','-n',appId+'/app.aniverse.tablet.MainActivity');}catch{}
 for(const connection of connections)await connection.close().catch(()=>{});
 for(const port of forwarded)try{adb('forward','--remove','tcp:'+port);}catch{}
 server.closeAllConnections();forbidden.closeAllConnections();await Promise.all([server.listening?new Promise(resolve=>server.close(resolve)):Promise.resolve(),forbidden.listening?new Promise(resolve=>forbidden.close(resolve)):Promise.resolve()]);
 const report={passed:!errors.length,serial,appId,run,nativeInfo,installedApkSHA256,environment:{hostRendering:process.env.ANDROID_TEST_BACKEND??'unspecified'},checks,errors,pageErrors,forbiddenRequests,requests,limits:['Debug application on the explicitly owned emulator, not a physical Galaxy Tab S10+.','Real source playback uses a neutral local fixture and public sample video. No remote website attack, account action or installed release profile was used.','No native picker/file-transfer or physical casting/audio certification is implied.']};
 writeFileSync(path.join(artifacts,'android-tablet.json'),JSON.stringify(report,null,2)+'\n');if(errors.length)process.exitCode=1;
}
