import { Check, LayoutGrid, List, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../lib/format';
import { Checkbox, Select } from './controls';

interface Props {
  total: number;
  current: number;
  watched: Set<number>;
  /** When set, only these episode numbers exist on the selected source. */
  available: Set<number> | null;
  titles: Map<number, string>;
  thumbs: Map<number, string>;
  onSelect: (episode: number) => void;
  sourceLabel?: string;
}

const CHUNK = 100;

export function EpisodePanel({ total, current, watched, available, titles, thumbs, onSelect, sourceLabel }: Props) {
  const [mode, setMode] = useState<'list' | 'grid'>(total > 30 ? 'grid' : 'list');
  const [filter, setFilter] = useState('');
  const [hideWatched, setHideWatched] = useState(false);
  // A range picked by the user applies until the current episode changes.
  const [picked, setPicked] = useState<{ forEpisode: number; chunk: number } | null>(null);
  const chunk = picked && picked.forEpisode === current ? picked.chunk : Math.floor((current - 1) / CHUNK);
  const setChunk = (c: number) => setPicked({ forEpisode: current, chunk: c });
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [current, mode, chunk]);

  const chunks = Math.ceil(total / CHUNK);
  const numbers = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list = Array.from({ length: total }, (_, i) => i + 1);
    if (q) list = list.filter((n) => String(n) === q || String(n).startsWith(q) || (titles.get(n) ?? '').toLowerCase().includes(q));
    else if (chunks > 1) list = list.slice(chunk * CHUNK, chunk * CHUNK + CHUNK);
    if (hideWatched) list = list.filter((n) => !watched.has(n) || n === current);
    return list;
  }, [filter, total, chunks, chunk, hideWatched, watched, current, titles]);

  return (
    <div className="card ep-panel">
      <div className="ep-panel-head">
        <div className="row between">
          <strong>Episodes</strong>
          <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>
            {watched.size}/{total} watched{sourceLabel ? ` · ${sourceLabel}` : ''}
          </span>
        </div>
        <div className="row">
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--text-3)' }} />
            <input className="input" style={{ width: '100%', height: 30, paddingLeft: 28 }} placeholder="Find episode…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find episode" />
          </div>
          <button className={cx('icon-btn bordered', mode === 'list' && 'on')} style={{ width: 30, height: 30 }} aria-label="List view" onClick={() => setMode('list')}>
            <List size={15} />
          </button>
          <button className={cx('icon-btn bordered', mode === 'grid' && 'on')} style={{ width: 30, height: 30 }} aria-label="Grid view" onClick={() => setMode('grid')}>
            <LayoutGrid size={15} />
          </button>
        </div>
        <div className="row between">
          {chunks > 1 && !filter ? (
            <Select<number>
              ariaLabel="Episode range"
              size="sm"
              value={chunk}
              onChange={setChunk}
              options={Array.from({ length: chunks }, (_, i) => ({ value: i, label: `${i * CHUNK + 1}–${Math.min(total, (i + 1) * CHUNK)}` }))}
            />
          ) : (
            <span />
          )}
          <Checkbox checked={hideWatched} onChange={setHideWatched} label={<span style={{ fontSize: 'var(--fs-sm)' }}>Hide watched</span>} />
        </div>
      </div>
      <div className={cx('ep-list', mode === 'grid' && 'grid-mode')}>
        {numbers.length === 0 && <div className="faint" style={{ padding: 12 }}>No episodes match.</div>}
        {numbers.map((n) => {
          const unavailable = available !== null && !available.has(n);
          const cls = cx(n === current && 'active', watched.has(n) && 'watched', unavailable && 'unavailable');
          const label = titles.get(n);
          const tip = unavailable ? `Episode ${n} is not available on this source` : label ? `Episode ${n}: ${label}` : `Episode ${n}`;
          return mode === 'grid' ? (
            <button key={n} ref={n === current ? activeRef : undefined} className={cx('ep-cell', cls)} title={tip} onClick={() => onSelect(n)}>
              {watched.has(n) && n !== current ? <Check size={13} /> : n}
            </button>
          ) : (
            <button key={n} ref={n === current ? activeRef : undefined} className={cx('ep-row', cls)} title={tip} onClick={() => onSelect(n)}>
              <span className="num">{n}</span>
              <span className="ellipsis">{label ?? `Episode ${n}`}</span>
              {thumbs.get(n) ? <img src={thumbs.get(n)} alt="" loading="lazy" /> : watched.has(n) ? <Check size={14} color="var(--ok)" /> : <span />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
