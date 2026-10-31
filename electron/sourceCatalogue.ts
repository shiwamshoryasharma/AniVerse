import {BrowserWindow} from 'electron';
import type {SourceInfo,SourceCataloguePage,SourceCatalogueRequest} from '../app/shared/types';
import {catalogueMatches} from '../app/shared/audioAvailability';
import {buildSearchUrl} from '../app/core/sources/web';
import {discoveryScore} from '../app/core/metadata/search';
import type {AniListClient} from '../app/core/metadata/anilist';
import type {RustPolicy} from '../app/core/security/rustPolicy';
import {AppError,sleep} from '../app/core/util';
import {isChallengeTitle} from '../app/core/net/cloudflare';
import type {SessionManager} from './sessions';
import type {EpisodeArtwork} from './episodeArtwork';
import {catalogueScript,type CatalogueSnapshot} from './cataloguePage';
import {pageScript,type PageOp} from './sitePage';
interface Context {window:BrowserWindow;key:string;page:number;loaded:number}
/** One bounded source browser; public catalogue DOM only, never private APIs or media URLs. */
export class SourceCatalogue {
 private current:Context|null=null;
 private tail:Promise<unknown>=Promise.resolve();
 private queued=0;private epoch=0;private idle:NodeJS.Timeout|undefined;
 constructor(private sources:()=>SourceInfo[],private sessions:SessionManager,private security:RustPolicy,private artwork:EpisodeArtwork,private anilist:AniListClient){}
 close(){this.epoch++;clearTimeout(this.idle);if(this.current&&!this.current.window.isDestroyed())this.current.window.destroy();this.current=null;}
 list(request:SourceCatalogueRequest):Promise<SourceCataloguePage>{
  if(this.queued>=16)return Promise.reject(new AppError('network','The catalogue is busy. Try again shortly.'));
  const epoch=this.epoch;this.queued++;
  // React Query may reuse an in-flight category when toggled back quickly.
  // Serialize reads without cancelling a result another mounted query still needs.
  const run=()=>this.read(request,epoch);
  const work=this.tail.then(run,run);
  this.tail=work.catch(()=>undefined);return work.finally(()=>{this.queued--;if(epoch===this.epoch&&this.current){clearTimeout(this.idle);this.idle=setTimeout(()=>this.close(),120000);this.idle.unref();}});
 }
 private async read(request:SourceCatalogueRequest,epoch:number):Promise<SourceCataloguePage>{
  const deadline=Date.now()+40000;
  const source=this.sources().find(source=>source.id===request.sourceId&&source.enabled&&source.kind==='web');
  if(!source)throw new AppError('not-found','Choose an enabled website source.');
  if(epoch!==this.epoch)throw new AppError('network','Catalogue request cancelled.');
  clearTimeout(this.idle);
  const search=request.query?.search?.trim()??'',key=source.partition+':'+source.url+':'+request.audio+':'+search;
  if(!this.current||this.current.window.isDestroyed()||this.current.key!==key||this.current.page>request.page||Date.now()-this.current.loaded>60000){
   if(this.current&&!this.current.window.isDestroyed())this.current.window.destroy();
   const window=new BrowserWindow({show:false,width:1440,height:1000,skipTaskbar:true,webPreferences:{session:this.sessions.ensure(source),sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,autoplayPolicy:'document-user-activation-required',backgroundThrottling:true}});
   const wc=window.webContents;wc.setAudioMuted(true);wc.setWindowOpenHandler(()=>({action:'deny'}));
   const guard=(event:Electron.Event,url:string)=>{if(!this.security.decide({context:'navigate',url,source:source.url}).allowed)event.preventDefault();};
   wc.on('will-navigate',guard);wc.on('will-redirect',guard);
   wc.on('dom-ready',()=>{void wc.executeJavaScriptInIsolatedWorld(1017,[{code:'document.addEventListener("play",event=>event.target.pause?.(),true);document.querySelectorAll("video,audio").forEach(media=>media.pause());'}]).catch(()=>undefined);});
   this.current={window,key,page:1,loaded:Date.now()};
   const start=search&&source.searchTemplate?buildSearchUrl(source.searchTemplate,search):source.url;
   let timer:NodeJS.Timeout|undefined;
   try{await Promise.race([wc.loadURL(start),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new AppError('network','The source catalogue took too long to load.')),25000);timer.unref();})]);}
   catch(error){if(!wc.isDestroyed())window.destroy();this.current=null;throw error;}
   finally{clearTimeout(timer);}
   await sleep(700);
   if(search&&!source.searchTemplate){
    const operate=(op:PageOp)=>wc.executeJavaScriptInIsolatedWorld(1017,[{code:pageScript(op)}]);
    let input=await operate({op:'openSearch',attempt:-1});
    for(let attempt=0;!input?.input&&attempt<4;attempt++){await operate({op:'openSearch',attempt});await sleep(400);input=await operate({op:'openSearch',attempt:-1});}
    if(!input?.input||!(await operate({op:'fillSearch',query:search}))?.ok)throw new AppError('not-found','Open the source to search this title.');
    for(const type of ['keyDown','char','keyUp'] as const)wc.sendInputEvent({type,keyCode:type==='char'?'\r':'Enter'});
    await sleep(1200);await operate({op:'viewAll'});await sleep(400);
   }
  }
  const context=this.current!,alive=()=>epoch===this.epoch&&this.current===context&&!context.window.isDestroyed()&&Date.now()<deadline;
  const page=async(kind:'read'|'filter'|'next')=>{
   if(!alive())throw new AppError('network','Catalogue request cancelled.');
   if(isChallengeTitle(context.window.webContents.getTitle()))throw new AppError('cloudflare','Open this source to complete its security check, then retry the catalogue.');
   return context.window.webContents.executeJavaScriptInIsolatedWorld(1017,[{code:catalogueScript({kind,audio:request.audio,search:!!search})}]);
  };
  const settle=async(previous?:string)=>{
   const limit=Math.min(deadline,Date.now()+15000);let last:CatalogueSnapshot|undefined,stable='',since=0;
   while(alive()&&Date.now()<limit){
    try{
     last=await page('read') as CatalogueSnapshot;
     const signature=last.items.map(item=>item.url).join('|'),selected=!last.canFilter||last.active===request.audio;
     if(last.canFilter&&last.active!==request.audio)await page('filter');
     const suitable=!last.canFilter||request.audio==='all'||last.items.every(item=>catalogueMatches(item,request.audio,request.audio));
     if((last.items.length||last.empty)&&selected&&suitable&&(!previous||signature!==previous)){
      if(stable!==signature){stable=signature;since=Date.now();}
      if(Date.now()-since>=400)return last;
     }
    }catch(error){if(error instanceof AppError)throw error;}
    await sleep(200);
   }
   if(last&&(last.items.length||last.empty)&&(!last.canFilter||last.active===request.audio)&&(!previous||last.items.map(item=>item.url).join('|')!==previous))return last;
   throw new AppError('network','The source did not provide a readable catalogue. Open the source or try another.');
  };
  let snapshot=await settle();
  while(context.page<request.page){
   if(!snapshot.hasNext)break;
   const before=snapshot.items.map(item=>item.url).join('|');
   if(!await page('next'))break;
   snapshot=await settle(before);context.page++;
  }
  if(!alive())throw new AppError('network','Catalogue request cancelled.');
  const category=snapshot.active==='dub'||snapshot.active==='sub'?snapshot.active:'all';
  if(!snapshot.canFilter&&!snapshot.items.some(item=>item.sub!==null||item.dub!==null))throw new AppError('not-found','This source does not expose readable SUB/DUB catalogue badges. Try another source.');
  const eligible=snapshot.items.filter(item=>catalogueMatches(item,request.audio,category)&&(!search||source.searchTemplate||discoveryScore(search,[item.title])>=.55));
  let metadataError=false;
  const media=await this.anilist.catalogueCards(eligible.flatMap(item=>item.anilistId?[item.anilistId]:[]),request.query).catch(()=>{metadataError=true;return [];});
  if(!alive())throw new AppError('network','Catalogue request cancelled.');
  const metadataFilters=Object.entries(request.query??{}).some(([key,value])=>!['search','page','perPage','sort'].includes(key)&&value!==undefined&&value!==false&&(!Array.isArray(value)||value.length>0));
  const items=eligible.flatMap(item=>{
   const match=media.find(card=>card.id===item.anilistId);
   if(item.anilistId&&!match&&!metadataError)return [];
   if(!match&&metadataFilters)return [];
   const checked=match&&discoveryScore(item.title,[match.title.english,match.title.romaji,match.title.native,match.title.userPreferred])>=.75?match:null;
   return [{title:item.title,url:item.url,cover:checked?.cover||(item.image?this.artwork.grant(context.window.webContents,item.image):null),sub:item.sub,dub:item.dub,total:item.total,media:checked}];
  });
  if(request.query?.sort==='SCORE_DESC')items.sort((a,b)=>(b.media?.score??0)-(a.media?.score??0));
  return {items,sourceId:source.id,sourceName:source.name,page:context.page,hasNext:snapshot.hasNext,audio:request.audio,metadataError};
 }
}
