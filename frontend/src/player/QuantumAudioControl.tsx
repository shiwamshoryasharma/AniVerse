import { AudioLines } from 'lucide-react';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Range } from '../components/controls';
import { modernWindows } from '../lib/bridge';
import { canUseQuantumAudio, initialQuantumIntensity, openQuantumAudio, saveQuantumIntensity } from './quantumAudio';

export function QuantumAudioUnavailable({ labelled = false }: { labelled?: boolean } = {}) {
  const hint = useId();
  if (!modernWindows) return null;
  return <>
    <button className="btn ghost sm" type="button" disabled={!labelled} aria-disabled={true}
      aria-label="AniVerse Quantum Audio unavailable for this source" aria-describedby={hint}
      title="This source plays with its original audio.">
      <AudioLines size={16} aria-hidden />{labelled && <span className="quantum-audio-label">Quantum Audio</span>}
    </button>
    <span id={hint} className="sr-only">This source plays with its original audio.</span>
  </>;
}

export function QuantumAudioControl({ video, url, labelled }: { video: RefObject<HTMLVideoElement | null>; url: string; labelled?: boolean }) {
  const graph = useRef<Awaited<ReturnType<typeof openQuantumAudio>> | null>(null);
  const generation = useRef(0);
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [intensity, setIntensity] = useState(initialQuantumIntensity);
  const supported = modernWindows && canUseQuantumAudio(url);
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

  if (!modernWindows) return null;
  if (!supported) return <QuantumAudioUnavailable labelled={labelled} />;
  return <div className="quantum-audio-control">
    <button className={'btn ghost sm' + (enabled ? ' on' : '')} type="button"
      aria-label="AniVerse Quantum Audio" aria-expanded={open}
      title="AniVerse Quantum Audio" onClick={() => setOpen(value => !value)}>
      <AudioLines size={17} aria-hidden />{labelled && <span className="quantum-audio-label">Quantum Audio</span>}
    </button>
    {open && <div className="player-menu quantum-audio-menu" aria-label="AniVerse Quantum Audio controls">
      <strong>AniVerse Quantum Audio</strong>
      <button className="btn sm" type="button" aria-label="Enable Quantum Audio" aria-pressed={enabled}
        disabled={busy || unavailable} onClick={() => void toggle()}>{busy ? 'Starting…' : enabled ? 'Turn off' : 'Turn on'}</button>
      {unavailable ? <small role="status">Playing original audio.</small> :
        <label>Intensity <Range ariaLabel="Quantum Audio intensity" value={intensity} min={0} max={100} step={1}
          onChange={value => {
            setIntensity(value);
            saveQuantumIntensity(value);
          }} /></label>}
    </div>}
  </div>;
}