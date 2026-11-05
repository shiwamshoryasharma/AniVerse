// Real Android native transfers and Local watch UI on the owned debug emulator only.
// Prepare by default; run after APK installation confirmation: node test/e2e/android-downloads.mjs --run
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {androidClient} from './helpers/android-cdp.mjs';
if(!process.argv.includes('--run')){console.log('Prepared only. Run with --run after the latest owned Android debug APK is installed.');process.exit(0);}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),cache=path.join(root,'test/cache/android-downloads'),artifacts=path.join(root,'test/artifacts');mkdirSync(cache,{recursive:true});mkdirSync(artifacts,{recursive:true});
const expectedVersion=readFileSync(path.join(root,'android/app/build.gradle.kts'),'utf8').match(/versionName\s*=\s*"([^"]+)"/)?.[1];
const run=mkdtempSync(path.join(cache,'run-')),client=androidClient({root,run}),origin='http://10.0.2.2:18765';
const clip=readFileSync(path.join(root,'test/cache/release-1.5.2-ui/sintel-trailer.mp4')),sha256=createHash('sha256').update(clip).digest('hex'),etag='"aniverse-controlled-video-v1"';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const requests=[],created=new Set(),plannedTitles=new Set(),checks=[],errors=[],pageErrors=[],measurements=[];
let page,nativeInfo,forbiddenRequests=0,resumeId,nonrangeId,badId,cancelId,baseline;
const timers=new Set();
const forbidden=createServer((_req,res)=>{forbiddenRequests++;res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':clip.length});res.end(clip);});
function stream(req,res,record){
 const noRange=record.path==='/nonrange.mp4',brokenRange=record.path==='/bad-range.mp4',requested=req.headers.range?.match(/^bytes=(\d+)-$/),start=!noRange&&requested?Number(requested[1]):0;
 if(start>=clip.length){res.writeHead(416,{'Content-Range':'bytes */'+clip.length});res.end();return;}
 const partial=!noRange&&!!requested,status=partial?206:200;
 record.status=status;record.offset=start;record.etag=etag;res.writeHead(status,{'Content-Type':'video/mp4','Content-Length':clip.length-start,'ETag':etag,'Cache-Control':'no-store',...(!noRange?{'Accept-Ranges':'bytes'}:{}),...(partial?{'Content-Range':'bytes '+(brokenRange?start+1:start)+'-'+(clip.length-1)+'/'+clip.length}:{})});
 if(req.method==='HEAD'){res.end();return;}
 let position=start,timer;
 const schedule=()=>{timer=setTimeout(()=>{timers.delete(timer);send();},120);timers.add(timer);};
 const send=()=>{if(res.destroyed)return;if(position>=clip.length){res.end();return;}const end=Math.min(position+32*1024,clip.length);record.sentBytes=(record.sentBytes??0)+end-position;const keep=res.write(clip.subarray(position,end));position=end;if(keep)schedule();else res.once('drain',schedule);};
 res.once('close',()=>{if(timer){clearTimeout(timer);timers.delete(timer);}record.closedAt=Date.now();});send();
}
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost'),record={method:req.method,path:url.pathname,range:req.headers.range??null,ifRange:req.headers['if-range']??null,at:Date.now()};requests.push(record);
 if(url.pathname==='/graphql'){
  let body='';for await(const chunk of req){body+=chunk.toString();if(body.length>256*1024){res.writeHead(413);res.end();return;}}
  let input;try{input=JSON.parse(body||'{}');}catch{res.writeHead(400);res.end();return;}
  const raw=JSON.parse(readFileSync(path.join(root,'test/fixtures/anilist-home.json'),'utf8')).data.trending.media[0];const item={...raw,id:7,idMal:null,title:{english:'Arcadia Story',romaji:'Arcadia Story',native:null,userPreferred:'Arcadia Story'},coverImage:{large:'',extraLarge:'',color:null},bannerImage:null,isAdult:false,streamingEpisodes:[],externalLinks:[],relations:{edges:[]},recommendations:{nodes:[]},characters:{edges:[]},studios:{nodes:[]},tags:[]};
  const data={Media:item,Page:{media:[item],pageInfo:{currentPage:1,total:1,hasNextPage:false},airingSchedules:[]},trending:{media:[item]},spotlight:{media:[]},popularSeason:{media:[]},upcoming:{media:[]},topRated:{media:[]},recent:{airingSchedules:[]},GenreCollection:['Action','Fantasy'],MediaTagCollection:[{name:'Isekai',isAdult:false}]};res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data}));return;
 }
 if(url.pathname==='/redirect.mp4'){res.writeHead(302,{Location:'http://10.0.2.2:'+forbidden.address().port+'/private.mp4'});res.end();return;}
 if(['/episode.mp4','/nonrange.mp4','/bad-range.mp4','/cancel.mp4'].includes(url.pathname)){stream(req,res,record);return;}
 res.writeHead(404);res.end();
});
const test=async(name,body)=>{try{const result=await body();checks.push({name,passed:true,...(result===undefined?{}:{actual:result})});console.log('[PASS] '+name);}catch(error){checks.push({name,passed:false,error:String(error.stack||error)});errors.push(name+': '+error.message);console.error('[FAIL] '+name+': '+error.message);await page?.screenshot({path:path.join(artifacts,'android-downloads-failure-'+checks.length+'.png')}).catch(()=>{});}};
async function until(read,predicate,label,timeout=25000){let last;for(const end=Date.now()+timeout;Date.now()<end;){last=await read();if(predicate(last))return last;await delay(180);}throw Error(label+'; last state: '+JSON.stringify(last));}
const all=()=>client.native('downloads.list');
const current=id=>all().then(rows=>rows.find(row=>row.id===id)??null);
const entry=(id,predicate,label,timeout)=>until(()=>current(id),predicate,label,timeout);
const add=async(route,title)=>{plannedTitles.add(title);const result=await client.native('downloads.add',{url:origin+route,title});assert.match(result.id,/^[a-f0-9-]{36}$/);created.add(result.id);return result.id;};
const card=title=>page.locator('.tablet-download-card').filter({has:page.getByRole('heading',{name:title,exact:true})});
async function settledSize(id){let previous=-1;return until(async()=>{const size=client.fileSize(id,'part');const stable=size===previous;previous=size;return {size,stable};},value=>value.size>0&&value.stable,'Partial file did not settle',6000).then(value=>value.size);}
async function pause(id,title,useUI=false){
 if(useUI)await client.touch(card(title).getByRole('button',{name:'Pause',exact:true}));else await client.native('downloads.control',{id,action:'pause'});
 await entry(id,row=>row?.status==='paused','Pause state not reported');const size=await settledSize(id);await delay(700);assert.equal(client.fileSize(id,'part'),size,'Pause must stop actual writes');return size;
}
async function finish(id,title){const row=await entry(id,value=>value?.status==='complete'||value?.status==='failed','Transfer did not finish',50000);assert.equal(row.status,'complete',row.error??'Unexpected failed transfer');assert.equal(row.bytes,clip.length);assert.equal(row.totalBytes,clip.length);assert.equal(client.fileSize(id,'video'),clip.length);assert.equal(client.fileHash(id,'video'),sha256);const local=await client.native('offline.list');assert.ok(local.items.some(item=>item.id===id&&item.title===title&&item.bytes===clip.length&&item.durationMs>0));return row;}
async function cleanup(id){const record=await current(id);if(record){await client.native('downloads.control',{id,action:record.status==='complete'?'remove':'cancel'});await entry(id,row=>row===null,'Own transfer cleanup did not finish',10000);}const local=await client.native('offline.list');if(local.items.some(item=>item.id===id))await client.native('offline.remove',{id});}
try{
 await Promise.all([new Promise(resolve=>server.listen(18765,'127.0.0.1',resolve)),new Promise(resolve=>forbidden.listen(0,'127.0.0.1',resolve))]);
 client.adb('shell','pm','grant',client.appId,'android.permission.POST_NOTIFICATIONS');
 const attached=await client.connect();page=attached.page;page.on('pageerror',error=>pageErrors.push(error.message));nativeInfo=await client.native('native.info');assert.equal(nativeInfo.version,expectedVersion);
 const notice=page.getByRole('button',{name:'I understand · Start browsing',exact:true});if(await notice.count())await client.touch(notice);
 baseline=await client.native('offline.list');client.adb('shell','run-as',client.appId,'id');await client.nav('Downloads');await page.getByRole('heading',{name:'Downloads',exact:true}).waitFor();
 const title='Range fixture · episode 1 ['+path.basename(run)+']';plannedTitles.add(title);
 await test('Add download UI starts a native queue with progress speed and total size',async()=>{
  await client.touch(page.getByRole('button',{name:'Add download',exact:true}));const dialog=page.getByRole('dialog',{name:'Add direct video download',exact:true});await dialog.waitFor();await dialog.getByRole('textbox',{name:'Download URL',exact:true}).fill(origin+'/episode.mp4');await dialog.getByRole('textbox',{name:'Download name',exact:true}).fill(title);await client.touch(dialog.getByRole('button',{name:'Start download',exact:true}));await dialog.waitFor({state:'hidden'});
  const added=await until(all,rows=>rows.some(row=>row.title===title),'Added transfer must be present');resumeId=added.find(row=>row.title===title).id;created.add(resumeId);const row=await entry(resumeId,value=>value?.status==='running'&&value.bytes>0&&value.speedBytesPerSecond>0,'Running transfer must report progress and speed');assert.equal(row.totalBytes,clip.length);assert.equal(row.resumable,true);await card(title).waitFor();assert.ok(await card(title).getByRole('progressbar').count());await page.waitForFunction(element=>element?.querySelector('.chip')?.textContent==='running'&&Number(element.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow'))>0&&/\/s/.test(element.innerText),await card(title).elementHandle());const visibleUI={percent:Number(await card(title).getByRole('progressbar').getAttribute('aria-valuenow')),text:await card(title).innerText()};await page.screenshot({path:path.join(artifacts,'android-downloads-progress.png')});return {...row,visibleUI};
 });
 await test('Pause preserves the partial file and stops actual writes',async()=>{assert.ok(resumeId);const bytes=await pause(resumeId,title,true);await card(title).getByRole('button',{name:'Resume',exact:true}).waitFor();measurements.push({name:'resumable pause',id:resumeId,partialBytes:bytes});await page.screenshot({path:path.join(artifacts,'android-downloads-paused.png')});return {partialBytes:bytes};});
 await test('Resume uses the exact saved byte offset and validator then produces the original video hash',async()=>{
  assert.ok(resumeId);const offset=client.fileSize(resumeId,'part');assert.ok(offset>0&&offset<clip.length);await client.touch(card(title).getByRole('button',{name:'Resume',exact:true}));await until(async()=>requests.find(request=>request.path==='/episode.mp4'&&request.range),Boolean,'Resume did not send Range');
  const range=requests.find(request=>request.path==='/episode.mp4'&&request.range);assert.equal(range.range,'bytes='+offset+'-');assert.equal(range.ifRange,etag);await finish(resumeId,title);return {offset,range:range.range,validator:range.ifRange,bytes:clip.length,sha256};
 });
 await test('Completed transfer appears in Local watch with thumbnail and removal frees its private copy',async()=>{
  assert.ok(resumeId);await client.nav('Local watch');await page.getByRole('heading',{name:'Local watch',exact:true}).waitFor();const localCard=page.locator('.tablet-file-card').filter({has:page.getByRole('heading',{name:title,exact:true})});await localCard.waitFor();await until(()=>localCard.locator('img').evaluate(image=>image.complete&&image.naturalWidth>0&&getComputedStyle(image).display!=='none'),Boolean,'Local thumbnail did not decode');await page.screenshot({path:path.join(artifacts,'android-downloads-local-watch.png')});
  const before=await client.native('offline.list');await client.touch(localCard.getByRole('button',{name:'Remove saved '+title,exact:true}));const dialog=page.getByRole('dialog',{name:'Remove saved episode?',exact:true});await dialog.waitFor();await client.touch(dialog.getByRole('button',{name:'Remove saved copy',exact:true}));await dialog.waitFor({state:'hidden'});await localCard.waitFor({state:'hidden'});const after=await client.native('offline.list');assert.ok(!after.items.some(item=>item.id===resumeId));assert.equal(before.usedBytes-after.usedBytes,clip.length);assert.equal(client.fileSize(resumeId,'video'),null);await cleanup(resumeId);await client.nav('Downloads');return {releasedBytes:clip.length,remainingItems:after.items.length};
 });
 await test('Non-range servers expose Restart and safely restart from zero without corrupt append',async()=>{
  const name='Restart fixture · episode 2';nonrangeId=await add('/nonrange.mp4',name);await entry(nonrangeId,row=>row?.status==='running'&&row.bytes>0,'Non-range transfer did not start');await pause(nonrangeId,name);await card(name).getByRole('button',{name:'Restart',exact:true}).waitFor();const offset=client.fileSize(nonrangeId,'part');await client.touch(card(name).getByRole('button',{name:'Restart',exact:true}));await finish(nonrangeId,name);const calls=requests.filter(request=>request.path==='/nonrange.mp4');assert.ok(calls.length>=2);assert.ok(calls.every(request=>request.range===null));await cleanup(nonrangeId);return {discardedPartialBytes:offset,requests:calls.length,sha256};
 });
 await test('Malformed resumed Content-Range fails before appending or publishing a corrupt file',async()=>{
  badId=await add('/bad-range.mp4','Bad range fixture');await entry(badId,row=>row?.status==='running'&&row.bytes>0,'Malformed-range fixture did not start');await pause(badId,'Bad range fixture');const before=client.fileHash(badId,'part'),bytes=client.fileSize(badId,'part');await client.native('downloads.control',{id:badId,action:'resume'});const failed=await entry(badId,row=>row?.status==='failed','Invalid range must fail');assert.match(failed.error,/range|match|restart/i);assert.equal(client.fileHash(badId,'part'),before);assert.equal(client.fileSize(badId,'part'),bytes);assert.equal(client.fileSize(badId,'video'),null);assert.ok(!(await client.native('offline.list')).items.some(item=>item.id===badId));await cleanup(badId);return {error:failed.error,unchangedPartialBytes:bytes};
 });
 await test('Private-network redirects fail before the target receives any request',async()=>{
  const id=await add('/redirect.mp4','Redirect fixture');const row=await entry(id,value=>value?.status==='failed','Private redirect must fail');assert.match(row.error,/blocked|protection/i);assert.equal(forbiddenRequests,0);assert.equal(client.fileSize(id,'video'),null);assert.ok(!(await client.native('offline.list')).items.some(item=>item.id===id));await cleanup(id);return {error:row.error,forbiddenRequests};
 });
 await test('Cancellation removes only its own pending transfer and partial file',async()=>{
  cancelId=await add('/cancel.mp4','Cancel fixture');await entry(cancelId,row=>row?.status==='running'&&row.bytes>0,'Cancellation fixture did not start');assert.ok(client.fileSize(cancelId,'part')>0);await client.native('downloads.control',{id:cancelId,action:'cancel'});await entry(cancelId,row=>row===null,'Cancelled queue item was not removed');assert.equal(client.fileSize(cancelId,'part'),null);assert.equal(client.fileSize(cancelId,'video'),null);assert.ok(!(await client.native('offline.list')).items.some(item=>item.id===cancelId));
 });
 assert.deepEqual(pageErrors,[]);
}catch(error){errors.push(String(error.stack||error));console.error(error);}
finally{
 if(page)try{for(const item of await all())if(plannedTitles.has(item.title))created.add(item.id);}catch(error){errors.push('Own transfer discovery during cleanup: '+error.message);}
 for(const id of created)try{await cleanup(id);}catch(error){errors.push('Cleanup '+id+': '+error.message);}
 await client.close();for(const timer of timers)clearTimeout(timer);server.closeAllConnections();forbidden.closeAllConnections();await Promise.all([server.listening?new Promise(resolve=>server.close(resolve)):Promise.resolve(),forbidden.listening?new Promise(resolve=>forbidden.close(resolve)):Promise.resolve()]);
 const report={passed:!errors.length,checks,errors,pageErrors,run,serial:client.serial,appId:client.appId,nativeInfo,expectedVideo:{bytes:clip.length,sha256},baseline,requests,measurements,forbiddenRequests,limits:['Owned Android debug emulator only; no real device, external website or account was used.','Real native transfers use a controlled local HTTP debug fixture; release builds require public HTTPS.','Native player/subtitle instrumentation is separate. Existing unrelated Local watch copies and historical source/media evidence are preserved.']};writeFileSync(path.join(artifacts,'android-downloads.json'),JSON.stringify(report,null,2)+'\n');if(errors.length)process.exitCode=1;
}
