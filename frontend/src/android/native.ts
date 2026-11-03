export interface NativeInfo {
  version: string; platform: 'android'; buildType:string; fixture:boolean; sdkInt: number; tablet: boolean; smallestWidthDp: number; securityPatch: string; webViewVersion: string; webViewUpdatedAtMs:number; upscaling: false;
  sandbox: { appPrivateStorage: boolean; originRestrictedBridge: boolean; websiteNativeBridge: false; multiProfile: boolean };
}
export interface OfflineVideo { id:string; title:string; bytes:number; durationMs:number; positionMs:number; subtitleName:string|null; addedAt:number }
export interface OfflineLibrary { items:OfflineVideo[]; usedBytes:number; freeBytes:number }
export interface DownloadItem { id:string;title:string;host:string;status:'queued'|'running'|'paused'|'failed'|'complete';bytes:number;totalBytes:number;resumable:boolean;speedBytesPerSecond:number;error:string|null }
export interface NativeAccount { provider:'anilist'|'mal';connected:boolean;userId:number;userName:string|null;avatar:string|null;lastSyncAt:number|null }
interface NativeChannel { postMessage:(message:string)=>void; onmessage:((event:{data:string})=>void)|null }
declare global { interface Window { AniVerseNative?:NativeChannel } }
const waiting=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
let sequence=0;
export function connectNative(){
  const channel=window.AniVerseNative;if(!channel)throw new Error('Open AniVerse in its Android tablet app.');
  channel.onmessage=event=>{try{const reply=JSON.parse(event.data);const id=String(reply.id);const task=waiting.get(id);if(!task)return;waiting.delete(id);clearTimeout(task.timer);if(reply.error)task.reject(new Error(String(reply.error.message??'Native request failed.')));else task.resolve(reply.result);}catch{/* Invalid native messages have no authority. */}};
}
export function nativeCall<T=unknown>(method:string,input:Record<string,unknown>={}):Promise<T>{
  return new Promise((resolve,reject)=>{
    const channel=window.AniVerseNative;if(!channel){reject(new Error('The Android host is unavailable.'));return;}
    const id='tablet-'+(++sequence);const packet=JSON.stringify({id,method,input});const limit=method==='storage.save'?4*1024*1024:64*1024;
    if(new TextEncoder().encode(packet).byteLength>limit){reject(new Error('Request exceeds its size budget.'));return;}
    const timer=setTimeout(()=>{waiting.delete(id);reject(new Error('The Android request timed out.'));},['offline.import','offline.subtitle'].includes(method)?75*60_000:method==='accounts.configure'?15*60_000:35_000);
    waiting.set(id,{resolve:resolve as (value:unknown)=>void,reject,timer});
    try{channel.postMessage(packet);}catch(error){waiting.delete(id);clearTimeout(timer);reject(error);}
  });
}
