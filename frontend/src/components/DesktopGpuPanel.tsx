import { Cpu, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { DesktopGpuPreference, DesktopGpuState } from '../../../app/shared/graphics';
import { call, errorText, isAniVerse2 } from '../lib/bridge';
import { useToast } from '../lib/useToast';
import { Select } from './controls';

const options = [
  { value: 'system', label: 'System default' },
  { value: 'high-performance', label: 'Dedicated GPU preferred' },
  { value: 'power-saving', label: 'Power-saving GPU preferred' },
] satisfies { value: DesktopGpuPreference; label: string }[];

function probeRenderer() {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgl');
  if (!context) return { renderer: null, textures: false };
  try {
    const details = context.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: details ? String(context.getParameter(details.UNMASKED_RENDERER_WEBGL)) : null,
      textures: Boolean(context.getExtension('OES_texture_float') &&
        context.getExtension('OES_texture_float_linear')),
    };
  } finally {
    context.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

export function DesktopGpuPanel({ state, refresh }: { state: DesktopGpuState; refresh: () => Promise<unknown> }) {
  const toast = useToast();
  const browser = isAniVerse2 ? 'WebView2' : 'Chromium';
  const application = isAniVerse2 ? 'AniVerse2' : 'AniVerse';
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<ReturnType<typeof probeRenderer>>();
  const save = async (preference: DesktopGpuPreference) => {
    setSaving(true);
    try { await call('app.setGpuPreference', { preference }); await refresh(); }
    catch (error) { toast.push({ level: 'error', message: errorText(error) }); }
    finally { setSaving(false); }
  };
  return <section className="gpu-rendering">
    <h3>Graphics adapter preference</h3>
    <p>Choose which adapter {browser} should prefer for the app and its website players.</p>
    <Select<DesktopGpuPreference> ariaLabel="Graphics adapter preference" width={268} options={options}
      disabled={saving || !state.supported} value={state.preferred} onChange={value => void save(value)} />
    <p className="faint">{state.supported
      ? 'Current startup preference · ' + (options.find(option => option.value === state.applied)?.label ?? 'System default')
      : browser + ' uses the Windows graphics preference.'}</p>
    {state.restartRequired && <div className="row" role="status">
      <span>Restart {application} to apply the graphics adapter preference.</span>
      <button className="btn sm" onClick={() => void call('app.restart')
        .catch(error => toast.push({ level: 'error', message: errorText(error) }))}><RefreshCw size={14} /> Restart {application}</button>
    </div>}
    <button className="btn ghost sm" onClick={() => setProbe(probeRenderer())}><Cpu size={14} /> Check WebGL renderer</button>
    {probe && <p role="status">{probe.renderer ?? browser + ' did not report a renderer name.'}
      {' · '}{probe.textures ? 'Anime4K texture support detected' : 'Anime4K texture support unavailable'}
    </p>}
  </section>;
}