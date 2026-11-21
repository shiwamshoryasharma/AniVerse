import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';

const cache=resolve('test/cache/aniverse2');
await mkdir(cache,{recursive:true});
const run=await mkdtemp(join(cache,'rendering-'));
const profile=join(run,'profile');
await mkdir(join(profile,'config'),{recursive:true});
await writeFile(join(profile,'config','streaming-sites.txt'),'https://fixture.test/\n');
await writeFile(join(profile,'graphics.json'),'{"mode":"accelerated"}\n');
const exe=resolve(process.env.ANIVERSE2_TEST_EXE ?? 'test/cache/aniverse2/aniverse2-isolated-test.exe');
const exec=promisify(execFile);
const report={passed:false,checks:{}};

async function launch(stage, check) {
  const socket=createServer().listen(0,'127.0.0.1');
  await once(socket,'listening');
  const port=socket.address().port;
  await new Promise((done,reject)=>socket.close(error=>error?reject(error):done()));
  const data=join(profile,'webview-'+stage);
  const env={...process.env,ANIVERSE2_TEST_PROFILE:profile,WEBVIEW2_USER_DATA_FOLDER:data,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-address=127.0.0.1 --remote-debugging-port='+port,
    TEMP:run,TMP:run,TMPDIR:run,ANIVERSE2_FIXTURE_BROWSER_DATA:data};
  delete env.ANIVERSE_ELECTRON_HANDOFF;
  const child=spawn(exe,[],{windowsHide:true,stdio:'ignore',env});
  let browser, failure;
  child.on('error',error=>{failure=error;});
  const exit=once(child,'exit').catch(()=>undefined);
  try {
    const deadline=Date.now()+20_000;
    while(!browser && Date.now()<deadline) {
      if(failure||child.exitCode!==null) throw failure ?? Error('Fixture process exited.');
      try {browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:500});} catch {await delay(175);}
    }
    assert.ok(browser);
    const context=browser.contexts()[0];
    const page=context.pages()[0] ?? await context.waitForEvent('page');
    await page.waitForURL('https://tauri.localhost/**', {waitUntil:'domcontentloaded',timeout:30000});
    const rpc=(method,input)=>page.evaluate(data=>window.__TAURI__.core.invoke('desktop_rpc',data),{method,input});
    const query=await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',
      resolve('test/e2e/fixtures/aniverse2-rendering-process.ps1')],
      {windowsHide:true,env,timeout:8000});
    const [mode, adapter] = query.stdout.trim().split(/\r?\n/);
    await check(rpc,mode,page,adapter);
  } finally {
    await browser?.close().catch(()=>undefined);
    if(child.pid && child.exitCode===null && child.signalCode===null && child.kill()) await exit;
  }
}

async function webglRenderer(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const gl = canvas.getContext('webgl');
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return renderer;
  });
}

try {
  await launch('initial',async(rpc,mode,_page,adapter)=>{
    assert.equal(mode,'accelerated');
    assert.deepEqual((await rpc('app.info')).uiRendering,{active:'accelerated',preferred:'accelerated',restartRequired:false});
    assert.deepEqual(await rpc('app.setUiRendering',{mode:'stable'}),{active:'accelerated',preferred:'stable',restartRequired:true});
    assert.deepEqual(JSON.parse(await readFile(join(profile,'graphics.json'),'utf8')),{mode:'stable'});
    report.checks.preferencePersistedBeforeRestart=true;
    if (process.env.ANIVERSE2_CHECK_GPU === '1') {
      assert.equal(adapter,'system');
      report.systemRenderer=await webglRenderer(_page);
      assert.deepEqual(await rpc('app.setGpuPreference',{preference:'high-performance'}),
        {applied:'system',preferred:'high-performance',supported:true,restartRequired:true});
      assert.deepEqual(JSON.parse(await readFile(join(profile,'graphics-adapter.json'),'utf8')),
        {preference:'high-performance'});
      report.checks.gpuPreferencePersisted=true;
    }
  });
  await launch('restart',async(rpc,mode,page,adapter)=>{
    assert.equal(mode,'stable','Stable composition flag must reach WebView2.');
    assert.deepEqual((await rpc('app.info')).uiRendering,{active:'stable',preferred:'stable',restartRequired:false});
    report.checks.actualBrowserProcessFlag=true;
    if (process.env.ANIVERSE2_CHECK_GPU === '1') {
      assert.equal(adapter,'high-performance');
      report.dedicatedPreferenceRenderer=await webglRenderer(page);
      assert.deepEqual((await rpc('app.info')).gpuAdapterPreference,
        {applied:'high-performance',preferred:'high-performance',supported:true,restartRequired:false});
      await page.evaluate(()=>{ location.hash='#/settings/graphics'; });
      await page.getByRole('combobox',{name:'Graphics adapter preference'}).waitFor();
      await page.getByRole('tab',{name:'Compatibility video'}).click();
      await page.getByRole('switch',{name:'Enable Anime4K Upscale'}).waitFor();
      await page.getByRole('tab',{name:'Overview'}).click();
      await rpc('app.setGpuPreference',{preference:'power-saving'});
      report.checks.dedicatedPreferenceReachedWebView2=true;
      report.checks.nonRtxCompatibilityControls=true;
    }
    if (process.env.ANIVERSE2_CHECK_RENDER_UI !== '0') {
      await page.evaluate(()=>{ location.hash='#/settings/graphics'; });
      await page.getByRole('heading',{name:'Interface rendering'}).waitFor({timeout:5000});
      await page.getByText('Active: Stable UI.',{exact:false}).waitFor({timeout:5000});
      report.checks.graphicsControlReflectsActiveMode=true;
    }
    assert.deepEqual(await rpc('app.setUiRendering',{mode:'accelerated'}),{active:'stable',preferred:'accelerated',restartRequired:true});
  });
  await launch('roundtrip',async(rpc,mode,_page,adapter)=>{
    assert.equal(mode,'accelerated','The Stable flag must not survive selecting Accelerated.');
    assert.deepEqual((await rpc('app.info')).uiRendering,{active:'accelerated',preferred:'accelerated',restartRequired:false});
    report.checks.acceleratedRoundTrip=true;
    if (process.env.ANIVERSE2_CHECK_GPU === '1') {
      assert.equal(adapter,'power-saving');
      report.powerSavingRenderer=await webglRenderer(_page);
      assert.equal((await rpc('app.info')).gpuAdapterPreference.applied,'power-saving');
      await rpc('app.setGpuPreference',{preference:'system'});
      report.checks.powerSavingPreferenceReachedWebView2=true;
    }
  });
  if (process.env.ANIVERSE2_CHECK_GPU === '1') {
    await launch('system',async(rpc,_mode,_page,adapter)=>{
      assert.equal(adapter,'system');
      assert.equal((await rpc('app.info')).gpuAdapterPreference.applied,'system');
      report.checks.systemPreferenceRestored=true;
    });
  }
  report.passed=true;
} catch(error) {
  report.error=String(error);
  throw error;
} finally {
  await mkdir('test/artifacts',{recursive:true});
  await writeFile('test/artifacts/aniverse2-ui-rendering.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
