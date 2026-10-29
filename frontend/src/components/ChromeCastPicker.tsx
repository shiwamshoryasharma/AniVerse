import { Cast, ExternalLink, RefreshCw, Tv } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CastDevice } from '../../../app/shared/types';
import { call, errorText } from '../lib/bridge';
import { isCasting, useCastState } from '../player/useCastState';
/** Explicitly opens Chrome's isolated cast window; opening the AniVerse chooser alone never launches projection. */
export function ChromeCastPicker({onPick,disabled=false}:{onPick:(device:CastDevice)=>void;disabled?:boolean}) {
  const [devices,setDevices]=useState<CastDevice[]|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const mounted=useRef(true),state=useCastState();
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const scan=async()=>{
    setBusy(true);setError('');
    try{const found=await call('cast.chromeDevices');if(mounted.current)setDevices(found);}
    catch(e){if(mounted.current){setDevices([]);setError(errorText(e));}}
    finally{if(mounted.current)setBusy(false);}
  };
  const blocked=disabled||busy||isCasting(state);
  return <section className="chrome-cast-picker">
    <div className="wireless-heading"><Cast size={22}/><div><strong>Cast with Google Chrome</strong><span>Chrome’s TV discovery and tab casting</span></div></div>
    <p>Use this if Chrome can see your TV. Opens a separate Chrome window for the selected player; your normal browser profile and desktop are not shared.</p>
    <button className="btn primary" disabled={blocked} onClick={()=>void scan()}>{busy?<span className="spinner sm"/>:devices?<RefreshCw size={15}/>:<ExternalLink size={15}/>} {busy?'Chrome is finding TVs…':devices?'Find TVs again with Chrome':'Find TVs with Chrome'}</button>
    {isCasting(state)&&<p>Stop the current cast before choosing another TV.</p>}
    {!!devices?.length&&<div className="stack">{devices.filter((device,index)=>devices.findIndex(other=>other.name===device.name)===index).map(device=><button className="cast-device-card" disabled={blocked} key={device.id} onClick={()=>onPick(device)}><Tv size={19}/><span><strong>{device.name}</strong><small>Chrome tab casting</small></span><Cast size={16}/></button>)}</div>}
    {devices?.length===0&&!error&&<p role="status">Chrome found no TVs. Check that Chrome’s Cast menu can see the TV on this device, then try again.</p>}
    {error&&<p role="alert" className="err">{error}</p>}
    <p className="faint">Processing stays on this device. Chrome negotiates TV output quality; a 4K input does not guarantee a 4K tab cast. This route does not change Windows resolution.</p>
  </section>;
}
