import { CalendarDays, Check, Clock3, Film, LayoutGrid, List, Play, Search, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { HistoryEntry } from '../../../app/shared/types';
import { Empty, ErrorState, Loading, Modal } from '../components/common';
import { call, errorText } from '../lib/bridge';
import { cx, timeAgo } from '../lib/format';
import { useHistory, useSources } from '../lib/queries';
import { useToast } from '../lib/useToast';
import '../styles/history.css';

type HistoryView = 'grid' | 'list';
function readView(): HistoryView {
  try { return localStorage.getItem('aniverse.historyView') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
}
function watchedPercent(entry: HistoryEntry): number {
  return Number.isFinite(entry.position) && entry.duration > 0 ? Math.max(0, Math.min(100, Math.round(entry.position / entry.duration * 100))) : 0;
}
function clock(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return value >= 3600 ? `${Math.floor(value / 3600)}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}` : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
function dayLabel(seconds: number): string {
  const date = new Date(seconds * 1000), today = new Date(), yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function HistoryPage() {
  const { data, isLoading, error, refetch } = useHistory();
  const { data: sources } = useSources();
  const qc = useQueryClient(), toast = useToast();
  const [view, setView] = useState(readView), [search, setSearch] = useState('');
  const [confirmClear, setConfirmClear] = useState(false), [removing, setRemoving] = useState<number | 'all' | null>(null);
  const sourceNames = useMemo(() => new Map(sources?.map(source => [source.id, source.name])), [sources]);
  const rows = useMemo(() => [...(data ?? [])].sort((a, b) => b.watchedAt - a.watchedAt), [data]);
  const groups = useMemo(() => {
    const query = search.trim().toLocaleLowerCase(), output = new Map<string, HistoryEntry[]>();
    for (const row of rows) {
      const source = row.sourceId ? sourceNames.get(row.sourceId) ?? row.sourceId : 'Local collection';
      if (query && !`${row.media.title} ${source}`.toLocaleLowerCase().includes(query)) continue;
      const date = dayLabel(row.watchedAt);
      const group = output.get(date) ?? []; group.push(row); output.set(date, group);
    }
    return [...output];
  }, [rows, search, sourceNames]);
  const shown = groups.reduce((total, [, entries]) => total + entries.length, 0);
  const saveView = (next: HistoryView) => { setView(next); try { localStorage.setItem('aniverse.historyView', next); } catch { /* optional device preference */ } };
  const clear = async (id: number | null) => {
    if (removing !== null) return;
    setRemoving(id ?? 'all');
    try {
      await call('library.clearHistory', { id });
      await qc.invalidateQueries({ queryKey: ['library'] });
      setConfirmClear(false);
    } catch (err) { toast.push({ level: 'error', message: errorText(err) }); }
    finally { setRemoving(null); }
  };
  return <div className="page history-page">
    <div className="history-heading">
      <div><span className="history-eyebrow"><Clock3 size={14} /> YOUR WATCHING JOURNEY</span><h1 className="page-title">Watch history</h1><p className="page-sub">Pick up a story, revisit an episode, or find where you left off.</p></div>
      {!!rows.length && <button className="btn ghost sm history-clear" onClick={() => setConfirmClear(true)}><Trash2 size={15} /> Clear history</button>}
    </div>
    {!!rows.length && <>
      <div className="history-summary" aria-label="Recent history summary">
        <span><Film size={17} /><b>{rows.length}</b> recent episodes</span>
        <span><LayoutGrid size={17} /><b>{new Set(rows.map(row => row.media.id)).size}</b> series</span>
        <span><Check size={17} /><b>{rows.filter(row => watchedPercent(row) >= 90).length}</b> almost finished</span>
      </div>
      <div className="history-toolbar card">
        <label className="history-search"><Search size={17} /><input className="input" aria-label="Search history" placeholder="Find an anime or source…" value={search} onChange={event => setSearch(event.target.value)} />{search && <button className="icon-btn" aria-label="Clear history search" onClick={() => setSearch('')}><X size={16} /></button>}</label>
        <span className="history-result-count" aria-live="polite">{shown} {shown === 1 ? 'episode' : 'episodes'}</span>
        <div className="history-view" role="group" aria-label="History layout">
          <button className={cx('btn sm', view === 'grid' && 'active')} aria-pressed={view === 'grid'} onClick={() => saveView('grid')}><LayoutGrid size={16} /> Grid</button>
          <button className={cx('btn sm', view === 'list' && 'active')} aria-pressed={view === 'list'} onClick={() => saveView('list')}><List size={16} /> List</button>
        </div>
      </div>
    </>}
    {isLoading ? <Loading /> : error ? <ErrorState error={error} onRetry={() => void refetch()} /> : !rows.length ? <Empty title="Your next story starts here">Episodes you watch will appear here, ready to resume.</Empty> : !shown ? <Empty title="No matching episodes">Try another anime title or source, or clear your search.</Empty> : <div className="history-results" data-view={view}>
      {groups.map(([date, entries]) => <section className="history-day" key={date} aria-label={date}>
        <h2 className="history-day-title"><CalendarDays size={15} />{date}<span>{entries.length}</span></h2>
        <div className="history-items">{entries.map(entry => {
          const percent = watchedPercent(entry), source = entry.sourceId ? sourceNames.get(entry.sourceId) ?? entry.sourceId : 'Local collection';
          const to = `/watch/${entry.media.id}/${entry.episode}${entry.sourceId ? `?source=${encodeURIComponent(entry.sourceId)}` : '?local=1'}`;
          const dateTime = new Date(entry.watchedAt * 1000);
          return <article className={cx('history-entry', percent >= 90 && 'history-complete')} data-history-id={entry.id} key={entry.id}>
            <Link className="history-cover" to={to} aria-label={`Play ${entry.media.title}, episode ${entry.episode}`}>
              {entry.media.cover ? <img src={entry.media.cover} alt="" loading="lazy" decoding="async" /> : <Film size={28} />}
              <span className="history-episode">EP {entry.episode}</span>
            </Link>
            <div className="history-detail">
              <Link className="history-title" to={`/anime/${entry.media.id}`}>{entry.media.title}</Link>
              <div className="history-meta"><span>Episode {entry.episode}</span><span className="history-source" title={source}>{source}</span></div>
              <time dateTime={dateTime.toISOString()} title={dateTime.toLocaleString()}>{timeAgo(entry.watchedAt)}</time>
              <div className="history-progress-row"><span>{entry.duration > 0 ? `${percent}% watched` : 'Opened'}</span><span>{entry.duration > 0 ? `${clock(entry.position)} / ${clock(entry.duration)}` : 'Progress unavailable'}</span></div>
              <div className="history-progress" role="progressbar" aria-label={`${entry.media.title} episode ${entry.episode} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div>
            </div>
            <div className="history-actions"><Link className="btn sm primary" to={to}><Play size={14} /> {entry.position > 0 && percent < 90 ? 'Resume' : 'Play'}</Link><button className="icon-btn" aria-label="Remove from history" title="Remove this episode from history" disabled={removing !== null} onClick={() => void clear(entry.id)}><Trash2 size={16} /></button></div>
          </article>;
        })}</div>
      </section>)}
    </div>}
    {confirmClear && <Modal title="Clear history?" onClose={() => removing === null && setConfirmClear(false)} actions={<><button className="btn" disabled={removing !== null} onClick={() => setConfirmClear(false)}>Cancel</button><button className="btn danger" disabled={removing !== null} onClick={() => void clear(null)}><Trash2 size={15} />{removing === 'all' ? 'Clearing…' : 'Clear history'}</button></>}><p>Remove your watch history from this device? Your library, favourites and episode progress will stay available.</p></Modal>}
  </div>;
}
