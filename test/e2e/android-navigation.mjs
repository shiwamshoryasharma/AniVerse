
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {_electron} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),cache=path.join(root,'test/cache/android-0.4.5-navigation');mkdirSync(cache,{recursive:true});
const run=mkdtempSync(path.join(cache,'fixture-')),runtime=path.join(run,'page.cjs'),checks=[];
await build({entryPoints:[path.join(root,'electron/sitePage.ts')],outfile:runtime,bundle:true,platform:'node',format:'cjs',logLevel:'warning'});
const {pageScript}=createRequire(import.meta.url)(runtime);
const kotlin=readFileSync(path.join(root,'android/app/src/main/java/app/aniverse/tablet/SourceBrowser.kt'),'utf8');
const submit=kotlin.slice(kotlin.indexOf('private fun submitSearch()')).match(/web\.evaluateJavascript\("""([\s\S]*?)"""\.trimIndent\(\)/)?.[1];assert.ok(submit,'Native search submission JavaScript is available');
const entry=path.join(run,'main.cjs');writeFileSync(entry,"const {app,BrowserWindow}=require('electron');app.setPath('userData',"+JSON.stringify(path.join(run,'profile'))+");app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadURL('about:blank');});");
const app=await _electron.launch({args:[entry],env:{...process.env,TEMP:run,TMP:run,TMPDIR:run},timeout:60000}),page=await app.firstWindow();
await page.route('https://fixture.example.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}));
await page.goto('https://fixture.example.test/');
const invoke=packet=>page.evaluate(script=>(0,eval)(script),pageScript(packet));
async function check(name,html,body){try{await page.setContent(html);await body();checks.push({name,passed:true});console.log('[PASS] '+name);}catch(error){checks.push({name,passed:false,error:String(error)});console.log('[FAIL] '+name+': '+error.message);}}
try{
 await check('Android follows an exposed search-route anchor','<a href="/search">Search</a>',async()=>assert.equal((await invoke({op:'openSearch',attempt:0,platform:'android'})).clicked,true));
 await page.goto('https://fixture.example.test/');
 const preview='<section id="preview" class="search-preview">Search '+('catalogue card '.repeat(30))+'</section>';
 await check('Android ignores decorative search catalogue containers',preview,async()=>assert.equal((await invoke({op:'openSearch',attempt:0,platform:'android'})).clicked,false));
 await check('Android rejects a cached decorative opener after real control hydrates',preview+'<button aria-label="Open search" onclick="this.insertAdjacentHTML(\'afterend\',\'<input type=search placeholder=Search>\')">Search</button>',async()=>{
  assert.equal((await invoke({op:'openSearch',attempt:0,selector:'#preview',platform:'android'})).clicked,false);
  assert.equal((await invoke({op:'openSearch',attempt:0,platform:'android'})).clicked,true);
  assert.equal((await invoke({op:'openSearch',attempt:-1,platform:'android'})).input,true);
 });
 await check('Desktop decorative opener behavior remains unchanged',preview,async()=>assert.equal((await invoke({op:'openSearch',attempt:0})).clicked,true));
 await check('Desktop search-route behavior remains unchanged','<a href="/search">Search</a>',async()=>assert.equal((await invoke({op:'openSearch',attempt:0})).clicked,false));
 const card='<a role="option" href="/anime/arcadia"><span class="c1"><span class="c2">Arcadia Story</span><span>TV · 1998</span></span></a>';
 await check('Android separates exact result title from adjacent metadata',card,async()=>assert.equal((await invoke({op:'findTitle',titles:['Arcadia Story'],season:1,platform:'android'}))?.[0]?.href,'https://fixture.example.test/anime/arcadia'));
 await check('Desktop result scoring remains unchanged',card,async()=>assert.equal(await invoke({op:'findTitle',titles:['Arcadia Story'],season:1}),null));
 const watch='<div role="link" data-href="/watch/arcadia/1">Watch Ep 1 · Sub</div>';
 await check('Android follows a semantic watch link with an audio badge',watch,async()=>assert.equal((await invoke({op:'watchLink',slug:null,platform:'android'}))?.href,'https://fixture.example.test/watch/arcadia/1'));
 await check('Desktop semantic watch-link behavior stays unchanged',watch,async()=>assert.equal(await invoke({op:'watchLink',slug:null}),null));
 await check('Android rejects a cross-source watch link','<div role="link" data-href="https://other.example.test/watch/arcadia/1">Watch Ep 1 · Sub</div>',async()=>assert.equal(await invoke({op:'watchLink',slug:null,platform:'android'}),null));
 await check('Native Android submits a visible adjacent search button without a form','<div><input type="search" aria-label="Search"><button aria-label="Search" onclick="window.submitted=document.querySelector(\'input\').value">Go</button></div>',async()=>{await invoke({op:'fillSearch',query:'Arcadia Story'});assert.equal(await page.evaluate(script=>(0,eval)(script),submit),true);assert.equal(await page.evaluate(()=>window.submitted),'Arcadia Story');});
 await check('Native Android does not activate a hidden adjacent button','<div><input type="search" aria-label="Search"><button style="display:none" aria-label="Search">Go</button></div>',async()=>{await invoke({op:'fillSearch',query:'Arcadia Story'});assert.equal(await page.evaluate(script=>(0,eval)(script),submit),false);});
 await check('Native Android retains normal form submission','<form onsubmit="window.submitted=document.querySelector(\'input\').value;return false"><input type="search" aria-label="Search"><button>Search</button></form>',async()=>{await invoke({op:'fillSearch',query:'Arcadia Story'});assert.equal(await page.evaluate(script=>(0,eval)(script),submit),true);assert.equal(await page.evaluate(()=>window.submitted),'Arcadia Story');});
}finally{
 await app.close();
 const report={passed:checks.every(c=>c.passed),checks,run,scope:'Neutral rendered DOM copied by control shape only; no external source or media requests.'};
 writeFileSync(path.join(root,'test/artifacts/android-navigation-dom.json'),JSON.stringify(report,null,2));
 writeFileSync(path.join(run,'report.json'),JSON.stringify(report,null,2));
 if(!report.passed)process.exitCode=1;
 console.log('[REPORT] '+run);
}
