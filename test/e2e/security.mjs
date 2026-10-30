// Real app security and playback checks. Uses renderer CDP only, compatible with disabled Node inspector fuses.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),cache=path.join(root,'test/cache/security-ui'),artifacts=path.join(root,'test/artifacts');
mkdirSync(cache,{recursive:true});mkdirSync(artifacts,{recursive:true});
const run=mkdtempSync(path.join(cache,'run-')),profile=path.join(run,'profile'),config=path.join(run,'config'),temp=path.join(run,'temp');
for(const directory of [profile,config,temp])mkdirSync(directory,{recursive:true});
const clip=readFileSync(path.join(root,'test/cache/release-1.5.2-ui/sintel-trailer.mp4'));
let forbiddenRequests=0;
const forbidden=createServer((_req,res)=>{forbiddenRequests++;res.setHeader('Access-Control-Allow-Origin','*');res.end('Must not be contacted');});
await new Promise(resolve=>forbidden.listen(0,'127.0.0.1',resolve));
const forbiddenURL='http://127.0.0.1:'+forbidden.address().port;
const html='<!doctype html><meta charset="utf-8"><title>Security playback fixture</title><style>body{margin:0;background:#151020;color:white;font:16px sans-serif}#player{position:relative;width:960px;height:540px}video{width:100%;height:100%;object-fit:contain}a,button{margin:10px}</style><div id="player"><video id="v" controls muted loop src="/video.mp4"></video></div><button id="quality">Switch quality</button><a href="/next" id="next">Next page</a><script>window.originalVideo=v;quality.onclick=()=>{v.src="/video.mp4?quality=low";v.play();};</script>';
const server=createServer((req,res)=>{
 if(req.url.startsWith('/video.mp4')){
  const m=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/),start=m?Number(m[1]):0,end=m&&m[2]?Math.min(Number(m[2]),clip.length-1):clip.length-1;
  res.writeHead(m?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,...(m?{'Content-Range':'bytes '+start+'-'+end+'/'+clip.length}:{})});res.end(clip.subarray(start,end+1));return;
 }
 const send=()=>{if(!res.destroyed){res.writeHead(200,{'Content-Type':'text/html'});res.end(html);}};
 if(req.url.includes('/slow/')){const timer=setTimeout(send,10000);timer.unref();}else send();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
