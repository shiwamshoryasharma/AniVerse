import { BookmarkPlus, CalendarDays, Check, ChevronLeft, ChevronRight, Clock, Info, LayoutGrid, ListTree, Play, Search, Star } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { AiringItem, MediaFormat } from '../../../app/shared/types';
import { Empty, ErrorState, Loading } from '../components/common';
import { Checkbox, Select } from '../components/controls';
import { HoverPreview } from '../components/HoverCard';
import { MediaCard } from '../components/MediaCard';
import { airTime, countdown, cx, formatLabel, snapshotOf, titleOf } from '../lib/format';
import { useEntries, useFavourites, useSchedule, useSetStatus, useSettings } from '../lib/queries';
import { useToast } from '../lib/useToast';

type FormatFilter = 'all' | 'tv' | 'ona' | 'movie';
const FORMAT_FILTERS: { value: FormatFilter; label: string }[] = [
  { value: 'all', label: 'All formats' },
  { value: 'tv', label: 'TV' },
  { value: 'ona', label: 'ONA / web' },
  { value: 'movie', label: 'Movies & specials' },
];
const matchesFormat = (f: MediaFormat | null, filter: FormatFilter) =>
  filter === 'all' || (filter === 'tv' ? f === 'TV' || f === 'TV_SHORT' : filter === 'ona' ? f === 'ONA' : f === 'MOVIE' || f === 'SPECIAL' || f === 'OVA');

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return d;
}

function readView(): 'timeline' | 'grid' {
  try {
    return localStorage.getItem('aniverse.scheduleView') === 'grid' ? 'grid' : 'timeline';
  } catch {
    return 'timeline';
  }
}

