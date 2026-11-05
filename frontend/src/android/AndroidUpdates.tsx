import { Download, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { nativeCall } from './native';
import { tablet } from './bridge';

interface UpdateState {
  state:'current'|'available'|'unavailable';
  currentVersion:string; currentVersionCode:number;
  version?:string; tag?:string; releaseUrl?:string; message:string;
}
let cached:UpdateState|undefined;
let checking:Promise<UpdateState>|undefined;
async function check(){
  checking??=nativeCall<UpdateState>('updates.check').then(value=>{
    cached=value;window.dispatchEvent(new CustomEvent('tablet-update-changed',{detail:value}));return value;
  }).finally(()=>{checking=undefined;});
  return checking;
}
export function AndroidUpdateNotice(){
  const [update,setUpdate]=useState(cached);
  useEffect(()=>{
    const listener=(event:Event)=>setUpdate((event as CustomEvent<UpdateState>).detail);
    window.addEventListener('tablet-update-changed',listener);
    const timer=setTimeout(()=>{if(tablet.info().buildType==='release')void check().catch(()=>undefined);},3000);
    return()=>{clearTimeout(timer);window.removeEventListener('tablet-update-changed',listener);};
  },[]);
  if(update?.state!=='available')return null;
  return <a className="tablet-update-notice" href="#/settings">AniVerse {update.version} is available · Open Settings to update</a>;
}
export function AndroidUpdates(){
  const [update,setUpdate]=useState(cached);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const run=async(install=false)=>{
    setBusy(true);setMessage('');
    try{
      if(install&&update?.tag){
        const result=await nativeCall<{state:string;message:string}>('updates.install',{tag:update.tag});
        setMessage(result.message);
      }else setUpdate(await check());
    }catch(error){setMessage(error instanceof Error?error.message:String(error));}
    finally{setBusy(false);}
  };
  return <section className="tablet-settings-card card" aria-labelledby="android-updates-heading">
    <div className="tablet-settings-title"><ShieldCheck size={24}/><div>
      <h2 id="android-updates-heading">App updates</h2>
      <p>Installed version {tablet.info().version}. Updates come from the Android GitHub releases.</p>
    </div></div>
    <p role="status">{message||(busy?'Checking or preparing the verified update…':update?.message??'Check for a newer Android release.')}</p>
    <div className="row wrap gap">
      <button className="btn" disabled={busy} onClick={()=>void run()}><RefreshCw size={18}/> Check for updates</button>
      {update?.state==='available'&&<button className="btn primary" disabled={busy} onClick={()=>void run(true)}><Download size={18}/> Update to {update.version}</button>}
    </div>
    <p className="faint">The APK must match this app’s package and signing certificate. Android asks for your approval before installing; your app data stays in place.</p>
  </section>;
}
