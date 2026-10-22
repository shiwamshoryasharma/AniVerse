import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { AiringItem } from '../../../app/shared/types';
import { call } from '../lib/bridge';
import { cx, timeAgo, titleOf } from '../lib/format';
import { useSettings } from '../lib/queries';
import { useToast } from '../lib/useToast';
import { ErrorState } from './common';
import { MediaCard, SkeletonCards } from './MediaCard';

type Filter = 'all' | 'tv' | 'other' | 'top';
const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['tv', 'TV'],
  ['other', 'ONA / Other'],
  ['top', 'Top rated'],
];
const REFRESH_MS = 5 * 60_000;
const SEEN_KEY = 'aniverse.latestSeen';

function readSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

/**
 * The newest aired episodes (6×6, one card per show), polled every 5 minutes so
 * new releases appear on their own. Episodes newer than your last visit get a
 * NEW badge, and a notice pops up when one airs while you are here.
 */
export function LatestGrid() {
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<Filter>('all');
  const [seenAt] = useState(readSeen);
  const [now, setNow] = useState(() => Date.now());
  const navigate = useNavigate();
  const toast = useToast();
  const lang = useSettings().appearance.titleLanguage;
  const { data, error, refetch, isPlaceholderData, dataUpdatedAt } = useQuery({
    queryKey: ['latest', page],
    queryFn: () => call('meta.latest', { page }),
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    staleTime: 60_000,
  });

  // Remember the newest episode seen so the next visit can highlight newer ones.
  const newest = useRef(0);
  useEffect(() => {
    if (page === 1 && data?.items[0]) newest.current = Math.max(newest.current, data.items[0].airingAt);
  }, [data, page]);
  useEffect(
    () => () => {
      try {
        if (newest.current) localStorage.setItem(SEEN_KEY, String(newest.current));
      } catch {
        // storage unavailable
      }
    },
    [],
  );

  // Announce episodes that appear while the page is open.
  const known = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (page !== 1 || !data || isPlaceholderData) return;
    const ids = new Set(data.items.map((a) => a.id));
    if (known.current) {
      const fresh = data.items.filter((a) => !known.current!.has(a.id));
      if (fresh.length) {
        toast.push({
          level: 'info',
          message: fresh.length === 1 ? `New episode: ${titleOf(fresh[0].media, lang)} — EP ${fresh[0].episode}` : `${fresh.length} new episodes just aired, including ${titleOf(fresh[0].media, lang)}.`,
          action: { label: 'Watch', run: () => navigate(`/watch/${fresh[0].media.id}/${fresh[0].episode}`) },
        });
      }
    }
    known.current = ids;
  }, [data, page, isPlaceholderData, toast, navigate, lang]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const items = useMemo(() => {
    const list = data?.items ?? [];
    const tv = (a: AiringItem) => a.media.format === 'TV' || a.media.format === 'TV_SHORT';
    if (filter === 'tv') return list.filter(tv);
    if (filter === 'other') return list.filter((a) => !tv(a));
    if (filter === 'top') return [...list].sort((a, b) => (b.media.score ?? 0) - (a.media.score ?? 0));
    return list;
  }, [data, filter]);

  const updated = dataUpdatedAt ? Math.max(0, Math.round((now - dataUpdatedAt) / 60000)) : null;

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">Latest episodes</h2>
        <span className="row faint" style={{ gap: 6, fontSize: 'var(--fs-xs)' }} title="Checks for new episodes every 5 minutes">
          <span className="dot" /> {updated === null ? 'Loading…' : updated === 0 ? 'Updated just now' : `Updated ${updated}m ago`}
        </span>
        <div className="tabs" style={{ marginLeft: 'auto' }}>
          {FILTERS.map(([f, label]) => (
            <button key={f} className={cx('tab', filter === f && 'active')} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
        <div className="rail-arrows">
          <button className="icon-btn bordered" aria-label="Newer" disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            <ChevronLeft size={16} />
          </button>
          <button className="icon-btn bordered" aria-label="Older" disabled={!data?.hasNext} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight size={16} />
          </button>
        </div>
        <button className="more" style={{ marginLeft: 0 }} onClick={() => navigate('/schedule')}>
          <CalendarDays size={14} /> Schedule
        </button>
      </div>
      {error && !data ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <div className={cx('grid six', isPlaceholderData && 'fading')}>
          {!data
            ? <SkeletonCards count={36} />
            : items.map((a) => (
                <MediaCard
                  key={a.id}
                  media={a.media}
                  to={`/watch/${a.media.id}/${a.episode}`}
                  badge={a.airingAt > seenAt && seenAt > 0 ? <span className="chip new">NEW</span> : <span className="chip accent">EP {a.episode}</span>}
                  subtitle={`EP ${a.episode} · ${timeAgo(a.airingAt)}`}
                />
              ))}
        </div>
      )}
      {data && items.length === 0 && <p className="muted">Nothing in this filter on this page.</p>}
      <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
        <span className="faint" style={{ fontSize: 'var(--fs-sm)' }}>Page {page}</span>
      </div>
    </section>
  );
}
