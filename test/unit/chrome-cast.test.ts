import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { CdpPipe } from '../../electron/cast/cdpPipe';
import { ChromeCast, chromeArguments } from '../../electron/cast/chromeCast';
const closers:(()=>void)[]=[];
afterEach(()=>{for(const close of closers.splice(0))close();vi.useRealTimers();});
it('frames private pipe messages across chunks and rejects outstanding requests on disconnect',async()=>{
 const input=new PassThrough(),output=new PassThrough(),pipe=new CdpPipe(input,output);closers.push(()=>pipe.close());
 const messages:string[]=[];input.on('data',chunk=>messages.push(chunk.toString()));
 const request=pipe.call('Cast.enable',{},'owned');
 const wire=JSON.parse(messages[0].slice(0,-1));expect(wire.sessionId).toBe('owned');
 output.write('{"id":'+wire.id+',"res');output.write('ult":{}}\0');
 await expect(request).resolves.toEqual({});
 const next=pipe.call('Cast.enable');pipe.close();await expect(next).rejects.toThrow(/closed/i);
});
it('uses an isolated profile and a private pipe without changing Windows resolution or app scaling',()=>{
 const args=chromeArguments('E:/profile','http://127.0.0.1:1234/secret/');
 expect(args).toContain('--user-data-dir=E:/profile');expect(args).toContain('--remote-debugging-pipe');
 expect(args.join(' ')).not.toMatch(/remote-debugging-port|force-device-scale|no-sandbox|disable-web-security|display-mode|headless/);
});
class Driver extends EventEmitter {
 calls:{method:string;params:any;session?:string}[]=[];closed=false;
 sinks=[{id:'one',name:'Fixture TV'}];
 async call<T=any>(method:string,params:any={},session?:string):Promise<T>{
  this.calls.push({method,params,session});
  if(method==='Target.getTargets')return {targetInfos:[{targetId:'owned',type:'page',url:'http://127.0.0.1:1234/secret/'}]} as T;
  if(method==='Target.attachToTarget')return {sessionId:'owned-session'} as T;
  if(method==='Cast.enable')this.emit('Cast.sinksUpdated',{sinks:this.sinks},'owned-session');
  if(method==='Runtime.evaluate')return {result:{value:{mediaSessionId:1,playerState:'PLAYING',currentTime:3}}} as T;
  if(method==='Page.bringToFront')this.emit('Cast.sinksUpdated',{sinks:this.sinks.map((s,i)=>i===1?{...s,session:'AniVerse'}:s)},'owned-session');
  if(method==='Cast.startTabMirroring')this.emit('Cast.sinksUpdated',{sinks:this.sinks.map(s=>({...s,session:'AniVerse'}))},'owned-session');
  return {} as T;
 }
 close(){this.closed=true;}
}
function fixture(){
 const driver=new Driver();
 const launcher=vi.fn(async()=>({pipe:driver as unknown as CdpPipe,stop:()=>driver.close()}));
 const chrome=new ChromeCast('E:/profile',launcher,async()=>({url:'http://127.0.0.1:1234/secret/',close:()=>undefined}));
 closers.push(()=>chrome.close());return {chrome,driver,launcher};
}
it('enumerates receivers through Chrome and starts TAB mirroring only after the owned player loads',async()=>{
 const {chrome,driver}=fixture();
 const list=await chrome.scan(0);expect(list[0]).toMatchObject({id:'chrome:one',transport:'chrome',host:'127.0.0.1'});
 const client=chrome.client(list[0].id);const media=vi.fn();client.on('media',media);
 await client.connect('127.0.0.1',0);await client.launch();
 await client.load({contentId:'http://127.0.0.1:99/processed/token/index.m3u8',contentType:'application/x-mpegurl',streamType:'LIVE',metadata:{title:'Fixture'}});
 const methods=driver.calls.map(c=>c.method);
 expect(methods.indexOf('Runtime.evaluate')).toBeLessThan(methods.indexOf('Cast.startTabMirroring'));
 expect(driver.calls.find(c=>c.method==='Cast.startTabMirroring')?.params).toEqual({sinkName:'Fixture TV'});
 expect(methods).not.toContain('Cast.startDesktopMirroring');expect(media).toHaveBeenCalled();
 await client.stopApp();client.close();expect(driver.closed).toBe(true);
});
it('hands duplicate names to Chrome’s native chooser instead of silently choosing a receiver',async()=>{
 const {chrome,driver}=fixture();driver.sinks.push({id:'two',name:'Fixture TV'});
 const list=await chrome.scan(0);expect(list).toHaveLength(2);
 const client=chrome.client(list[0].id);
 await client.load({contentId:'http://127.0.0.1/fixture.mp4'});
 expect(driver.calls.some(c=>c.method==='Page.bringToFront')).toBe(true);
 expect(driver.calls.some(c=>c.method==='Cast.startTabMirroring')).toBe(false);
 await client.stopApp();client.close();
});
it('does not close an active cast when its chooser unmounts',async()=>{
 const {chrome,driver}=fixture();const list=await chrome.scan(0);chrome.client(list[0].id);
 chrome.closeIfIdle();expect(driver.closed).toBe(false);
});
it('closes the connection and rejects playback after navigation leaves its owned companion',async()=>{
 const {chrome,driver}=fixture();const list=await chrome.scan(0);const client=chrome.client(list[0].id);
 const ended=vi.fn();client.on('disconnected',ended);
 driver.emit('Page.frameNavigated',{frame:{url:'https://unrelated.test',parentId:undefined}},'owned-session');
 expect(driver.closed).toBe(true);expect(ended).toHaveBeenCalled();
 await expect(client.load({contentId:'http://127.0.0.1/video.mp4'})).rejects.toThrow(/closed|no longer/i);
});

it('revokes a pending client immediately when its Chrome connection is closed',async()=>{
 const {chrome}=fixture();const list=await chrome.scan(0);const client=chrome.client(list[0].id);
 chrome.close();await expect(client.connect('127.0.0.1',0)).rejects.toThrow(/closed/i);
});
