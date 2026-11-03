const {app,BrowserWindow,session}=require('electron');
const {mkdirSync,writeFileSync,readFileSync}=require('node:fs');
const {DatabaseSync}=require('node:sqlite');
const path=require('node:path');
const root=process.env.ANIVERSE_NAV_ROOT;
const baseline=process.env.ANIVERSE_NAV_BASELINE==='1';
const cache=path.join(root,'test/cache/navigation-learning');
const artifacts=path.join(root,'test/artifacts');
const runDirectory=path.join(cache,(baseline?'before-':'after-')+Date.now());
mkdirSync(runDirectory,{recursive:true});mkdirSync(artifacts,{recursive:true});
app.setPath('userData',path.join(runDirectory,'profile'));
app.setPath('sessionData',path.join(runDirectory,'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
const {SiteNavigator,Store,SourceRegistry,WebSiteAdapter}=require(process.env.ANIVERSE_NAV_RUNTIME);
const host='navigation-learning.test',origin='https://'+host;
const sourceId='navigation-fixture';
const entries=[{id:sourceId,name:'Neutral source',url:origin+'/',host,kind:'web',line:1,youtube:null}];
const catalogue=[['skybound','Skybound Chronicle'],['copper','Copper Harbor'],['ivory','Ivory Horizon'],['cobalt','Cobalt Lantern'],['violet','Violet Compass'],['amber','Amber Meridian'],['silver','Silver Orchard'],['crimson','Crimson Valley'],['jade','Jade Lighthouse'],['pearl','Pearl Crossing'],['bronze','Bronze Meadow'],['coral','Coral Summit']];
const checks=[],runs=[],errors=[],blockedRequests=[];
const dbFile=path.join(runDirectory,'store.sqlite');
const recipeFile=path.join(runDirectory,'recipes.json');
writeFileSync(recipeFile,'{}\n');
let layout='tabs-v1',active=null,store=null,registry=null,navigator=null,win=null,fetches=0;
function check(name,condition,actual){checks.push({name,passed:!!condition,actual});console.log('['+(condition?'PASS':'FAIL')+'] '+name+' '+JSON.stringify(actual));}
function dumpKv(){const db=new DatabaseSync(dbFile,{readOnly:true});try{return db.prepare('SELECT key,value FROM kv ORDER BY key').all().map(row=>({key:row.key,value:JSON.parse(row.value)}));}finally{db.close();}}
function learningRows(){return dumpKv().filter(row=>row.key==='site-method:'+sourceId);}
function href(slug,episode){return '/watch/'+slug+'/'+episode;}
function fixture(url){
 const u=new URL(url);const parts=u.pathname.split('/').filter(Boolean);const slug=parts[1]||'';const title=catalogue.find(row=>row[0]===slug)?.[1]||'';
 const isWatch=parts[0]==='watch';const isPlay=parts[0]==='play';const isSeries=parts[0]==='anime';const episode=isWatch?Number(parts[2]):null;
 const version=layout==='tabs-v1'?'v1':'v2';
 const episodeAttribute=layout==='tabs-v1'?'data-episode':'data-num';
 const episodeLinks='<section class="episodes">'+[1,2,3].map(n=>'<a '+episodeAttribute+'="'+n+'" href="'+href(slug,n)+'">Episode '+n+'</a>').join('')+'</section>';
 const titleBody=isSeries?'<h1>'+title+'</h1>'+(layout==='watch-v2'?'<a class="watch-'+version+'" href="/play/'+slug+'">Watch now</a>':'<button class="episodes-'+version+'" id="episode-tab-'+version+'" role="tab" aria-selected="false">Episodes</button><div id="episode-content"></div>'):'';
 const watchBody=isWatch?'<h1>'+title+'</h1><video id="original-player" data-original-player="'+slug+'" controls width="800" height="450"></video>'+episodeLinks:isPlay?'<h1>'+title+'</h1>'+episodeLinks:'';
 return '<!doctype html><meta charset="utf-8"><title>'+(title||'Neutral fixture')+'</title><style>body{font:16px sans-serif;margin:20px}button,a,input{display:inline-block;margin:10px;padding:12px}video{display:block;background:#182838;width:800px;height:450px}[hidden]{display:none!important}#search-overlay{background:#def;padding:20px}</style><body data-series="'+slug+'" data-episode="'+(episode||'')+'" data-layout="'+layout+'"><header><button id="search-'+version+'" class="open-search-'+version+'" aria-label="Search">Search</button></header><section id="search-overlay" hidden><input id="query-'+version+'" type="search" placeholder="Search titles"><div id="results"></div></section><main>'+titleBody+watchBody+'</main><script>const titles='+JSON.stringify(catalogue)+';const episodeLinks='+JSON.stringify(episodeLinks)+';function record(action){const events=JSON.parse(sessionStorage.getItem("navigation-actions")||"[]");events.push({action,at:performance.now(),path:location.pathname});sessionStorage.setItem("navigation-actions",JSON.stringify(events));}document.querySelector("header button").onclick=()=>{record("search-open");document.querySelector("#search-overlay").hidden=false;document.querySelector("input").focus();};document.querySelector("input").oninput=event=>{record("search-input");const query=event.target.value.toLowerCase();setTimeout(()=>{document.querySelector("#results").innerHTML=titles.filter(row=>row[1].toLowerCase().includes(query)).map(row=>"<a class=result-'+version+' href=/anime/"+row[0]+"><h3>"+row[1]+"</h3></a>").join("");record("search-results");},40);};const tab=document.querySelector("[role=tab]");if(tab)tab.onclick=()=>{record("episodes-tab");tab.setAttribute("aria-selected","true");document.querySelector("#episode-content").innerHTML=episodeLinks;};document.querySelectorAll("a").forEach(link=>link.addEventListener("click",()=>record("link-click")));</script>';
}
const instrument=`(()=>{const g=globalThis;if(!g.__navigationLearningInstrumented){g.__navigationLearningInstrumented=true;for(const proto of [Document.prototype,Element.prototype])for(const name of ['querySelector','querySelectorAll']){const original=proto[name];proto[name]=function(selector){if(g.__navigationLearningStats){g.__navigationLearningStats.queries++;if(g.__navigationLearningStats.selectors.length<60)g.__navigationLearningStats.selectors.push(String(selector));}return original.call(this,selector);};}const click=HTMLElement.prototype.click;HTMLElement.prototype.click=function(){if(g.__navigationLearningStats)g.__navigationLearningStats.clicks++;return click.call(this);};}g.__navigationLearningStats={queries:0,clicks:0,selectors:[]};})();`;
function decorate(wc){
 const execute=wc.executeJavaScriptInIsolatedWorld.bind(wc);
 wc.executeJavaScriptInIsolatedWorld=async(world,scripts,...args)=>{
  const match=scripts.map(script=>script.code.match(/"op"\s*:\s*"([^"]+)"/)).find(Boolean);
  const op=match?.[1]||'other';const started=performance.now();const run=active;
  try{
   const value=await execute(world,scripts.map(script=>({...script,code:instrument+'\n'+script.code})),...args);
   const stats=await execute(world,[{code:'globalThis.__navigationLearningStats'}]).catch(()=>null);
   const selector=scripts.map(script=>script.code.match(/"selector"\s*:\s*("(?:[^"\\]|\\.)*")/)).find(Boolean);
   const row={op,ms:Math.round((performance.now()-started)*10)/10,empty:value==null||(Array.isArray(value)&&!value.length),clicked:!!value?.clicked,input:value?.input,selector:selector?JSON.parse(selector[1]):null,queries:stats?.queries??0,clicks:stats?.clicks??0,selectors:stats?.selectors??[]};
   if(run)run.operations.push(row);return value;
  }catch(error){if(run)run.operations.push({op,error:String(error),ms:Math.round(performance.now()-started)});throw error;}
 };
}
function makeNavigator(){
 registry=new SourceRegistry(store,{async get(_source,url){fetches++;if(active)active.discoveryFetches++;return {url,text:fixture(url),status:200};}},[new WebSiteAdapter()]);registry.setEntries(entries);
 navigator=new SiteNavigator(store,registry,recipeFile,event=>{if(active)active.status.push({atMs:Math.round(performance.now()-active.started),message:event.message});},async wc=>wc.executeJavaScript('(()=>{const v=document.querySelector("video");return v?{paused:false,ended:false,currentTime:0,duration:120,video:{readyState:v.readyState}}:null})()'),()=>true);
}
async function makeWindow(partition){
 const ses=session.fromPartition(partition);
 ses.webRequest.onBeforeRequest((details,callback)=>{const allowed=details.url.startsWith(origin+'/')||details.url==='about:blank';if(!allowed)blockedRequests.push(details.url);callback({cancel:!allowed});});
 if(!await ses.protocol.isProtocolHandled('https'))await ses.protocol.handle('https',request=>{if(active)active.loads.push(new URL(request.url).pathname);return new Response(fixture(request.url),{headers:{'Content-Type':'text/html; charset=utf-8'}});});
 const window=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false}});window.webContents.on('console-message',event=>{if(event.level==='error')console.log('[PAGE] '+event.message);});decorate(window.webContents);return window;
}
async function open(name,index,episode=1,{privateSource=false}={}){
 const [slug,title]=catalogue[index];const source={...registry.get(sourceId),...(privateSource?{partition:'navigation-private-session'}:{})};
 const run={name,slug,title,episode,layout,privateSource,started:performance.now(),loads:[],operations:[],status:[],discoveryFetches:0};active=run;runs.push(run);
 console.log('[RUN] '+name+' '+title+' episode '+episode+' '+layout);
 let timeout;
 try{
  const result=await Promise.race([navigator.openEpisode(win.webContents,source,{mediaId:1000+index,titles:[title],episode,focus:true}),new Promise((_,reject)=>{timeout=setTimeout(()=>{win.destroy();reject(new Error(name+' exceeded its 60 second request deadline'));},60000);})]);
  run.ms=Math.round(performance.now()-run.started);run.result={ok:result.ok,via:result.via,failure:result.failure,url:result.url,focused:result.focused};
  run.identity=await win.webContents.executeJavaScript('({series:document.body.dataset.series,episode:Number(document.body.dataset.episode),players:document.querySelectorAll("video").length,originalPlayer:document.querySelector("video")?.getAttribute("data-original-player"),actions:JSON.parse(sessionStorage.getItem("navigation-actions")||"[]")})');
  run.originalPlayer=run.identity.players===1&&run.identity.originalPlayer===slug;
  check(name+' opens the requested series and episode',result.ok&&run.identity.series===slug&&run.identity.episode===episode,{ms:run.ms,result:run.result,identity:{series:run.identity.series,episode:run.identity.episode}});
  check(name+' retains and focuses the original source player',run.originalPlayer&&result.focused,{originalPlayer:run.originalPlayer,focused:result.focused});
  run.counts=Object.fromEntries([...new Set(run.operations.map(op=>op.op))].map(op=>[op,run.operations.filter(row=>row.op===op).length]));
  run.failedEpisodePolls=run.operations.filter(op=>op.op==='findEpisode'&&op.empty).length;
  run.waitingForSearchInput=run.operations.filter(op=>op.op==='openSearch'&&op.input===false&&!op.clicked).length;
  run.domQueries=run.operations.reduce((sum,op)=>sum+(op.queries||0),0);run.domClicks=run.operations.reduce((sum,op)=>sum+(op.clicks||0),0);
  console.log('[METRIC] '+JSON.stringify({name,ms:run.ms,loads:run.loads,discoveryFetches:run.discoveryFetches,failedEpisodePolls:run.failedEpisodePolls,waitingForSearchInput:run.waitingForSearchInput,operations:run.counts,domQueries:run.domQueries,domClicks:run.domClicks}));
  return run;
 }finally{clearTimeout(timeout);delete run.started;active=null;}
}
function efficient(name,run,cold){
 check(name+' avoids rediscovering a successful source search',run.discoveryFetches===0,{discoveryFetches:run.discoveryFetches});
 check(name+' skips repeated generic search-opener polling',run.waitingForSearchInput<=2,{cold:cold.waitingForSearchInput,warm:run.waitingForSearchInput});
 check(name+' skips failed episode-list polling before its known tab',run.failedEpisodePolls<=2,{cold:cold.failedEpisodePolls,warm:run.failedEpisodePolls});
 check(name+' is materially faster under identical rendered fixture timing',run.ms<cold.ms*.8,{coldMs:cold.ms,warmMs:run.ms,speedup:Number((cold.ms/run.ms).toFixed(2))});
}
function privacy(name,before,run){
 const after=learningRows();
 check(name+' does not change persisted normal source methods',JSON.stringify(before)===JSON.stringify(after),{before,after});
 const used=run.operations.filter(op=>/^learn|method/i.test(op.op)||op.selector);
 check(name+' does not execute persisted learned selectors',used.length===0,used.map(op=>({op:op.op,selector:op.selector})));
 check(name+' does not persist title or episode links',Object.keys(store.getSiteLinks(sourceId,1000+catalogue.findIndex(row=>row[0]===run.slug))).length===0,store.getSiteLinks(sourceId,1000+catalogue.findIndex(row=>row[0]===run.slug)));
}
app.whenReady().then(async()=>{
 try{
  store=new Store(dbFile);makeNavigator();win=await makeWindow('persist:navigation-normal-'+Date.now());
  const cold=await open('cold first series',0);
  const warm=await open('different series same source',1);efficient('A different series on the same source',warm,cold);
  const next=await open('next episode',1,2);
  check('The next episode uses the existing title episode pattern',next.result.via==='derived'&&next.loads.length===1&&next.failedEpisodePolls===0,{via:next.result.via,loads:next.loads,failedEpisodePolls:next.failedEpisodePolls});
  win.destroy();store.close();store=new Store(dbFile);makeNavigator();win=await makeWindow('persist:navigation-reopened-'+Date.now());
  const reopened=await open('new navigator and reopened store',2);efficient('A new navigator and reopened store',reopened,cold);
  layout='tabs-v2';win.destroy();win=await makeWindow('persist:navigation-changed-'+Date.now());const changed=await open('changed selectors',3);
  check('Changed selectors recover through bounded generic fallback',changed.result.ok&&changed.ms<60000,{ms:changed.ms,counts:changed.counts});
  const normalMethods=learningRows();
  check('A successful source method is persisted independently of title links',normalMethods.some(row=>row.key==='site-method:'+sourceId&&row.value?.version===1&&row.value?.origin===origin),normalMethods);
  const serialized=JSON.stringify(normalMethods).toLowerCase();
  check('Learned source methods store no title, query, concrete series URL, or copied page/player content',!catalogue.some(([slug,title])=>serialized.includes(slug)||serialized.includes(title.toLowerCase()))&&!/<!doctype|<html|<video|sessionstorage|navigation-actions/.test(serialized),normalMethods);
  if(!baseline){
   layout='watch-v2';const watch=await open('changed route to Watch page',4);
   check('Changed Episodes to Watch layout falls back and opens the requested identity',watch.result.ok&&watch.loads.some(url=>url.startsWith('/play/')),{loads:watch.loads,ms:watch.ms});
   const watchWarm=await open('learned Watch page route',5);efficient('A repeated Watch page layout',watchWarm,watch);
   const privacyBefore=learningRows();
   store.setIncognito(true);win.destroy();win=await makeWindow('navigation-incognito-'+Date.now());
   const incognito=await open('incognito',6,1,{privateSource:true});privacy('Incognito navigation',privacyBefore,incognito);store.setIncognito(false);
   store.setTitlePrivate(1007,true);win.destroy();win=await makeWindow('navigation-private-title-'+Date.now());
   const privateTitle=await open('private title',7,1,{privateSource:true});privacy('Private-title navigation',privacyBefore,privateTitle);store.setTitlePrivate(1007,false);
   writeFileSync(recipeFile,JSON.stringify({[host]:{cacheLinks:false}}));win.destroy();win=await makeWindow('persist:navigation-no-cache-'+Date.now());
   const noCache=await open('recipe cacheLinks false',8);privacy('cacheLinks:false navigation',privacyBefore,noCache);
  }
  check('The fixture contacted no external network',blockedRequests.length===0,blockedRequests);
 }catch(error){errors.push(String(error.stack||error));console.error(error);}
 finally{
  if(win&&!win.isDestroyed())win.destroy();if(store)store.close();
  const passed=!errors.length&&checks.every(row=>row.passed);
  const report={passed,mode:baseline?'baseline':'current',probeCondition:'Controlled already-playing ProbeResult; the real inert source video is retained and focused. Media decoding is not exercised.',scope:'Real SiteNavigator, Store and SourceRegistry bundled from source; actual isolated-world pageScript; hidden Electron; controlled neutral protocol fixtures; original source player DOM retained. No live sites or media extraction. Focus attach event handlers excluded to keep explicit openEpisode timings comparable.',sourceHashes:JSON.parse(readFileSync(path.join(cache,baseline?'baseline-hashes.json':'hashes.json'),'utf8')),runDirectory,fetches,checks,runs,errors,blockedRequests};
  const filename=path.join(artifacts,'navigation-learning'+(baseline?'-before':'')+'.json');writeFileSync(filename,JSON.stringify(report,null,2)+'\n');console.log('[REPORT] '+filename);app.exit(passed?0:1);
 }
});
