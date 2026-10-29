import { app, BrowserWindow, session, ipcMain, webContents } from 'electron';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { registerRpc } from '../../../electron/ipc';
import { isPlayerCapturePermission } from '../../../electron/cast/capturePermission';
import { PlayerCapture } from '../../../electron/playerCapture';
import { WebsiteMirror } from '../../../electron/cast/websiteMirror';
import { CastService } from '../../../electron/cast/castService';
import { Sender4K } from '../../../electron/cast/sender4k';
const run=process.env.MIRROR_RUN!, root=process.env.MIRROR_ROOT!;
app.setPath('userData',path.join(run,'profile'));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.whenReady().then(async()=>{
 const host=new BrowserWindow({show:false,skipTaskbar:true,width:1280,height:800,webPreferences:{preload:path.join(run,'preload.cjs'),sandbox:true,contextIsolation:true,webviewTag:true,backgroundThrottling:false}});
 let loaded:any=null, mirror:WebsiteMirror, chunks=0;
 const errors:string[]=[];
 const tools=process.env.E2E_MEDIA_RESOURCES?path.join(process.env.E2E_MEDIA_RESOURCES,'ffmpeg'):path.join(root,'build/vendor/ffmpeg');
 const shaders=process.env.E2E_MEDIA_RESOURCES?path.join(process.env.E2E_MEDIA_RESOURCES,'anime4k'):path.join(root,'assets/anime4k');
 const sender=new Sender4K(tools,shaders,path.join(run,'encoding'),message=>errors.push(message));
 class Receiver extends EventEmitter {
  async connect(){} async launch(){} async stopApp(){} close(){} async media(){} async volume(){}
  async load(media:any){loaded=media; this.emit('media',{playerState:'PLAYING',currentTime:0,mediaSessionId:1});}
 }
 const cast=new CastService(s=>mirror?.onCastState(s),()=>null,sender,()=>new Receiver());
 (cast as any).devices.set('fixture',{id:'fixture',name:'TV fixture',model:'Receiver fixture',host:'127.0.0.1',port:8009});
 const guest=(id:number)=>{const wc=webContents.fromId(id);if(!wc||wc.getType()!=='webview'||wc.hostWebContents!==host.webContents)throw new Error('Unowned view');return wc;};
 const captures=new PlayerCapture(()=>host,guest,event=>host.webContents.send('aniverse:event','player.captureEnded',event));
 session.defaultSession.setDisplayMediaRequestHandler((request,callback)=>captures.handle(request,callback));
 mirror=new WebsiteMirror(cast,sender,captures,guest,message=>errors.push(message));
 session.defaultSession.setPermissionRequestHandler((wc,p,cb,details)=>cb(isPlayerCapturePermission(p,details)&&mirror.canCapture(wc)));
 session.defaultSession.setPermissionCheckHandler((wc,p)=>p==='display-capture'&&mirror.canCapture(wc));
 const source=session.fromPartition('persist:src-mirror-fixture');
 source.setPermissionRequestHandler((wc,p,cb)=>cb(false));
 source.protocol.handle('https',request=>{
  if(new URL(request.url).pathname==='/video.mp4')return new Response(readFileSync(path.join(root,'test/cache/release-1.5.2-ui/sintel-trailer.mp4')),{headers:{'Content-Type':'video/mp4'}});
  return new Response('<!doctype html><html><body style="margin:0;background:#000"><video style="width:100vw;height:100vh" src="https://mirror-fixture.test/video.mp4" autoplay loop controls></video></body></html>',{headers:{'Content-Type':'text/html'}});
 });
 registerRpc({
  'cast.mirrorPrepare':(input:any)=>mirror.prepare(input.webContentsId,input.deviceId,input.title,input.upscale,{enabled:true,mode:'A',darken:false,thin:false}),
  'cast.mirrorChunk':async(input:any)=>{await mirror.push(input.ticket,input.sequence,input.bytes);chunks++;},
  'cast.mirrorStop':(input:any)=>mirror.stop(input.ticket),
 } as any,event=>event.senderFrame===host.webContents.mainFrame);
 ipcMain.handle('fixture',async(event,method)=>{
  if(event.senderFrame!==host.webContents.mainFrame)throw new Error('Untrusted frame');
  if(method==='fixture.state')return {state:cast.snapshot(),loaded,chunks,errors,folder:(sender as any).folder};
  if(method==='fixture.stop')return mirror.stop();
  throw new Error('Unknown fixture call');
 });
 await host.loadFile(path.join(run,'host.html'));
 app.on('before-quit',()=>{void mirror.stop();});
});