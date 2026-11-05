
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),cache=path.join(root,'test/cache/playback-observer');
mkdirSync(cache,{recursive:true});const run=mkdtempSync(path.join(cache,'run-')),observer=readFileSync(path.join(root,'android/app/src/main/assets/playback-observer.js'),'utf8');
const prefix='fixture-private-media:',reports=new Map();
const clip=readFileSync(path.join(root,'test/cache/release-1.5.2-ui/sintel-trailer.mp4')),checks=[];
let app;
const mediaServer=createServer((req,res)=>{if(req.url.endsWith('.mp4')){res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':clip.length});res.end(clip);}else{res.writeHead(200,{'Content-Type':'text/html'});res.end('<video autoplay muted loop playsinline style="width:640px;height:360px" src="/'+(req.url.includes('ad')?'advert':'episode')+'.mp4"></video>');}});
const rootServer=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<iframe sandbox="allow-scripts" id="owned" data-aniverse-player src="http://127.0.0.1:'+mediaServer.address().port+'/player" style="width:660px;height:390px"></iframe><iframe id="advert" src="http://127.0.0.1:'+mediaServer.address().port+'/ad" style="width:660px;height:390px"></iframe>');});
async function check(name,work){try{const actual=await work();checks.push({name,passed:true,actual});console.log('[PASS] '+name);}catch(error){checks.push({name,passed:false,error:String(error.stack||error)});console.log('[FAIL] '+name+': '+error.message);}}
try{
 await new Promise(r=>mediaServer.listen(0,'127.0.0.1',r));await new Promise(r=>rootServer.listen(0,'127.0.0.1',r));
 const entry=path.join(run,'main.cjs');writeFileSync(entry,"const {app,BrowserWindow}=require('electron');app.setPath('userData',"+JSON.stringify(path.join(run,'profile'))+");app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1500,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,autoplayPolicy:'no-user-gesture-required'}});w.loadURL('about:blank');});");
 app=await _electron.launch({args:[entry],env:{...process.env,TEMP:run,TMP:run,TMPDIR:run},timeout:60000});const page=await app.firstWindow();
 page.on('console',message=>{const text=message.text();if(text.startsWith(prefix)){try{const report=JSON.parse(text.slice(prefix.length));reports.set(report.id,report);}catch{}}});
 await page.context().addInitScript({content:"window.__ownershipMessages=[];addEventListener('message',event=>{if(event.data?.type==='aniverse-playing-media-v1')window.__ownershipMessages.push(event.data);});"});
 await page.context().addInitScript({content:observer.replace('__ANIVERSE_TELEMETRY_PREFIX__',JSON.stringify(prefix))});await page.goto('http://127.0.0.1:'+rootServer.address().port+'/');
 const rows=async()=>{const ids=await page.evaluate(()=>window.__aniversePlayingMediaV1.read());return ids.map(id=>reports.get(id)).filter(Boolean);};
 async function until(predicate){for(const end=Date.now()+12000;Date.now()<end;){const current=await rows();if(predicate(current))return current;await new Promise(r=>setTimeout(r,100));}throw Error('Private media telemetry did not satisfy condition');}

 await check('Cross-origin selected player reports advancing media without an app bridge',async()=>{
  const active=await until(current=>current.length===1&&current[0].played);
  assert.equal(active.length,1);assert.match(active[0].src,/\/episode.mp4$/);assert.equal(active[0].played,true);
  assert.equal(await page.frames()[1].evaluate(()=>typeof window.AniVerseNative+'|'+typeof window.aniverse),'undefined|undefined');
  return {ownedReports:active.length,played:true,noNativeBridge:true};
 });
 await check('Parent documents receive only opaque IDs, never child media URLs',async()=>{
  const exposure=await page.evaluate(()=>({ids:window.__aniversePlayingMediaV1.read(),messages:window.__ownershipMessages}));
  assert.ok(exposure.ids.length&&exposure.ids.every(id=>typeof id==='string'&&!id.includes('http')));
  assert.ok(exposure.messages.length);
  for(const message of exposure.messages)assert.deepEqual(Object.keys(message.item),['id']);
  assert.ok(!JSON.stringify(exposure).includes('episode.mp4'));
  assert.ok(!JSON.stringify(exposure).includes('resources'));
 });
 await check('Unrelated advertising frame is excluded',async()=>{
  assert.ok(await page.frames()[2].locator('video').evaluate(v=>v.currentTime>0));
  assert.ok((await rows()).every(row=>!row.src.includes('advert')));
 });
 await check('A hidden owned iframe is rejected immediately',async()=>{
  await page.locator('#owned').evaluate(el=>{el.style.display='none';});
  assert.deepEqual(await page.evaluate(()=>window.__aniversePlayingMediaV1.read()),[]);
  await page.locator('#owned').evaluate(el=>{el.style.display='block';});
  await until(current=>current.some(row=>row.played));
 });
 await check('Encrypted-media evidence survives the frame boundary',async()=>{
  await page.frames()[1].locator('video').evaluate(v=>v.dispatchEvent(new Event('encrypted')));
  await until(current=>current.some(row=>row.encrypted));
 });
 await check('Detached owned iframe cannot retain a current report',async()=>{
  await page.locator('#owned').evaluate(el=>el.remove());
  assert.deepEqual(await page.evaluate(()=>window.__aniversePlayingMediaV1.read()),[]);
 });
}finally{
 if(app)await app.close();mediaServer.closeAllConnections();rootServer.closeAllConnections();
 await Promise.all([new Promise(r=>mediaServer.close(r)),new Promise(r=>rootServer.close(r))]);
 const report={passed:checks.every(c=>c.passed),checks,run,scope:'Hidden real Chromium; neutral local cross-origin frames and public fixture video. No emulator, source website or credentials.'};
 writeFileSync(path.join(root,'test/artifacts/playback-observer.json'),JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
}