writeFileSync(path.join(config,'streaming-sites.txt'),origin+'\n');
writeFileSync(path.join(config,'filters.txt'),'! neutral security fixture\n');
await build({stdin:{contents:"export {Store} from './app/core/db/store';export {AniListClient} from './app/core/metadata/anilist';",resolveDir:root},outfile:path.join(run,'seed.cjs'),bundle:true,platform:'node',format:'cjs',external:['node:sqlite'],logLevel:'warning'});
const {Store,AniListClient}=createRequire(import.meta.url)(path.join(run,'seed.cjs'));
const store=new Store(path.join(profile,'aniverse.db'));
const raw=JSON.parse(readFileSync(path.join(root,'test/fixtures/anilist-home.json'),'utf8')).data.trending.media[0];
Object.assign(raw,{id:7,idMal:null,title:{english:'Fixture Series',romaji:'Fixture Series',native:null,userPreferred:'Fixture Series'},coverImage:{large:'',extraLarge:'',color:null},bannerImage:null,status:'FINISHED',episodes:3,synonyms:[],streamingEpisodes:[],externalLinks:[],relations:{edges:[]},recommendations:{nodes:[]},characters:{edges:[]},studios:{nodes:[]},tags:[]});
const data={Media:raw,Page:{media:[raw]},trending:{media:[]},spotlight:{media:[]},popularSeason:{media:[]},upcoming:{media:[]},topRated:{media:[]},recent:{airingSchedules:[]}};
const client=new AniListClient(async()=>new Response(JSON.stringify({data})),store,{showAdult:()=>false,token:()=>null});await client.details(7);await client.home();
store.setKv('settings',{updates:{autoCheck:false,autoDownload:false},accounts:{autoSync:false},privacy:{adblock:false},player:{autoplay:false,volume:0},appearance:{accent:'festival',reduceMotion:false}});
const localFile=path.join(run,'Fixture Series - 01.mp4');writeFileSync(localFile,clip);store.setKv('collection:roots',[run]);
store.db.prepare('INSERT INTO local_media(path,name,bytes,query,episode,media_id,missing) VALUES(?,?,?,?,?,?,0)').run(localFile,path.basename(localFile),clip.length,'Fixture Series',1,7);
store.close();
const marker=path.join(run,'unexpected-node-options-marker');
writeFileSync(path.join(run,'node-options.cjs'),'require("node:fs").writeFileSync('+JSON.stringify(marker)+',"unexpected execution");');
const packaged=!!process.env.E2E_EXE;
const exe=packaged?path.resolve(root,process.env.E2E_EXE):createRequire(import.meta.url)('electron');
const child=spawn(exe,[...(packaged?[]:[root]),'--remote-debugging-port=0',...(packaged?['--inspect=0']:[])],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ANIVERSE_HEADLESS:'1',ANIVERSE_DATA_DIR:profile,ANIVERSE_CONFIG_DIR:config,TEMP:temp,TMP:temp,TMPDIR:temp,...(packaged?{ELECTRON_RUN_AS_NODE:'1',NODE_OPTIONS:'--require='+path.join(run,'node-options.cjs')}:{})}});
let output='',endpoint;const endpointPromise=new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(Error('App did not expose a renderer CDP endpoint: '+output.slice(-2000))),45000);
 const consume=buffer=>{output+=buffer.toString();const match=output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/);if(match&&!endpoint){endpoint=match[1];clearTimeout(timer);resolve(endpoint);}};
 child.stdout.on('data',consume);child.stderr.on('data',consume);child.once('error',reject);child.once('exit',code=>{if(!endpoint){clearTimeout(timer);reject(Error('App exited before ready: '+code+' '+output.slice(-2000)));}});
});
let browser;const reports=[],errors=[];
const check=(name,actual)=>{reports.push({name,passed:true,actual});console.log('[PASS] '+name);};
try{
 browser=await chromium.connectOverCDP(await endpointPromise);
 let page;
 const end=Date.now()+30000;while(Date.now()<end){page=browser.contexts()[0]?.pages().find(page=>page.url().startsWith('app://'));if(page)break;await new Promise(resolve=>setTimeout(resolve,150));}
 assert.ok(page,'App renderer available');page.on('pageerror',error=>errors.push(error.message));await page.setViewportSize({width:1440,height:1000});await page.waitForSelector('.app');
 await page.getByRole('button',{name:'Got it',exact:true}).click();
 const rpc=(method,input)=>page.evaluate(({method,input})=>window.aniverse.invoke(method,input),{method,input});
 const info=await rpc('app.info');assert.equal(info.security.ready,true);assert.equal(info.security.engine,'rust-wasm');assert.match(info.security.sha256,/^[a-f0-9]{64}$/);
 if(packaged){assert.equal(existsSync(marker),false);assert.equal(/Debugger listening/.test(output),false);}
 check(packaged?'Production Rust active and Node environment/run-as-Node/inspector entry points ignored':'Embedded Rust active in development test',{packaged,security:info.security});
 const csp=await page.evaluate(()=>{const script=document.createElement('script');script.textContent='window.__badInlineCsp=true';document.head.append(script);return !window.__badInlineCsp;});
 assert.equal(csp,true);check('App CSP blocks untrusted inline scripts');
 assert.equal(await page.locator('.seasonal-logo').count(),1);
 const sources=await rpc('sources.list'),source=sources[0];
 await rpc('sources.pin',{sourceId:source.id,mediaId:7,url:origin+'/slow/episode-1'});
 await page.evaluate(id=>location.hash='#/watch/7/1?source='+id,source.id);
 await page.waitForSelector('.festival-buffer');await page.screenshot({path:path.join(artifacts,'security-festive-buffer.png')});
 assert.equal(await page.locator('.cat-stage').count(),0);check('Temporary festive buffer and vector logo render without replacing normal loader assets');
 await page.evaluate(()=>{window.__originalDate=Date;window.Date=class extends window.__originalDate{constructor(...args){super(...(args.length?args:[new window.__originalDate(2027,0,1).getTime()]));}static now(){return new window.__originalDate(2027,0,1).getTime();}};});
 await page.waitForSelector('.cat-stage');assert.equal(await page.locator('.festival-buffer').count(),0);assert.equal(await page.locator('.seasonal-logo').count(),0);
 await page.screenshot({path:path.join(artifacts,'security-january-cat-restored.png')});
 await page.evaluate(()=>window.Date=window.__originalDate);check('January clock restores the cat and standard logo without restarting');
 await page.evaluate(id=>location.hash='#/sources/'+id,source.id);
 await page.getByRole('button',{name:'Sign out & clear',exact:true}).waitFor();
 await page.waitForFunction(()=>{try{return !!document.querySelector('webview')?.getWebContentsId();}catch{return false;}});
 const view=page.locator('webview');
 const script=code=>view.evaluate((view,code)=>view.executeJavaScript(code,true),code);
 await page.waitForFunction(async()=>{try{return await document.querySelector('webview').executeJavaScript('!!document.querySelector("video")&&document.querySelector("video").readyState>=2');}catch{return false;}});
 const id=await view.evaluate(view=>view.getWebContentsId());
 assert.equal(await script('typeof require+"|"+typeof window.aniverse'),'undefined|undefined');
 await script('v.play()');const before=await rpc('player.probe',{webContentsId:id});await page.waitForTimeout(1400);const playing=await rpc('player.probe',{webContentsId:id});
 assert.ok(playing.currentTime>before.currentTime+.3&&!playing.paused&&playing.video.width>0);check('Source sandbox and normal decoded media playback work with protection active',playing.video);
 const denied=await script('fetch('+JSON.stringify(forbiddenURL+'/private')+').then(()=>false,()=>true)');
 assert.equal(denied,true);assert.equal(forbiddenRequests,0);
 await page.waitForTimeout(600);const after=await rpc('player.probe',{webContentsId:id});assert.ok(after.currentTime>playing.currentTime);
 assert.equal((await rpc('adblock.stats')).enabled,false);
 assert.ok(Object.values((await rpc('adblock.stats')).securityBlocked).reduce((sum,n)=>sum+n,0)>0);
 check('Unconfigured local-network requests are blocked before transmission even with ads off; video keeps advancing');
 await script('document.querySelector("#quality").click()');await page.waitForTimeout(1400);
 assert.equal(await script('v===window.originalVideo&&v.currentTime>0&&!v.paused'),true);check('Quality/source selection keeps the original video element and decoded playback');
 await rpc('site.focus',{webContentsId:id,on:true});
 await rpc('player.upscale',{webContentsId:id,options:{enabled:true,mode:'A',darken:false,thin:false}});
 const upscaleEnd=Date.now()+30000;let upscale;
 do{await page.waitForTimeout(200);upscale=await rpc('player.upscale',{webContentsId:id,options:{enabled:true,mode:'A',darken:false,thin:false}});}while(upscale.state==='waiting'&&Date.now()<upscaleEnd);
 assert.equal(upscale.state,'active',JSON.stringify(upscale));
 assert.equal(await script('v===window.originalVideo&&document.querySelector("[data-aniverse-upscale]").width===3840'),true);
 await page.screenshot({path:path.join(artifacts,'security-protected-upscale.png')});check('Real 4K filtering still uses the original source video and controls');
 await rpc('player.upscale',{webContentsId:id,options:{enabled:false,mode:'A',darken:false,thin:false}});
 await rpc('site.focus',{webContentsId:id,on:false});
 await script('document.querySelector("#next").click()');await page.waitForTimeout(1000);assert.equal(await script('location.pathname'),'/next');
 await script('location.href='+JSON.stringify(forbiddenURL+'/takeover'));await page.waitForTimeout(700);assert.equal(await script('location.pathname'),'/next');assert.equal(forbiddenRequests,0);check('Normal same-source navigation works; cross-site local takeovers are blocked');
 const rejected=await page.evaluate(()=>window.aniverse.invoke('__proto__').then(()=>false,()=>true));assert.equal(rejected,true);
 check('Invalid RPC names fail cleanly');
 await page.evaluate(()=>location.hash='#/watch/7/1?local=1');
 await page.waitForFunction(()=>document.querySelector('video')?.duration>0);
 await page.getByRole('button',{name:'Play',exact:true}).first().click();
 await page.waitForFunction(()=>{const video=document.querySelector('video');return video?.currentTime>.2&&!video.paused&&video.currentSrc.startsWith('media://local/');});
 assert.deepEqual(errors,[]);check('Granted local videos still decode through app media capabilities with production security controls');
}catch(error){reports.push({name:'security integration',passed:false,error:error.stack});console.error(error);process.exitCode=1;}
finally{
 if(browser)try{await browser.close();}catch{}
 if(child.exitCode===null)child.kill();
 server.closeAllConnections();forbidden.closeAllConnections();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>forbidden.close(resolve))]);
 writeFileSync(path.join(artifacts,'security-ui.json'),JSON.stringify({packaged,reports,errors,passed:reports.every(report=>report.passed),run},null,2)+'\n');
}
