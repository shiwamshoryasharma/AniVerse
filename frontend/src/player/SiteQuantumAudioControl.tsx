import { AudioLines } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { Range } from '../components/controls';
import { call, isAniVerse2, modernWindows } from '../lib/bridge';
import { initialQuantumIntensity, saveQuantumIntensity } from './quantumAudio';

type SiteQuantumState = 'off' | 'waiting' | 'unavailable' | 'active';
type SiteQuantumRequest = {
  webContentsId: number;
  action: 'enable' | 'off' | 'status' | 'level';
  intensity?: number;
};

async function request(input: SiteQuantumRequest): Promise<{state: SiteQuantumState}> {
  const tauri = (window as Window & {
    __TAURI__?: { core: { invoke<T>(command: string, args: unknown): Promise<T> } };
  }).__TAURI__;
  if (modernWindows && !isAniVerse2) return call('player.quantum', input);
  if (!isAniVerse2 || !tauri) return {state:'off'};
  return tauri.core.invoke('desktop_rpc', {method:'player.quantum', input});
}

export function SiteQuantumAudioControl({ id, ready }: { id: number | null; ready: boolean }) {
  const controlsId = useId();
  const [open, setOpen] = useState(false);
  const [armedId, setArmedId] = useState<number | null>(null);
  const [state, setState] = useState<SiteQuantumState>('off');
  const [intensity, setIntensity] = useState(initialQuantumIntensity);
  const level = useRef(intensity);
  const retainIntent = modernWindows && !isAniVerse2;
  const armed = id !== null && armedId === id;
  const active = armed && ready && state === 'active';

  useEffect(() => {
    if (!id || !armed || !ready) return;
    let cancelled = false;
    let timer: number | undefined;
    let action: 'enable' | 'status' = 'enable';
    let deadline = Date.now() + 9_000;
    const check = async () => {
      const result = await request({webContentsId:id, action, intensity:level.current / 100})
        .catch(() => ({state:'off' as const}));
      if (cancelled) return;
      if (result.state === 'active') {
        setState('active');
        action = 'status';
      } else if (retainIntent) {
        if (action === 'status') deadline = Date.now() + 9_000;
        action = 'enable';
        const waiting = result.state !== 'unavailable' && Date.now() < deadline;
        setState(waiting ? 'waiting' : 'unavailable');
        timer = window.setTimeout(check, waiting ? 950 : 4000);
        return;
      } else if (result.state === 'waiting' && action === 'enable' && Date.now() < deadline) {
        setState('waiting');
      } else {
        setState('unavailable');
        setArmedId(null);
        void request({webContentsId:id, action:'off'}).catch(() => {});
        return;
      }
      timer = window.setTimeout(check, action === 'enable' ? 950 : 800);
    };
    void check();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [id, armed, ready, retainIntent]);

  useEffect(() => () => {
    if (id) void request({webContentsId:id, action:'off'}).catch(() => {});
  }, [id]);

  if (!modernWindows) return null;
  return <div className="site-quantum-audio">
    <button className={'btn sm' + ((retainIntent ? armed : active) ? ' on' : '')} type="button"
      aria-label="AniVerse Quantum Audio" title="AniVerse Quantum Audio"
      aria-expanded={open} aria-controls={open ? controlsId : undefined} onClick={() => setOpen(value => !value)}>
      <AudioLines size={16} aria-hidden /> Quantum Audio
    </button>
    {open && <div id={controlsId} className="site-quantum-settings" role="group" aria-label="AniVerse Quantum Audio controls">
      <button className="btn sm" type="button" aria-label="Enable Quantum Audio" aria-pressed={retainIntent ? armed : active}
        disabled={!id || (!ready && !armed)} onClick={() => {
          if (!id) return;
          setArmedId(armed ? null : id);
          setState(armed ? 'off' : 'waiting');
          if (armed) void request({webContentsId:id, action:'off'}).catch(() => {});
        }}>{(retainIntent ? armed : active) ? 'Turn off' : armed ? 'Cancel' : 'Turn on'}</button>
      <Range ariaLabel="Quantum Audio intensity" value={intensity} min={0} max={100} step={1}
        onChange={value => {
          level.current = value;
          setIntensity(value);
          saveQuantumIntensity(value);
          if (active && id) void request({webContentsId:id, action:'level', intensity:value / 100}).catch(() => {});
        }} />
      <small role="status">{active ? 'Quantum Audio active' : armed && (!ready || state !== 'unavailable') ? 'Waiting for website audio…' :
        state === 'unavailable' ? (armed ? 'Playing original audio while Quantum Audio reconnects.' : 'Playing original audio. Try again when the website player is ready.') : ready ? 'Website audio' : 'Open an episode to use Quantum Audio.'}</small>
    </div>}
  </div>;
}
