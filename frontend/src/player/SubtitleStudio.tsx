import { Captions, FolderOpen } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Settings } from '../../../app/shared/types';
import { subtitleLinesAt, type CaptionCue } from '../../../app/shared/subtitles';
import { call, errorText } from '../lib/bridge';
import { useUpdateSettings } from '../lib/queries';

export function SubtitleStudio({ video, style }: { video: RefObject<HTMLVideoElement | null>; style: Settings['player']['subtitleStyle'] }) {
  const [open, setOpen] = useState(false);
  const [tracks, setTracks] = useState<{ index: number; label: string }[]>([]);
  const [primary, setPrimary] = useState<number | null>(null);
  const [secondary, setSecondary] = useState(-1);
  const [offset, setOffset] = useState(style.offset);
  const [secondOffset, setSecondOffset] = useState(0);
  const [size, setSize] = useState(style.size);
  const [color, setColor] = useState(style.color);
  const [background, setBackground] = useState(style.background);
  const [lines, setLines] = useState<string[]>([]);
  const [secondLines, setSecondLines] = useState<string[]>([]);
  const [error, setError] = useState('');
  const imported = useRef<{ element: HTMLTrackElement; url: string }[]>([]);
  const update = useUpdateSettings();
  const selected = useRef({ primary, secondary, offset, secondOffset });
  useEffect(() => {
    selected.current = { primary, secondary, offset, secondOffset };
  }, [primary, secondary, offset, secondOffset]);
  useEffect(() => {
    const v = video.current!;
    const refresh = () =>
      setTracks(
        Array.from(v.textTracks)
          .map((t, index) => ({ index, label: t.label || t.language || 'Track ' + (index + 1), kind: t.kind }))
          .filter((t) => t.kind === 'captions' || t.kind === 'subtitles'),
      );
    const draw = () => {
      const list = Array.from(v.textTracks);
      const s = selected.current;
      const first = s.primary === null ? list.findIndex((t) => t.kind === 'subtitles' || t.kind === 'captions') : s.primary;
      list.forEach((t, i) => {
        if (t.kind === 'subtitles' || t.kind === 'captions') t.mode = i === first || i === s.secondary ? 'hidden' : 'disabled';
      });
      setLines(subtitleLinesAt((list[first]?.cues ?? []) as unknown as ArrayLike<CaptionCue>, v.currentTime, s.offset));
      setSecondLines(
        s.secondary !== first ? subtitleLinesAt((list[s.secondary]?.cues ?? []) as unknown as ArrayLike<CaptionCue>, v.currentTime, s.secondOffset) : [],
      );
    };
    refresh();
    v.textTracks.addEventListener('addtrack', refresh);
    v.textTracks.addEventListener('removetrack', refresh);
    const timer = window.setInterval(draw, 100);
    return () => {
      window.clearInterval(timer);
      v.textTracks.removeEventListener('addtrack', refresh);
      v.textTracks.removeEventListener('removetrack', refresh);
      for (const t of imported.current) {
        t.element.remove();
        URL.revokeObjectURL(t.url);
      }
      imported.current = [];
    };
  }, [video]);
  const importTrack = async () => {
    setError('');
    try {
      const file = await call('player.openSubtitles');
      if (!file) return;
      const url = URL.createObjectURL(new Blob([file.text], { type: 'text/vtt' }));
      const element = document.createElement('track');
      element.kind = 'subtitles';
      element.label = file.name;
      element.src = url;
      imported.current.push({ element, url });
      video.current!.append(element);
      const index = Array.from(video.current!.textTracks).indexOf(element.track);
      element.track.mode = 'hidden';
      setPrimary(index);
      setOpen(true);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const choices = (value: number | null, set: (n: number) => void, label: string) => (
    <label>
      {label}
      <select className="input" aria-label={label} value={value ?? tracks[0]?.index ?? -1} onChange={(e) => set(Number(e.target.value))}>
        <option value="-1">Off</option>
        {tracks.map((t) => (
          <option value={t.index} key={t.index}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <div
        className="studio-captions"
        aria-live="off"
        style={{
          fontSize: size,
          color: color === 'green' ? '#8fffaf' : color,
          background: lines.length || secondLines.length ? 'rgba(0,0,0,' + background + ')' : 'transparent',
        }}
      >
        {lines.map((line, i) => (
          <div key={'p' + i}>{line}</div>
        ))}
        {secondLines.map((line, i) => (
          <div className="caption-secondary" key={'s' + i}>
            {line}
          </div>
        ))}
      </div>
      <div className="subtitle-studio">
        <button className="icon-btn" aria-label="Subtitle Studio" title="Subtitle Studio" onClick={() => setOpen((v) => !v)}>
          <Captions size={19} />
        </button>
        {open && (
          <div className="studio-menu" onKeyDown={(e) => e.stopPropagation()}>
            <div className="row between">
              <h4>Subtitle Studio</h4>
              <button className="btn xs" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
            <p>Native player captions. Positive offset shows captions later. Imported files stay on this device.</p>
            {choices(primary, setPrimary, 'Primary captions')}
            {choices(secondary, setSecondary, 'Secondary captions')}
            <div className="row">
              <label>
                Primary offset (s)
                <input
                  className="input"
                  aria-label="Primary offset"
                  type="number"
                  min="-15"
                  max="15"
                  step=".1"
                  value={offset}
                  onChange={(e) => setOffset(Math.max(-15, Math.min(15, Number(e.target.value))))}
                />
              </label>
              <label>
                Secondary offset (s)
                <input
                  className="input"
                  aria-label="Secondary offset"
                  type="number"
                  min="-15"
                  max="15"
                  step=".1"
                  value={secondOffset}
                  onChange={(e) => setSecondOffset(Math.max(-15, Math.min(15, Number(e.target.value))))}
                />
              </label>
            </div>
            <div className="row">
              <label>
                Size
                <input
                  className="input"
                  aria-label="Caption size"
                  type="number"
                  min="16"
                  max="48"
                  value={size}
                  onChange={(e) => setSize(Math.max(16, Math.min(48, Number(e.target.value))))}
                />
              </label>
              <label>
                Colour
                <select className="input" aria-label="Caption colour" value={color} onChange={(e) => setColor(e.target.value as typeof color)}>
                  {['white', 'yellow', 'cyan', 'green'].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Background
              <input
                type="range"
                aria-label="Caption background"
                min="0"
                max="1"
                step=".05"
                value={background}
                onChange={(e) => setBackground(Number(e.target.value))}
              />
            </label>
            <div className="row wrap">
              <button className="btn sm" onClick={() => void importTrack()}>
                <FolderOpen size={14} />
                Import SRT / VTT
              </button>
              <button className="btn sm" onClick={() => update.mutate({ player: { subtitleStyle: { size, color, background, offset } } })}>
                Save style
              </button>
            </div>
            {error && <p role="alert">{error}</p>}
            <p>Picture in picture and casting use the device's caption support; this overlay appears inside AniVerse.</p>
          </div>
        )}
      </div>
    </>
  );
}
