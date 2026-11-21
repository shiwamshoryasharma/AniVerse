import { AudioLines } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Range } from '../components/controls';
import { isAniVerse2 } from '../lib/bridge';
import { canUseQuantumAudio, openQuantumAudio } from './quantumAudio';

const intensityKey = 'aniverse2.quantum-intensity';

function initialIntensity() {
  try {
    const stored = localStorage.getItem(intensityKey);
    if (stored !== null && /^\d{1,3}$/.test(stored)) return Math.min(100, Number(stored));
  } catch { /* Preferences are optional. */ }
  return 50;
}

export function QuantumAudioUnavailable() {
  if (!isAniVerse2) return null;
  return <button className="btn ghost sm" type="button" disabled
    aria-label="AniVerse Quantum Audio unavailable for this source"
    title="This source plays with its original audio."><AudioLines size={17} /></button>;
}

export function QuantumAudioControl({ video, url }: { video: RefObject<HTMLVideoElement | null>; url: string }) {
  const graph = useRef<Awaited<ReturnType<typeof openQuantumAudio>> | null>(null);
  const generation = useRef(0);
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [intensity, setIntensity] = useState(initialIntensity);
  const supported = isAniVerse2 && canUseQuantumAudio(url);
  useEffect(() => () => {
    generation.current++;
    graph.current?.close();
    graph.current = null;
  }, [url]);
  useEffect(() => graph.current?.setIntensity(enabled ? intensity / 100 : 0), [enabled, intensity]);

  const toggle = async () => {
    if (enabled) { setEnabled(false); return; }
    if (graph.current) { setEnabled(true); return; }
    const element = video.current;
    if (!supported || !element || busy || unavailable) return;
    const run = generation.current;
    setBusy(true);
    try {
      const audio = await openQuantumAudio(element, url, () => {
        setEnabled(false);
        setUnavailable(true);
      });
      if (run !== generation.current) { audio.close(); return; }
      graph.current = audio;
      if (!audio.active) { setUnavailable(true); return; }
      audio.setIntensity(intensity / 100);
      setEnabled(true);
    } catch {
      if (run === generation.current) setUnavailable(true);
    } finally {
      if (run === generation.current) setBusy(false);
    }
  };

  if (!isAniVerse2) return null;
  if (!supported) return <QuantumAudioUnavailable />;
  return <div className="quantum-audio-control">
    <button className={'btn ghost sm' + (enabled ? ' on' : '')} type="button"
      aria-label="AniVerse Quantum Audio" aria-expanded={open}
      title="AniVerse Quantum Audio" onClick={() => setOpen(value => !value)}><AudioLines size={17} /></button>
    {open && <div className="player-menu quantum-audio-menu" aria-label="AniVerse Quantum Audio controls">
      <strong>AniVerse Quantum Audio</strong>
      <button className="btn sm" type="button" aria-label="Enable Quantum Audio" aria-pressed={enabled}
        disabled={busy || unavailable} onClick={() => void toggle()}>{busy ? 'Starting…' : enabled ? 'Turn off' : 'Turn on'}</button>
      {unavailable ? <small role="status">Playing original audio.</small> :
        <label>Intensity <Range ariaLabel="Quantum Audio intensity" value={intensity} min={0} max={100} step={1}
          onChange={value => {
            setIntensity(value);
            try { localStorage.setItem(intensityKey, String(value)); } catch { /* Optional preference. */ }
          }} /></label>}
    </div>}
  </div>;
}