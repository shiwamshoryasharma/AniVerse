import { useState } from 'react';

const PALETTES = [
  ['ion', 'Ion'],
  ['copper', 'Copper'],
  ['wisteria', 'Wisteria'],
  ['legacy', 'Original colours'],
] as const;

export function AniVerse2Palettes() {
  const [current, setCurrent] = useState(() => {
    const saved = localStorage.getItem('aniverse2.palette');
    if (PALETTES.some(([name]) => name === saved)) return saved;
    return localStorage.getItem('aniverse.desktop-theme') === 'midnight' ? 'legacy' : 'ion';
  });
  return (
    <div className="card card-pad stack">
      <strong>AniVerse2 colours</strong>
      <div className="row wrap" role="group" aria-label="AniVerse2 colours">
        {PALETTES.map(([palette, name]) => (
          <button key={palette} className={'btn sm' + (current === palette ? ' primary' : '')}
            aria-pressed={current === palette} onClick={() => {
              document.documentElement.dataset.aniverse2Theme = palette;
              localStorage.setItem('aniverse2.palette', palette);
              setCurrent(palette);
            }}>
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}
