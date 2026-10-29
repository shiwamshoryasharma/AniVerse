import { Cast, MonitorPlay, RefreshCw, ScreenShareOff, Tv, X } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { CastDevice } from '../../../app/shared/types';
import type { PlayerControls } from '../player/VideoPlayer';
import { useCastState, isCasting } from '../player/useCastState';
import { useToast } from '../lib/useToast';
import { call, errorText, onEvent } from '../lib/bridge';
import { startWebsiteMirror } from '../lib/websiteMirror';
import { Switch } from './common';
export function EpisodeCast({ native, webContentsId, title }: { native: RefObject<PlayerControls | null>; webContentsId: number | null; title: string }) {
  const state = useCastState(), toast = useToast();
  const [open, setOpen] = useState(false), [devices, setDevices] = useState<CastDevice[] | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [upscale, setUpscale] = useState(false), [audio, setAudio] = useState(true);
  const [capture, setCapture] = useState(false), dialog = useRef<HTMLDialogElement>(null), stopRef = useRef<(() => void) | null>(null);
  const mounted = useRef(true), [available, setAvailable] = useState(false);
  const scan = async () => { setDevices(null); setError(''); try { setDevices(await call('cast.devices')); } catch (e) { setDevices([]); setError(errorText(e)); } };
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); if (!open) dialog.current?.close(); }, [open]);
  useEffect(() => onEvent('cast.status', (next) => {
    if (['idle', 'error', 'ended'].includes(next.status) && stopRef.current) { stopRef.current(); stopRef.current = null; setCapture(false); }
  }), []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopRef.current?.(); }; }, []);
  const start = async (device: CastDevice) => {
    if (!webContentsId || busy) return;
    setBusy(true); setError('');
    let ticket: string | null = null;
    try {
      ticket = (await call('cast.mirrorPrepare', { webContentsId, deviceId: device.id, title, upscale })).ticket;
      const stop = await startWebsiteMirror(ticket, audio, (message) => toast.push({ level: 'error', message }));
      if (!mounted.current) { stop(); return; }
      stopRef.current = stop; setCapture(true); setOpen(false);
      toast.push({ level: 'info', message: 'Preparing the TV stream. Keep the episode playing; mirroring has a short delay.' });
    } catch (e) { if (ticket) void call('cast.mirrorStop', { ticket }).catch(() => undefined); setError(errorText(e)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const stop = () => { stopRef.current?.(); stopRef.current = null; setCapture(false); void call('cast.stop').catch((e) => toast.push({ level: 'error', message: errorText(e) })); };
  return <div className="episode-casting">
    {isCasting(state) && <button className="btn sm" onClick={stop}><ScreenShareOff size={15} />Stop casting</button>}
    <button className="btn primary episode-cast-button" disabled={busy} onClick={() => {
      if (native.current) native.current.openCast();
      else if (webContentsId) { setOpen(true); void scan(); void call('cast.capabilities').then((s) => setAvailable(s.available)).catch(() => undefined); }
      else toast.push({ level: 'info', message: 'Start an episode or open a video first, then choose Cast to TV.' });
    }}><Tv size={18} />{busy ? 'Preparing TV…' : 'Cast to TV'}</button>
    {capture && <span role="status" className="mirror-live-indicator"><Cast size={13} />{state.status === 'connecting' ? 'Preparing website stream…' : 'Mirroring to ' + state.device?.name}</span>}
    <dialog ref={dialog} className="episode-cast-dialog" aria-label="Cast episode to TV" onCancel={(e) => { e.preventDefault(); if (!busy) setOpen(false); }}>
      <header><div className="row"><Tv size={23} /><div><h2>Cast episode to TV</h2><p>{title}</p></div></div><button className="icon-btn" aria-label="Close TV chooser" disabled={busy} onClick={() => setOpen(false)}><X size={19} /></button></header>
      <div className="stack"><div className="mirror-explanation"><MonitorPlay size={21} /><div><strong>Mirror this website’s player</strong><p>Sends the selected site view and its audio to your TV. Your desktop and other apps are not captured. Keep the player visible; leaving the episode stops mirroring. Protected video may not be capturable.</p></div></div>
        <label className="row between">Include website audio<Switch label="Include website audio" on={audio} onChange={setAudio} disabled={busy} /></label>
        <label className="row between">Anime4K · process 4K on this device<Switch label="Mirror in 4K" on={upscale} onChange={setUpscale} disabled={busy || !available} /></label>
        <p className="faint">Standard mirroring uses H.264 at 1080p. 4K needs a Vulkan-capable sender and a 4K HEVC Cast receiver. All filtering and encoding run here. TV playback is delayed by a few seconds; use the website player to seek.</p>
        <div className="row between"><strong>Available TVs</strong><button className="btn sm" disabled={busy || devices === null} onClick={() => void scan()}><RefreshCw size={13} />Scan again</button></div>
        {devices === null ? <p className="row faint"><span className="spinner sm" />Looking for Chromecast / Google TV…</p> : !devices.length ? <div className="cast-empty"><Tv size={26} /><p>{error || 'No Cast TV found. Connect your TV and this device to the same local network.'}</p></div> :
          devices.map((device) => <button className="cast-device-card" disabled={busy || !available} key={device.id} onClick={() => void start(device)}><Tv size={20} /><span><strong>{device.name}</strong><small>{device.model}</small></span><Cast size={17} /></button>)}
        {!!error && !!devices?.length && <p className="err" role="alert">{error}</p>}
      </div>
    </dialog>
  </div>;
}
