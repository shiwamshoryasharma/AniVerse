import { Check, PanelLeft, PanelsTopLeft, RectangleHorizontal } from 'lucide-react';
import { INTERFACE_STYLES } from '../../../app/shared/interface';
import { useSettings, useUpdateSettings } from '../lib/queries';
import { useToast } from '../lib/useToast';
const ICONS = { classic: PanelLeft, studio: PanelsTopLeft, cinema: RectangleHorizontal };
export function ThemeStyles() {
  const settings = useSettings(), update = useUpdateSettings(), toast = useToast();
  return <section className="settings-group"><h3>Interface layouts</h3>
    <p className="page-sub">Change navigation, page structure and the viewing workspace. Accent and font are separate preferences.</p>
    <div className="theme-styles" role="group" aria-label="Interface layouts">{INTERFACE_STYLES.map((style) => {
      const Icon = ICONS[style.layout];
      return <button key={style.id} className={'theme-style ' + style.id + (settings.appearance.style === style.id ? ' selected' : '')}
        aria-pressed={settings.appearance.style === style.id} disabled={update.isPending}
        onClick={() => update.mutate({ appearance: { style: style.id } }, { onError: (error) => toast.push({ level: 'error', message: error.message }) })}>
        <div className={'layout-preview preview-' + style.layout} aria-hidden="true">
          <div className="preview-header" /><aside className="preview-navigation"><i /><i /><i /><i /></aside>
          <div className="preview-content"><b /><div className="preview-cards"><i /><i /><i /></div><div className="preview-shelf"><i /><i /><i /><i /></div></div>
        </div>
        <div className="row"><Icon size={18} /><strong>{style.name}</strong><span className="grow" />{settings.appearance.style === style.id && <Check size={17} />}</div>
        <small>{style.label}</small><p>{style.description}</p>
      </button>;
    })}</div>
  </section>;
}
