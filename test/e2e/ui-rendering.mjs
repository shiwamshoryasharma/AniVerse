// Window-composition regression: all profiles, preferences, screenshots and temp data stay under test/.
import assert from 'node:assert/strict';
import { _electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync,mkdtempSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),cache=path.join(root,'test/cache/ui-rendering');
mkdirSync(cache,{recursive:true});const run=mkdtempSync(path.join(cache,'run-')),temporary=path.join(run,'temp'),config=path.join(run,'config');
for(const folder of [temporary,config])mkdirSync(folder);
writeFileSync(path.join(config,'streaming-sites.txt'),'https://render-fixture.test\n');
writeFileSync(path.join(config,'filters.txt'),'! Rendering fixture\n');
const scale=process.env.E2E_DEVICE_SCALE_FACTOR;
if(scale&&!['1','1.25','1.5','2'].includes(scale))throw new Error('Unsupported test pixel ratio');
const suffix=scale??'system',reports=[],errors=[];
let app;
const launch=()=>_electron.launch({executablePath:process.env.E2E_EXE?path.resolve(root,process.env.E2E_EXE):createRequire(import.meta.url)('electron'),
 args:[...(process.env.E2E_EXE?[]:[root]),...(scale?['--force-device-scale-factor='+scale]:[])],cwd:root,
 env:{...process.env,ANIVERSE_HEADLESS:'1',ANIVERSE_DATA_DIR:path.join(run,'profile'),ANIVERSE_CONFIG_DIR:config,TEMP:temporary,TMP:temporary,TMPDIR:temporary}});
async function inspect(page,label){
 const data=await page.evaluate(()=>({dpr:devicePixelRatio,width:innerWidth,height:innerHeight,zoom:getComputedStyle(document.body).zoom,
  filters:[...document.querySelectorAll('*')].filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width&&r.height&&s.display!=='none'&&s.visibility!=='hidden'&&s.backdropFilter!=='none';}).map(e=>({tag:e.tagName,class:String(e.className),filter:getComputedStyle(e).backdropFilter})),
  backdrops:[...document.querySelectorAll('dialog[open]')].map(e=>({class:e.className,filter:getComputedStyle(e,'::backdrop').backdropFilter}))}));
 assert.deepEqual(data.filters,[],label+': active interface surfaces must not blur');
 assert.ok(data.backdrops.every(b=>b.filter==='none'),label+': modal must not blur the entire app');
 if(scale)assert.equal(data.dpr,Number(scale));
 reports.push({name:label,passed:true,...data});return data;
}
async function verifyGpu(page,mode){
 const webgl=await page.evaluate(()=>{
  const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;
  const gl=canvas.getContext('webgl');if(!gl)return {available:false};
  gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.finish();
  const pixels=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  const extension=gl.getExtension('WEBGL_debug_renderer_info'),renderer=extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
  return {available:true,renderer,pixels:[...pixels],lost:gl.isContextLost(),error:gl.getError(),width:gl.drawingBufferWidth,height:gl.drawingBufferHeight};
 });
 const features=await app.evaluate(({app})=>app.getGPUFeatureStatus());
 const info=await page.evaluate(()=>window.aniverse.invoke('app.info'));
 assert.equal(info.graphics.uiRendering.active,mode);
 assert.equal(info.graphics.uiRendering.restartRequired,false);
 assert.equal(features.gpu_compositing,mode==='stable'?'disabled_software':'enabled');
 console.log(JSON.stringify({mode,webgl,compositing:features.gpu_compositing}));
 assert.equal(webgl.available,true);assert.deepEqual(webgl.pixels,[255,0,0,255]);
 assert.ok(!/swiftshader|llvmpipe|software/i.test(webgl.renderer),'WebGL must retain the real GPU');
 assert.match(features.video_decode,/^enabled/);assert.match(features.video_encode,/^enabled/);
 reports.push({name:mode+' UI retains GPU WebGL and video codecs',passed:true,webgl,features});
}
try{
 for(const [index,mode] of ['stable','accelerated','stable'].entries()){
  app=await launch();const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.waitForSelector('.app');
  if(index===0){await page.waitForSelector('.release-dialog[open]');await inspect(page,'release dialog');await page.screenshot({path:path.join(root,'test/artifacts/ui-rendering-'+suffix+'-release.png')});await page.getByRole('button',{name:'Got it',exact:true}).click();}
  await page.evaluate(()=>location.hash='#/settings/graphics');await page.waitForSelector('.gpu-rendering');
  await page.evaluate(()=>document.fonts.ready);
  const baseline=await inspect(page,mode+' baseline');
  await verifyGpu(page,mode);
  if(index===0){
   for(let n=0;n<12;n++){
    await app.evaluate(({BrowserWindow},i)=>BrowserWindow.getAllWindows()[0].setSize(i%2?1440:1281,i%2?900:801),n);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const current=await inspect(page,'resize '+n);assert.equal(current.dpr,baseline.dpr);assert.equal(current.zoom,baseline.zoom);
   }
   await page.evaluate(()=>{const element=document.createElement('div');element.className='modal-backdrop';element.id='rendering-style-probe';document.body.append(element);});
   await inspect(page,'shared modal backdrop');await page.evaluate(()=>document.querySelector('#rendering-style-probe').remove());
   await page.screenshot({path:path.join(root,'test/artifacts/ui-rendering-'+suffix+'-settings.png')});
  }
  if(index<2){
   await page.getByLabel('Interface rendering',{exact:true}).click();
   await page.getByRole('option',{name:index===0?'Accelerated UI':'Stable UI · recommended',exact:true}).click();
   await page.getByRole('button',{name:'Restart AniVerse',exact:true}).waitFor();
   const pending=await page.evaluate(()=>window.aniverse.invoke('app.info'));
   assert.deepEqual(pending.graphics.uiRendering,{active:mode,preferred:index===0?'accelerated':'stable',restartRequired:true});
   reports.push({name:'Mode persists and waits for restart: '+mode,passed:true});
  }
  await app.close();app=null;
 }
 assert.deepEqual(errors,[]);
}finally{
 await app?.close();
 writeFileSync(path.join(root,'test/artifacts/ui-rendering-'+suffix+'.json'),JSON.stringify({packaged:!!process.env.E2E_EXE,reports,errors},null,2)+'\n');
}
console.log(JSON.stringify({passed:true,pixelRatio:suffix,checks:reports.length,errors}));
