// Opt-in Android functional test. Real URLs are read only from the ignored user config.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {androidClient} from './helpers/android-cdp.mjs';
if(!process.argv.includes('--run')){console.log('Prepared only; --run uses the isolated validation emulator and actual configured sources.');process.exit(0);}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),cache=path.join(root,'test/cache/android-live');mkdirSync(cache,{recursive:true});
const run=mkdtempSync(path.join(cache,'run-')),client=androidClient({root,run,serial:'emulator-5584',appId:'app.aniverse.tablet.debug'}),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),checks=[],sources=[],rendererErrors=[];
const normalizedOrigin=value=>{try{const url=new URL(value);return url.protocol+'//'+url.hostname.replace(/^www\./,'')+(url.port?':'+url.port:'');}catch{return '';}};
const clean=value=>String(value).replace(/https?:\/\/[^\s"'<>]+/g,'[private URL]').slice(0,500);
let page,browser,details,installedApkSHA256,originalState,sourceEnabledBefore,isolationRestored=false,expectedSourceIndices=[];const requestedIndices=new Set((process.env.ANDROID_LIVE_INDICES??'1,2,3').split(',').map(Number));
const rpc=(method,input={})=>page.evaluate(({method,input})=>window.aniverse.invoke(method,input),{method,input});
function inspectionDeadline(operation,milliseconds=5000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Read-only inspector deadline exceeded; website may be paused under debugging')),milliseconds);Promise.resolve(operation).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});}
const mediaFrames=new WeakMap();
const pendingProbes=new WeakMap();
function boundedProbe(target){
 let task=pendingProbes.get(target);
 if(!task){task=sourceProbe(target).finally(()=>{if(pendingProbes.get(target)===task)pendingProbes.delete(target);});pendingProbes.set(target,task);}
 return inspectionDeadline(task);
}

// Interact only with visible controls in the owned player; a replaced iframe is retryable.
async function ownedPlayerFrame(frame,target){
 if(frame.isDetached())return false;
 const main=target.mainFrame();
 if(frame===main)return true;
 let current=frame;
 // Ownership must trace to the marked root in the source page, not to an
 // unrelated embedded page which happens to contain a similarly named node.
 for(let depth=0;depth<12;depth++){
  if(current.isDetached())return false;
  const parent=current.parentFrame();if(!parent)return false;
  const element=await inspectionDeadline(current.frameElement(),1000).catch(()=>null);
  if(!element)return false;
  let visible=false;
  try{visible=await inspectionDeadline(element.evaluate((el,{top})=>{
   const box=el.getBoundingClientRect(),style=getComputedStyle(el);
   if(box.width<=0||box.height<=0||style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)return false;
   if(el.checkVisibility&&!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;
   if(!top)return true;
   const root=document.querySelector('[data-aniverse-player]');
   return !!root&&(root===el||root.contains(el))&&getComputedStyle(root).position==='fixed';
  },{top:parent===main}),1000).catch(()=>false);}finally{await element.dispose().catch(()=>{});}
  if(!visible)return false;
  if(parent===main)return true;
  current=parent;
 }
 return false;
}
async function trustedPlayerState(source){
 const [state,label,sourceId]=await Promise.all([
  page.locator('.tablet-player-slot').getAttribute('data-player-state').catch(()=>null),
  page.getByRole('combobox',{name:'Playback source',exact:true}).innerText().catch(()=>''),
  page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]??'').get('source')).catch(()=>null),
 ]);
 const selected=label.trim()===source.name&&sourceId===source.id;
 return {state,selected,ready:state==='ready'&&selected};
}
async function currentMediaFrame(target){
 let frame=mediaFrames.get(target);
 if(frame&&!frame.isDetached()&&await ownedPlayerFrame(frame,target).catch(()=>false))return frame;
 mediaFrames.delete(target);
 await boundedProbe(target).catch(()=>null);
 frame=mediaFrames.get(target);
 return frame&&!frame.isDetached()&&await ownedPlayerFrame(frame,target).catch(()=>false)?frame:null;
}
async function tapPlayer(target,result,source){
 const trusted=await trustedPlayerState(source);
 const probe=await boundedProbe(target).catch(()=>null);
 if(!trusted.ready||!probe?.focus)return false;
 const candidates=[];
 for(const frame of [...new Set([mediaFrames.get(target),...target.frames()].filter(Boolean))]){
  if(frame.isDetached()||!await ownedPlayerFrame(frame,target).catch(()=>false))continue;
  try{
   const scope=frame===target.mainFrame()?frame.locator('[data-aniverse-player]'):frame.locator('body');
   const play=scope.getByRole('button',{name:/^(play(?: video| episode| now)?|start(?: playback)?|resume)$/i});
   candidates.push(...await play.all());
   candidates.push(...await scope.locator('.vjs-big-play-button,.jw-icon-playback,.plyr__control--overlaid').all());
   candidates.push(...await scope.locator('video').all());
  }catch(error){
   result.touchErrors=[...(result.touchErrors??[]),clean(error.message)].slice(-3);
  }
 }
 candidates.push(target.locator('[data-aniverse-player]').first());
 for(const candidate of candidates.slice(0,8)){
  try{
   if(!await candidate.isVisible())continue;
   const box=await candidate.boundingBox();if(!box||box.width<=0||box.height<=0)continue;
   await inspectionDeadline(client.touch(candidate),5000);
   result.playerTaps=(result.playerTaps??0)+1;result.initialPlayerTap=true;return true;
  }catch(error){
   const message=clean(error.message);
   result.touchErrors=[...(result.touchErrors??[]),message].slice(-3);
  }
 }
 return false;
}
const snapshot=list=>list.map(({id,name,url,enabled})=>({id,name,url,enabled})).sort((a,b)=>a.id.localeCompare(b.id));
async function shot(name,target=page){await inspectionDeadline(target.screenshot({path:path.join(run,name+'.png')}),6000).catch(()=>{});}
async function check(name,body){try{const actual=await body();checks.push({name,passed:true,...(actual===undefined?{}:{actual})});console.log('[PASS] '+name);}catch(error){checks.push({name,passed:false,error:clean(error.message)});writeFileSync(path.join(run,'check-'+checks.length+'-error.txt'),String(error.stack||error));console.log('[FAIL] '+name+': '+clean(error.message));await shot('failure-'+checks.length);}}
// XML is optional diagnostic evidence; page/title/media verification must continue when Android cannot dump an animated window.
async function nativeUI(result){
 const file='/data/local/tmp/aniverse-live-'+path.basename(run)+'.xml';
 const failed=(stage,error)=>{
  const detail={stage,code:error.code??null,status:error.status??null,signal:error.signal??null,message:clean(error.message)};
  result.diagnosticErrors=[...(result.diagnosticErrors??[]),detail].slice(-6);
  try{writeFileSync(path.join(run,'source-'+result.sourceIndex+'-'+stage+'-error-private.json'),JSON.stringify({stack:String(error.stack||error),stdout:error.stdout?.toString(),stderr:error.stderr?.toString()},null,2));}catch{}
 };
 try{
  client.adb('shell','uiautomator','dump',file);
  const xml=client.adb('exec-out','cat',file);
  result.nativeUIDumpAvailable=true;
  return xml;
 }catch(error){
  result.nativeUIDumpAvailable=false;failed('native-ui-dump',error);return '';
 }finally{
  try{client.adb('shell','rm','-f',file);}catch(error){failed('native-ui-cleanup',error);}
 }
}
// This callback reads the selected player's subtree only when markedRoot=true.
// Unfocused diagnostics use the document scope but never populate the pass signal.
function readPlayerMedia({markedRoot=false}={}){
 const root=markedRoot?document.querySelector('[data-aniverse-player]'):document;
 if(!root)return {video:null,qualityControls:false,area:0};
 const nodes=[...(root instanceof HTMLVideoElement?[root]:root.querySelectorAll('video'))];
 const videos=nodes.map(video=>{
  const box=video.getBoundingClientRect(),style=getComputedStyle(video);
  return {video,area:box.width*box.height,visible:box.width>0&&box.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&(!video.checkVisibility||video.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))};
 }).filter(item=>item.visible).sort((a,b)=>b.area-a.area);
 const chosen=videos[0],v=chosen?.video;
 return {video:v?{paused:v.paused,time:v.currentTime,duration:Number.isFinite(v.duration)?v.duration:null,width:v.videoWidth,height:v.videoHeight,readyState:v.readyState,frames:v.getVideoPlaybackQuality?.().totalVideoFrames??v.webkitDecodedFrameCount??0,controls:v.controls}:null,
  area:chosen?.area??0,qualityControls:[...root.querySelectorAll('button,[role=button],select')].some(el=>{
   const r=el.getBoundingClientRect(),style=getComputedStyle(el);
   return r.width>0&&r.height>0&&style.visibility!=='hidden'&&style.display!=='none'&&/quality|resolution|1080p|720p|480p/i.test((el.getAttribute('aria-label')||'')+' '+el.textContent);
  })};
}
async function sourceProbe(target){
 const rootProbe=await target.evaluate(()=>{
  const player=document.querySelector('[data-aniverse-player]');
  return {nativeBridge:typeof window.AniVerseNative,appBridge:typeof window.aniverse,
   focus:!!player&&getComputedStyle(player).position==='fixed',readyState:document.readyState,
   inputs:[...document.querySelectorAll('input')].map(input=>({type:input.type,value:input.value,placeholder:input.placeholder,enterKeyHint:input.enterKeyHint,name:input.name,visible:input.getBoundingClientRect().width>0,form:input.form?{method:input.form.method,action:input.form.action}:null})),
   title:document.title,body:document.body?.innerText.slice(0,1800)||'',webdriver:navigator.webdriver};
 });
 rootProbe.video=null;rootProbe.qualityControls=false;
 const main=target.mainFrame(),previous=mediaFrames.get(target);
 mediaFrames.delete(target);
 const frames=[...new Set([previous,main,...target.frames()].filter(Boolean))];
 const deadline=Date.now()+3500;
 if(!rootProbe.focus){
  // Preserve evidence about early/unfocused/ad videos, without treating them as
  // the app's selected media or stopping the episode-navigation wait.
  for(const frame of [main,...frames.filter(frame=>frame!==main)].slice(0,4)){
   if(frame.isDetached()||Date.now()>=deadline)continue;
   const diagnostic=await inspectionDeadline(frame.evaluate(readPlayerMedia,{markedRoot:false}),800).catch(()=>null);
   if(diagnostic?.video){rootProbe.unfocusedVideo=diagnostic.video;break;}
  }
  return rootProbe;
 }
 let selected;
 for(const frame of frames.slice(0,24)){
  if(frame.isDetached()||Date.now()>=deadline)continue;
  if(!await ownedPlayerFrame(frame,target).catch(()=>false))continue;
  const observed=await inspectionDeadline(frame.evaluate(readPlayerMedia,{markedRoot:frame===main}),800).catch(()=>null);
  if(!observed?.video||frame.isDetached())continue;
  if(!selected||observed.area>selected.observed.area)selected={frame,observed};
 }
 if(selected&&!selected.frame.isDetached()){
  rootProbe.video=selected.observed.video;
  rootProbe.qualityControls=selected.observed.qualityControls;
  rootProbe.mediaFrameKind=selected.frame===main?'main-player':'owned-player-frame';
  mediaFrames.set(target,selected.frame);
 }
 return rootProbe;
}
async function decodedSamples(target,source,result){
 let pair={first:null,second:null,owned:false};
 // One iframe replacement is recoverable; never compare clocks from two frames.
 for(let attempt=0;attempt<2;attempt++){
  const first=await boundedProbe(target).catch(()=>null),frame=mediaFrames.get(target),before=await trustedPlayerState(source);
  await delay(2000);
  const second=await boundedProbe(target).catch(()=>null),afterFrame=mediaFrames.get(target),after=await trustedPlayerState(source);
  const owned=!!frame&&frame===afterFrame&&!frame.isDetached()&&first?.focus===true&&second?.focus===true&&before.ready&&after.ready;
  pair={first,second,owned};
  if(owned)return pair;
  result.mediaFrameRetries=(result.mediaFrameRetries??0)+1;
 }
 return pair;
}

