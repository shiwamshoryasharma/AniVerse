import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as reserve } from 'node:net';
import { resolve,join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const cache=resolve('test/cache/aniverse2');
await mkdir(cache,{recursive:true});
const run=await mkdtemp(join(cache,'network-adblock-'));
const profile=join(run,'profile');
await mkdir(join(profile,'config'),{recursive:true});
const bound=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;};
let forbiddenHits=0;
const forbidden=createServer((_req,res)=>{forbiddenHits++;res.end('');});
const forbiddenPort=await bound(forbidden);
const hits=new Map();
const source=createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  const phase=url.searchParams.get('phase')??'0';
  const key=phase+url.pathname;
  hits.set(key,(hits.get(key)??0)+1);
  res.setHeader('Cache-Control','no-store');
  if(url.pathname==='/'){
    res.setHeader('content-type','text/html; charset=utf-8');
    res.end('<!doctype html><main><h1>Network filter fixture</h1></main>'+
      '<script src="/fixture-ad.js?phase='+phase+'"></script>'+
      '<script src="/fixture-normal.js?phase='+phase+'"></script>'+
      '<script src="http://127.0.0.1:'+forbiddenPort+'/private-fixture.js?phase='+phase+'"></script>');
  }else{
    res.setHeader('content-type','text/javascript');res.end('void 0;');
  }
});
const origin='http://127.0.0.1:'+await bound(source);
await writeFile(join(profile,'config','streaming-sites.txt'),origin+'/\n');
await writeFile(join(profile,'rust-network-filters.txt'),'[Adblock Plus 2.0]\n! isolated local cache\n/fixture-ad.js$script\n/fixture-normal.js$script\n');
await writeFile(join(profile,'config','filters.txt'),'@@/fixture-normal.js$script\n');
const reserved=reserve();
const port=await bound(reserved);
await new Promise((done,reject)=>reserved.close(error=>error?reject(error):done()));
const env={...process.env,ANIVERSE2_TEST_PROFILE:profile,ANIVERSE2_TEST_SITE_ORIGIN:origin,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-address=127.0.0.1 --remote-debugging-port='+port,
  TEMP:run,TMP:run,TMPDIR:run};
