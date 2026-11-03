// History redesign regression through the real isolated Electron renderer/main/store.
// Run npm run build first. No live source, provider account or installed profile is used.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {_electron} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const artifacts=path.join(root,'test/artifacts'),cache=path.join(root,'test/cache/history-ui');
mkdirSync(cache,{recursive:true});mkdirSync(artifacts,{recursive:true});
const run=mkdtempSync(path.join(cache,'run-'));
const profile=path.join(run,'profile'),config=path.join(run,'config'),temp=path.join(run,'temp');
for(const directory of [profile,config,temp])mkdirSync(directory,{recursive:true});
writeFileSync(path.join(config,'streaming-sites.txt'),'https://history-fixture.test\n');
writeFileSync(path.join(config,'filters.txt'),'! neutral local test\n');
await build({stdin:{contents:"export {Store} from './app/core/db/store';export {AniListClient} from './app/core/metadata/anilist';",resolveDir:root},outfile:path.join(run,'seed.cjs'),bundle:true,platform:'node',format:'cjs',external:['node:sqlite'],logLevel:'warning'});
const {Store,AniListClient}=createRequire(import.meta.url)(path.join(run,'seed.cjs'));
const db=new Store(path.join(profile,'aniverse.db'));
const title=(id,name)=>({id,idMal:null,title:{english:name,romaji:name,native:null,userPreferred:name},type:'ANIME',synonyms:[],coverImage:{extraLarge:'https://history-assets.test/poster-'+id+'.svg',large:'https://history-assets.test/poster-'+id+'.svg',color:'#7c5faf'},bannerImage:null,format:'TV',status:'FINISHED',episodes:12,duration:24,averageScore:82,season:'FALL',seasonYear:2024,genres:['Adventure'],isAdult:false,nextAiringEpisode:null,startDate:{year:2024,month:10,day:1},description:'Neutral history fixture.',streamingEpisodes:[],externalLinks:[],relations:{edges:[]},recommendations:{nodes:[]},characters:{edges:[]},studios:{nodes:[]},tags:[]});
const titles=[title(7,'Arcadia Story'),title(8,'Clockwork Road'),title(9,'Local Journey')];
const data={Media:titles[0],Page:{media:titles,pageInfo:{currentPage:1,total:3,hasNextPage:false},airingSchedules:[]},trending:{media:titles},spotlight:{media:[]},popularSeason:{media:[]},upcoming:{media:[]},topRated:{media:[]},recent:{airingSchedules:[]}};
const client=new AniListClient(async()=>new Response(JSON.stringify({data})),db,{showAdult:()=>false,token:()=>null});
await client.home();await client.latest();await client.details(7);
const snapshot=raw=>({id:raw.id,idMal:null,title:raw.title.english,cover:raw.coverImage.large,banner:null,format:'TV',episodes:12});
const now=Math.floor(Date.now()/1000),specs=[{media:snapshot(titles[0]),episode:2,position:1080,duration:1440,sourceId:'history-fixture-test',watchedAt:now-120},{media:snapshot(titles[0]),episode:1,position:1440,duration:1440,sourceId:'history-fixture-test',watchedAt:now-420},{media:snapshot(titles[1]),episode:3,position:120,duration:600,sourceId:'history-fixture-test',watchedAt:now-87000},{media:snapshot(titles[2]),episode:1,position:0,duration:0,sourceId:null,watchedAt:now-180000}];
for(const {watchedAt,...save}of specs){db.saveProgress(save,.9);db.db.prepare('UPDATE history SET watched_at=? WHERE media_id=? AND episode=?').run(watchedAt,save.media.id,save.episode);}
db.patchSourceOverride('history-fixture-test',{name:'Fixture library'});
db.setKv('settings',{privacy:{adblock:false,blockPopups:true},updates:{autoCheck:false,autoDownload:false},player:{autoplay:false},appearance:{spoilerShield:false}});
const seeded=db.listHistory(200,0);db.close();
let app,page;const checks=[],errors=[],pageErrors=[];
const test=async(name,body)=>{try{await body();checks.push({name,passed:true});console.log('[PASS] '+name);}catch(error){checks.push({name,passed:false,error:String(error.stack||error)});errors.push(name+': '+error.message);console.error('[FAIL] '+name+': '+error.message);await page?.screenshot({path:path.join(artifacts,'history-ui-failure-'+checks.length+'.png')}).catch(()=>{});}};
const entries=()=>page.locator('.history-entry');
const view=name=>page.getByRole('button',{name,exact:true});
const selected=async name=>{await view(name).click();await page.waitForFunction(name=>document.querySelector('.history-results')?.getAttribute('data-view')===name.toLowerCase(),name);assert.equal(await view(name).getAttribute('aria-pressed'),'true');};
const go=async()=>{await page.evaluate(()=>location.hash='#/history');await page.getByRole('heading',{name:'Watch history',exact:true}).waitFor();};
const query=()=>page.getByRole('textbox',{name:'Search history',exact:true});
const rpc=(method,input)=>page.evaluate(({method,input})=>window.aniverse.invoke(method,input),{method,input});
try{
 app=await _electron.launch({args:[root],cwd:root,env:{...process.env,ANIVERSE_HEADLESS:'1',ANIVERSE_DATA_DIR:profile,ANIVERSE_CONFIG_DIR:config,TEMP:temp,TMP:temp,TMPDIR:temp},timeout:60000});
 await app.evaluate(({app,session},data)=>{
  const install=ses=>ses.protocol.handle('https',request=>{
   const url=new URL(request.url);
   if(url.hostname==='graphql.anilist.co')return new Response(JSON.stringify({data}),{headers:{'Content-Type':'application/json'}});
   if(url.hostname==='history-assets.test')return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="340"><rect width="240" height="340" fill="#302342"/><circle cx="120" cy="130" r="65" fill="#9b6a35"/><path d="M30 280L120 170L210 280Z" fill="#7355a3"/></svg>',{headers:{'Content-Type':'image/svg+xml'}});
   if(url.hostname==='history-fixture.test')return new Response('<!doctype html><title>Fixture library</title><form action="/search"><input name="q" type="search"></form><a href="/anime/arcadia-story">Arcadia Story</a>',{headers:{'Content-Type':'text/html'}});
   return new Response('',{status:404});
  });
  install(session.defaultSession);install(session.fromPartition('persist:src-history-fixture-test'));app.on('session-created',install);
 },data);
 page=await app.firstWindow();page.setDefaultTimeout(3500);page.on('pageerror',error=>pageErrors.push(error.message));await page.setViewportSize({width:1440,height:1000});await page.waitForSelector('.app');
 if(await page.locator('.release-dialog[open]').count())await page.getByRole('button',{name:'Got it',exact:true}).click();
 await go();
 await test('History exposes accessible Grid and List choices',async()=>{
  for(const name of ['Grid','List'])assert.equal(await view(name).count(),1,name+' view must be available');
  assert.equal(await page.locator('.history-page').count(),1);
  const pressed=await Promise.all(['Grid','List'].map(name=>view(name).getAttribute('aria-pressed')));assert.equal(pressed.filter(value=>value==='true').length,1);
 });
 await test('Grid places comfortable history cards in columns',async()=>{
  await selected('Grid');assert.equal(await entries().count(),4);
  const [one,two]=await Promise.all([entries().nth(0).boundingBox(),entries().nth(1).boundingBox()]);assert.ok(one&&two&&two.x>one.x+one.width-3,'Two cards must fit side by side');assert.ok(Math.abs(one.y-two.y)<3,'First two cards must share a grid row');
  await page.screenshot({path:path.join(artifacts,'history-ui-grid.png')});
 });
 await test('List uses full rows and restores after reload',async()=>{
  await selected('List');assert.equal(await entries().count(),4);
  const [one,two]=await Promise.all([entries().nth(0).boundingBox(),entries().nth(1).boundingBox()]);assert.ok(one&&two&&one.width>700&&Math.abs(one.x-two.x)<3&&two.y>=one.y+one.height-3);
  await page.reload();await page.getByRole('heading',{name:'Watch history',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('.history-results')?.dataset.view==='list');assert.equal(await view('List').getAttribute('aria-pressed'),'true');
  await page.screenshot({path:path.join(artifacts,'history-ui-list.png')});
 });
 await test('Grid preference also survives reload',async()=>{
  await selected('Grid');await page.reload();await page.getByRole('heading',{name:'Watch history',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('.history-results')?.dataset.view==='grid');assert.equal(await view('Grid').getAttribute('aria-pressed'),'true');
 });
 await test('History searches titles without case sensitivity and recovers from no match',async()=>{
  await query().fill('cLoCkWoRk');await page.waitForFunction(()=>document.querySelectorAll('.history-entry').length===1);assert.match(await entries().first().innerText(),/Clockwork Road/);
  await query().fill('not-a-real-fixture-title');await page.waitForFunction(()=>document.querySelectorAll('.history-entry').length===0);assert.equal((await rpc('library.history',{limit:200,offset:0})).length,4,'Filtering must not delete history');
  await query().fill('');await page.waitForFunction(()=>document.querySelectorAll('.history-entry').length===4);
 });
 await test('Entries show accessible bounded progress, dates and friendly source names',async()=>{
  const first=page.locator('[data-history-id="'+seeded[0].id+'"]');assert.equal(await first.count(),1);await first.scrollIntoViewIfNeeded();await page.waitForFunction(element=>element?.innerText.includes('Episode 2'),await first.elementHandle());assert.match(await first.innerText(),/Episode\s*2/i);assert.match(await first.innerText(),/Fixture library/);assert.doesNotMatch(await first.innerText(),/history-fixture-test/);
  const progress=first.getByRole('progressbar');assert.equal(await progress.count(),1);assert.equal(Number(await progress.getAttribute('aria-valuenow')),75);
  const date=first.locator('time[datetime]');assert.ok(await date.count());assert.ok(Number.isFinite(Date.parse(await date.first().getAttribute('datetime'))));
  const unknown=page.locator('[data-history-id="'+seeded[3].id+'"]');await unknown.scrollIntoViewIfNeeded();await page.waitForFunction(element=>element?.innerText.includes('Local Journey'),await unknown.elementHandle());assert.doesNotMatch(await unknown.innerText(),/NaN|Infinity|undefined/);for(const value of await page.getByRole('progressbar').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-valuenow')).filter(value=>value!==null))){assert.ok(Number(value)>=0&&Number(value)<=100);}
 });
 await test('Play retains the exact title episode and source route',async()=>{
  const first=page.locator('[data-history-id="'+seeded[0].id+'"]');await first.getByRole('link',{name:/^(Play|Resume)$/i}).or(first.getByRole('button',{name:/^(Play|Resume)$/i})).first().click();
  await page.waitForFunction(()=>location.hash.startsWith('#/watch/7/2'));const route=await page.evaluate(()=>location.hash);assert.equal(new URLSearchParams(route.split('?')[1]).get('source'),'history-fixture-test');await go();
 });
 await test('Removing one history item preserves the other episode and records',async()=>{
  const remove=page.locator('[data-history-id="'+seeded[1].id+'"]');await remove.getByRole('button',{name:'Remove from history',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.history-entry').length===3);
  const remaining=await rpc('library.history',{limit:200,offset:0});assert.equal(remaining.length,3);assert.ok(remaining.some(row=>row.id===seeded[0].id));assert.ok(!remaining.some(row=>row.id===seeded[1].id));
 });
 await test('Clear history requires confirmation and Cancel preserves every entry',async()=>{
  await page.getByRole('button',{name:'Clear history',exact:true}).click();const dialog=page.getByRole('dialog',{name:/clear history/i});await dialog.waitFor();assert.equal((await rpc('library.history',{limit:200,offset:0})).length,3);await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(await entries().count(),3);
 });
 await test('Confirmed clear removes history and presents an empty state',async()=>{
  await page.getByRole('button',{name:'Clear history',exact:true}).click();const dialog=page.getByRole('dialog',{name:/clear history/i});await dialog.waitFor();await dialog.getByRole('button',{name:'Clear history',exact:true}).click();await dialog.waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelectorAll('.history-entry').length===0);assert.equal((await rpc('library.history',{limit:200,offset:0})).length,0);assert.equal(await page.getByRole('button',{name:'Clear history',exact:true}).count(),0);const empty=page.locator('.history-page .state');assert.equal(await empty.count(),1);assert.equal(await empty.isVisible(),true);assert.ok((await empty.getByRole('heading').innerText()).trim().length>0);
 });
 assert.deepEqual(pageErrors,[]);
}catch(error){errors.push(String(error.stack||error));console.error(error);}
finally{
 if(app)await app.close();
 const report={passed:!errors.length,checks,errors,pageErrors,run,scope:'Hidden development Electron, real SQLite and trusted IPC; neutral metadata/source/poster fixtures only. No remote website/account/device or installed profile touched.'};
 writeFileSync(path.join(artifacts,'history-ui.json'),JSON.stringify(report,null,2)+'\n');
 if(errors.length)process.exitCode=1;
}