export function SchedulePage() {
  const [now, setNow] = useState(() => new Date());
  const [weekOffset, setWeekOffset] = useState(0);
  const todayIndex = (now.getDay() + 6) % 7;
  const [day, setDay] = useState(todayIndex);
  const [query, setQuery] = useState('');
  const [format, setFormat] = useState<FormatFilter>('all');
  const [mineOnly, setMineOnly] = useState(false);
  const [view, setView] = useState(readView);
  const today = now.toDateString();
  const week = useMemo(() => {
    const start = startOfWeek(new Date(today));
    start.setDate(start.getDate() + weekOffset * 7);
    return start;
  }, [weekOffset, today]);
  const from = Math.floor(week.getTime() / 1000);
  const { data, error, refetch, isLoading } = useSchedule(from, from + 7 * 86400);
  const { data: entries } = useEntries(null);
  const { data: favourites } = useFavourites();
  const lang = useSettings().appearance.titleLanguage;
  const nowRef = useRef<HTMLDivElement>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const mine = useMemo(() => new Set([...(entries ?? []).map((e) => e.media.id), ...(favourites ?? []).map((f) => f.media.id)]), [entries, favourites]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data ?? []).filter(
      (a) =>
        matchesFormat(a.media.format, format) &&
        (!mineOnly || mine.has(a.media.id)) &&
        (!q || [a.media.title.english, a.media.title.romaji, a.media.title.native].some((t) => t?.toLowerCase().includes(q))),
    );
  }, [data, query, format, mineOnly, mine]);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(week);
    d.setDate(week.getDate() + i);
    const start = Math.floor(d.getTime() / 1000);
    return { date: d, start, count: filtered.filter((a) => a.airingAt >= start && a.airingAt < start + 86400).length };
  });
  const dayStart = days[day].start;
  const items = filtered.filter((a) => a.airingAt >= dayStart && a.airingAt < dayStart + 86400);
  const nowSec = now.getTime() / 1000;
  const isToday = weekOffset === 0 && day === todayIndex;
  const nextId = items.find((a) => a.airingAt > nowSec)?.id;

  // Bring the "now" line into view when opening today.
  const scrolled = useRef(false);
  useEffect(() => {
    if (!isToday || !data || scrolled.current) return;
    scrolled.current = true;
    nowRef.current?.scrollIntoView({ block: 'center' });
  }, [isToday, data]);

  const saveView = (v: 'timeline' | 'grid') => {
    setView(v);
    try {
      localStorage.setItem('aniverse.scheduleView', v);
    } catch {
      // storage unavailable
    }
  };

  return (
    <div className="page">
      <div className="sched-head">
        <div>
          <h1 className="page-title">Airing schedule</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            <Clock size={13} style={{ verticalAlign: -2 }} /> {now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} ·{' '}
            <b className="mono">{now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</b> · {timezone}
          </p>
        </div>
        <div className="row">
          <button className="icon-btn bordered" aria-label="Previous week" onClick={() => setWeekOffset((w) => w - 1)}>
            <ChevronLeft size={16} />
          </button>
          <button
            className={cx('btn sm', weekOffset === 0 && day === todayIndex && 'on')}
            onClick={() => {
              setWeekOffset(0);
              setDay(todayIndex);
              scrolled.current = false;
            }}
          >
            <CalendarDays size={14} /> Today
          </button>
          <button className="icon-btn bordered" aria-label="Next week" onClick={() => setWeekOffset((w) => w + 1)}>
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="days">
        {days.map((d, i) => {
          const past = weekOffset < 0 || (weekOffset === 0 && i < todayIndex);
          const isTodayCard = weekOffset === 0 && i === todayIndex;
          return (
            <button key={i} className={cx('day', i === day && 'active', past && 'past', isTodayCard && 'today')} onClick={() => setDay(i)}>
              <small>{isTodayCard ? 'Today' : d.date.toLocaleDateString(undefined, { weekday: 'short' })}</small>
              <b>{d.date.getDate()}</b>
              <span className="day-count">{isLoading ? '…' : `${d.count} ep${d.count === 1 ? '' : 's'}`}</span>
            </button>
          );
        })}
      </div>

      <div className="sched-tools card">
        <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-3)' }} />
          <input className="input" style={{ width: '100%', paddingLeft: 30 }} placeholder="Filter this week…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter schedule" />
        </div>
        <Select<FormatFilter> ariaLabel="Format" width={170} value={format} onChange={setFormat} options={FORMAT_FILTERS} />
        <Checkbox checked={mineOnly} onChange={setMineOnly} label="My list & favourites only" />
        <div className="tabs" role="tablist" aria-label="View">
          <button className={cx('tab', view === 'timeline' && 'active')} onClick={() => saveView('timeline')} aria-label="Timeline view">
            <ListTree size={14} />
          </button>
          <button className={cx('tab', view === 'grid' && 'active')} onClick={() => saveView('grid')} aria-label="Grid view">
            <LayoutGrid size={14} />
          </button>
        </div>
      </div>

      {error && !data ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <Loading label="Loading the week…" />
      ) : items.length === 0 ? (
        <Empty title={mineOnly || query || format !== 'all' ? 'Nothing matches your filters' : 'Nothing airs on this day'}>Try another day or clear the filters.</Empty>
      ) : view === 'grid' ? (
        <div className="grid six">
          {items.map((a) => (
            <MediaCard
              key={a.id}
              media={a.media}
              to={a.airingAt <= nowSec ? `/watch/${a.media.id}/${a.episode}` : undefined}
              badge={<span className={cx('chip', a.airingAt <= nowSec ? 'accent' : undefined)}>EP {a.episode}</span>}
              subtitle={`${airTime(a.airingAt)} · ${a.airingAt <= nowSec ? 'aired' : `in ${countdown(a.airingAt)}`}`}
            />
          ))}
        </div>
      ) : (
        <div className="timeline">
          {items.map((a, i) => {
            const aired = a.airingAt <= nowSec;
            const showNow = isToday && !aired && (i === 0 || items[i - 1].airingAt <= nowSec);
            return (
              <div key={a.id}>
                {showNow && (
                  <div className="now-line" ref={nowRef}>
                    <span>Now · {airTime(nowSec)}</span>
                  </div>
                )}
                <ScheduleSlot item={a} aired={aired} next={a.id === nextId} inList={mine.has(a.media.id)} title={titleOf(a.media, lang)} />
              </div>
            );
          })}
          {isToday && items.every((a) => a.airingAt <= nowSec) && (
            <div className="now-line" ref={nowRef}>
              <span>Now · {airTime(nowSec)} — that’s everything for today</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScheduleSlot({ item: a, aired, next, inList, title }: { item: AiringItem; aired: boolean; next: boolean; inList: boolean; title: string }) {
  const navigate = useNavigate();
  const setStatus = useSetStatus();
  const toast = useToast();
  const lang = useSettings().appearance.titleLanguage;
  return (
    <div className={cx('slot', aired && 'aired', next && 'next')}>
      <div className="slot-time">
        {airTime(a.airingAt)}
        <div>{aired ? <span className="chip">Aired</span> : next ? <span className="chip accent">Up next</span> : <span className="chip">in {countdown(a.airingAt)}</span>}</div>
      </div>
      <div className="slot-line">
        <i />
      </div>
      <div className="card slot-card">
        <HoverPreview media={a.media} watchTo={aired ? `/watch/${a.media.id}/${a.episode}` : undefined}>
          <img src={a.media.cover} alt="" loading="lazy" style={{ cursor: 'pointer' }} onClick={() => navigate(`/anime/${a.media.id}`)} />
        </HoverPreview>
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="ellipsis grow" style={{ fontWeight: 750, fontSize: 'var(--fs-md)', cursor: 'pointer' }} onClick={() => navigate(`/anime/${a.media.id}`)}>
              {title}
            </span>
            {a.media.score ? (
              <span className="chip">
                <Star size={10} fill="var(--warn)" color="var(--warn)" /> {(a.media.score / 10).toFixed(1)}
              </span>
            ) : null}
            <span className="chip">{formatLabel(a.media.format)}</span>
          </div>
          <div style={{ color: 'var(--accent)', fontWeight: 650, fontSize: 'var(--fs-sm)', margin: '3px 0 6px' }}>
            Episode {a.episode}
            {a.media.episodes ? ` of ${a.media.episodes}` : ''}
            {a.media.duration ? ` · ${a.media.duration} min` : ''}
          </div>
          <p className="faint clamp-2" style={{ margin: '0 0 8px', fontSize: 'var(--fs-sm)' }}>
            {a.media.description ?? ''}
          </p>
          <div className="row wrap" style={{ gap: 6 }}>
            {a.media.genres.slice(0, 3).map((g) => (
              <span key={g} className="chip">
                {g}
              </span>
            ))}
            <div className="grow" />
            {aired && (
              <button className="btn primary xs" onClick={() => navigate(`/watch/${a.media.id}/${a.episode}`)}>
                <Play size={12} fill="currentColor" /> Watch EP {a.episode}
              </button>
            )}
            <button className="btn xs" onClick={() => navigate(`/anime/${a.media.id}`)}>
              <Info size={12} /> Details
            </button>
            <button
              className={cx('btn xs', inList && 'on')}
              disabled={inList}
              onClick={() =>
                setStatus.mutate(
                  { media: snapshotOf(a.media, lang), status: 'PLANNING' },
                  { onSuccess: () => toast.push({ level: 'success', message: `Added “${title}” to Plan to watch.` }) },
                )
              }
            >
              {inList ? <Check size={12} /> : <BookmarkPlus size={12} />} {inList ? 'In your list' : 'Plan'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
