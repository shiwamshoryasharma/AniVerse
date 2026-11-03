// Browse filter regressions against the real hidden Electron app. Build before running.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {_electron} from 'playwright-core';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const cache=path.join(root,'test/cache/browse-filters'),artifacts=path.join(root,'test/artifacts');
mkdirSync(cache,{recursive:true});mkdirSync(artifacts,{recursive:true});
const run=mkdtempSync(path.join(cache,'run-'));
const profile=path.join(run,'profile'),config=path.join(run,'config'),temp=path.join(run,'temp');
for(const folder of [profile,config,temp])mkdirSync(folder,{recursive:true});
writeFileSync(path.join(config,'streaming-sites.txt'),'https://browse-fixture.test\n');
writeFileSync(path.join(config,'filters.txt'),'! deterministic local fixture\n');
await build({stdin:{contents:"export {Store} from './app/core/db/store';export {AniListClient} from './app/core/metadata/anilist';",resolveDir:root},outfile:path.join(run,'seed.cjs'),bundle:true,platform:'node',format:'cjs',external:['node:sqlite'],logLevel:'warning'});
const {Store,AniListClient}=createRequire(import.meta.url)(path.join(run,'seed.cjs'));
const raw={id:7,idMal:null,type:'ANIME',title:{english:'Arcadia Story',romaji:'Arcadia Story',native:null,userPreferred:'Arcadia Story'},synonyms:[],coverImage:{extraLarge:'',large:'',color:null},bannerImage:null,format:'TV',status:'FINISHED',episodes:12,duration:24,averageScore:82,season:'FALL',seasonYear:2024,genres:['Action','Fantasy'],isAdult:false,nextAiringEpisode:null,startDate:{year:2024,month:10,day:1},description:'A neutral catalogue fixture.',studios:{nodes:[]},staff:{edges:[]},tags:[]};
const second={...raw,id:8,title:{english:'Clockwork Road',romaji:'Clockwork Road',native:null,userPreferred:'Clockwork Road'},format:'MOVIE',genres:['Mecha','Sci-Fi']};
const data={GenreCollection:['Action','Adventure','Comedy','Drama','Ecchi','Fantasy','Hentai','Mecha','Sci-Fi'],MediaTagCollection:[{name:'Isekai',isAdult:false,category:'Theme'},{name:'Female Harem',isAdult:false,category:'Cast'},{name:'Male Harem',isAdult:false,category:'Cast'},{name:'Adult fixture',isAdult:true,category:'Sexual content'}],Page:{pageInfo:{currentPage:1,total:2,hasNextPage:false},media:[raw,second],airingSchedules:[]},spotlight:{media:[]},trending:{media:[raw,second]},popularSeason:{media:[]},upcoming:{media:[]},topRated:{media:[raw]},recent:{airingSchedules:[]},Media:raw};
const db=new Store(path.join(profile,'aniverse.db'));
const client=new AniListClient(async()=>new Response(JSON.stringify({data})),db,{showAdult:()=>false,token:()=>null});
await client.home();await client.latest();await client.genres();await client.browse({page:1,perPage:30});
db.setKv('settings',{privacy:{adblock:false,blockPopups:true},updates:{autoCheck:false,autoDownload:false},player:{autoplay:false},appearance:{showAdult:false}});
db.patchSourceOverride('browse-fixture-test',{name:'Fixture catalogue'});
db.close();
let app,page;const checks=[],errors=[],pageErrors=[],measurements=[];
const test=async(name,body)=>{
 try{await page.keyboard.press('Escape');await body();checks.push({name,passed:true});console.log('[PASS] '+name);}
 catch(error){checks.push({name,passed:false,error:String(error.stack||error)});errors.push(name+': '+error.message);console.error('[FAIL] '+name+': '+error.message);await page.screenshot({path:path.join(artifacts,'browse-filters-failure-'+checks.length+'.png')}).catch(()=>{});}
};
const go=async(hash)=>{await page.evaluate(hash=>location.hash=hash,hash);await page.getByRole('heading',{name:'Browse anime',exact:true}).waitFor();};
const params=()=>page.evaluate(()=>Object.fromEntries(new URLSearchParams(location.hash.split('?')[1]||'')));
const genre=()=>page.getByRole('combobox',{name:/^genres?$/i});
const theme=()=>page.getByRole('combobox',{name:/theme|tags/i}).first();
const format=()=>page.getByRole('combobox',{name:/^formats?$/i});
const listbox=()=>page.getByRole('listbox').last();
const option=(name)=>listbox().getByRole('option',{name,exact:true});
const checked=async(name)=>{
 const item=option(name);
 // React Router commits filter URL updates asynchronously; wait for the observable state.
 await page.waitForFunction(element=>element?.getAttribute('aria-selected')==='true',await item.elementHandle());
 assert.equal(await item.getAttribute('aria-selected'),'true',name+' must retain its selected state');
 assert.ok(await item.locator('input[type=checkbox], [role=checkbox], .check-box, .select-check, .select-checkbox').count(),name+' must show a checkbox');
};
try{
 app=await _electron.launch({args:[root],cwd:root,env:{...process.env,ANIVERSE_HEADLESS:'1',ANIVERSE_DATA_DIR:profile,ANIVERSE_CONFIG_DIR:config,TEMP:temp,TMP:temp,TMPDIR:temp},timeout:60000});
 await app.evaluate(({app,session},input)=>{
  globalThis.browseFilterRequests=[];
  const install=ses=>ses.protocol.handle('https',async request=>{
   const url=new URL(request.url);
   if(url.hostname==='graphql.anilist.co'){
    const body=await request.json().catch(()=>({}));
    if(body.query?.includes('pageInfo')&&body.variables?.perPage)globalThis.browseFilterRequests.push(body.variables);
    return new Response(JSON.stringify({data:input}),{headers:{'Content-Type':'application/json'}});
   }
   if(url.hostname==='browse-fixture.test'){
    const card=(id,title,sub,dub)=>'<a data-anilist-id="'+id+'" data-sub-count="'+sub+'" data-dub-count="'+dub+'" href="/anime/'+id+'"><img alt=""><h3>'+title+'</h3></a>';
    const cards=card(7,'Arcadia Story',12,11)+card(8,'Clockwork Road',1,0);
    const html='<!doctype html><title>Fixture catalogue</title><main><h1>Catalogue</h1><button data-audio="all" aria-pressed="true">ALL</button><button data-audio="dub">DUB</button><button data-audio="sub">SUB</button><div id="cards">'+cards+'</div></main><script>document.querySelectorAll("[data-audio]").forEach(button=>button.onclick=()=>{document.querySelectorAll("[data-audio]").forEach(node=>node.setAttribute("aria-pressed",String(node===button)));document.getElementById("cards").innerHTML=button.dataset.audio==="dub"?'+JSON.stringify(card(7,'Arcadia Story',12,11))+':'+JSON.stringify(cards)+';});</script>';
    return new Response(html,{headers:{'Content-Type':'text/html'}});
   }
   return new Response('',{status:404});
  });
  install(session.defaultSession);install(session.fromPartition('persist:src-browse-fixture-test'));app.on('session-created',install);
 },data);
 page=await app.firstWindow();page.setDefaultTimeout(4000);await page.setViewportSize({width:1560,height:1000});page.on('pageerror',error=>pageErrors.push(error.message));await page.waitForSelector('.app');
 if(await page.locator('.release-dialog[open]').count())await page.getByRole('button',{name:'Got it',exact:true}).click();
 await go('#/browse');await page.waitForSelector('.mcard');

 await test('Genre dropdown keeps two selections checked without closing',async()=>{
  await go('#/browse');await genre().click();await option('Action').click();
  assert.equal(await genre().getAttribute('aria-expanded'),'true','Selecting one genre must keep the filter open');
  await option('Fantasy').click();await checked('Action');await checked('Fantasy');
  assert.deepEqual((await params()).genres.split(',').sort(),['Action','Fantasy']);
  assert.match(await genre().innerText(),/2/,'Trigger must report the selection count');
 });
 await test('Themes expose Isekai and Harem tags and preserve search while selecting',async()=>{
  await go('#/browse');assert.equal(await theme().count(),1,'Browse must expose a Themes/Tags filter');
  await theme().click();const search=listbox().getByRole('textbox');await search.fill('Isekai');await option('Isekai').click();
  assert.equal(await theme().getAttribute('aria-expanded'),'true');assert.equal(await search.inputValue(),'Isekai');await checked('Isekai');
  assert.equal(await search.evaluate(input=>document.activeElement===input),true,'Selection must preserve filter input focus');
  await search.fill('Harem');await option('Female Harem').click();await checked('Female Harem');
  assert.deepEqual((await params()).tags.split(',').sort(),['Female Harem','Isekai']);
 });
 await test('Existing Ecchi Mecha and Sci-Fi genres remain searchable without exposing adult-only tags',async()=>{
  await go('#/browse');await genre().click();
  for(const name of ['Ecchi','Mecha','Sci-Fi'])assert.equal(await option(name).count(),1,name+' must remain available');
  assert.equal(await option('Hentai').count(),0);
  await page.keyboard.press('Escape');await theme().click();const search=listbox().getByRole('textbox');await search.fill('Adult fixture');assert.equal(await option('Adult fixture').count(),0);
 });
 await test('Format dropdown keeps TV and Movie selected together',async()=>{
  await go('#/browse');await format().click();await option('TV').click();assert.equal(await format().getAttribute('aria-expanded'),'true','Selecting TV must keep Format open');
  await option('Movie').click();await checked('TV');await checked('Movie');assert.deepEqual((await params()).formats.split(',').sort(),['MOVIE','TV']);
 });
 await test('Genre theme and format URL state reaches metadata and survives reload',async()=>{
  await go('#/browse?genres=Action,Fantasy&tags=Isekai,Female%20Harem&formats=TV,MOVIE');
  await page.waitForFunction(()=>document.querySelectorAll('.mcard').length===2);
  await page.waitForTimeout(200);
  const requests=await app.evaluate(()=>globalThis.browseFilterRequests);
  const request=requests.find(request=>request.genre_in?.length===2&&request.format_in?.length===2);
  assert.ok(request,'Combined genre/format query must reach metadata');assert.deepEqual(request.tag_in,['Isekai','Female Harem'],'Theme tags must reach AniList tag_in');
  await page.reload();await page.getByRole('heading',{name:'Browse anime',exact:true}).waitFor();await genre().click();await checked('Action');await checked('Fantasy');
  await page.keyboard.press('Escape');await theme().click();await checked('Isekai');await checked('Female Harem');
  await page.keyboard.press('Escape');await format().click();await checked('TV');await checked('Movie');
  await page.keyboard.press('Escape');await page.screenshot({path:path.join(artifacts,'browse-filters-selected.png')});
 });
 await test('Clear selection and reset remove active filter state',async()=>{
  await go('#/browse?genres=Action,Fantasy&tags=Isekai&formats=TV,MOVIE');await genre().click();await listbox().getByRole('button',{name:/clear/i}).click();
  assert.equal((await params()).genres,undefined);assert.equal((await params()).tags,'Isekai');
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'Reset filters',exact:true}).click();assert.deepEqual(await params(),{});
 });
 await test('Audio dropdown tabs reload and reset retain existing source catalogue behavior',async()=>{
  await go('#/browse');await page.getByRole('combobox',{name:'Audio',exact:true}).click();await page.getByRole('option',{name:'DUB + SUB',exact:true}).click();
  const tabs=page.getByRole('group',{name:'Browse audio availability'});await page.waitForFunction(()=>document.querySelector('[aria-label="Browse audio availability"] [aria-pressed=true]')?.textContent==='DUB');assert.equal(await tabs.getByRole('button',{name:'DUB',exact:true}).getAttribute('aria-pressed'),'true');
  await page.waitForFunction(()=>document.querySelector('.source-catalogue')?.getAttribute('aria-busy')==='false'&&document.querySelectorAll('.source-catalogue .mcard').length===1);
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.source-catalogue .mcard').length===1);
  assert.equal(await page.getByRole('combobox',{name:'Audio',exact:true}).innerText(),'DUB + SUB');
  await tabs.getByRole('button',{name:'SUB',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.source-catalogue .mcard').length===2);
  await page.getByRole('button',{name:'Reset filters',exact:true}).click();await page.waitForFunction(()=>!location.hash.includes('audio=')&&!document.querySelector('.source-catalogue'));assert.deepEqual(await params(),{});
 });
 await test('DUB filter changes avoid unused ALL-grid metadata requests',async()=>{
  await go('#/browse?audio=dub');
  await page.waitForFunction(()=>document.querySelector('.source-catalogue')?.getAttribute('aria-busy')==='false'&&document.querySelectorAll('.source-catalogue .mcard').length===1);
  const before=await app.evaluate(()=>globalThis.browseFilterRequests);
  await page.getByRole('combobox',{name:'Minimum score',exact:true}).click();
  await page.getByRole('option',{name:'8.0+',exact:true}).click();
  await page.waitForFunction(()=>new URLSearchParams(location.hash.split('?')[1]).get('score')==='80');
  await page.waitForFunction(()=>document.querySelector('.source-catalogue')?.getAttribute('aria-busy')==='false'&&document.querySelectorAll('.source-catalogue .mcard').length===1);
  let after=[];
  for(const end=Date.now()+15000;Date.now()<end;){
   after=await app.evaluate(()=>globalThis.browseFilterRequests);
   if(after.slice(before.length).some(variables=>Object.hasOwn(variables,'id_in')&&variables.averageScore_greater===79))break;
   await page.waitForTimeout(50);
  }
  await page.waitForFunction(()=>document.querySelector('.source-catalogue')?.getAttribute('aria-busy')==='false');
  const added=after.slice(before.length);
  const unusedAllGrid=added.filter(variables=>!Object.hasOwn(variables,'id_in'));
  const catalogueResolution=added.filter(variables=>Object.hasOwn(variables,'id_in'));
  measurements.push({name:'DUB score-filter metadata requests',before:before.length,after:after.length,unusedAllGridRequests:unusedAllGrid.length,catalogueResolutionRequests:catalogueResolution.length,variables:added});
  console.log('[METRIC] DUB score filter: '+unusedAllGrid.length+' unused ALL-grid request(s), '+catalogueResolution.length+' catalogue resolution request(s)');
  assert.equal(catalogueResolution.length,1,'The active source catalogue must still resolve its metadata filters');
  assert.equal(unusedAllGrid.length,0,'Changing a DUB filter must not fetch the unused ALL metadata grid');
 });
 assert.deepEqual(pageErrors,[]);
}catch(error){errors.push(String(error.stack||error));console.error(error);}
finally{
 if(app)await app.close();
 const report={passed:!errors.length,checks,errors,pageErrors,measurements,run,notes:['Development Electron with neutral protocol fixtures; no live sites, accounts or physical media devices.','All profiles, test config, scripts, temporary files and evidence stay under test/.']};
 writeFileSync(path.join(artifacts,'browse-filters.json'),JSON.stringify(report,null,2)+'\n');
 if(errors.length)process.exitCode=1;
}
