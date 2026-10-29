import { useEffect,useRef } from 'react';
import type { UpscaleSettings,UpscaleStatus } from '../../../app/shared/upscale';
import type { PlayerCaptureSession } from '../lib/playerCapture';
export function CompatibilityUpscale({capture,options,onStatus}:{capture:PlayerCaptureSession;options:UpscaleSettings;onStatus:(status:UpscaleStatus)=>void}){
  const video=useRef<HTMLVideoElement>(null),canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    const element=video.current,target=canvas.current;if(!element||!target)return;
    let cancelled=false,dispose:(()=>void)|undefined;
    element.srcObject=capture.stream;
    void element.play().then(()=>import('../../../app/shared/upscaleRuntime')).then(({attachAnime4K})=>{
      if(!cancelled)dispose=attachAnime4K(element,target,options,status=>onStatus({...status,message:'Compatibility · '+status.message}));
    }).catch(()=>{if(!cancelled)onStatus({state:'unavailable',message:'Compatibility capture could not start. Keep the source player visible and try again.'});});
    return()=>{cancelled=true;dispose?.();element.pause();element.srcObject=null;};
  },[capture,options,onStatus]);
  return <div className="compatibility-upscale-surface" aria-hidden="true"><video ref={video} muted playsInline/><canvas key={JSON.stringify(options)} ref={canvas}/></div>;
}
