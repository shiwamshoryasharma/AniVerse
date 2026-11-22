import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,readdir,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
const helper=path.resolve(process.argv[2]);
const tools=path.resolve('build/vendor/ffmpeg'), ffmpeg=path.join(tools,'ffmpeg.exe'), ffprobe=path.join(tools,'ffprobe.exe');
const cache=path.resolve('test/cache/media-transfer'); await mkdir(cache,{recursive:true});
const scratch=await mkdtemp(path.join(cache,'segmented-fixture-'));
const files=new Map(), requests=[], children=new Set();
function tool(exe,args,cwd=scratch){return execFileSync(exe,args,{cwd,windowsHide:true,encoding:'utf8',timeout:45000});}
function probe(file){return JSON.parse(tool(ffprobe,['-v','error','-show_entries','stream=codec_type,codec_name,start_time,duration:format=start_time,duration','-of','json',file]));}
for(const [name,extra] of [['mixed-ts',[]],['mixed-fmp4',['-hls_segment_type','fmp4']]]){
  const folder=path.join(scratch,name);await mkdir(folder);
  tool(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=96x54:rate=12','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3','-c:v','libx264','-bf','0','-g','12','-c:a','aac','-f','hls','-hls_time','1','-hls_list_size','0',...extra,'-hls_segment_filename','part-%d.'+(extra.length?'m4s':'ts'),'episode.m3u8'],folder);
  let manifest=await readFile(path.join(folder,'episode.m3u8'),'utf8');
  for(const [i,name] of (await readdir(folder)).filter(n=>/^part-\d+\./.test(n)).sort().entries()){
    const renamed='segment-'+i+(i%2?'.png':'.webp');files.set('/'+path.basename(folder)+'/'+renamed,await readFile(path.join(folder,name)));manifest=manifest.replaceAll(name,renamed+'?part=fixture');
  }
  if(extra.length){files.set('/'+path.basename(folder)+'/initial.png',await readFile(path.join(folder,'init.mp4')));manifest=manifest.replaceAll('init.mp4','initial.png?init=fixture');}
  files.set('/'+path.basename(folder)+'/episode.m3u8',Buffer.from(manifest));
}
const split=path.join(scratch,'split');await mkdir(split);
for(const [name,input,codec] of [['video',['-f','lavfi','-i','testsrc2=size=96x54:rate=12'],['-an','-c:v','libx264','-bf','0','-g','12']],['audio',['-f','lavfi','-i','sine=frequency=880:sample_rate=48000'],['-vn','-c:a','aac']]]){
  tool(ffmpeg,['-nostdin','-v','error',...input,'-t','3',...codec,'-f','hls','-hls_time','1','-hls_list_size','0','-hls_segment_filename',name+'-%d.ts',name+'.m3u8'],split);
}
await writeFile(path.join(split,'probe-master.m3u8'),'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=400000,AUDIO="audio"\nvideo.m3u8\n');
const av=JSON.parse(tool(ffprobe,['-v','error','-protocol_whitelist','file','-allowed_extensions','m3u8,ts,m4s,mp4','-f','hls','-show_entries','format=start_time','-of','json','probe-master.m3u8'],split));
const originPts=Math.round(Number(av.format.start_time)*90000);
for(const name of ['video','audio']){
  let manifest=await readFile(path.join(split,name+'.m3u8'),'utf8');
  for(const [i,file] of (await readdir(split)).filter(n=>n.startsWith(name+'-')&&n.endsWith('.ts')).sort().entries()){
    const renamed=name+'-'+i+(i%2?'.png':'.webp');files.set('/split/'+renamed,await readFile(path.join(split,file)));manifest=manifest.replaceAll(file,renamed+'?segment=fixture');
  }
  files.set('/split/'+name+'.m3u8',Buffer.from(manifest));
}
for(let i=0;i<3;i++)files.set('/split/caption-'+i+(i%2?'.png':'.webp'),Buffer.from('WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:'+String(10+i).padStart(2,'0')+'.000,MPEGTS:'+(originPts+i*90000)+'\n\n00:00:'+String(10+i).padStart(2,'0')+'.250 --> 00:00:'+String(10+i).padStart(2,'0')+'.750\nSynthetic caption '+(i+1)+'\n\n'));
files.set('/split/captions.m3u8',Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:1\n'+[0,1,2].map(i=>'#EXTINF:1,\ncaption-'+i+(i%2?'.png':'.webp')+'?caption=fixture\n').join('')+'#EXT-X-ENDLIST\n'));
files.set('/split/unselected.m3u8',Buffer.from('#EXTM3U\n#EXTINF:3,\nnever-unselected.png\n#EXT-X-ENDLIST\n'));
files.set('/split/master.m3u8',Buffer.from('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8?audio=fixture"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="captions.m3u8?sub=fixture"\n#EXT-X-STREAM-INF:BANDWIDTH=900000,AUDIO="audio",SUBTITLES="subs"\nunselected.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=400000,AUDIO="audio",SUBTITLES="subs"\nvideo.m3u8?video=fixture\n'));
for(const ext of ['png','webp']){
  tool(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','color=blue:size=2x2','-frames:v','1','-update','1','real.'+ext]);
  files.set('/image/'+ext,await readFile(path.join(scratch,'real.'+ext)));
  files.set('/image/'+ext+'.m3u8',Buffer.from('#EXTM3U\n#EXTINF:1,\n'+ext+'\n#EXT-X-ENDLIST\n'));
}
files.set('/image/html',Buffer.from('<html><body>Login required</body></html>'));
files.set('/image/html.m3u8',Buffer.from('#EXTM3U\n#EXTINF:1,\nhtml\n#EXT-X-ENDLIST\n'));
files.set('/encrypted.m3u8',Buffer.from('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="never.key"\n#EXTINF:1,\nnever.ts\n#EXT-X-ENDLIST\n'));
files.set('/cross-host.m3u8',Buffer.from('#EXTM3U\n#EXTINF:1,\nhttp://192.168.1.1/never.ts\n#EXT-X-ENDLIST\n'));
files.set('/missing.m3u8',Buffer.from('#EXTM3U\n#EXTINF:1,\nmissing.png\n#EXT-X-ENDLIST\n'));
files.set('/empty.vtt',Buffer.from('WEBVTT\n\n'));
files.set('/direct.vtt',Buffer.from('WEBVTT\n\n00:00:00.250 --> 00:00:00.750\nSynthetic DOM caption\n\n'));
let stalled;
const server=createServer((request,response)=>{
  const name=new URL(request.url,'http://fixture.test').pathname;requests.push(request.url);
  assert.equal(request.headers.cookie,undefined);assert.equal(request.headers.authorization,undefined);
  if(name==='/slow.m3u8'){response.end('#EXTM3U\n#EXTINF:1,\nslow.webp\n#EXT-X-ENDLIST\n');return;}
  if(name==='/slow.webp'){stalled?.();return;}
  if(name==='/redirect.m3u8'){response.writeHead(302,{location:'/encrypted.m3u8'}).end();return;}
  const bytes=files.get(name);if(!bytes){response.writeHead(404).end();return;}
  response.setHeader('Content-Type',name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':name.endsWith('.png')?'image/png':name.endsWith('.webp')?'image/webp':'application/octet-stream');response.setHeader('Content-Length',bytes.length);response.end(bytes);
});
server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
function start(route,destination,selection={}){
  const child=spawn(helper,[],{env:{...process.env,ANIVERSE_TEST_MEDIA_ORIGIN:origin},windowsHide:true,stdio:['pipe','pipe','pipe']});children.add(child);child.stdin.on('error',()=>{});
  const request={url:origin+route,destination,...selection};child.stdin.write(JSON.stringify(request)+'\n');
  const events=[],reader=createInterface({input:child.stdout});let errors='';reader.on('line',line=>events.push(JSON.parse(line)));child.stderr.on('data',data=>{errors+=data;});
  const timer=setTimeout(()=>child.stdin.end(),45000);
  const done=once(child,'close').then(([code])=>{clearTimeout(timer);children.delete(child);reader.close();return{code,events,errors};});return{child,done};
}
function times(text){return [...text.matchAll(/(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})\s+-->/g)].map(m=>Number(m[1]||0)*3600+Number(m[2])*60+Number(m[3])+Number(m[4])/1000);}
const report={passed:false,scratch,cases:[]};
try{
  for(const kind of ['mixed-ts','mixed-fmp4']){
    const output=path.join(scratch,kind+'.mp4');const route='/'+kind+'/episode.m3u8?ticket=fixture';
    const result=await start(route,output,{expectedDuration:3,playlists:[origin+route],observations:[origin+'/unrelated.json',origin+'/'+kind+'/segment-0.webp?part=fixture']}).done;
    assert.equal(result.code,0,JSON.stringify(result));const data=probe(output);assert.deepEqual(data.streams.map(s=>s.codec_name),['h264','aac']);assert.ok(Math.abs(Number(data.streams[0].start_time)-Number(data.streams[1].start_time))<0.15);assert.ok(Math.abs(Number(data.format.duration)-3)<0.25);report.cases.push(kind);
  }
  const index=requests.length, output=path.join(scratch,'split-subtitles.mp4');
  const result=await start('/split/master.m3u8?master=fixture',output,{expectedDuration:3,playlists:[origin+'/split/master.m3u8?master=fixture',origin+'/split/video.m3u8?video=fixture'],observations:[origin+'/unrelated.json',origin+'/split/video-0.webp?segment=fixture',origin+'/split/audio-0.webp?segment=fixture'],subtitle:{language:'en',label:'English'}}).done;
  assert.equal(result.code,0,JSON.stringify(result));const data=probe(output);assert.deepEqual(data.streams.map(s=>s.codec_name),['h264','aac','mov_text']);
  const cues=tool(ffmpeg,['-nostdin','-v','error','-i',output,'-map','0:s:0','-c:s','webvtt','-f','webvtt','pipe:1']);for(const cue of [1,2,3])assert.ok(cues.includes('Synthetic caption '+cue),cues);assert.deepEqual(times(cues).length,3);times(cues).forEach((value,i)=>assert.ok(Math.abs(value-(i+.25))<.06,'Caption timing mismatch: '+cues));
  assert.ok(!requests.slice(index).some(url=>url.includes('never-unselected')),'Unselected quality was downloaded');report.cases.push('selected-master-audio-webvtt-content-and-timing');
  const unownedOutput=path.join(scratch,'unowned-query.mp4'), unownedStart=requests.length;
  const unowned=await start('/mixed-ts/episode.m3u8?ticket=fixture',unownedOutput).done;
  assert.notEqual(unowned.code,0,'Unscoped query URL was accepted');await assert.rejects(stat(unownedOutput),{code:'ENOENT'});assert.equal(requests.length,unownedStart,'Unscoped query URL reached the network');report.cases.push('unowned-query-rejected-before-network');
  const mismatchOutput=path.join(scratch,'wrong-duration.mp4'), mismatchStart=requests.length;
  const mismatch=await start('/mixed-ts/episode.m3u8?ticket=fixture',mismatchOutput,{expectedDuration:30,playlists:[origin+'/mixed-ts/episode.m3u8?ticket=fixture'],observations:[origin+'/mixed-ts/segment-0.webp?part=fixture']}).done;
  assert.notEqual(mismatch.code,0,'A different-duration clip was accepted');await assert.rejects(stat(mismatchOutput),{code:'ENOENT'});
  assert.ok(requests.slice(mismatchStart).every(url=>new URL(url,origin).pathname.endsWith('.m3u8')),'Rejected-duration media segments were downloaded');report.cases.push('selected-duration-mismatch-rejected-before-segments');
  for(const name of ['direct','empty']){
    const target=path.join(scratch,'dom-'+name+'.mp4');const transferred=await start('/mixed-ts/episode.m3u8?ticket=fixture',target,{expectedDuration:3,playlists:[origin+'/mixed-ts/episode.m3u8?ticket=fixture'],observations:[origin+'/mixed-ts/segment-0.webp?part=fixture'],subtitle:{url:origin+'/'+name+'.vtt?track=fixture',language:'en',label:'Selected text track'}}).done;
    assert.equal(transferred.code,0,JSON.stringify(transferred));const tracks=probe(target).streams.map(stream=>stream.codec_name);
    if(name==='direct'){assert.deepEqual(tracks,['h264','aac','mov_text']);const text=tool(ffmpeg,['-nostdin','-v','error','-i',target,'-map','0:s:0','-c:s','webvtt','-f','webvtt','pipe:1']);assert.ok(text.includes('Synthetic DOM caption'));assert.ok(Math.abs(times(text)[0]-.25)<.06);}
    else assert.deepEqual(tracks,['h264','aac'],'An empty optional subtitle track should not block video or add a fake stream');
    report.cases.push('selected-dom-'+name+'-webvtt');
  }
  const safe=await readFile(output);const existing=await start('/split/master.m3u8?master=fixture',output,{expectedDuration:3,playlists:[origin+'/split/master.m3u8?master=fixture'],observations:[origin+'/split/video-0.webp?segment=fixture'],subtitle:{language:'en',label:'English'}}).done;assert.notEqual(existing.code,0);assert.deepEqual(await readFile(output),safe);report.cases.push('no-overwrite');
  for(const route of ['/image/png.m3u8','/image/webp.m3u8','/image/html.m3u8','/encrypted.m3u8','/cross-host.m3u8','/missing.m3u8','/redirect.m3u8']){
    const target=path.join(scratch,'refused-'+report.cases.length+'.mp4');const first=requests.length;const refused=await start(route,target).done;assert.notEqual(refused.code,0,route);await assert.rejects(stat(target),{code:'ENOENT'});if(route==='/encrypted.m3u8')assert.deepEqual(requests.slice(first),[route]);report.cases.push('reject-'+route);
  }
  const waiting=new Promise(resolve=>{stalled=resolve;});const cancelled=path.join(scratch,'cancelled.mp4'), slow=start('/slow.m3u8',cancelled);await waiting;slow.child.stdin.end();const stopped=await slow.done;assert.notEqual(stopped.code,0);await assert.rejects(stat(cancelled),{code:'ENOENT'});report.cases.push('cooperative-cancel');
  assert.ok(!(await readdir(scratch)).some(name=>name.startsWith('.aniverse-')),'Temporary download data leaked');report.cases.push('temporary-cleanup');
  assert.ok(!requests.some(url=>url.includes('unrelated.json')||url.includes('never.key')),'Unrelated/protected resources were requested');
  report.passed=true;
}catch(error){report.error=String(error.stack||error);throw error;}
finally{for(const child of children)child.stdin.end();server.closeAllConnections();server.close();await writeFile(path.join(scratch,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}