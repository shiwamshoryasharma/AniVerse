import { Check, Moon, Sparkles, Sun } from 'lucide-react';
import { useSettings, useUpdateSettings } from '../lib/queries';
import { useToast } from '../lib/useToast';
const STYLES = [
  { id: 'classic', name: 'Classic', label: 'The original AniVerse', desc: 'Compact charcoal surfaces and familiar cinematic contrast.', icon: Moon },
  { id: 'aurora', name: 'Aurora', label: 'A cooler kind of cinema', desc: 'Deep indigo, softly lit panels and spacious rounded surfaces.', icon: Sparkles },
  { id: 'paper', name: 'Paper', label: 'Light, calm, readable', desc: 'Warm ivory, crisp typography and quiet editorial panels.', icon: Sun },
] as const;
export function ThemeStyles() {
  const settings = useSettings(), update = useUpdateSettings(), toast = useToast();
  return <section className="settings-group"><h3>Interface themes</h3>
    <p className="page-sub">Three complete UI styles. Your accent, font and density remain yours.</p>
    <div className="theme-styles" role="group" aria-label="Interface themes">{STYLES.map((style) =>
      <button key={style.id} className={'theme-style ' + style.id + (settings.appearance.style === style.id ? ' selected' : '')}
        aria-pressed={settings.appearance.style === style.id} disabled={update.isPending}
        onClick={() => update.mutate({ appearance: { style: style.id } }, { onError: (error) => toast.push({ level: 'error', message: error.message }) })}>
        <div className="theme-style-preview" aria-hidden="true"><i /><div><b /><span /><span /><div className="preview-posters"><em /><em /><em /></div></div></div>
        <div className="row"><style.icon size={17} /><strong>{style.name}</strong><span className="grow" />{settings.appearance.style === style.id && <Check size={17} />}</div>
        <small>{style.label}</small><p>{style.desc}</p>
      </button>)}</div>
  </section>;
}
