import { Check, ChevronDown, Palette, RotateCcw } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { appearanceThemes, changeLayerColour, colourInk, colourLayers, colourSwatches, defaultLayerColour, getAppearance,
  resetAppearance, selectAppearanceTheme, subscribeAppearance } from '../lib/aniverse2Appearance';
import type { ColourLayer } from '../lib/aniverse2Appearance';
import { useMidnightTheme } from '../lib/desktopTheme';
import { isAniVerse2 } from '../lib/bridge';
import '../styles/aniverse2-appearance.css';

function swatchStyle(hex: string, property = '--swatch'): CSSProperties {
  return { [property]: hex, '--swatch-ink': colourInk(hex) } as CSSProperties;
}

export function AniVerse2Palettes() {
  const { theme, colours } = useSyncExternalStore(subscribeAppearance, getAppearance);
  const midnight = useMidnightTheme();
  const [layer, setLayer] = useState<ColourLayer>('header');
  const active = colourLayers.find(entry => entry.id === layer)!;
  const chosen = colours[layer] ?? defaultLayerColour(layer);

  return (
    <section className="card card-pad stack av2-appearance" aria-labelledby="av2-appearance-title">
      <div className="av2-appearance-head">
        <h3 id="av2-appearance-title">{isAniVerse2 ? 'AniVerse2 themes' : 'AniVerse themes'}</h3>
        <button type="button" className="btn sm" onClick={resetAppearance}>
          <RotateCcw size={14} aria-hidden="true" /> Reset colours
        </button>
      </div>
      <div className="av2-theme-grid" role="group" aria-label={isAniVerse2 ? 'AniVerse2 themes' : 'AniVerse themes'}>
        {appearanceThemes.map(({ id, name, color, surface, detail }) => (
          <button type="button" key={id} className="av2-theme-option" aria-pressed={!midnight && theme === id}
            aria-label={name} style={{ '--theme-color': color, '--theme-surface': surface } as CSSProperties}
            onClick={() => selectAppearanceTheme(id)}>
            <span className="av2-theme-strip" aria-hidden="true"><i /><i /><i /><i /></span>
            <span className="av2-theme-label"><strong>{name}</strong>{!midnight && theme === id && <Check size={15} aria-hidden="true" />}</span>
            <small>{detail}</small>
          </button>
        ))}
      </div>
      <details className="av2-colour-editor">
        <summary><Palette size={16} aria-hidden="true" /> Custom colours <ChevronDown size={16} aria-hidden="true" /></summary>
        <div className="av2-colour-content">
          <div className="av2-colour-layers" role="group" aria-label="Colour layer">
            {colourLayers.map(({ id, name }) => (
              <button type="button" className="btn sm" key={id} aria-pressed={layer === id} onClick={() => setLayer(id)}>
                {colours[id] && <span className="av2-colour-dot" style={swatchStyle(colours[id]!)} aria-hidden="true" />}
                {name}
              </button>
            ))}
          </div>
          <div className="av2-colour-options">
            <div className="av2-swatches" role="group" aria-label={active.name + ' colour palette'}>
              {colourSwatches.map(({ name, value }) => (
                <button type="button" className="av2-swatch" key={value} title={name} aria-label={name}
                  aria-pressed={colours[layer] === value} style={swatchStyle(value)} onClick={() => changeLayerColour(layer, value)}>
                  {colours[layer] === value && <Check size={16} aria-hidden="true" />}
                </button>
              ))}
            </div>
            <label className="av2-colour-pick">
              <span>Custom {active.name.toLowerCase()} colour</span>
              <input type="color" value={chosen} onChange={event => changeLayerColour(layer, event.currentTarget.value)}
                onInput={event => changeLayerColour(layer, event.currentTarget.value)} />
              <code>{chosen.toUpperCase()}</code>
            </label>
            <button type="button" className="btn sm ghost" disabled={!colours[layer]} onClick={() => changeLayerColour(layer)}>
              Use theme colour
            </button>
          </div>
        </div>
      </details>
    </section>
  );
}
