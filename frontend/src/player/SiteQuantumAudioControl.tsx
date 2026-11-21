import { AudioLines } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Range } from '../components/controls';
import { isAniVerse2 } from '../lib/bridge';
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
  if (!isAniVerse2 || !tauri) return {state:'off'};
  return tauri.core.invoke('desktop_rpc', {method:'player.quantum', input});
}

export function SiteQuantumAudioControl({ id, ready }: { id: number | null; ready: boolean }) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [state, setState] = useState<SiteQuantumState>('off');
  const [intensity, setIntensity] = useState(initialQuantumIntensity);
  const level = useRef(intensity);
  const active = armed && ready && state === 'active';

  useEffect(() => {
    if (!id || !armed || !ready) return;
    let cancelled = false;
    let timer: number | undefined;
    let action: 'enable' | 'status' = 'enable';
    const deadline = Date.now() + 9_000;
    const check = async () => {
      const result = await request({webContentsId:id, action, intensity:level.current / 100})
        .catch(() => ({state:'off' as const}));
      if (cancelled) return;
      if (result.state === 'active') {
        setState('active');
        action = 'status';
      } else if (result.state === 'waiting' && action === 'enable' && Date.now() < deadline) {
        setState('waiting');
      } else {
        setState('unavailable');
        setArmed(false);
        void request({webContentsId:id, action:'off'}).catch(() => {});
        return;
      }
      timer = window.setTimeout(check, action === 'enable' ? 950 : 800);
    };
    void check();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [id, armed, ready]);

  useEffect(() => () => {
    if (id) void request({webContentsId:id, action:'off'}).catch(() => {});
  }, [id]);

  if (!isAniVerse2) return null;
  return <div className="site-quantum-audio">
    <button className={'btn ghost sm' + (active ? ' on' : '')} type="button"
      aria-label="AniVerse Quantum Audio" title="AniVerse Quantum Audio"
      aria-expanded={open} onClick={() => setOpen(value => !value)}><AudioLines size={17} /></button>
    {open && <div className="site-quantum-settings" aria-label="AniVerse Quantum Audio controls">
      <button className="btn sm" type="button" aria-label="Enable Quantum Audio" aria-pressed={active}
        disabled={!id || (!ready && !armed)} onClick={() => {
          if (!id) return;
          setArmed(!armed);
          setState(armed ? 'off' : 'waiting');
          if (armed) void request({webContentsId:id, action:'off'}).catch(() => {});
        }}>{active ? 'Turn off' : armed ? 'Cancel' : 'Turn on'}</button>
      <Range ariaLabel="Quantum Audio intensity" value={intensity} min={0} max={100} step={1}
        onChange={value => {
          level.current = value;
          setIntensity(value);
          saveQuantumIntensity(value);
          if (active && id) void request({webContentsId:id, action:'level', intensity:value / 100}).catch(() => {});
        }} />
      <small role="status">{active ? 'Quantum Audio active' : armed ? 'Waiting for website audio…' :
        state === 'unavailable' ? 'Playing original audio. Try again when the website player is ready.' : 'Website audio'}</small>
    </div>}
  </div>;
}
