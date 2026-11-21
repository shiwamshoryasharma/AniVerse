import { Check, PanelBottom, PanelLeft, PanelRight, PanelsTopLeft, RectangleHorizontal } from 'lucide-react';
import { INTERFACE_STYLES } from '../../../app/shared/interface';
import { useSettings, useUpdateSettings } from '../lib/queries';
import { useToast } from '../lib/useToast';
import { setMidnightTheme, useMidnightTheme } from '../lib/desktopTheme';
import { isAniVerse2 } from '../lib/bridge';
import { AniVerse2Palettes } from './AniVerse2Palettes';
import { ANIVERSE2_LAYOUTS, setAniVerse2Layout, useAniVerse2Layout, type AniVerse2Layout } from '../lib/interfaceLayout';
const ICONS = { classic: PanelLeft, studio: PanelsTopLeft, cinema: RectangleHorizontal, dock: PanelBottom, atlas: PanelRight };
const layouts = isAniVerse2 ? [...INTERFACE_STYLES, ...ANIVERSE2_LAYOUTS] : INTERFACE_STYLES;
export function ThemeStyles() {
  const settings = useSettings(), update = useUpdateSettings(), toast = useToast();
  const midnight = useMidnightTheme();
  const activeLayout = useAniVerse2Layout() ?? settings.appearance.style;
  const selectLayout = async (id: typeof INTERFACE_STYLES[number]['id'] | AniVerse2Layout) => {
    try {
      if (id === 'dock' || id === 'atlas') {
        setAniVerse2Layout(id);
      } else {
        if (id !== settings.appearance.style) await update.mutateAsync({ appearance: { style: id } });
        setAniVerse2Layout(null);
      }
    } catch (error) {
      toast.push({ level: 'error', message: error instanceof Error ? error.message : 'Could not save the layout.' });
    }
  };
  return <section className="settings-group"><h3>Interface layouts</h3>
    <p className="page-sub">Change navigation, page structure and the viewing workspace. Accent and font are separate preferences.</p>
    {isAniVerse2 && <AniVerse2Palettes />}
    <div className="card midnight-preview">
      <div><h3>Midnight</h3><p>Deep navy surfaces, mint controls and a clearer episode selection.</p></div>
      <button className="btn" aria-pressed={midnight} onClick={() => setMidnightTheme(!midnight)}>
        {midnight ? 'Restore previous colours' : 'Use Midnight theme'}
      </button>
    </div>
    <div className="card festival-preview">
      <div><span className="eyebrow">SEASONAL DARK PALETTE</span><h3>Diwali × Halloween</h3><p>Warm lamp gold, pumpkin orange and midnight violet. Applied with this update through December 31, 2026, then your previous palette returns. You can switch away now or select it manually later.</p></div>
      <button className="btn primary" disabled={update.isPending} aria-pressed={settings.appearance.accent==='festival'} onClick={()=>{setMidnightTheme(false);update.mutate({appearance:{accent:settings.appearance.accent==='festival'?'ember':'festival'}},{onError:error=>toast.push({level:'error',message:error.message})});}}>{settings.appearance.accent==='festival'?'Use standard palette':'Use festive palette'}</button>
    </div>
    <div className="theme-styles" role="group" aria-label="Interface layouts">{layouts.map((style) => {
      const Icon = ICONS[style.layout];
      return <button key={style.id} className={'theme-style ' + style.id + (activeLayout === style.id ? ' selected' : '')}
        aria-pressed={activeLayout === style.id} disabled={update.isPending}
        onClick={() => void selectLayout(style.id)}>
        <div className={'layout-preview preview-' + style.layout} aria-hidden="true">
          <div className="preview-header" /><aside className="preview-navigation"><i /><i /><i /><i /></aside>
          <div className="preview-content"><b /><div className="preview-cards"><i /><i /><i /></div><div className="preview-shelf"><i /><i /><i /><i /></div></div>
        </div>
        <div className="row"><Icon size={18} /><strong>{style.name}</strong><span className="grow" />{activeLayout === style.id && <Check size={17} />}</div>
        <small>{style.label}</small><p>{style.description}</p>
      </button>;
    })}</div>
  </section>;
}