try{
 await build({stdin:{contents:"export {parseSitesConfig} from './app/core/config/sitesConfig';",resolveDir:root},outfile:path.join(run,'sites.cjs'),bundle:true,platform:'node',format:'cjs',logLevel:'warning'});
 const {parseSitesConfig}=createRequire(import.meta.url)(path.join(run,'sites.cjs')),configured=parseSitesConfig(readFileSync(path.join(root,'config/streaming-sites.txt'),'utf8')).entries;
 assert.ok(configured.length,'Actual user source configuration is available');assert.ok(configured.every(source=>new URL(source.url).protocol==='https:'),'Normal functional sources must be HTTPS');
 expectedSourceIndices=configured.flatMap((_entry,index)=>requestedIndices.has(index+1)?[index+1]:[]);
 assert.ok(expectedSourceIndices.length,'At least one requested configured source is required');
 const connected=await client.connect();page=connected.page;browser=await chromium.connectOverCDP('http://127.0.0.1:'+connected.port,{noDefaults:true,artifactsDir:run});page.on('pageerror',error=>rendererErrors.push(clean(error.message)));
 const apk=client.adb('shell','pm','path',client.appId).split(/\r?\n/).find(item=>item.endsWith('/base.apk'))?.replace(/^package:/,'');assert.match(apk,/^\/data\/app\/[A-Za-z0-9_~+\/=.-]+\/base\.apk$/);installedApkSHA256=client.adb('shell','sha256sum',apk).split(/\s+/)[0];const immutableHash=createHash('sha256').update(readFileSync(path.resolve(root,process.env.ANDROID_LIVE_APK??'test/cache/android-0.1.0/normal-app-debug.apk'))).digest('hex');assert.equal(installedApkSHA256,immutableHash,'Installed normal APK matches immutable normal-app-debug.apk');
 originalState=await client.native('storage.load');writeFileSync(path.join(run,'initial-state-private.json'),JSON.stringify(originalState));
 const notice=page.getByRole('button',{name:'I understand · Start browsing',exact:true});if(await notice.count())await client.touch(notice);
 await check('Official AniList metadata loads in the normal network build',async()=>{const info=await client.native('native.info');assert.equal(info.fixture,false);details=await rpc('meta.details',{id:Number(process.env.ANDROID_LIVE_MEDIA_ID??1)});assert.equal(details.id,Number(process.env.ANDROID_LIVE_MEDIA_ID??1));assert.ok(details.title?.english||details.title?.romaji);assert.ok(details.cover.startsWith('https://'));await client.nav('Home');await page.locator('.hero h1').waitFor({timeout:45000});await shot('official-home');writeFileSync(path.join(run,'metadata-private.json'),JSON.stringify(details));return {id:details.id,title:details.title.english??details.title.romaji,officialCover:true,fixture:false};});
 await check('Actual configured sources are added through the URL form without replacing existing entries',async()=>{await client.nav('Sources');const before=await rpc('sources.list');for(const [index,entry]of configured.entries()){const existing=(await rpc('sources.list')).find(source=>source.url===entry.url);if(existing)continue;await client.touch(page.getByRole('button',{name:'Add source',exact:true}));const modal=page.getByRole('dialog',{name:'Add source URL',exact:true});await modal.waitFor();await modal.getByRole('textbox',{name:'Source URL',exact:true}).fill(entry.url);await modal.getByRole('textbox',{name:'Source name',exact:true}).fill('Source '+(index+1));await client.touch(modal.getByRole('button',{name:'Save source',exact:true}));await modal.waitFor({state:'hidden',timeout:25000});}const after=await rpc('sources.list');for(const previous of snapshot(before))assert.deepEqual(snapshot(after).find(source=>source.id===previous.id),previous);assert.ok(configured.every(entry=>after.some(source=>source.url===entry.url)));await shot('actual-sources-private');return {configured:configured.length,saved:after.length,preserved:before.length};});
 await check('Sources and header refresh preserve source identity, URL, name and enabled state',async()=>{const before=snapshot(await rpc('sources.list'));await client.touch(page.getByRole('button',{name:'Refresh sources',exact:true}));await page.getByText(/Refreshed \d+ saved sources\./).waitFor();assert.deepEqual(snapshot(await rpc('sources.list')),before);await client.touch(page.getByRole('button',{name:'Refresh',exact:true}));await page.getByRole('button',{name:'Refresh',exact:true}).waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('[aria-label=Refresh]')?.disabled);assert.deepEqual(snapshot(await rpc('sources.list')),before);return {sourceCount:before.length};});
 if(details){const current=await rpc('sources.list');sourceEnabledBefore=new Map(current.map(source=>[source.id,source.enabled]));writeFileSync(path.join(run,'source-flags-before-isolation-private.json'),JSON.stringify([...sourceEnabledBefore]));const selected=configured.map((entry,index)=>({source:current.find(source=>source.url===entry.url),index:index+1})).filter(item=>requestedIndices.has(item.index)&&!!item.source);
 assert.deepEqual(selected.map(item=>item.index),expectedSourceIndices,'Every requested configured source must be available, including disabled sources');
 for(const {source,index}of selected){const result={source:'Source '+index,sourceIndex:index,kind:source.kind ?? null,configuredKind:configured[index-1].kind,sourceOriginallyEnabled:sourceEnabledBefore.get(source.id)===true,episode:1,automaticNavigation:false,episodeConfirmed:false,decodedPlayback:false,bridgeAbsent:null,challenge:false};let target;let nextPlayerTap=0;const openedAt=Date.now();
 try{
  // Test each source independently: the app's normal recovery must not switch this case to a different site.
  const isolatedState=await client.native('storage.load');
  assert.ok(Array.isArray(isolatedState.sources),'Native source state is available for isolated checks');
  await client.native('storage.save',{value:{...isolatedState,sources:isolatedState.sources.map(item=>({...item,enabled:item.id===source.id}))}});
  await page.reload();await page.waitForFunction(()=>!!window.aniverse&&!!window.AniVerseNative);
  const isolatedSources=await rpc('sources.list');assert.deepEqual(isolatedSources.filter(item=>item.enabled).map(item=>item.id),[source.id],'Only requested source is enabled during its isolated check');
  result.sourceIsolated=true;
  await page.evaluate(({sourceId,mediaId})=>{location.hash='#/watch/'+mediaId+'/1?source='+encodeURIComponent(sourceId);},{sourceId:source.id,mediaId:details.id});await page.locator('.tablet-watch').waitFor({timeout:25000});const chooser=page.getByRole('combobox',{name:'Playback source',exact:true});await client.touch(chooser);await client.touch(page.getByRole('listbox').getByRole('option',{name:source.name,exact:true}));assert.equal((await chooser.innerText()).trim(),source.name,'Actual UI selects requested saved source');await page.locator('.tablet-player-slot').waitFor();
  const deadline=Date.now()+Number(process.env.ANDROID_LIVE_TIMEOUT??45000),trace=[];let last;
  while(Date.now()<deadline){
   target=browser.contexts().flatMap(context=>context.pages()).find(candidate=>!candidate.isClosed()&&normalizedOrigin(candidate.url())===normalizedOrigin(source.url));
   if(target){
    last=await boundedProbe(target).catch(()=>null);
    if(last){
     const url=target.url(),trusted=await trustedPlayerState(source);
     trace.push({url,...last,appPlayerState:trusted.state,requestedSourceSelected:trusted.selected});
     result.bridgeAbsent=last.nativeBridge==='undefined'&&last.appBridge==='undefined';
     result.automaticNavigation=new URL(url).pathname.replace(/\/$/,'')!==new URL(source.url).pathname.replace(/\/$/,'')||new URL(url).search!==new URL(source.url).search;
     result.challenge=/just a moment|verify (?:you are|that you)|checking your browser|captcha|access denied|cloudflare ray/i.test(last.title+' '+last.body);
     if(!result.challenge&&trusted.ready&&last.focus&&(!last.video||last.video.paused)&&(result.playerTaps??0)<3&&Date.now()>=nextPlayerTap){
      await tapPlayer(target,result,source);nextPlayerTap=Date.now()+2500;
     }
     if(result.challenge||(trusted.ready&&last.focus&&last.video?.readyState>=2))break;
    }
   }
   await delay(1000);
  }
  if(target&&last&&!result.challenge&&(!result.automaticNavigation||!last.video)){
   const {pageScript}=createRequire(import.meta.url)(path.join(root,'test/cache/android-0.1.0/site-page.cjs'));let operation;try{operation=await inspectionDeadline(target.evaluate(pageScript({op:'openSearch',attempt:-1})));}catch(error){operation={error:String(error)};}
   const xml=await nativeUI(result);writeFileSync(path.join(run,'source-'+index+'-stalled-native-private.xml'),xml);writeFileSync(path.join(run,'source-'+index+'-stalled-dom-private.json'),JSON.stringify({probe:last,operation},null,2));
   result.nativeStatus=['Loading website…','Finding the series…','Searching for the series…','Finding episode 1…','Episode 1','Choose the series/episode on the website'].filter(value=>xml.includes(value));
   console.log('[DIAG] '+JSON.stringify({source:'Source '+index,readyState:last.readyState,nativeStatus:result.nativeStatus,searchInputFound:operation?.input===true,requestedTitleFilled:last.inputs.some(input=>/cowboy|bebop/i.test(input.value))}));
   if(index===1&&!result.automaticNavigation){for(const input of await target.locator('input').all()){if(await input.isVisible()&&/cowboy|bebop/i.test(await input.inputValue())){result.manualEnterTried=true;await input.press('Enter');for(const end=Date.now()+30000;Date.now()<end;){await delay(1000);last=await boundedProbe(target).catch(()=>null);if(!last)continue;trace.push({url:target.url(),afterManualEnter:true,...last});result.afterManualEnterNavigation=new URL(target.url()).pathname.replace(/\/$/,'')!==new URL(source.url).pathname.replace(/\/$/,'')||new URL(target.url()).search!==new URL(source.url).search;if(last.focus&&last.video?.readyState>=2&&(await trustedPlayerState(source)).ready)break;}break;}}
   }
  }
  result.observationMilliseconds=Date.now()-openedAt;writeFileSync(path.join(run,'source-'+index+'-trace-private.json'),JSON.stringify(trace,null,2));writeFileSync(path.join(run,'source-'+index+'-targets-private.json'),JSON.stringify(browser.contexts().flatMap(context=>context.pages()).filter(candidate=>!candidate.isClosed()).map(candidate=>candidate.url())));
  if(target&&last){await shot('source-'+index+'-private',target);const xml=await nativeUI(result);writeFileSync(path.join(run,'source-'+index+'-native-private.xml'),xml);const {pageScript}=createRequire(import.meta.url)(path.join(root,'test/cache/android-0.1.0/site-page.cjs'));result.titleCheck=await inspectionDeadline(target.evaluate(pageScript({op:'titleCheck',titles:[details.title.english,details.title.romaji,details.title.native].filter(Boolean),season:1}))).catch(()=>null);result.episodeCheck=await inspectionDeadline(target.evaluate(pageScript({op:'episodeCheck',episode:result.episode}))).catch(()=>null);result.appPlayerState=await page.locator('.tablet-player-slot').getAttribute('data-player-state').catch(()=>null);result.requestedSourceSelected=(await trustedPlayerState(source)).selected;result.episodeConfirmed=result.episodeCheck?.matches===true&&result.titleCheck?.score>=.72&&result.appPlayerState==='ready'&&result.requestedSourceSelected&&(result.automaticNavigation||result.afterManualEnterNavigation);result.automaticFocus=last.focus;result.originalQualityControls=last.qualityControls;result.webdriver=last.webdriver;
   if(last.video){
    let mediaFrame=await currentMediaFrame(target);
    if(mediaFrame){
     await inspectionDeadline(mediaFrame.evaluate(({markedRoot})=>{
      const root=markedRoot?document.querySelector('[data-aniverse-player]'):document;
      const videos=root?[...(root instanceof HTMLVideoElement?[root]:root.querySelectorAll('video'))]:[];
      const video=videos.filter(v=>{const r=v.getBoundingClientRect(),s=getComputedStyle(v);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0;})
       .sort((a,b)=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return y.width*y.height-x.width*x.height;})[0];
      if(video)video.muted=true;
     },{markedRoot:mediaFrame===target.mainFrame()}),1500).catch(error=>{result.mediaInspectionError=clean(error.message);});
    }
    if(last.video.paused&&!result.challenge&&(result.playerTaps??0)<3)await tapPlayer(target,result,source);
    await delay(1200);
    const {first,second,owned}=await decodedSamples(target,source,result);
    result.decodedPlayback=owned&&!!first?.video&&!!second?.video&&!second.video.paused&&second.video.time>first.video.time+.2&&second.video.frames>first.video.frames&&second.video.width>0;
    result.media=second?.video?{width:second.video.width,height:second.video.height,advancedSeconds:first?.video?second.video.time-first.video.time:0,decodedFrames:first?.video?second.video.frames-first.video.frames:0,ownedPlayer:owned}:null;
    if(index===1&&result.decodedPlayback){
     for(const end=Date.now()+12000;Date.now()<end;){
      const later=await boundedProbe(target).catch(()=>null);
      if(!later?.video||later.video.paused||later.video.time>=8){result.laterFrameTime=later?.video?.time;break;}
      await delay(750);
     }
    }
    mediaFrame=await currentMediaFrame(target);
    if(mediaFrame){
     try{
      const scope=mediaFrame===target.mainFrame()?mediaFrame.locator('[data-aniverse-player]'):mediaFrame.locator('body');
      const quality=scope.getByRole('button',{name:/^(video )?(quality|resolution)( settings)?$/i}).first();
      if(await quality.count()&&await quality.isVisible()){
       await inspectionDeadline(client.touch(quality),5000);result.originalQualityMenuOpened=true;
       result.qualityChoices=await inspectionDeadline(scope.evaluate(el=>[...new Set((el.innerText.match(/(?:2160|1440|1080|720|480|360|240)p/g)||[]))]),1500);
       await shot('source-'+index+'-quality-private',target);
      }
     }catch(error){result.qualityInspectionError=clean(error.message);}
    }
    await shot('source-'+index+'-playback-private',target);
    writeFileSync(path.join(run,'source-'+index+'-native-playback-private.png'),execFileSync('C:/Users/Admin/AppData/Local/Android/Sdk/platform-tools/adb.exe',['-s',client.serial,'exec-out','screencap','-p'],{cwd:root,windowsHide:true,timeout:20000,maxBuffer:16*1024*1024}));
   }
  }
  result.observation=result.afterManualEnterNavigation?'Manual Enter enabled navigation; native automatic search still failed':!target?'Owned source target not acquired; page/bridge/navigation unverified':result.challenge?'Website challenge; automatic episode and playback not verified':!result.automaticNavigation?'Automatic navigation remained on source homepage':!result.episodeConfirmed?'Search/title navigation observed; selected episode not confirmed':!result.decodedPlayback?'Episode navigation observed; decoded playback not verified':'Original episode video decoded and clock advanced';
 }catch(error){result.error=clean(error.message);writeFileSync(path.join(run,'source-'+index+'-error-private.txt'),String(error.stack||error));}
 finally{
  try{
   const surface=await page.locator('.tablet-player-slot').evaluate(slot=>({state:slot.getAttribute('data-player-state'),message:slot.querySelector('[role="status"]')?.textContent??null})).catch(()=>null);
   result.appPlayerState=surface?.state??null;
   let message=surface?.message?clean(surface.message):null;
   if(message){for(const identity of [new URL(source.url).hostname,source.host,source.name].filter(Boolean))message=message.split(identity).join('[source]');}
   result.appStatusMessage=message;
   result.requestedSourceSelected=(await trustedPlayerState(source)).selected;
   result.episodeConfirmed=!!result.episodeConfirmed&&result.appPlayerState==='ready'&&result.requestedSourceSelected;
   result.decodedPlayback=!!result.decodedPlayback&&result.appPlayerState==='ready'&&result.requestedSourceSelected;
  }catch(error){result.appStateInspectionError=clean(error.message);}
  sources.push(result);console.log('[LIVE] '+JSON.stringify(result));await client.nav('Home');await delay(500);
 }
 }}
 assert.deepEqual(sources.map(result=>result.sourceIndex),expectedSourceIndices,'Every requested configured source must produce exactly one result');
 await client.nav('Home');await shot('finished-home');
}catch(error){checks.push({name:'Live harness setup/completion',passed:false,error:clean(error.message)});writeFileSync(path.join(run,'fatal-private.txt'),String(error.stack||error));console.log('[FAIL] Live harness setup/completion: '+clean(error.message));}
finally{
 if(sourceEnabledBefore&&page&&!page.isClosed()){
  try{
   // Merge only enable flags into the latest state; retain library/history/account/config changes.
   const latest=await client.native('storage.load');
   await client.native('storage.save',{value:{...latest,sources:latest.sources.map(item=>({...item,enabled:sourceEnabledBefore.has(item.id)?sourceEnabledBefore.get(item.id):item.enabled}))}});
   const restored=await client.native('storage.load');
   isolationRestored=[...sourceEnabledBefore].every(([id,enabled])=>restored.sources.some(item=>item.id===id&&item.enabled===enabled));
   assert.equal(isolationRestored,true,'Every original source enable flag is restored');
   await page.reload();await page.waitForFunction(()=>!!window.aniverse&&!!window.AniVerseNative);
  }catch(error){checks.push({name:'Restore source isolation flags',passed:false,error:clean(error.message)});writeFileSync(path.join(run,'restore-source-flags-error-private.txt'),String(error.stack||error));}
 }
 if(browser)await browser.close().catch(()=>{});await client.close();const observedSourceIndices=sources.map(result=>result.sourceIndex),sourceCoverageComplete=expectedSourceIndices.length>0&&observedSourceIndices.length===expectedSourceIndices.length&&observedSourceIndices.every((index,at)=>index===expectedSourceIndices[at]);const passed=checks.length===3&&checks.every(check=>check.passed)&&isolationRestored&&sourceCoverageComplete&&sources.every(source=>source.sourceIsolated&&source.requestedSourceSelected&&source.automaticNavigation&&source.episodeConfirmed&&source.decodedPlayback&&source.bridgeAbsent)&&!rendererErrors.length;const report={passed,run,serial:'emulator-5584',appId:client.appId,installedApkSHA256,checks,sources,rendererErrors,requestedSourceIndices:[...requestedIndices],expectedSourceIndices,observedSourceIndices,sourceCoverageComplete,sourceIsolationRestored:isolationRestored,scope:'Actual configured Windows sources added using URL form; every requested configured source including YouTube and originally disabled entries checked independently with only its own source enabled, original enable flags restored into latest state; ordinary low-rate one-episode browsing, no downloads, security probes or challenge bypass. Source identities and URLs redacted; private evidence in ignored cache.'};mkdirSync(path.join(root,'test/artifacts'),{recursive:true});writeFileSync(path.join(run,'report-redacted.json'),JSON.stringify(report,null,2));writeFileSync(path.join(root,'test/artifacts/android-live.json'),JSON.stringify(report,null,2));if(!passed)process.exitCode=1;console.log('[REPORT] '+path.join(run,'report-redacted.json'));}
