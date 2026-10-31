import { Check, LayoutGrid, List, Search, Play, EyeOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { hideEpisode } from '../../../app/shared/workspace';
import { cx } from '../lib/format';
import {audioMatches} from '../../../app/shared/audioAvailability';
import {AudioFilter,type AudioChoice} from './AudioFilter';
import { Checkbox, Select } from './controls';

interface Props {
  total: number;
  current: number;
  watched: Set<number>;
  /** When set, only these episode numbers exist on the selected source. */
  available: Set<number> | null;
  titles: Map<number, string>;
  thumbs: Map<number, string>;
  audio?:Map<number,('sub'|'dub')[]>;
  onSelect: (episode: number) => void;
  sourceLabel?: string;
  spoilerShield?: boolean;
}

const CHUNK = 100;

export function EpisodePanel({ total, current, watched, available, titles, thumbs, audio, onSelect, sourceLabel, spoilerShield = false }: Props) {
  const [mode, setMode] = useState<'list' | 'grid'>(total > 30 ? 'grid' : 'list');
  const [filter, setFilter] = useState('');
  const [language,setLanguage]=useState<AudioChoice>('all');
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
    if (q) list = list.filter((n) => String(n) === q || String(n).startsWith(q) || (!hideEpisode(n,current,watched,spoilerShield) && (titles.get(n) ?? '').toLowerCase().includes(q)));
    else if (chunks > 1) list = list.slice(chunk * CHUNK, chunk * CHUNK + CHUNK);
    if(language!=='all')list=list.filter(n=>audioMatches(audio?.get(n),language));
    if (hideWatched) list = list.filter((n) => !watched.has(n) || n === current);
    return list;
  }, [filter, total, chunks, chunk, hideWatched, watched, current, titles, spoilerShield,language,audio]);

  return (
    <div className="card ep-panel">
      <div className="ep-panel-head">
        <div className="row between">
          <strong>Episodes <span className="chip">{total}</span></strong>
          <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>
            {watched.size}/{total} watched{sourceLabel ? ` · ${sourceLabel}` : ''}
          </span>
        </div>
        <AudioFilter value={language} onChange={setLanguage} label="Episode audio availability"/>
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
        {numbers.length === 0 && <div className="faint" style={{ padding: 12 }}>{language==='all'?'No episodes match.':'No '+language.toUpperCase()+' episodes confirmed by this source. Check ALL for unverified episodes.'}</div>}
        {numbers.map((n) => {
          const unavailable = available !== null && !available.has(n);
          const cls = cx(n === current && 'active', watched.has(n) && 'watched', unavailable && 'unavailable');
          const hidden = hideEpisode(n,current,watched,spoilerShield);
          const label = hidden ? undefined : titles.get(n);
          const tip = unavailable ? `Episode ${n} is not available on this source` : label ? `Episode ${n}: ${label}` : `Episode ${n}`;
          return mode === 'grid' ? (
            <button key={n} ref={n === current ? activeRef : undefined} className={cx('ep-cell', cls)} title={tip} onClick={() => onSelect(n)}>
              {watched.has(n) && n !== current ? <Check size={13} /> : n}
            </button>
          ) : (
            <button key={n} ref={n === current ? activeRef : undefined} className={cx('ep-row', cls)} aria-current={n===current?'true':undefined} aria-label={tip} title={tip} onClick={() => onSelect(n)}>
              <span className="ep-thumb">
                {!hidden&&thumbs.get(n)?<img key={thumbs.get(n)} src={thumbs.get(n)} alt="" loading="lazy" onLoad={event=>event.currentTarget.style.removeProperty('display')} onError={event=>{event.currentTarget.style.display='none';}}/>:null}
                <span className="ep-thumb-symbol">{hidden?<EyeOff size={20}/>:<Play size={20} fill="currentColor"/>}</span>
              </span>
              <span className="ep-description">
                <span className="ep-number">EP {String(n).padStart(2,'0')}</span>
                <strong className="ellipsis">{label ?? `Episode ${n}`}</strong>
                {!!audio?.get(n)?.length&&<span className="ep-audio-badges">{audio.get(n)!.map(value=><span key={value} className={value}>{value.toUpperCase()}</span>)}</span>}
                <span className="ep-state">{watched.has(n)?<><Check size={12}/> Watched</>:n===current?<><Play size={11}/> Now watching</>:unavailable?'Try another source':hidden?'Spoiler hidden':'Episode '+n}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
