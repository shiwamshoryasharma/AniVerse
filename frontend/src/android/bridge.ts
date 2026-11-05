import type { AniverseBridge, EventContract, EventName, RpcInput, RpcMethod, RpcOutput } from '../../../app/shared/rpc';
import type { BrowseQuery, ListStatus, MediaSnapshot, PrivacyState, ProgressSave, Provider, Settings, SourceInfo, SyncReport } from '../../../app/shared/types';
import { AniListClient } from '../../../app/core/metadata/anilist';
import { SettingsService } from '../../../app/core/settings';
import { AniListSync, MalSync } from '../../../app/core/sync/providers';
import { parseSitesConfig } from '../../../app/core/config/sitesConfig';
import { AppError } from '../../../app/core/util';
import { TabletLibrary } from './library';
import { connectNative, nativeCall, type NativeAccount, type NativeInfo } from './native';

type CacheEntry={value:unknown;expires:number;at:number};
type Edit={media:MediaSnapshot;kind:'entry'|'favourite';at:number;providers:Provider[]};
interface SavedState { surface?:'light'|'dark';navigation?:'rail'|'tabs';metadataMode?:string;settings?:Settings;library?:unknown;sources?:SourceInfo[];privateMediaIds?:number[];metadata?:Record<string,CacheEntry>;kv?:Record<string,unknown>;edits?:Edit[];noticeAccepted?:boolean }
const listeners=new Map<string,Set<(payload:unknown)=>void>>();
const emit=<E extends EventName>(event:E,payload:EventContract[E])=>listeners.get(event)?.forEach(listener=>listener(payload));
let saved:SavedState={},library=new TabletLibrary(),privacy:PrivacyState={incognito:false,privateMediaIds:[]};
let epoch=0,settings:SettingsService,metadata:AniListClient,device:NativeInfo;
let persistChain=Promise.resolve();let persistTimer:ReturnType<typeof setTimeout>|undefined;
const temporary=new Map<string,CacheEntry>();
const now=()=>Math.floor(Date.now()/1000);
function persist(){
  saved.library=library.exportData();
  const snapshot=JSON.parse(JSON.stringify(saved));
  const task=persistChain.catch(()=>undefined).then(()=>nativeCall('storage.save',{value:snapshot})).then(()=>undefined);
  persistChain=task;return task;
}
function persistLater(){clearTimeout(persistTimer);persistTimer=setTimeout(()=>void persist().catch(error=>emit('app.notice',{level:'error',message:String(error)})),1500);}
function refreshPrivacy(){library.setPrivacy(privacy);epoch++;temporary.clear();emit('privacy.changed',privacy);}
const blocked=(id:number)=>privacy.incognito||privacy.privateMediaIds.includes(id);
function edited(media:MediaSnapshot,kind:Edit['kind']){if(blocked(media.id))return;saved.edits=(saved.edits??[]).filter(row=>row.media.id!==media.id||row.kind!==kind);saved.edits.push({media,kind,at:now(),providers:['anilist','mal']});}
const browserStore={
  getKv:<T,>(key:string,fallback:T):T=>((key==='settings'?saved.settings:saved.kv?.[key])??fallback) as T,
  setKv:(key:string,value:unknown)=>{if(key==='settings')saved.settings=value as Settings;else(saved.kv??={})[key]=value;persistLater();},
  cacheContext:()=>epoch,
  cacheGet:<T,>(key:string):T|null=>{const value=(privacy.incognito||privacy.privateMediaIds.length?temporary.get(key):saved.metadata?.[key]);return value&&value.expires>now()?value.value as T:null;},
  cacheGetStale:<T,>(key:string):T|null=>{const value=(privacy.incognito||privacy.privateMediaIds.length?temporary.get(key):saved.metadata?.[key]);return value?.value as T??null;},
  cacheSet:(key:string,value:unknown,ttl:number,context:number)=>{
    if(context!==epoch)return;const entry={value,expires:now()+ttl,at:now()};
    if(privacy.incognito||privacy.privateMediaIds.length){temporary.set(key,entry);if(temporary.size>80)temporary.delete(temporary.keys().next().value!);return;}
    saved.metadata??={};saved.metadata[key]=entry;
    let entries=Object.entries(saved.metadata).sort((a,b)=>b[1].at-a[1].at);while(entries.length>24||JSON.stringify(Object.fromEntries(entries)).length>700_000)entries.pop();saved.metadata=Object.fromEntries(entries);persistLater();
  },
  libraryIds:()=>library.entries(null).map(row=>row.media.id),
};
const fetchOfficial:typeof fetch=async(url,init)=>{
  if(typeof url!=='string')throw new Error('Expected an official API URL.');
  if(init?.signal?.aborted)throw new DOMException('Request cancelled','AbortError');
  const headers=new Headers(init?.headers);
  const result=await nativeCall<{status:number;body:string;retryAfter:string}>('api.request',{url,method:init?.method??'GET',body:typeof init?.body==='string'?init.body:'',contentType:headers.get('Content-Type')?.split(';')[0]??'application/json',authenticated:headers.has('Authorization')},init?.signal??undefined);
  if(init?.signal?.aborted)throw new DOMException('Request cancelled','AbortError');
  return new Response(result.status===204?null:result.body,{status:result.status,headers:{'Content-Type':'application/json',...(result.retryAfter?{'Retry-After':result.retryAfter}:{})}});
};
function sourceInfo(url:string,name?:string):SourceInfo {
  const parsed=parseSitesConfig(url).entries[0];if(!parsed)throw new Error('Paste a valid source website URL.');
  return {...parsed,id:crypto.randomUUID(),name:name?.trim()||parsed.name,enabled:true,order:saved.sources?.length??0,adblock:false,autoCloudflare:false,searchTemplate:null,searchTemplateSource:null,searchCheckedAt:null,partition:'tablet-source',capabilities:{search:true,episodes:true,streams:false,comments:false,login:true}};
}
export const tablet={
  info:()=>device,
  surface:():'light'|'dark'=>saved.surface==='dark'?'dark':'light',
  async setSurface(mode:'light'|'dark'){
    if(mode!=='light'&&mode!=='dark')throw new Error('Choose a supported glass theme.');
    saved.surface=mode;await persist();document.documentElement.dataset.tabletSurface=mode;window.dispatchEvent(new CustomEvent('tablet-surface-changed',{detail:mode}));
  },
  navigation:():'rail'|'tabs'=>saved.navigation==='rail'?'rail':'tabs',
  async setNavigation(mode:'rail'|'tabs'){
    if(mode!=='rail'&&mode!=='tabs')throw new Error('Choose a supported navigation layout.');
    saved.navigation=mode;await persist();window.dispatchEvent(new CustomEvent('tablet-navigation-changed',{detail:mode}));
  },
  accepted:()=>saved.noticeAccepted===true,
  acceptNotice:async()=>{saved.noticeAccepted=true;await persist();},
  sources:()=>saved.sources??[],
  async reloadSources(){
    await persistChain;const stored=await nativeCall<SavedState>('storage.load');
    saved.sources=stored.sources??[];emit('sources.changed',saved.sources);return saved.sources;
  },
  async refresh(){
    await tablet.reloadSources();epoch++;temporary.clear();
    if(!privacy.incognito){for(const entry of Object.values(saved.metadata??{}))entry.expires=0;await persist();}
  },
  async saveSource(value:{id?:string;url:string;name:string;enabled:boolean}){
    const url=new URL(/^https?:\/\//i.test(value.url.trim())?value.url.trim():'https://'+value.url.trim()).href;
    await nativeCall('sources.validate',{url});
    const previous=saved.sources?.find(source=>source.id===value.id);
    const source={...sourceInfo(url,value.name),...(previous?{id:previous.id,order:previous.order}:{}),enabled:value.enabled};
    source.partition='tablet-source-'+source.id;
    if(previous&&previous.url!==url)await nativeCall('sources.clear',{id:previous.id});
    saved.sources=[...(saved.sources??[]).filter(item=>item.id!==source.id),source].sort((a,b)=>a.order-b.order);await persist();emit('sources.changed',saved.sources);return source;
  },
  async removeSource(id:string){await nativeCall('sources.clear',{id});saved.sources=(saved.sources??[]).filter(source=>source.id!==id);await persist();emit('sources.changed',saved.sources);},
  async sync(provider:Provider):Promise<SyncReport>{
    if(privacy.incognito)throw new Error('Exit incognito before syncing an account.');
    const account=(await nativeCall<NativeAccount[]>('accounts.list')).find(row=>row.provider===provider&&row.connected);if(!account)throw new Error('Connect this account first.');
    const client=provider==='anilist'?new AniListSync(metadata):new MalSync(fetchOfficial,metadata);
    const result:SyncReport={pushed:0,failed:0,pulled:0,resolved:0,errors:[]};
    emit('sync.status',{provider,state:'syncing',message:'Reading your list from the official provider…'});
    try{
      const remote=await client.pull('native-account',account.userId);
      const pending=[...(saved.edits??[])].filter(row=>row.providers.includes(provider));
      for(const edit of pending){
        if(blocked(edit.media.id))continue;
        try{
          const local=library.entries(null).find(row=>row.media.id===edit.media.id);
          const other=remote.entries.find(row=>row.media.id===edit.media.id);
          if(edit.kind==='entry'&&other&&other.updatedAt>edit.at){result.resolved++;continue;}
          const status=edit.kind==='entry'?await client.pushEntry('native-account',{mediaId:edit.media.id,idMal:edit.media.idMal},local?{status:local.status,progress:local.progress,score:local.score}:null,account.userId):await client.pushFavourite('native-account',{mediaId:edit.media.id,idMal:edit.media.idMal},library.favourites().some(row=>row.media.id===edit.media.id));
          if(status==='done')result.pushed++;
          edit.providers=edit.providers.filter(value=>value!==provider);
          const live=saved.edits?.find(row=>row.media.id===edit.media.id&&row.kind===edit.kind&&row.at===edit.at);if(live)live.providers=edit.providers;
        }catch(error){result.failed++;result.errors.push(String(error));}
      }
      const data=library.exportData();
      for(const entry of remote.entries){
        if(blocked(entry.media.id))continue;
        const edit=(saved.edits??[]).find(row=>row.media.id===entry.media.id&&row.kind==='entry'&&row.providers.includes(provider));
        const local=data.entries.find(row=>row.media.id===entry.media.id);
        if(edit&&edit.at>=entry.updatedAt)continue;
        if(local&&local.updatedAt>entry.updatedAt)continue;
        data.entries=data.entries.filter(row=>row.media.id!==entry.media.id);data.entries.push(entry);data.media=data.media.filter(row=>row.id!==entry.media.id);data.media.push(entry.media);result.pulled++;
      }
      for(const media of remote.favourites){if(blocked(media.id)||(saved.edits??[]).some(row=>row.media.id===media.id&&row.kind==='favourite'))continue;if(!data.favourites.some(row=>row.media.id===media.id))data.favourites.push({media,addedAt:now()});}
      library=new TabletLibrary(data);library.setPrivacy(privacy);saved.edits=saved.edits?.filter(row=>row.providers.length);await persist();await nativeCall('accounts.synced',{provider});
      emit('sync.status',{provider,state:result.failed?'error':'ok',message:`${result.pulled} imported, ${result.pushed} saved to account.`});return result;
    }catch(error){emit('sync.status',{provider,state:'error',message:String(error)});throw error;}
  },
};
async function dispatch(method:RpcMethod,input:unknown):Promise<unknown>{
  switch(method){
    case 'meta.home':return metadata.home();
    case 'meta.browse':return metadata.browse(input as BrowseQuery);
    case 'meta.details':return metadata.details((input as {id:number}).id);
    case 'meta.search':return metadata.search((input as {q:string}).q);
    case 'meta.schedule':{const value=input as {from:number;to:number};return metadata.schedule(value.from,value.to);}
    case 'meta.latest':return metadata.latest((input as {page:number}).page);
    case 'meta.genres':return metadata.genres();
    case 'meta.hover':return metadata.hoverInfo((input as {id:number}).id);
    case 'settings.get':return settings.get();
    case 'settings.set':{const result=settings.update(input as Partial<Settings>);await persist();return result;}
    case 'sources.list':return saved.sources??[];
    case 'sources.reload':return tablet.reloadSources();
    case 'sources.audio':return [];
    case 'sources.catalogue':throw new AppError('config','Use Open source to browse this website’s own catalogue in Android. Metadata discovery remains available in ALL.');
    case 'library.state':return library.state((input as {mediaId:number}).mediaId);
    case 'library.history':{const value=input as {limit:number;offset:number};return library.history(value.limit,value.offset);}
    case 'library.continue':return library.continueWatching();
    case 'library.entries':return library.entries((input as {status:ListStatus|null}).status);
    case 'library.favourites':return library.favourites();
    case 'library.saveProgress':{const value=input as ProgressSave;const result=library.saveProgress(value);if(result.completedNow)edited(value.media,'entry');await persist();return result;}
    case 'library.markWatched':{const value=input as {media:MediaSnapshot;episode:number;watched:boolean};library.markWatched(value.media,value.episode,value.watched);edited(value.media,'entry');break;}
    case 'library.clearHistory':library.clearHistory((input as {id:number|null}).id);break;
    case 'library.dismissContinue':library.dismissContinue((input as {mediaId:number}).mediaId);break;
    case 'library.toggleFavourite':{const media=(input as {media:MediaSnapshot}).media;const result=library.toggleFavourite(media);edited(media,'favourite');await persist();return result;}
    case 'library.setStatus':{const value=input as {media:MediaSnapshot;status:ListStatus|null};library.setStatus(value.media,value.status);edited(value.media,'entry');break;}
    case 'library.setScore':{const value=input as {media:MediaSnapshot;score:number|null};library.setScore(value.media,value.score);edited(value.media,'entry');break;}
    case 'privacy.state':return privacy;
    case 'privacy.incognito':{privacy={...privacy,incognito:(input as {on:boolean}).on};await nativeCall('privacy.set',{incognito:privacy.incognito});refreshPrivacy();return privacy;}
    case 'privacy.title':{const value=input as {mediaId:number;on:boolean};saved.privateMediaIds=[...new Set([...(saved.privateMediaIds??[]).filter(id=>id!==value.mediaId),...(value.on?[value.mediaId]:[])])];privacy={...privacy,privateMediaIds:saved.privateMediaIds};refreshPrivacy();await persist();return privacy;}
    case 'accounts.list':return nativeCall('accounts.list');
    case 'accounts.disconnect':return nativeCall('accounts.disconnect',input as {provider:Provider});
    case 'accounts.sync':return tablet.sync((input as {provider:Provider}).provider);
    case 'app.openExternal':return nativeCall('external.open',input as {url:string});
    default:throw new AppError('config','This desktop feature is not available in the Android tablet edition.');
  }
  await persist();return undefined;
}
export async function installTabletBridge(){
  connectNative();const [state,info,privateState]=await Promise.all([nativeCall<SavedState>('storage.load'),nativeCall<NativeInfo>('native.info'),nativeCall<{incognito:boolean}>('privacy.state')]);saved=state;device=info;
  library=new TabletLibrary(saved.library);privacy={incognito:privateState.incognito,privateMediaIds:saved.privateMediaIds??[]};library.setPrivacy(privacy);
  settings=new SettingsService(browserStore);
  metadata=new AniListClient(fetchOfficial,browserStore,{showAdult:()=>settings.get().appearance.showAdult,token:()=>null});
  const metadataMode=device.fixture?'fixture':'official';
  if(saved.metadataMode!==metadataMode){saved.metadata={};saved.metadataMode=metadataMode;await persist();}
  window.aniverse={platform:'android',invoke:async<M extends RpcMethod>(method:M,input:RpcInput<M>)=>dispatch(method,input) as Promise<RpcOutput<M>>,on:<E extends EventName>(event:E,listener:(payload:EventContract[E])=>void)=>{const set=listeners.get(event)??new Set();listeners.set(event,set);set.add(listener as (payload:unknown)=>void);return()=>set.delete(listener as (payload:unknown)=>void);}} satisfies AniverseBridge;
  document.documentElement.dataset.platform='android';
  document.documentElement.dataset.tabletSurface=tablet.surface();
  window.addEventListener('tablet-progress',event=>{const value=(event as CustomEvent<ProgressSave>).detail;try{const completed=library.saveProgress(value);if(completed.completedNow)edited(value.media,'entry');persistLater();}catch{/* Invalid page observations never grant native access. */}});
}
