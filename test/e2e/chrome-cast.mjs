// Real installed Chrome + the production companion and media server. TV route remains unverified without a physical receiver.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const cache=path.join(root,'test/cache/chrome-cast');mkdirSync(cache,{recursive:true});
const run=mkdtempSync(path.join(cache,'run-')),temporary=path.join(run,'temp');mkdirSync(temporary);
for(const key of ['TEMP','TMP','TMPDIR'])process.env[key]=temporary;
const player=await build({entryPoints:[path.join(root,'electron/cast/chromePlayer.ts')],bundle:true,platform:'browser',format:'iife',minify:true,write:false,logLevel:'warning'});
await build({stdin:{contents:"export { ChromeCast } from './electron/cast/chromeCast';export { CastService } from './electron/cast/castService';export { Sender4K } from './electron/cast/sender4k';",resolveDir:root},bundle:true,platform:'node',format:'cjs',outfile:path.join(run,'driver.cjs'),define:{__ANIVERSE_CHROME_PLAYER_SCRIPT__:JSON.stringify(player.outputFiles[0].text)},logLevel:'warning'});
const {ChromeCast,CastService,Sender4K}=createRequire(import.meta.url)(path.join(run,'driver.cjs'));
const chrome=new ChromeCast(path.join(run,'profile'));
const reports=[],errors=[];
const artifact=path.join(root,'test/artifacts/chrome-cast.json');
let cast;
try{
 const devices=await chrome.scan(2000);
 reports.push({name:'Installed Chrome native Cast API and owned companion start',passed:true,receiverCount:devices.length});
 const tools=process.env.E2E_MEDIA_RESOURCES?path.join(process.env.E2E_MEDIA_RESOURCES,'ffmpeg'):path.join(root,'build/vendor/ffmpeg');
 const shaders=process.env.E2E_MEDIA_RESOURCES?path.join(process.env.E2E_MEDIA_RESOURCES,'anime4k'):path.join(root,'assets/anime4k');
 const sender=new Sender4K(tools,shaders,path.join(run,'encoding'),message=>errors.push(message));
 const clip=path.join(root,'test/cache/release-1.5.2-ui/sintel-trailer.mp4');
 class LocalPlayer extends EventEmitter{
  async connect(){}async launch(){}async stopApp(){}close(){}
  async load(media,currentTime=0){const status=await chrome.evaluate('globalThis.AniVerseChromePlayer.load('+JSON.stringify({url:media.contentId,title:'Neutral cast fixture',startAt:currentTime,live:media.streamType==='LIVE'})+')');this.emit('media',status);}
  async media(type,extra={}){const status=await chrome.evaluate('globalThis.AniVerseChromePlayer.command('+JSON.stringify(type)+','+JSON.stringify(extra.currentTime??null)+')');this.emit('media',status);}
  async volume(v){await chrome.evaluate('globalThis.AniVerseChromePlayer.command("VOLUME",'+JSON.stringify(v)+')');}
 }
 cast=new CastService(()=>undefined,()=>clip,sender,()=>new LocalPlayer());
 cast.rememberDevices([{id:'fixture',name:'Owned Chrome companion',host:'127.0.0.1',port:0,model:'No physical TV',transport:'chrome'}]);
 for(const upscale4k of [false,true]){
  await cast.start('fixture',{url:'media://local/fixture',kind:'mp4',title:'Neutral fixture',startAt:1,upscale4k});
  const before=await chrome.evaluate('({time:document.querySelector("video").currentTime,width:document.querySelector("video").videoWidth,height:document.querySelector("video").videoHeight,paused:document.querySelector("video").paused,frames:{totalVideoFrames:document.querySelector("video").getVideoPlaybackQuality().totalVideoFrames,droppedVideoFrames:document.querySelector("video").getVideoPlaybackQuality().droppedVideoFrames}})');
  await new Promise(r=>setTimeout(r,2500));
  const after=await chrome.evaluate('({time:document.querySelector("video").currentTime,width:document.querySelector("video").videoWidth,height:document.querySelector("video").videoHeight,paused:document.querySelector("video").paused,frames:{totalVideoFrames:document.querySelector("video").getVideoPlaybackQuality().totalVideoFrames,droppedVideoFrames:document.querySelector("video").getVideoPlaybackQuality().droppedVideoFrames}})');
  assert.equal(after.paused,false);assert.ok(after.time>before.time+1.5);assert.ok(after.frames.totalVideoFrames>before.frames.totalVideoFrames);
  if(upscale4k){assert.equal(after.width,3840);assert.equal(after.height,2160);}
  const image=await chrome.call('Page.captureScreenshot',{format:'png'});
  writeFileSync(path.join(root,'test/artifacts/chrome-cast-'+(upscale4k?'4k':'standard')+'.png'),Buffer.from(image.data,'base64'));
  reports.push({name:upscale4k?'Embedded HEVC 4K HLS plays in real Chrome':'Opened local MP4 plays in real Chrome',passed:true,before,after});
  await cast.stop();
 }
 assert.deepEqual(errors,[]);
 // Closing the app-owned Chrome connection must revoke all further access.
 chrome.close();await assert.rejects(chrome.evaluate('document.title'),/closed/);
 reports.push({name:'Owned Chrome shuts down and rejects further commands',passed:true});
}finally{
 await cast?.stop();chrome.close();
 writeFileSync(artifact,JSON.stringify({physicalTV:false,profileContained:true,privatePipe:true,reports,errors},null,2)+'\n');
}
console.log(JSON.stringify({reports:reports.map(r=>r.name),physicalTV:false,artifact}));
