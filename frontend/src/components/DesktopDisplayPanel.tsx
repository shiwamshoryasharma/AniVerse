import { useEffect, useState } from 'react';
import { call, errorText } from '../lib/bridge';
import { displayScales, setDisplayScale, useDisplayScale, type DisplayScale } from '../lib/displayScale';
import { useToast } from '../lib/useToast';
import { Select } from './controls';

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight, dpi: Math.round(devicePixelRatio * 100) };
}

export function DesktopDisplayPanel() {
  const scale = useDisplayScale();
  const [size, setSize] = useState(viewport);
  const toast = useToast();
  useEffect(() => {
    const resize = () => setSize(viewport());
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  return <section className="gpu-rendering desktop-display" aria-label="Display and window">
    <h3>Display & window</h3>
    <p>Window {size.width} × {size.height} · Windows scaling {size.dpi}%</p>
    <div className="row">
      <Select<DisplayScale> ariaLabel="Interface scale" value={scale} onChange={setDisplayScale}
        options={displayScales.map(value => ({ value, label: value === 'auto' ? 'Automatic interface scale' : value + '% interface scale' }))} />
      <button className="btn ghost sm" onClick={() => void call('cast.windowsDisplay', {target:'display'})
        .catch(error => toast.push({ level: 'error', message: errorText(error) }))}>Windows display settings</button>
    </div>
  </section>;
}