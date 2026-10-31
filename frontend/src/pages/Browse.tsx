import { FilterX, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { BrowseQuery, BrowseSort, MediaFormat, MediaSeason, MediaStatus } from '../../../app/shared/types';
import { Empty, ErrorState, Spinner } from '../components/common';
import { Checkbox, Select, type SelectOption } from '../components/controls';
import { MediaCard, SkeletonCards } from '../components/MediaCard';
import { cx, formatLabel } from '../lib/format';
import {SourceCatalogueResults} from '../components/SourceCatalogueResults';
import {AudioFilter,type AudioChoice} from '../components/AudioFilter';
import { useBrowse, useGenres } from '../lib/queries';


const FORMATS: MediaFormat[] = ['TV', 'TV_SHORT', 'MOVIE', 'OVA', 'ONA', 'SPECIAL', 'MUSIC'];
const SEASONS: MediaSeason[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
const STATUSES: [MediaStatus, string][] = [
  ['RELEASING', 'Airing'],
  ['FINISHED', 'Finished'],
  ['NOT_YET_RELEASED', 'Upcoming'],
  ['HIATUS', 'Hiatus'],
  ['CANCELLED', 'Cancelled'],
];
const SORTS: [BrowseSort, string][] = [
  ['POPULARITY_DESC', 'Most popular'],
  ['TRENDING_DESC', 'Trending'],
  ['SCORE_DESC', 'Top rated'],
  ['START_DATE_DESC', 'Newest'],
  ['UPDATED_AT_DESC', 'Recently updated'],
  ['FAVOURITES_DESC', 'Most favourited'],
  ['TITLE_ROMAJI', 'Title A–Z'],
  ['EPISODES_DESC', 'Most episodes'],
];
const SOURCES: [string, string][] = [
  ['MANGA', 'Manga'],
  ['LIGHT_NOVEL', 'Light novel'],
  ['ORIGINAL', 'Original'],
  ['VISUAL_NOVEL', 'Visual novel'],
  ['VIDEO_GAME', 'Video game'],
  ['NOVEL', 'Novel'],
  ['WEB_NOVEL', 'Web novel'],
  ['OTHER', 'Other'],
];
const COUNTRIES: [string, string][] = [
  ['JP', 'Japan'],
  ['CN', 'China'],
  ['KR', 'Korea'],
  ['TW', 'Taiwan'],
];

const ANY = (label: string): SelectOption<string> => ({ value: '', label });

const YEAR_NOW = new Date().getFullYear() + 1;
const YEARS = Array.from({ length: YEAR_NOW - 1959 }, (_, i) => YEAR_NOW - i);

function readQuery(p: URLSearchParams): BrowseQuery {
  const list = (k: string) => (p.get(k) ? p.get(k)!.split(',').filter(Boolean) : undefined);
  const num = (k: string) => (p.get(k) ? Number(p.get(k)) : undefined);
  return {
    search: p.get('search') ?? undefined,
    genres: list('genres'),
    excludedGenres: list('exclude'),
    formats: list('formats') as MediaFormat[] | undefined,
    season: (p.get('season') as MediaSeason) ?? undefined,
    year: num('year'),
    status: (p.get('status') as MediaStatus) ?? undefined,
    country: (p.get('country') as BrowseQuery['country']) ?? undefined,
    sourceMaterial: p.get('source') ?? undefined,
    minScore: num('score'),
    minEpisodes: num('minEp'),
    maxEpisodes: num('maxEp'),
    sort: (p.get('sort') as BrowseSort) ?? undefined,
    excludeLibrary: p.get('hideLibrary') === '1' || undefined,
  };
}

export function BrowsePage() {
  const [audio,setAudio]=useState<AudioChoice>('all');
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => readQuery(params), [params]);
  const [text, setText] = useState(query.search ?? '');
  const genres = useGenres();
  const result = useBrowse(query);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => setText(query.search ?? ''), [query.search]);

  const set = (key: string, value: string | number | undefined | null) => {
    const next = new URLSearchParams(params);
    if (value === undefined || value === null || value === '') next.delete(key);
    else next.set(key, String(value));
    setParams(next, { replace: true });
  };

  useEffect(() => {
    const t = setTimeout(() => {
      if ((query.search ?? '') !== text.trim()) set('search', text.trim());
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = result;
  useEffect(() => {
    if(audio!=='all')return;
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage,audio]);

  /** Genre chips cycle: off → include → exclude → off. */
  const cycleGenre = (g: string) => {
    const inc = new Set(query.genres ?? []);
    const exc = new Set(query.excludedGenres ?? []);
    if (inc.has(g)) {
      inc.delete(g);
      exc.add(g);
    } else if (exc.has(g)) exc.delete(g);
    else inc.add(g);
    const next = new URLSearchParams(params);
    if (inc.size) next.set('genres', [...inc].join(','));
    else next.delete('genres');
    if (exc.size) next.set('exclude', [...exc].join(','));
    else next.delete('exclude');
    setParams(next, { replace: true });
  };

  const toggleFormat = (f: MediaFormat) => {
    const set_ = new Set(query.formats ?? []);
    if (set_.has(f)) set_.delete(f);
    else set_.add(f);
    set('formats', [...set_].join(','));
  };

  const items = result.data?.pages.flatMap((p) => p.items) ?? [];
  const total = result.data?.pages[0]?.total ?? 0;
  const activeFilters = [...params.keys()].length;

  return (
    <div className="page">
      <div className="browse">
        <aside className="card side-panel">
          <h4>Genres</h4>
          <div className="chips">
            {(genres.data?.genres ?? []).map((g) => (
              <button
                key={g}
                className={cx('chip', query.genres?.includes(g) && 'on', query.excludedGenres?.includes(g) && 'off')}
                onClick={() => cycleGenre(g)}
                title="Click to include, again to exclude"
              >
                {g}
              </button>
            ))}
          </div>
          <h4>Format</h4>
          <div className="chips">
            {FORMATS.map((f) => (
              <button key={f} className={cx('chip', query.formats?.includes(f) && 'on')} onClick={() => toggleFormat(f)}>
                {formatLabel(f)}
              </button>
            ))}
          </div>
          <h4>Quick links</h4>
          <div className="stack" style={{ gap: 4 }}>
            {(
              [
                ['Trending now', 'sort=TRENDING_DESC'],
                ['Airing now', 'status=RELEASING&sort=POPULARITY_DESC'],
                ['Upcoming', 'status=NOT_YET_RELEASED&sort=POPULARITY_DESC'],
                ['Top rated movies', 'formats=MOVIE&sort=SCORE_DESC'],
                ['Recently updated', 'sort=UPDATED_AT_DESC'],
              ] as const
            ).map(([label, qs]) => (
              <button key={label} className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={() => setParams(new URLSearchParams(qs), { replace: true })}>
                {label}
              </button>
            ))}
          </div>
        </aside>

        <div style={{ minWidth: 0 }}>
          <h1 className="page-title">Browse anime</h1>
          <p className="page-sub">
            {audio!=='all'?'Browsing the selected source catalogue':result.isLoading
              ? 'Searching AniList…'
              : // AniList reports a placeholder total of 5000 for broad filtered queries.
                total >= 5000
                ? `${items.length.toLocaleString()}${hasNextPage ? '+' : ''} results`
                : `${total.toLocaleString()} results`}
          </p>

          <div className="card" style={{ marginBottom: 18 }}>
            <div className="filter-bar">
              <div style={{ position: 'relative', gridColumn: 'span 2' }}>
                <Search size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-3)' }} />
                <input className="input" style={{ paddingLeft: 32 }} placeholder="Search titles…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search titles" />
              </div>
              <Select ariaLabel="Genre" value={query.genres?.[0] ?? ''} onChange={(v) => set('genres', v)} options={[ANY('Any genre'), ...(genres.data?.genres ?? []).map((g) => ({ value: g, label: g }))]} />
              <Select ariaLabel="Season" value={query.season ?? ''} onChange={(v) => set('season', v)} options={[ANY('Any season'), ...SEASONS.map((s) => ({ value: s, label: s[0] + s.slice(1).toLowerCase() }))]} />
              <Select ariaLabel="Year" value={query.year ? String(query.year) : ''} onChange={(v) => set('year', v)} options={[ANY('Any year'), ...YEARS.map((y) => ({ value: String(y), label: String(y) }))]} />
              <Select ariaLabel="Format" value={query.formats?.length === 1 ? query.formats[0] : ''} onChange={(v) => set('formats', v)} options={[ANY('Any format'), ...FORMATS.map((f) => ({ value: f, label: formatLabel(f) }))]} />
              <Select ariaLabel="Status" value={query.status ?? ''} onChange={(v) => set('status', v)} options={[ANY('Any status'), ...STATUSES.map(([v, l]) => ({ value: v, label: l }))]} />
              <Select ariaLabel="Country" value={query.country ?? ''} onChange={(v) => set('country', v)} options={[ANY('Any country'), ...COUNTRIES.map(([v, l]) => ({ value: v, label: l }))]} />
              <Select ariaLabel="Source material" value={query.sourceMaterial ?? ''} onChange={(v) => set('source', v)} options={[ANY('Any source'), ...SOURCES.map(([v, l]) => ({ value: v, label: l }))]} />
              <Select ariaLabel="Minimum score" value={query.minScore ? String(query.minScore) : ''} onChange={(v) => set('score', v)} options={[ANY('Any score'), ...[90, 80, 70, 60, 50].map((s) => ({ value: String(s), label: `${(s / 10).toFixed(1)}+` }))]} />
              <Select
                ariaLabel="Episode range"
                value={query.minEpisodes || query.maxEpisodes ? `${query.minEpisodes ?? ''}-${query.maxEpisodes ?? ''}` : ''}
                onChange={(v) => {
                  const [min, max] = v.split('-');
                  const next = new URLSearchParams(params);
                  if (min) next.set('minEp', min);
                  else next.delete('minEp');
                  if (max) next.set('maxEp', max);
                  else next.delete('maxEp');
                  setParams(next, { replace: true });
                }}
                options={[
                  ANY('Any length'),
                  { value: '1-1', label: 'Single episode' },
                  { value: '2-13', label: '2–13 eps' },
                  { value: '14-26', label: '14–26 eps' },
                  { value: '27-100', label: '27–100 eps' },
                  { value: '101-', label: '100+ eps' },
                ]}
              />
              <Select ariaLabel="Sort" value={query.sort ?? 'POPULARITY_DESC'} onChange={(v) => set('sort', v)} options={SORTS.map(([v, l]) => ({ value: v, label: l }))} />
            </div>
            <div className="filter-actions">
              <Checkbox checked={!!query.excludeLibrary} onChange={(on) => set('hideLibrary', on ? '1' : null)} label="Hide titles in my library" />
              {query.genres?.map((g) => (
                <button key={g} className="chip on" onClick={() => cycleGenre(g)}>
                  + {g}
                </button>
              ))}
              {query.excludedGenres?.map((g) => (
                <button key={g} className="chip off" onClick={() => cycleGenre(g)}>
                  − {g}
                </button>
              ))}
              <div className="grow" />
              {activeFilters > 0 && (
                <button className="btn ghost sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                  <FilterX size={14} /> Reset filters
                </button>
              )}
            </div>
          </div>

          <AudioFilter value={audio} onChange={setAudio} label="Browse audio availability"/>
          {audio!=='all'?<SourceCatalogueResults audio={audio} query={query}/>:result.error && !items.length ? (
            <ErrorState error={result.error} onRetry={() => void result.refetch()} />
          ) : !result.isLoading && !items.length ? (
            <Empty title="No anime match these filters">Try removing a filter or searching a different title.</Empty>
          ) : (
            <div className="grid">
              {items.map((m) => (
                <MediaCard key={m.id} media={m} />
              ))}
              {(result.isLoading || isFetchingNextPage) && <SkeletonCards count={12} />}
            </div>
          )}
          {audio==='all'&&<div ref={sentinel} style={{ height: 40, display: 'grid', placeItems: 'center', marginTop: 16 }}>
            {isFetchingNextPage && <Spinner />}
            {!hasNextPage && items.length > 0 && <span className="faint">That’s everything.</span>}
          </div>}
        </div>
      </div>
    </div>
  );
}
