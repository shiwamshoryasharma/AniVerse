import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import type { CastDevice } from '../../app/shared/types';
import type { CastTransport } from './castService';
import type { MediaStatus } from './castv2';
import { CdpPipe } from './cdpPipe';
declare const __ANIVERSE_CHROME_PLAYER_SCRIPT__: string;
interface Sink { id:string; name:string; session?:string }
interface Driver { pipe:CdpPipe; stop:()=>void }
interface Companion { url:string; close:()=>void }
interface Connection extends Driver { session:string; url:string; companion:Companion }
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export function chromeArguments(profile:string,url:string) {
  return ['--user-data-dir='+profile,'--remote-debugging-pipe','--no-first-run','--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required','--new-window',url];
}
async function launchChrome(profile:string,url:string):Promise<Driver> {
  const candidates=process.platform==='win32'?
    [process.env.PROGRAMFILES,process.env['PROGRAMFILES(X86)'],process.env.LOCALAPPDATA].filter((p):p is string=>!!p).map(p=>path.join(p,'Google/Chrome/Application/chrome.exe')):
    process.platform==='darwin'?['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']:['/usr/bin/google-chrome','/usr/bin/google-chrome-stable'];
  const executable=candidates.find(file=>existsSync(file));
  if(!executable)throw new Error('Google Chrome is not installed. Install Chrome to use its TV discovery, or use direct Google Cast below.');
  await mkdir(profile,{recursive:true});
  const child=spawn(executable,chromeArguments(profile,url),{windowsHide:true,stdio:['ignore','ignore','ignore','pipe','pipe']});
  const pipe=new CdpPipe(child.stdio[3] as Writable,child.stdio[4] as Readable);
  child.once('error',()=>pipe.close());child.once('exit',()=>pipe.close());
  return {pipe,stop:()=>{
    void pipe.call('Browser.close',{},undefined,1500).catch(()=>undefined).finally(()=>pipe.close());
    const timer=setTimeout(()=>{if(child.exitCode===null)child.kill();},2000);timer.unref();
  }};
}
async function companionServer():Promise<Companion> {
  const secret=randomBytes(24).toString('hex'),root='/'+secret+'/';
  const script=typeof __ANIVERSE_CHROME_PLAYER_SCRIPT__==='string'?__ANIVERSE_CHROME_PLAYER_SCRIPT__:'';
  const server=http.createServer((req,res)=>{
    if(!['GET','HEAD'].includes(req.method??'')||!/^127\.0\.0\.1:\d+$/.test(req.headers.host??'')){res.writeHead(404).end();return;}
    const isPage=req.url===root,isScript=req.url===root+'player.js';
    if(!isPage&&!isScript){res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':isPage?'text/html; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer',
      'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src http: https:; media-src http: https: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});
    res.end(req.method==='HEAD'?'':isPage?'<!doctype html><html><head><meta charset="utf-8"><title>AniVerse · Chrome Cast</title></head><body><script src="'+root+'player.js"></script></body></html>':script);
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:'http://127.0.0.1:'+(server.address() as AddressInfo).port+root,close:()=>{server.closeAllConnections();server.close();}};
}

/** Uses installed Chrome's real Media Router, in an app-owned profile and private pipe. */
export class ChromeCast {
  private connection:Connection|null=null;
  private opening:Promise<Connection>|null=null;
  private generation=0;
  private sinks:Sink[]=[];
  private active:ChromeCastClient|null=null;
  private idleTimer:NodeJS.Timeout|null=null;
  constructor(private profile:string,private launch=launchChrome,private serve=companionServer,private notice:(message:string)=>void=()=>undefined) {}
  private async open():Promise<Connection> {
    if(this.connection)return this.connection;
    if(this.opening)return this.opening;
    const generation=this.generation;
    this.opening=(async()=>{
      const companion=await this.serve();
      let driver:Driver|null=null;
      try{
        driver=await this.launch(this.profile,companion.url);
        const pipe=driver.pipe;
        const {targetInfos}=await pipe.call<{targetInfos:{targetId:string;type:string;url:string}[]}>('Target.getTargets');
        const target=targetInfos.find(t=>t.type==='page'&&t.url===companion.url)??targetInfos.find(t=>t.type==='page');
        if(!target)throw new Error('Chrome did not open its casting window.');
        const {sessionId}=await pipe.call<{sessionId:string}>('Target.attachToTarget',{targetId:target.targetId,flatten:true});
        if(generation!==this.generation)throw new Error('Chrome casting was cancelled.');
        const connection:Connection={...driver,session:sessionId,url:companion.url,companion};this.connection=connection;
        pipe.on('closed',()=>{if(this.connection===connection)this.fail('The Chrome casting window was closed.');});
        pipe.on('Cast.sinksUpdated',(event,session)=>{
          if(session!==sessionId||this.connection!==connection)return;
          this.sinks=(Array.isArray(event.sinks)?event.sinks:[]).filter((s:any)=>typeof s.id==='string'&&s.id.length<=180&&typeof s.name==='string'&&s.name.length<=200).slice(0,100);
          this.active?.receiversChanged();
        });
        pipe.on('Cast.issueUpdated',(event,session)=>{if(session===sessionId&&event.issueMessage&&this.active)this.fail('Chrome Cast: '+String(event.issueMessage).slice(0,400));});
        pipe.on('Page.frameNavigated',(event,session)=>{
          if(session===sessionId&&!event.frame?.parentId&&event.frame?.url!==connection.url)this.fail('Chrome left its AniVerse casting page. Start casting again.');
        });
        await pipe.call('Page.enable',{},sessionId);
        if(target.url!==companion.url)await pipe.call('Page.navigate',{url:companion.url},sessionId);
        await pipe.call('Runtime.enable',{},sessionId);
        const deadline=Date.now()+15000;
        while(!(await pipe.call('Runtime.evaluate',{expression:'Boolean(globalThis.AniVerseChromePlayer)',returnByValue:true},sessionId)).result?.value){
          if(generation!==this.generation)throw new Error('Chrome casting was cancelled.');
          if(Date.now()>deadline)throw new Error('Chrome could not load the AniVerse casting player.');
          await delay(100);
        }
        await pipe.call('Cast.enable',{},sessionId);
        return connection;
      }catch(error){if(this.connection?.pipe===driver?.pipe)this.connection=null;driver?.stop();companion.close();throw error;}
    })().finally(()=>{this.opening=null;});
    return this.opening;
  }
  async scan(timeout=5000):Promise<CastDevice[]> {
    await this.open();
    if(this.idleTimer)clearTimeout(this.idleTimer);
    this.idleTimer=setTimeout(()=>this.closeIfIdle(),120000);this.idleTimer.unref();
    await delay(timeout);
    if(!this.connection)throw new Error('The Chrome casting window is closed.');
    return this.sinks.map(s=>({id:'chrome:'+s.id,name:s.name,model:'Google Chrome · tab casting',host:'127.0.0.1',port:0,transport:'chrome'}));
  }
  client(id:string):CastTransport {
    const sink=this.sinks.find(s=>'chrome:'+s.id===id);
    if(!sink||!this.connection)throw new Error('That Chrome receiver is no longer available. Find TVs with Chrome again.');
    if(this.idleTimer)clearTimeout(this.idleTimer);this.idleTimer=null;
    this.active=new ChromeCastClient(this,sink);return this.active;
  }
  sessionFor(id:string){return this.sinks.find(s=>s.id===id)?.session;}
  named(name:string){return this.sinks.filter(s=>s.name===name);}
  async manualChoice(){
    this.notice('Chrome found multiple receivers with the same name. In its casting window, use Chrome’s Cast menu → Sources → Cast tab, then choose your TV.');
    await this.evaluate('globalThis.AniVerseChromePlayer.manualChoice()');
    await this.call('Page.bringToFront');
  }
  async call<T=any>(method:string,params:object={}) {
    const c=this.connection;if(!c)throw new Error('Chrome casting connection is closed.');
    return c.pipe.call<T>(method,params,c.session);
  }
  async evaluate<T=any>(expression:string):Promise<T> {
    const result=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,timeout:35000});
    if(result.exceptionDetails)throw new Error(String(result.exceptionDetails.exception?.description??result.exceptionDetails.text??'Chrome player failed.').slice(0,500));
    return result.result?.value as T;
  }
  private fail(message:string){const active=this.active;this.close();active?.emit('disconnected',new Error(message));}
  closeIfIdle(){if(!this.active)this.close();}
  close() {
    this.generation++;this.active?.revoke();this.active=null;this.sinks=[];
    if(this.idleTimer)clearTimeout(this.idleTimer);this.idleTimer=null;
    const connection=this.connection;this.connection=null;
    if(connection){connection.stop();connection.companion.close();}
  }
}
class ChromeCastClient extends EventEmitter implements CastTransport {
  private closed=false;
  private started=false;
  private observedSession=false;
  constructor(private chrome:ChromeCast,private sink:Sink){super();}
  async connect(){if(this.closed)throw new Error('Chrome casting connection is closed.');}
  async launch(){}
  async load(media:Record<string,unknown>,currentTime=0):Promise<MediaStatus> {
    if(this.closed)throw new Error('Chrome casting connection is closed.');
    const metadata=media.metadata as {title?:string}|undefined;
    // The companion is loopback-only. Source pages, cookies and the desktop are never sent to Chrome.
    const input={url:media.contentId,title:metadata?.title??'AniVerse',startAt:currentTime,live:media.streamType==='LIVE',tracks:media.tracks};
    await this.chrome.evaluate('globalThis.AniVerseChromePlayer.load('+JSON.stringify(input)+')');
    if(!this.started){
      const matches=this.chrome.named(this.sink.name),manual=matches.length>1;
      const previous=new Map(matches.map(s=>[s.id,s.session]));
      if(manual)await this.chrome.manualChoice();
      else await this.chrome.call('Cast.startTabMirroring',{sinkName:this.sink.name});
      const end=Date.now()+(manual?90000:20000);
      for(;;){
        const selected=manual?this.chrome.named(this.sink.name).find(s=>s.session&&s.session!==previous.get(s.id)):
          this.chrome.named(this.sink.name).find(s=>s.id===this.sink.id&&s.session);
        if(selected){this.sink=selected;break;}
        if(this.closed)throw new Error('Chrome casting was cancelled.');
        if(Date.now()>end)throw new Error('Chrome could not establish a TV session. Check its Cast menu and the TV confirmation, then try again.');
        await delay(100);
      }
      this.started=true;this.observedSession=true;
      await this.chrome.evaluate('globalThis.AniVerseChromePlayer.casting()');
    }
    return this.media('GET_STATUS');
  }
  receiversChanged(){
    if(this.started&&this.observedSession&&!this.chrome.sessionFor(this.sink.id)){this.emit('closed');this.close();}
  }
  async media(type:'PLAY'|'PAUSE'|'STOP'|'SEEK'|'GET_STATUS',extra:Record<string,unknown>={}):Promise<MediaStatus> {
    if(this.closed)throw new Error('Chrome casting connection is closed.');
    const status=await this.chrome.evaluate<MediaStatus>('globalThis.AniVerseChromePlayer.command('+JSON.stringify(type)+','+JSON.stringify(extra.currentTime??null)+')');
    if(this.started)this.emit('media',status);return status;
  }
  async volume(value:number){await this.chrome.evaluate('globalThis.AniVerseChromePlayer.command("VOLUME",'+JSON.stringify(value)+')');}
  async stopApp(){if(this.started&&this.chrome.named(this.sink.name).length===1)await this.chrome.call('Cast.stopCasting',{sinkName:this.sink.name}).catch(()=>undefined);}
  revoke(){this.closed=true;}
  close(){if(this.closed)return;this.closed=true;this.chrome.close();}
}
