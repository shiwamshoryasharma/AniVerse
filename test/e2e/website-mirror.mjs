// Real owned-webview video/audio capture and embedded encoding. Receiver transport is controlled.
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,writeFileSync,readFileSync,readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron } from 'playwright-core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const cache=path.join(root,'test/cache/website-mirror');mkdirSync(cache,{recursive:true});
const run=mkdtempSync(path.join(cache,'run-'));mkdirSync(path.join(run,'temp'));
const require=createRequire(import.meta.url);
await build({entryPoints:[path.join(root,'test/e2e/fixtures/mirror-main.ts')],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:path.join(run,'main.cjs'),logLevel:'warning'});
await build({entryPoints:[path.join(root,'frontend/src/lib/websiteMirror.ts')],bundle:true,platform:'browser',format:'iife',globalName:'Mirror',outfile:path.join(run,'renderer.js'),logLevel:'warning'});
writeFileSync(path.join(run,'preload.cjs'),"const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('aniverse',{invoke:async(m,i)=>{if(m.startsWith('fixture.'))return ipcRenderer.invoke('fixture',m,i);const r=await ipcRenderer.invoke('aniverse:rpc',m,i);if(!r.ok)throw new Error(r.error.message);return r.data;}});");
writeFileSync(path.join(run,'host.html'),'<!doctype html><html><body><button id="start">Cast fixture</button><webview partition="persist:src-mirror-fixture" src="https://mirror-fixture.test/player" style="width:960px;height:540px" webpreferences="backgroundThrottling=no"></webview><script src="./renderer.js"></script><script>window.fixtureErrors=[];document.querySelector("webview").addEventListener("dom-ready",()=>window.guestId=document.querySelector("webview").getWebContentsId());document.querySelector("#start").onclick=async()=>{try{const {ticket}=await window.aniverse.invoke("cast.mirrorPrepare",{webContentsId:window.guestId,deviceId:"fixture",title:"Website fixture",upscale:!!window.upscale});window.stopMirror=await Mirror.startWebsiteMirror(ticket,true,e=>fixtureErrors.push(e));}catch(e){fixtureErrors.push(String(e))}};</script></body></html>');
const app=await _electron.launch({executablePath:require('electron'),args:[path.join(run,'main.cjs')],cwd:root,env:{...process.env,MIRROR_RUN:run,MIRROR_ROOT:root,TEMP:path.join(run,'temp'),TMP:path.join(run,'temp')},timeout:60000});
app.process().stdout.on('data',c=>process.stdout.write(c));app.process().stderr.on('data',c=>process.stderr.write(c));
const reports=[];
async function until(fn){const deadline=Date.now()+60000;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,200));}throw new Error('Mirror state timed out');}
try{
 const page=await app.firstWindow();
 await page.waitForFunction(()=>window.guestId>0);
 // Capturing without the main process's single-use grant must fail.
 assert.equal(await page.evaluate(async()=>{try{await navigator.mediaDevices.getDisplayMedia({video:true});return false;}catch{return true;}}),true);
 reports.push({name:'Unarmed capture denied',passed:true});
 assert.equal(await page.evaluate(async()=>{try{await window.aniverse.invoke('cast.mirrorPrepare',{webContentsId:1,deviceId:'fixture',title:'Invalid owner',upscale:false});return false;}catch{return true;}}),true);
 reports.push({name:'Unowned view rejected by main process',passed:true});
 const guest=await app.evaluate(({webContents})=>webContents.getAllWebContents().find(w=>w.getType()==='webview').id);
 await app.evaluate(async({webContents},id)=>{await webContents.fromId(id).executeJavaScript("document.querySelector('video').play()",true);},guest);
 for(const upscale of [false,true]){
  await page.evaluate(v=>window.upscale=v,upscale);
  await page.click('#start');
  await until(()=>page.evaluate(async()=>{const s=await window.aniverse.invoke('fixture.state');if(s.errors.length||fixtureErrors.length)throw new Error(JSON.stringify({s,fixtureErrors}));return !!s.loaded&&s.state.status==='playing';}));
  const state=await page.evaluate(()=>window.aniverse.invoke('fixture.state'));
  assert.ok(state.chunks>0);assert.equal(state.state.processing.live,true);
  assert.equal(await page.evaluate(async()=>{try{const stream=await navigator.mediaDevices.getUserMedia({audio:true,video:true});stream.getTracks().forEach(t=>t.stop());return false;}catch{return true;}}),true);
  const segment=readdirSync(state.folder).filter(f=>/segment-\d+\.m4s$/.test(f)).sort()[0];
  const sample=path.join(run,'capture-'+upscale+'.mp4');
  writeFileSync(sample,Buffer.concat([readFileSync(path.join(state.folder,'init.mp4')),readFileSync(path.join(state.folder,segment))]));
  const tools=process.env.E2E_MEDIA_RESOURCES?path.join(process.env.E2E_MEDIA_RESOURCES,'ffmpeg'):path.join(root,'build/vendor/ffmpeg');
  const {stdout}=await promisify(execFile)(path.join(tools,'ffprobe.exe'),['-v','error','-show_streams','-of','json',sample],{windowsHide:true});
  const streams=JSON.parse(stdout).streams,video=streams.find(s=>s.codec_type==='video'),audio=streams.find(s=>s.codec_type==='audio');
  assert.equal(video.codec_name,upscale?'hevc':'h264');assert.equal(video.width,upscale?3840:1920);assert.equal(audio.codec_name,'aac');
  assert.ok((await fetch(state.loaded.contentId)).ok);
  reports.push({name:upscale?'Website capture encoded in 4K':'Website capture encoded in 1080p',passed:true,codec:video.codec_name,width:video.width,height:video.height,audio:audio.codec_name});
  await page.evaluate(()=>window.stopMirror());
  await until(()=>page.evaluate(async()=>(await window.aniverse.invoke('fixture.state')).state.status==='idle'));
 }
 // A new episode destroys the capture grant and encoder.
 await page.evaluate(()=>{window.upscale=false;window.stopMirror=null;});await page.click('#start');
 await page.waitForFunction(()=>!!window.stopMirror);
 await app.evaluate(async({webContents},id)=>webContents.fromId(id).loadURL('https://mirror-fixture.test/next'),guest);
 await until(()=>page.evaluate(async()=>{const s=await window.aniverse.invoke('fixture.state');return s.state.status==='idle'&&!s.folder;}));
 reports.push({name:'Source navigation stops capture and encoder',passed:true});
 console.log(JSON.stringify(reports,null,2));
}catch(error){
 console.error(await (await app.firstWindow()).evaluate(async()=>({state:await window.aniverse.invoke('fixture.state'),errors:window.fixtureErrors})));
 throw error;
}finally{
 await app.close();writeFileSync(path.join(root,'test/artifacts/release-1.5.3-mirror.json'),JSON.stringify({reports,physicalTVTested:false},null,2)+'\n');
}