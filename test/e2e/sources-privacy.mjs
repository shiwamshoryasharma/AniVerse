// Integrated neutral-source fallback, private-session and seasonal episode-card checks.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {_electron} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const artifacts=path.join(root,'test/artifacts'),cache=path.join(root,'test/cache/sources-privacy');
mkdirSync(cache,{recursive:true});mkdirSync(artifacts,{recursive:true});
const run=mkdtempSync(path.join(cache,'run-')),profile=path.join(run,'profile'),config=path.join(run,'config'),temp=path.join(run,'temp');
for(const folder of [profile,config,temp])mkdirSync(folder,{recursive:true});
writeFileSync(path.join(config,'streaming-sites.txt'),'https://fallback-one.test\nhttps://fallback-two.test\nhttps://disabled-source.test\n');
writeFileSync(path.join(config,'filters.txt'),'! neutral fixture\n');
await build({stdin:{contents:"export {Store} from './app/core/db/store';export {AniListClient} from './app/core/metadata/anilist';",resolveDir:root},outfile:path.join(run,'seed.cjs'),bundle:true,platform:'node',format:'cjs',external:['node:sqlite'],logLevel:'warning'});
const {Store,AniListClient}=createRequire(import.meta.url)(path.join(run,'seed.cjs'));
const db=new Store(path.join(profile,'aniverse.db'));
const media={id:7,idMal:null,title:'Fixture Series',cover:'',banner:null,format:'TV',episodes:3};
const raw=JSON.parse(readFileSync(path.join(root,'test/fixtures/anilist-home.json'),'utf8')).data.trending.media[0];
Object.assign(raw,{id:7,idMal:null,title:{english:'Fixture Series',romaji:'Fixture Romaji',native:'作品タイトル',userPreferred:'Fixture Series'},coverImage:{extraLarge:'',large:'',color:null},bannerImage:null,status:'FINISHED',episodes:3,synonyms:['Alternate Fixture'],streamingEpisodes:[],externalLinks:[],relations:{edges:[]},recommendations:{nodes:[]},characters:{edges:[]},studios:{nodes:[]},tags:[]});
const data={Media:raw,Page:{media:[raw],pageInfo:{currentPage:1,total:1,hasNextPage:false}},trending:{media:[raw]},spotlight:{media:[]},popularSeason:{media:[]},upcoming:{media:[]},topRated:{media:[]},recent:{airingSchedules:[]}};
const client=new AniListClient(async()=>new Response(JSON.stringify({data})),db,{showAdult:()=>false,token:()=>null});
await client.details(7);await client.home();
db.setLibraryEntry(media,'CURRENT',0);
db.setKv('settings',{privacy:{adblock:false,blockPopups:true,watchInsights:true},updates:{autoCheck:false,autoDownload:false},player:{autoplay:false},appearance:{spoilerShield:false,accent:'violet'}});
for(const [id,name] of [['fallback-one-test','First source'],['fallback-two-test','Archive source'],['disabled-source-test','Disabled source']]){
 db.patchSourceOverride(id,{name,enabled:id!=='disabled-source-test',searchTemplate:'https://'+id.replace('-test','.test')+'/search?q={query}'});
 db.setPin(id,7,'https://'+id.replace('-test','.test')+'/watch/fixture/episode-1');
}
db.close();
const clip=readFileSync(path.join(root,'test/cache/release-1.5.2-ui/sintel-trailer.mp4')).toString('base64');
const launch=()=>_electron.launch({executablePath:process.env.E2E_EXE?path.resolve(root,process.env.E2E_EXE):createRequire(import.meta.url)('electron'),args:process.env.E2E_EXE?[]:[root],cwd:root,env:{...process.env,ANIVERSE_HEADLESS:'1',ANIVERSE_DATA_DIR:profile,ANIVERSE_CONFIG_DIR:config,TEMP:temp,TMP:temp,TMPDIR:temp},timeout:60000});
let app;const results=[],errors=[];
const check=(name,actual)=>{results.push({name,passed:true,actual});console.log('[PASS] '+name);};
async function setup(){
 app=await launch();
 await app.evaluate(({app,session},input)=>{
  globalThis.fixtureUnavailable=new Set(['fallback-one.test']);globalThis.fixtureHits={};globalThis.fixturePrivateSessions=[];
  const install=ses=>{
   ses.protocol.handle('https',request=>{
    const u=new URL(request.url);
    if(u.hostname==='graphql.anilist.co')return new Response(JSON.stringify({data:input.data}),{headers:{'Content-Type':'application/json'}});
    if(u.hostname==='media-fixture.test')return new Response(Buffer.from(input.clip,'base64'),{headers:{'Content-Type':'video/mp4'}});
    globalThis.fixtureHits[u.hostname]=(globalThis.fixtureHits[u.hostname]??0)+1;
    if(globalThis.fixtureUnavailable.has(u.hostname))return new Response('<!doctype html><title>404 Page not found</title><h1>Page not found</h1>',{headers:{'Content-Type':'text/html'}});
    return new Response('<!doctype html><title>Fixture Series</title><style>body{margin:0;background:#000}.outer{margin:80px;transform:translateY(35px)}#player{position:relative;width:640px;height:360px}video{position:absolute;left:40px;top:100px;width:480px;height:270px;object-fit:cover}</style><div class="outer"><div id="player"><video controls loop src="https://media-fixture.test/video.mp4"></video></div></div>',{headers:{'Content-Type':'text/html'}});
   });
  };
  install(session.defaultSession);
  for(const partition of ['persist:src-fallback-one-test','persist:src-fallback-two-test','persist:src-disabled-source-test'])install(session.fromPartition(partition));
  app.on('session-created',ses=>{install(ses);globalThis.fixturePrivateSessions.push(ses);});
 },{data,clip});
 const page=await app.firstWindow();await page.setViewportSize({width:1560,height:1000});
 page.on('pageerror',e=>errors.push(e.message));await page.waitForSelector('.app');
 if(await page.locator('.release-dialog[open]').count())await page.getByRole('button',{name:'Got it',exact:true}).click();
 return page;
}
const invoke=(page,method,input)=>page.evaluate(({method,input})=>window.aniverse.invoke(method,input),{method,input});
const go=async(page,url)=>{await page.evaluate(h=>location.hash=h,url);};
const ready=async (page,privateExpected=null)=>{
 const deadline=Date.now()+45000;
 while(Date.now()<deadline){
  const id=await page.evaluate(expected=>{const view=document.querySelector('webview');if(!view||document.querySelector('.screen .cat-loader'))return null;if(expected!==null&&view.getAttribute('partition').startsWith('persist:')===expected)return null;try{return view.getWebContentsId();}catch{return null;}},privateExpected);
  if(id&&await app.evaluate(async({webContents},id)=>{const guest=webContents.fromId(id);return !!guest&&!guest.isDestroyed()&&await guest.executeJavaScript('!!document.querySelector("video")&&document.querySelector("video").readyState>=2&&!!document.querySelector("[data-aniverse-player]")').catch(()=>false);},id))return id;
  await page.waitForTimeout(150);
 }
 throw Error('Ready source guest timed out');
};
try{
 let page=await setup();
 await go(page,'#/settings/themes');await page.getByText('Diwali × Halloween',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.dataset.accent),'festival');
 await page.screenshot({path:path.join(artifacts,'sources-privacy-festival-settings.png')});check('Seasonal palette applied automatically and has an explicit opt-out');
 await go(page,'#/watch/7/1?source=fallback-one-test');
 await page.waitForFunction(()=>location.hash.includes('source=fallback-two-test'),{},{timeout:45000});
 let guest=await ready(page);
 const bounds=await app.evaluate(async({webContents},id)=>webContents.fromId(id).executeJavaScript('(()=>{const r=document.querySelector("video").getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,vw:innerWidth,vh:innerHeight};})()'),guest);
 assert.ok(Math.abs(bounds.x)<1&&Math.abs(bounds.y)<1&&Math.abs(bounds.w-bounds.vw)<1&&Math.abs(bounds.h-bounds.vh)<1);
 assert.equal((await app.evaluate(()=>globalThis.fixtureHits))['disabled-source.test'],undefined);
 await page.screenshot({path:path.join(artifacts,'sources-privacy-episode-cards.png')});check('Missing first source automatically opens the episode on the archive source with corrected normal-player bounds',bounds);
 const oldURL=await app.evaluate(({webContents},id)=>webContents.fromId(id).getURL(),guest);
 await app.evaluate(async({webContents},id)=>webContents.fromId(id).executeJavaScript('window.open("https://fallback-two.test/advert","_blank");window.open("https://advert.test","_blank");'),guest);
 await page.waitForTimeout(500);
 assert.equal(await app.evaluate(({webContents},id)=>webContents.fromId(id).getURL(),guest),oldURL);
 assert.ok(Object.values((await invoke(page,'adblock.stats')).popupsBlocked).reduce((a,b)=>a+b,0)>=2);check('Same-site and external popups cannot replace the episode');
 await app.evaluate(()=>{globalThis.fixtureUnavailable.add('fallback-two.test');});
 await page.locator('.source-btn').filter({hasText:'First source'}).click();
 await page.getByText('No enabled source could open this episode',{exact:true}).waitFor({timeout:45000});
 const exhausted=await app.evaluate(()=>({...globalThis.fixtureHits}));await page.waitForTimeout(1200);
 assert.deepEqual(await app.evaluate(()=>globalThis.fixtureHits),exhausted);
 await app.evaluate(()=>{globalThis.fixtureUnavailable.delete('fallback-two.test');});
 await page.getByRole('button',{name:'Retry sources',exact:true}).click();
 guest=await ready(page);await page.waitForFunction(()=>location.hash.includes('fallback-two-test'));check('Fallback exhausts each enabled source once and recovers through Retry sources');
 await app.evaluate(async({webContents},id)=>webContents.fromId(id).session.cookies.set({url:'https://fallback-two.test',name:'normal-marker',value:'public'}),guest);
 await page.getByRole('button',{name:'Start incognito',exact:true}).click();await page.getByRole('button',{name:'Exit incognito',exact:true}).waitFor();guest=await ready(page,true);
 const privateState=await app.evaluate(async({webContents},id)=>{const ses=webContents.fromId(id).session;globalThis.fixtureActivePrivate=ses;return {persistent:ses.isPersistent(),cookies:await ses.cookies.get({})};},guest);
 assert.equal(privateState.persistent,false);assert.equal(privateState.cookies.some(c=>c.name==='normal-marker'),false);
 await app.evaluate(async()=>globalThis.fixtureActivePrivate.cookies.set({url:'https://fallback-two.test',name:'private-marker',value:'temporary'}));
 await invoke(page,'library.saveProgress',{media,episode:2,position:80,duration:100,sourceId:'fallback-two-test'});
 assert.equal((await invoke(page,'library.state',{mediaId:7})).progress.some(p=>p.episode===2),false);
 await page.getByRole('button',{name:'Exit incognito',exact:true}).click();
 await page.waitForFunction(()=>!location.hash.includes('/watch/'));
 assert.equal((await app.evaluate(async()=>globalThis.fixtureActivePrivate.cookies.get({}))).length,0);check('Incognito isolates and clears website cookies and prevents new playback records');
 await go(page,'#/watch/7/1?source=fallback-two-test');guest=await ready(page);
 assert.ok(await app.evaluate(async({webContents},id)=>(await webContents.fromId(id).session.cookies.get({name:'normal-marker'})).length===1,guest));
 await page.getByRole('button',{name:'Keep title private',exact:true}).click();await page.waitForSelector('.privacy-banner');guest=await ready(page,true);
 assert.ok((await invoke(page,'privacy.state')).privateMediaIds.includes(7));
 assert.equal(await app.evaluate(({webContents},id)=>webContents.fromId(id).session.isPersistent(),guest),false);
 await app.evaluate(async({webContents},id)=>{globalThis.fixtureActivePrivate=webContents.fromId(id).session;await globalThis.fixtureActivePrivate.cookies.set({url:'https://fallback-two.test',name:'title-private-marker',value:'temporary'});},guest);
 await go(page,'#/settings/themes');await page.getByText('Diwali × Halloween',{exact:true}).waitFor();await page.waitForTimeout(400);
 assert.equal((await app.evaluate(async()=>globalThis.fixtureActivePrivate.cookies.get({}))).length,0);
 await go(page,'#/watch/7/1?source=fallback-two-test');guest=await ready(page);
 assert.equal((await app.evaluate(async({webContents},id)=>webContents.fromId(id).session.cookies.get({}),guest)).length,0);check('Private-title sessions are released on leaving and revisiting creates a fresh valid session');
 await app.close();app=null;page=await setup();
 const persisted=await invoke(page,'privacy.state');assert.equal(persisted.incognito,false);assert.ok(persisted.privateMediaIds.includes(7));
 await go(page,'#/watch/7/1?source=fallback-two-test');guest=await ready(page);
 assert.equal(await app.evaluate(({webContents},id)=>webContents.fromId(id).session.isPersistent(),guest),false);check('Permanent title privacy survives restart; temporary incognito does not');
 await go(page,'#/settings/privacy');await page.getByRole('button',{name:'Update filters',exact:true}).waitFor();check('Manual filter refresh is visible in privacy settings');
 assert.deepEqual(errors,[]);
}catch(error){results.push({name:'integration',passed:false,error:error.stack});console.error(error);if(app)try{await (await app.firstWindow()).screenshot({path:path.join(artifacts,'sources-privacy-failure.png')});}catch{};process.exitCode=1;}
finally{if(app)await app.close();writeFileSync(path.join(artifacts,'sources-privacy.json'),JSON.stringify({passed:results.every(r=>r.passed),packaged:!!process.env.E2E_EXE,results,errors,run},null,2)+'\n');}