delete env.ANIVERSE_ELECTRON_HANDOFF;
delete env.WEBVIEW2_USER_DATA_FOLDER;
delete env.ANIVERSE2_TEST_FRAME_ORIGIN;
const exe=resolve(process.env.ANIVERSE2_TEST_EXE??'test/cache/aniverse2/aniverse2-isolated-test.exe');
const child=spawn(exe,[],{env,windowsHide:true,stdio:'ignore'});
const exit=once(child,'exit').catch(()=>undefined);
let browser,failure;
child.on('error',error=>{failure=error;});
async function waitFor(check) {
  const timeout=Date.now()+15_000;
  while(Date.now()<timeout){ if(await check()) return; await delay(100); }
  throw Error('The isolated browser did not finish its expected request.');
}
const report={passed:false,checks:{}};
try{
  await waitFor(async()=>{
    if(failure||child.exitCode!==null) throw failure??Error('Fixture app exited.');
    try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:400});}catch{}
    return Boolean(browser);
  });
  const context=browser.contexts()[0];
  const page=context.pages()[0]??await context.waitForEvent('page');
  await page.waitForURL('https://tauri.localhost/**');
  const invoke=(method,input)=>page.evaluate(value=>window.aniverse.invoke(value.method,value.input),{method,input});
  const [configured]=await invoke('sources.list');
  const {webContentsId}=await invoke('site.surface',{action:'attach',sourceId:configured.id,partition:configured.partition,
    bounds:{x:0,y:0,width:800,height:500}});
  await waitFor(async()=>(await invoke('adblock.stats')).ready);
  const inspect=async(phase,ads,securityCount)=>{
    await invoke('site.surface',{action:'navigate',webContentsId,url:origin+'/?phase='+phase});
    await waitFor(async()=>{
      const snapshot=await invoke('adblock.stats');
      return hits.has(phase+'/fixture-normal.js')&&(snapshot.securityBlocked[configured.id]??0)>=securityCount;
    });
    assert.equal(hits.has(phase+'/fixture-ad.js'),ads);
    assert.equal(forbiddenHits,0);
  };
  await inspect('1',false,1);
  const stats=await invoke('adblock.stats');
  assert.equal(stats.blocked[configured.id],1);
  assert.equal(stats.securityBlocked[configured.id],1);
  report.checks.blockedRequestAndAllowedException=true;
  await invoke('sources.update',{id:configured.id,patch:{adblock:false}});
  await inspect('2',true,2);
  report.checks.perSourceOptOutKeepsPrivateNetworkDenied=true;
  await invoke('sources.update',{id:configured.id,patch:{adblock:true}});
  await invoke('settings.set',{privacy:{adblock:false}});
  await inspect('3',true,3);
  assert.equal((await invoke('adblock.stats')).enabled,false);
  report.checks.globalOptOutKeepsPrivateNetworkDenied=true;
  await invoke('site.surface',{action:'detach',webContentsId});
  if (process.env.ANIVERSE2_CHECK_SOURCE_LIFETIME === '1') {
    const attach=()=>invoke('site.surface',{action:'attach',sourceId:configured.id,partition:configured.partition,
      bounds:{x:0,y:0,width:800,height:500}});
    const oldView=await attach();
    await page.evaluate(()=>{location.hash='#/settings/privacy';});
    await page.waitForURL('**/#/settings/privacy');
    await invoke('site.surface',{action:'reload',webContentsId:oldView.webContentsId});
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>typeof window.aniverse?.invoke==='function');
    const stale=await page.evaluate(async webContentsId=>{
      try{await window.aniverse.invoke('site.surface',{action:'reload',webContentsId});return 'still attached';}
      catch(error){return error?.message??String(error);}
    },oldView.webContentsId);
    assert.match(stale,/source page was closed/i);
    const newView=await attach();
    assert.notEqual(newView.webContentsId,oldView.webContentsId);
    await invoke('site.surface',{action:'detach',webContentsId:newView.webContentsId});
    report.checks.fullRendererReloadReclaimsOldSourceView=true;
  }
  if (process.env.ANIVERSE2_CHECK_BLOCKING_REPORT === '1') {
    await page.evaluate(() => { location.hash = '#/settings/privacy'; });
    await page.getByRole('button', {name: 'View report', exact: true}).click();
    const chart=page.getByRole('figure', {name: 'Blocks by source'});
    await chart.waitFor();
    await page.getByText('Filter-list matches such as ads, trackers and promotions.').waitFor();
    const row=page.getByRole('row').filter({has:page.getByRole('rowheader',{name:configured.name,exact:true})});
    await row.waitFor();
    const counts=await row.getByRole('cell').allTextContents();
    assert.equal(counts[0],'1');
    assert.ok(Number(counts[1]) >= 3);
    assert.equal(Number(counts[3]),Number(counts[0])+Number(counts[1])+Number(counts[2]));
    const axis=await chart.locator('.blocking-report-axis span').allTextContents();
    assert.equal(axis.length,5);
    assert.equal(axis[0],'0');
    assert.ok(Number(axis.at(-1))>=Number(counts[3]));
    await page.getByRole('combobox',{name:'Filter report by source'}).click();
    await page.getByRole('option',{name:configured.name}).click();
    await page.getByRole('combobox',{name:'Filter report by category'}).click();
    await page.getByRole('option',{name:'Popups',exact:true}).click();
    assert.equal(await chart.count(),0);
    assert.equal(await page.getByText('No blocks match these filters.').count(),1);
    await page.getByRole('combobox',{name:'Filter report by category'}).click();
    await page.getByRole('option',{name:'Security rules',exact:true}).click();
    await chart.waitFor();
    assert.equal(await row.getByRole('cell').first().textContent(),counts[1]);
    assert.equal(await page.getByRole('columnheader',{name:'Network filters'}).count(),0);
    report.checks.filterableBlockingReport=true;
  }
  if (process.env.ANIVERSE2_CHECK_LAYOUTS === '1') {
    const { checkLayouts } = await import('./fixtures/aniverse2-layouts.mjs');
    await checkLayouts(context, page);
    report.checks.appearanceLayouts=true;
  }
  if (process.env.ANIVERSE2_CHECK_APPEARANCE === '1') {
    const { checkAppearance } = await import('./fixtures/aniverse2-appearance.mjs');
    report.checks.appearance = await checkAppearance(context, page);
  }
  report.passed=true;
}catch(error){
  report.error=String(error);
  throw error;
}finally{
  await mkdir('test/artifacts',{recursive:true});
  await writeFile('test/artifacts/aniverse2-network-adblock-windows.json',JSON.stringify(report,null,2)+'\n');
  await browser?.close().catch(()=>undefined);
  if(child.pid && child.exitCode===null && child.signalCode===null && child.kill())await exit;
  source.close();forbidden.close();
  console.log(JSON.stringify(report,null,2));
}
