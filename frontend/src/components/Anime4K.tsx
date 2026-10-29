import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { CompatibilityUpscale } from './CompatibilityUpscale';
import { capturePlayer, stopPlayerCapture, type PlayerCaptureSession } from '../lib/playerCapture';
import type { UpscaleStatus } from '../../../app/shared/upscale';
import { useSettings, useUpdateSettings } from '../lib/queries';
import { call, errorText, onEvent } from '../lib/bridge';
import { useToast } from '../lib/useToast';
import { Switch } from './common';

const MODES = [['A', 'Most 1080p'], ['B', 'Soft restore'], ['C', 'Denoise'], ['A+A', 'Stronger restore'], ['B+B', 'Double soft'], ['C+A', 'Denoise + restore']] as const;
export function Anime4KPanel({ status }: { status?: UpscaleStatus }) {
  const options = useSettings().player.upscale, update = useUpdateSettings(), toast = useToast();
  const save = (patch: Partial<typeof options>) => update.mutate({ player: { upscale: patch } }, { onError: (e) => toast.push({ level: 'error', message: e.message }) });
  return <div className="anime4k-panel stack">
    <div className="row"><strong className="grow">Anime4K Upscale</strong><Switch label="Enable Anime4K Upscale" on={options.enabled} onChange={(enabled) => save({ enabled })} /></div>
    <p role="status" className="faint">{status?.message ?? (options.enabled ? 'Enabled · applies to compatible native and website players' : 'Browser upscaling is off')}</p>
    <div className="anime4k-modes" role="group" aria-label="Anime4K preset">{MODES.map(([mode, description]) =>
      <button className={'btn ' + (options.mode === mode ? 'primary' : '')} aria-pressed={options.mode === mode} key={mode} onClick={() => save({ mode })}><b>{mode.length === 1 ? 'Mode ' + mode : mode}</b><small>{description}</small></button>)}</div>
    <label className="row"><span className="grow">Darken lines<small>Makes outlines bolder</small></span><Switch label="Darken lines" on={options.darken} onChange={(darken) => save({ darken })} /></label>
    <label className="row"><span className="grow">Thin lines<small>Refines line weight</small></span><Switch label="Thin lines" on={options.thin} onChange={(thin) => save({ thin })} /></label>
    <p className="faint">When rendering falls behind playback, AniVerse tries lighter processing and returns to the original picture if needed. It keeps the original audio and media clock.</p>
    <p className="faint">GPU filtering targets up to 3840 × 2160 while preserving aspect ratio. It does not create missing source detail. CORS, protected video, PiP and receiver playback can limit browser filtering. Sender-side 4K casting uses the separate embedded encoder.</p>
  </div>;
}
export function Anime4KSurface({ video, sourceKey, disabled }: { video: RefObject<HTMLVideoElement | null>; sourceKey: string; disabled: boolean }) {
  const options = useSettings().player.upscale;
  const [status, setStatus] = useState<UpscaleStatus>({ state: 'off', message: 'Anime4K is off' });
  const [attempt, setAttempt] = useState(0), canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = video.current, target = canvas.current;
    if (!element || !target || !options.enabled || disabled) { setStatus({ state: 'off', message: 'Anime4K is off' }); return; }
    let cancelled = false, dispose: (() => void) | undefined;
    void import('../../../app/shared/upscaleRuntime').then(({ attachAnime4K }) => {
      if (!cancelled) dispose = attachAnime4K(element, target, options, setStatus);
    }).catch(() => setStatus({ state: 'unavailable', message: 'Anime4K could not be loaded.' }));
    return () => { cancelled = true; dispose?.(); };
  }, [video, sourceKey, options, disabled, attempt]);
  // A lost context requires a fresh canvas; each settings change remounts it.
  return <><canvas key={attempt} ref={canvas} className="anime4k-canvas" aria-hidden="true" />
    {options.enabled && !disabled && <button className={'anime4k-status ' + status.state} onClick={() => status.state === 'unavailable' && setAttempt((v) => v + 1)} title={status.message} role="status">{status.message}</button>}</>;
}
export function SiteAnime4K({ webContentsId, surface }: { webContentsId: number; surface: RefObject<HTMLDivElement | null> }) {
  const options = useSettings().player.upscale;
  const [status,setStatus]=useState<UpscaleStatus>(),[compatStatus,setCompatStatus]=useState<UpscaleStatus>();
  const [capture,setCapture]=useState<PlayerCaptureSession|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const current=useRef<PlayerCaptureSession|null>(null),mounted=useRef(true),generation=useRef({});
  const stop=useCallback(async()=>{
    generation.current={};
    const owned=current.current;current.current=null;
    if(owned)await stopPlayerCapture(owned);
    if(mounted.current)setCapture(null);
  },[]);
  useEffect(()=>{
    mounted.current=true;
    return()=>{mounted.current=false;generation.current={};const owned=current.current;current.current=null;if(owned)void stopPlayerCapture(owned);};
  },[]);
  useEffect(()=>onEvent('player.captureEnded',event=>{if(event.ticket===current.current?.ticket)void stop();}),[stop]);
  useEffect(()=>{if(!options.enabled)void stop();},[options.enabled,stop]);
  useEffect(() => {
    let disposed = false, active = false;
    const tick = async () => {
      if (active) return; active = true;
      try { const state = await call('player.upscale', { webContentsId, options: capture ? {...options,enabled:false}:options }); if (!disposed&&!capture) setStatus(state); }
      catch (e) { if (!disposed&&!capture) setStatus({ state: 'unavailable', message: errorText(e) }); }
      finally { active = false; }
    };
    void tick(); const timer = window.setInterval(() => void tick(), 3000);
    return () => { disposed = true; clearInterval(timer); void call('player.upscale', { webContentsId, options: { ...options, enabled: false } }).catch(() => undefined); };
  }, [webContentsId, options,capture]);
  const start=async()=>{
    if(busy)return;setBusy(true);setError('');
    try{
      const request={};generation.current=request;
      const session=await capturePlayer(webContentsId,()=>mounted.current&&generation.current===request);
      if(!mounted.current){await stopPlayerCapture(session);return;}
      current.current=session;
      session.stream.getVideoTracks()[0]?.addEventListener('ended',()=>{if(current.current===session)void stop();},{once:true});
      setCompatStatus({state:'waiting',message:'Starting compatibility upscaling…'});setCapture(session);
    }catch(e){if(mounted.current)setError(errorText(e));}
    finally{if(mounted.current)setBusy(false);}
  };
  const shown=capture?compatStatus:status;
  return <div className="card site-anime4k">
    <details><summary>Anime4K Upscale <span className="faint" role="status">{shown?.message}</span></summary><Anime4KPanel status={shown}/></details>
    {options.enabled&&<div className="compatibility-upscale-actions">
      {capture?<button className="btn" onClick={()=>void stop()}>Stop compatibility upscaling</button>:<button className="btn primary" disabled={busy} onClick={()=>void start()}>{busy?'Starting capture…':'Use compatibility upscaling'}</button>}
      <p>For websites that block direct video filtering. Captures only this site view, applies Anime4K on this device, and keeps the original player’s audio and controls. Use player-only mode for best results. Protected video may still block capture.</p>
      {error&&<p className="err" role="alert">{error}</p>}
    </div>}
    {capture&&options.enabled&&surface.current&&createPortal(<CompatibilityUpscale capture={capture} options={options} onStatus={setCompatStatus}/>,surface.current)}
  </div>;
}
