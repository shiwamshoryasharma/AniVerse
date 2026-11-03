// DOM contract regression: no network/source URL is used by these markup-only cases.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {_electron} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),cache=path.join(root,'test/cache/search-visibility');mkdirSync(cache,{recursive:true});
const run=mkdtempSync(path.join(cache,'run-'));mkdirSync(path.join(root,'test/artifacts'),{recursive:true});
const runtime=path.join(run,'page.cjs');await build({entryPoints:[path.join(root,'electron/sitePage.ts')],outfile:runtime,bundle:true,platform:'node',format:'cjs',logLevel:'warning'});
const {pageScript}=createRequire(import.meta.url)(runtime);
const entry=path.join(run,'main.cjs');writeFileSync(entry,`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(run,'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadURL('about:blank');});`);
const app=await _electron.launch({args:[entry],env:{...process.env,TEMP:run,TMP:run,TMPDIR:run},timeout:60000});const page=await app.firstWindow(),checks=[];
async function test(name,html,verify){try{await page.setContent(html);await verify();checks.push({name,passed:true});console.log('[PASS] '+name);}catch(error){checks.push({name,passed:false,error:String(error)});console.log('[FAIL] '+name+': '+error.message);}}
const invoke=op=>page.evaluate(script=>(0,eval)(script),pageScript(op));
try{
 await test('Hidden music search cannot capture anime queries','<input id="music-search" style="visibility:hidden;width:400px;height:40px" placeholder="Song, artist or anime…"><input id="anime-query" type="search" placeholder="Search anime…" style="width:400px;height:40px">',async()=>{assert.equal((await invoke({op:'openSearch',attempt:-1})).input,true);await invoke({op:'fillSearch',query:'Cowboy Bebop'});assert.equal(await page.locator('#anime-query').inputValue(),'Cowboy Bebop');assert.equal(await page.locator('input').first().inputValue(),'');});
 await test('Offscreen unrelated search cannot capture the header query','<input style="position:absolute;top:2500px;width:400px;height:40px" placeholder="Find music"><input id="anime-query" type="search" placeholder="Search anime…" style="width:400px;height:40px">',async()=>{await invoke({op:'fillSearch',query:'Cowboy Bebop'});assert.equal(await page.locator('#anime-query').inputValue(),'Cowboy Bebop');});
 await test('Search waits for an actual visible editable field','<div style="opacity:0"><input type="search" placeholder="Search anime…" style="width:400px;height:40px"></div>',async()=>{assert.equal((await invoke({op:'openSearch',attempt:-1})).input,false);assert.equal((await invoke({op:'fillSearch',query:'Cowboy Bebop'})).ok,false);});
 await test('Transparent original media stays locatable for desktop overlays','<video style="width:960px;height:540px;opacity:0"></video>',async()=>{assert.equal((await invoke({op:'markPlayer',keep:false})).found,true);});
 await test('Offscreen episode controls remain discoverable','<button data-episode="37" style="position:absolute;top:2500px;width:100px;height:40px">Episode 37</button>',async()=>{const result=await invoke({op:'findEpisode',episode:37,slug:null});assert.ok(result?.pick,'Rendered offscreen episode must stay selectable');});
}finally{await app.close();const report={passed:checks.every(row=>row.passed),checks,run,networkRequests:0};writeFileSync(path.join(root,'test/artifacts/search-visibility.json'),JSON.stringify(report,null,2)+'\n');if(!report.passed)process.exitCode=1;}
