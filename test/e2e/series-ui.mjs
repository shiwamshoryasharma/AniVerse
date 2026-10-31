// Integrated series disambiguation, source episode stills and ALL/DUB/SUB UI. Development bundle only.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {_electron} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),cache=path.join(root,'test/cache/series-ui'),artifacts=path.join(root,'test/artifacts');
mkdirSync(cache,{recursive:true});mkdirSync(artifacts,{recursive:true});
const run=mkdtempSync(path.join(cache,'run-')),profile=path.join(run,'profile'),config=path.join(run,'config'),temp=path.join(run,'temp');
for(const folder of [profile,config,temp])mkdirSync(folder,{recursive:true});
const clipPath=path.join(root,'test/cache/release-1.5.2-ui/sintel-trailer.mp4'),clip=readFileSync(clipPath).toString('base64'),images=[];
for(let i=1;i<=3;i++){const file=path.join(run,'episode-'+i+'.jpg');execFileSync(path.join(root,'build/vendor/ffmpeg/ffmpeg.exe'),['-hide_banner','-loglevel','error','-ss',String(i*6),'-i',clipPath,'-frames:v','1','-vf','scale=320:-2','-y',file],{windowsHide:true});images.push(readFileSync(file).toString('base64'));}
writeFileSync(path.join(config,'streaming-sites.txt'),'https://series-one.test\n');writeFileSync(path.join(config,'filters.txt'),'! neutral fixture\n');
await build({stdin:{contents:"export {Store} from './app/core/db/store';export {AniListClient} from './app/core/metadata/anilist';",resolveDir:root},outfile:path.join(run,'seed.cjs'),bundle:true,platform:'node',format:'cjs',external:['node:sqlite'],logLevel:'warning'});
const {Store,AniListClient}=createRequire(import.meta.url)(path.join(run,'seed.cjs')),db=new Store(path.join(profile,'aniverse.db'));
const raw=JSON.parse(readFileSync(path.join(root,'test/fixtures/anilist-home.json'),'utf8')).data.trending.media[0];
Object.assign(raw,{id:7,idMal:null,title:{english:'Skybound Chronicle: River Arc',romaji:'Skybound Chronicle: Kawa-hen',native:'空の旅 川編',userPreferred:'Skybound Chronicle: River Arc'},coverImage:{extraLarge:'',large:'',color:null},bannerImage:null,status:'FINISHED',episodes:3,synonyms:['Skybound Chronicle Season 2'],streamingEpisodes:[],externalLinks:[],relations:{edges:[]},recommendations:{nodes:[]},characters:{edges:[]},studios:{nodes:[]},tags:[]});
const other={...raw,id:8,title:{english:'Unknown Audio Series',romaji:'Unknown Audio Series',native:null,userPreferred:'Unknown Audio Series'},synonyms:[]};
const data={Media:raw,Page:{media:[raw,other],airingSchedules:[{id:1,episode:1,airingAt:Math.floor(Date.now()/1000)-600,media:raw},{id:2,episode:1,airingAt:Math.floor(Date.now()/1000)-800,media:other}],pageInfo:{currentPage:1,total:2,hasNextPage:false}},trending:{media:[raw]},spotlight:{media:[]},popularSeason:{media:[]},upcoming:{media:[]},topRated:{media:[]},recent:{airingSchedules:[]}};
const client=new AniListClient(async()=>new Response(JSON.stringify({data})),db,{showAdult:()=>false,token:()=>null});await client.details(7);await client.home();await client.latest();await client.browse({page:1,perPage:30});
db.setKv('settings',{privacy:{adblock:false,blockPopups:true},updates:{autoCheck:false,autoDownload:false},player:{autoplay:false},appearance:{spoilerShield:false,accent:'festival'}});
db.patchSourceOverride('series-one-test',{name:'Fixture source',searchTemplate:'https://series-one.test/search?q={query}'});db.close();
let app;const checks=[],errors=[];
const check=(name,actual)=>{checks.push({name,passed:true,actual});console.log('[PASS] '+name);};
try{
 app=await _electron.launch({args:[root],cwd:root,env:{...process.env,ANIVERSE_HEADLESS:'1',ANIVERSE_DATA_DIR:profile,ANIVERSE_CONFIG_DIR:config,TEMP:temp,TMP:temp,TMPDIR:temp},timeout:60000});
 await app.evaluate(({app,session},input)=>{
  globalThis.imageRequests=[];globalThis.seriesPaths=[];
  const install=ses=>ses.protocol.handle('https',request=>{
   const url=new URL(request.url);
   if(url.hostname==='graphql.anilist.co')return new Response(JSON.stringify({data:input.data}),{headers:{'Content-Type':'application/json'}});
   if(url.hostname==='media-fixture.test')return new Response(Buffer.from(input.clip,'base64'),{headers:{'Content-Type':'video/mp4'}});
   if(url.hostname==='image-fixture.test'){if(url.pathname.includes('missing'))return new Response(null,{status:404});globalThis.imageRequests.push({partition:ses.getStoragePath(),url:url.pathname});return new Response(Buffer.from(input.images[Number(url.pathname.match(/\d+/)?.[0]??1)-1],'base64'),{headers:{'Content-Type':'image/jpeg'}});}
   globalThis.seriesPaths.push(url.pathname);
   const cards=[1,2,3].map(n=>'<a href="/watch/skybound-river/'+n+'" data-episode="'+n+'"><img src="https://image-fixture.test/'+(n===1&&url.pathname.startsWith('/anime/')?'missing-1':'frame-'+n)+'.jpg"><span>Episode '+n+'</span><b>'+(n===1?'SUB DUB':n===2?'SUB':'DUB')+'</b></a>').join('');
   const search='<h1>Search</h1><a href="/anime/skybound-parent"><h3>Skybound Chronicle</h3></a><a href="/anime/skybound-river"><h3>Skybound Chronicle: River Arc</h3></a>';
   const series='<h1>Skybound Chronicle: River Arc</h1>'+(url.pathname.startsWith('/watch/')?'<div class="episodes" id="late-cards"></div><script>setTimeout(()=>document.getElementById("late-cards").innerHTML='+JSON.stringify(cards)+',6500)</script>':'<div class="episodes">'+cards+'</div>');
   const video=url.pathname.startsWith('/watch/')?'<div id="player" style="width:960px;height:540px"><video id="actual-video" controls loop src="https://media-fixture.test/video.mp4"></video></div>':'';
   return new Response('<!doctype html><title>Skybound Chronicle: River Arc</title><style>body{background:#000;color:white}a{display:block}img{width:150px;height:85px}video{width:100%;height:100%}</style>'+(url.pathname.startsWith('/search')||url.pathname==='/'?search:video+series),{headers:{'Content-Type':'text/html'}});
  });
  install(session.defaultSession);install(session.fromPartition('persist:src-series-one-test'));app.on('session-created',install);
 },{data,clip,images});
 const page=await app.firstWindow();await page.setViewportSize({width:1560,height:1000});page.on('pageerror',error=>errors.push(error.message));await page.waitForSelector('.app');
 if(await page.locator('.release-dialog[open]').count())await page.getByRole('button',{name:'Got it',exact:true}).click();
 const rpc=(method,input)=>page.evaluate(({method,input})=>window.aniverse.invoke(method,input),{method,input});
 const go=hash=>page.evaluate(hash=>location.hash=hash,hash);
 await go('#/watch/7/1?source=series-one-test');
 await page.waitForFunction(()=>document.querySelectorAll('.ep-thumb img').length===3&&Array.from(document.querySelectorAll('.ep-thumb img')).every(img=>img.complete&&img.naturalWidth>0),{},{timeout:60000});
 const paths=await app.evaluate(()=>globalThis.seriesPaths);assert.ok(paths.includes('/anime/skybound-river'));assert.ok(!paths.includes('/anime/skybound-parent'));
 check('Full search → correct named arc → requested episode works beside the original series',paths.filter(p=>p.startsWith('/anime')));
 const srcs=await page.locator('.ep-thumb img').evaluateAll(images=>images.map(img=>({src:img.src,w:img.naturalWidth})));assert.equal(new Set(srcs.map(img=>img.src)).size,3);assert.ok(srcs.every(img=>img.src.startsWith('media://episode/')&&img.w===320));
 assert.equal(await page.locator('.ep-thumb img').first().isVisible(),true,'A replacement image must become visible after the initial image failed');
 check('Three distinct stills decode and recover visibly after an initial image failure',srcs);
 await page.screenshot({path:path.join(artifacts,'series-episode-thumbnails.png')});
 const audio=page.getByRole('group',{name:'Episode audio availability'});
 await audio.getByRole('button',{name:'DUB',exact:true}).click();assert.equal(await page.locator('.ep-row').count(),2);assert.equal(await page.locator('.ep-row').filter({hasText:'Episode 2'}).count(),0);
 await audio.getByRole('button',{name:'SUB',exact:true}).click();assert.equal(await page.locator('.ep-row').count(),2);assert.equal(await page.locator('.ep-row').filter({hasText:'Episode 3'}).count(),0);
 await audio.getByRole('button',{name:'ALL',exact:true}).click();assert.equal(await page.locator('.ep-row').count(),3);check('Episode ALL/DUB/SUB filters use per-episode badges');
 const id=await page.locator('webview').evaluate(view=>view.getWebContentsId());await rpc('player.control',{webContentsId:id,action:'play'});const before=await rpc('player.probe',{webContentsId:id});await page.waitForTimeout(1200);const after=await rpc('player.probe',{webContentsId:id});assert.ok(after.currentTime>before.currentTime+.3);
 check('Original source video continues decoding with thumbnail fetches and filters active');
 await rpc('settings.set',{appearance:{spoilerShield:true}});await page.reload();await page.waitForSelector('.ep-row');
 await page.waitForFunction(()=>document.querySelectorAll('.ep-thumb img').length===1&&document.querySelectorAll('.ep-thumb img')[0].complete);
 assert.equal(await page.locator('.ep-row').filter({hasText:'Episode 2'}).locator('img').count(),0);
 check('Cached navigation refreshes late-rendered episode cards while Spoiler Shield hides future artwork');
 await go('#/');const latest=page.getByRole('group',{name:'Latest episode audio availability'});await latest.waitFor();await page.waitForFunction(()=>document.querySelectorAll('.mcard').length>=2);
 await latest.getByRole('button',{name:'DUB',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.audio-coverage')&&document.querySelectorAll('.mcard').length===1&&document.querySelector('.mcard').textContent.includes('Skybound'));
 await page.screenshot({path:path.join(artifacts,'series-home-audio-filter.png')});check('Home DUB filter keeps confirmed episode availability and excludes unknown titles');
 await page.setViewportSize({width:1180,height:900});await page.waitForTimeout(150);
 assert.ok(await latest.evaluate(group=>{const r=group.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));check('Home audio controls remain visible at a narrower window width');
 await page.setViewportSize({width:1560,height:1000});
 await go('#/browse');const browse=page.getByRole('group',{name:'Browse audio availability'});await browse.waitFor();await browse.getByRole('button',{name:'SUB',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.mcard').length===1&&document.querySelector('.mcard').textContent.includes('Skybound'));check('Browse SUB filter excludes unverified titles and retains source-confirmed series');
 await go('#/watch/7/1?source=series-one-test');await page.getByRole('button',{name:'Keep title private',exact:true}).click();await page.waitForSelector('.privacy-banner');
 assert.deepEqual(await rpc('sources.audio'),[]);check('Private titles are removed from the session-local home/browse availability index');
 assert.deepEqual(errors,[]);
}catch(error){errors.push(String(error.stack||error));console.error(error);if(app)try{await(await app.firstWindow()).screenshot({path:path.join(artifacts,'series-ui-failure.png')});}catch{};process.exitCode=1;}
finally{if(app)await app.close();writeFileSync(path.join(artifacts,'series-ui.json'),JSON.stringify({passed:!errors.length,checks,errors,run},null,2)+'\n');}
