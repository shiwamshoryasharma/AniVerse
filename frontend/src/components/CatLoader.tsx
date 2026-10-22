import { useEffect, useState, type ReactNode } from 'react';
import { useSettings } from '../lib/queries';

/**
 * Running-cat loader: six drawings of a gallop cycle switched frame by frame.
 * The clock runs at 16 fps; the ground scrolls every tick and the drawing
 * changes every second tick ("on twos"), so one stride takes 0.75 s.
 * All frames stay mounted so none has to decode mid-animation.
 * Frames are imported with scripts/import-cat-frames.cjs.
 */
const FRAMES = Object.entries(import.meta.glob<string>('../assets/cat/frame-*.webp', { eager: true, import: 'default' }))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, url]) => url);
const FPS = 16;
const TICKS_PER_DRAWING = 2;
const GROUND_STEP = 12; // px per tick, roughly the cat's stride speed
const GROUND_PERIOD = 48; // px, one dash + gap

export function CatLoader({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) {
  const reduce = useSettings().appearance.reduceMotion;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (reduce) return;
    let raf = 0;
    let start: number | null = null;
    const loop = (t: number) => {
      start ??= t;
      setTick(Math.floor(((t - start) * FPS) / 1000));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);
  const frame = Math.floor(tick / TICKS_PER_DRAWING) % FRAMES.length;
  return (
    <div className="cat-loader" role="status" aria-live="polite">
      <div className="cat-stage" aria-hidden>
        {FRAMES.map((src, i) => (
          // A frame that fails to load is hidden rather than drawn as a broken image.
          <img key={src} src={src} alt="" draggable={false} className={i === frame ? 'cat-frame on' : 'cat-frame'} onError={(e) => (e.currentTarget.hidden = true)} />
        ))}
        <div className="cat-ground" style={{ backgroundPositionX: `${-((tick * GROUND_STEP) % GROUND_PERIOD)}px` }} />
      </div>
      <strong className="cat-label">{label}</strong>
      {hint && <span className="cat-hint">{hint}</span>}
      {children}
    </div>
  );
}
