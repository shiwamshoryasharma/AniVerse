import { ChevronLeft, ChevronRight, Info, Play, Star } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { MediaCard as Media } from '../../../app/shared/types';
import { ErrorState } from '../components/common';
import { HoverPreview } from '../components/HoverCard';
import { CardRail, HomeSkeleton, MediaCard, SkeletonCards } from '../components/MediaCard';
import { cx, formatLabel, pendingRelease, seasonLabel, timeAgo, titleOf } from '../lib/format';
import { useDismissContinue, useContinue, useHome, useSettings } from '../lib/queries';
import { LatestGrid } from '../components/LatestGrid';
import { isAniVerse2 } from '../lib/bridge';
import '../styles/home-startup.css';

export function HomePage() {
  const { data, error, refetch, isLoading } = useHome();
  const { data: cont } = useContinue();
  const dismiss = useDismissContinue();
  const navigate = useNavigate();

  if (error && !data) {
    return (
      <div className="page">
        <ErrorState error={error} onRetry={() => void refetch()} title="Couldn’t load AniList" />
      </div>
    );
  }

  return (
    <div className="page home-page">
      {data ? <Hero items={data.spotlight} /> : <HomeSkeleton className="hero" />}

      <div className="home-grid">
        <div style={{ minWidth: 0 }}>
          <LatestGrid />
        </div>

        <aside className="section" style={{ position: 'sticky', top: 0 }}>
          <TopCharts trending={data?.trending ?? []} popular={data?.popularSeason ?? []} top={data?.topRated ?? []} />
        </aside>
      </div>

      {!!cont?.length && (
        <CardRail title="Continue watching">
          {cont.map((c) => (
            <MediaCard
              key={c.media.id}
              media={snapshotToCard(c.media)}
              to={`/watch/${c.media.id}/${c.episode}${c.sourceId ? `?source=${c.sourceId}` : ''}`}
              progress={c.duration ? c.position / c.duration : 0}
              badge={<span className="chip accent">EP {c.episode}</span>}
              subtitle={`Episode ${c.episode} · ${timeAgo(c.updatedAt)}`}
              onRemove={{ label: 'Remove from Continue watching', run: () => dismiss.mutate(c.media.id) }}
            />
          ))}
        </CardRail>
      )}

      <div>
        <div style={{ minWidth: 0 }}>
          <section className="section">
            <div className="section-head">
              <h2 className="section-title">{data ? `Popular this ${seasonLabel(data.season.season, data.season.year)}` : 'Popular this season'}</h2>
              <button className="more" onClick={() => data && navigate(`/browse?season=${data.season.season}&year=${data.season.year}&sort=POPULARITY_DESC`)}>
                View all <ChevronRight size={14} />
              </button>
            </div>
            <div className="grid six">{isLoading ? <SkeletonCards count={12} shimmerFirst /> : data?.popularSeason.slice(0, 12).map((m) => <MediaCard key={m.id} media={m} />)}</div>
          </section>
        </div>
      </div>

      {!!data?.upcoming.length && (
        <CardRail
          title="Coming soon"
          action={
            <span onClick={() => navigate('/browse?status=NOT_YET_RELEASED&sort=POPULARITY_DESC')}>
              View all <ChevronRight size={14} />
            </span>
          }
        >
          {data.upcoming.map((m) => (
            <MediaCard key={m.id} media={m} subtitle={[formatLabel(m.format), pendingRelease(m)?.label ?? (seasonLabel(m.season, m.seasonYear) || 'TBA')].join(' · ')} />
          ))}
        </CardRail>
      )}

      {!!data?.topRated.length && (
        <CardRail title="All-time favourites" action={<span onClick={() => navigate('/browse?sort=SCORE_DESC')}>View all <ChevronRight size={14} /></span>}>
          {data.topRated.map((m) => (
            <MediaCard key={m.id} media={m} />
          ))}
        </CardRail>
      )}
    </div>
  );
}

function snapshotToCard(s: { id: number; idMal: number | null; title: string; cover: string; banner: string | null; format: Media['format']; episodes: number | null }): Media {
  return {
    id: s.id,
    idMal: s.idMal,
    title: { romaji: s.title, english: s.title, native: null, userPreferred: s.title },
    cover: s.cover,
    coverColor: null,
    banner: s.banner,
    format: s.format,
    status: null,
    episodes: s.episodes,
    duration: null,
    score: null,
    season: null,
    seasonYear: null,
    genres: [],
    isAdult: false,
    nextAiring: null,
    startDate: null,
    description: null,
  };
}

function Hero({ items }: { items: Media[] }) {
  const [{ index, previous }, selectSlide] = useState({ index: 0, previous: -1 });
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);
  const [loadedArt, setLoadedArt] = useState<string[]>([]);
  const spotlight = useRef<HTMLElement>(null);
  const setIndex = useCallback((choose: number | ((current: number) => number)) => {
    selectSlide(current => {
      const next = typeof choose === 'number' ? choose : choose(current.index);
      return next === current.index ? current : { index: next, previous: current.index };
    });
  }, []);
  const navigate = useNavigate();
  const lang = useSettings().appearance.titleLanguage;
  const count = items.length;
  const hasSlides = count > 0;

  useEffect(() => {
    const target = spotlight.current;
    if (!isAniVerse2 || !hasSlides || !target) return;
    let inViewport = true;
    const syncVisibility = () => setVisible(inViewport && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      inViewport = entry.isIntersecting;
      syncVisibility();
    });
    observer.observe(target);
    document.addEventListener('visibilitychange', syncVisibility);
    syncVisibility();
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', syncVisibility);
    };
  }, [hasSlides]);

  useEffect(() => {
    if (paused || !visible || count < 2) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % count), 7000);
    return () => clearInterval(t);
  }, [paused, visible, count, setIndex]);

  if (!count) return null;
  const active = index % count;
  const current = items[active];
  const next = visible && loadedArt.includes(current.banner ?? current.cover) ? (active + 1) % count : -1;

  return (
    <section ref={spotlight} className="hero" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} aria-roledescription="carousel">
      {items.map((m, i) => {
        const art = m.banner ?? m.cover;
        return (
          <div key={m.id} className={cx('hero-slide', i === active && 'active')} aria-hidden={i !== active}>
            {(!isAniVerse2 || i === active || i === previous || i === next) && (
              <img src={art} alt="" decoding={isAniVerse2 ? 'async' : undefined}
                fetchPriority={isAniVerse2 ? (i === active ? 'high' : 'low') : undefined}
                onLoad={isAniVerse2 ? () => setLoadedArt(loaded => loaded.includes(art) ? loaded : [...loaded.slice(-2), art]) : undefined} />
            )}
          </div>
        );
      })}
      <div className="hero-body">
        <span className="hero-kicker">#{active + 1} Spotlight</span>
        <h1 className="hero-title clamp-2">{titleOf(current, lang)}</h1>
        <div className="row wrap">
          {current.score && (
            <span className="chip glass">
              <Star size={11} fill="var(--warn)" color="var(--warn)" /> {(current.score / 10).toFixed(1)}
            </span>
          )}
          <span className="chip glass">{formatLabel(current.format)}</span>
          {current.seasonYear && <span className="chip glass">{current.seasonYear}</span>}
          {current.episodes && <span className="chip glass">{current.episodes} eps</span>}
          {current.genres.slice(0, 3).map((g) => (
            <span key={g} className="chip glass">
              {g}
            </span>
          ))}
        </div>
        <p className="hero-desc clamp-3">{current.description}</p>
        <div className="hero-actions">
          <button className="cta" onClick={() => navigate(`/watch/${current.id}/1`)}>
            <span className="row">
              <Play size={15} fill="currentColor" /> Watch now
            </span>
          </button>
          <button className="cta outline" onClick={() => navigate(`/anime/${current.id}`)}>
            <span className="row">
              <Info size={15} /> Details
            </span>
          </button>
        </div>
      </div>
      <div className="hero-nav">
        <div className="hero-thumbs">
          {items.slice(0, 7).map((m, i) => (
            <button key={m.id} className={cx('hero-thumb', i === active && 'active')} onClick={() => setIndex(i)} aria-label={`Show ${titleOf(m, lang)}`}>
              <img src={m.cover} alt="" loading={isAniVerse2 ? 'lazy' : undefined} decoding={isAniVerse2 ? 'async' : undefined} />
            </button>
          ))}
        </div>
        <div className="row">
          <button className="icon-btn bordered" aria-label="Previous" onClick={() => setIndex((i) => (i - 1 + count) % count)}>
            <ChevronLeft size={16} />
          </button>
          <div className="hero-dots">
            {items.map((m, i) => (
              <button key={m.id} className={cx(i === active && 'active')} aria-label={`Slide ${i + 1}`} onClick={() => setIndex(i)} />
            ))}
          </div>
          <button className="icon-btn bordered" aria-label="Next" onClick={() => setIndex((i) => (i + 1) % count)}>
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </section>
  );
}

function TopCharts({ trending, popular, top }: { trending: Media[]; popular: Media[]; top: Media[] }) {
  const [tab, setTab] = useState<'trending' | 'season' | 'top'>('trending');
  const navigate = useNavigate();
  const lang = useSettings().appearance.titleLanguage;
  const list = (tab === 'trending' ? trending : tab === 'season' ? popular : top).slice(0, 10);

  return (
    <>
      <div className="section-head">
        <h2 className="section-title">Top charts</h2>
      </div>
      <div className="tabs" style={{ marginBottom: 12, width: '100%' }}>
        {(
          [
            ['trending', 'Trending'],
            ['season', 'Season'],
            ['top', 'All time'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={cx('tab', tab === k && 'active')} style={{ flex: 1 }} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="rank-list">
        {list.length === 0 && Array.from({ length: 6 }, (_, i) => (i === 0 ? <HomeSkeleton key={i} style={{ height: 78 }} /> : <div key={i} className="skeleton" style={{ height: 78 }} />))}
        {list.map((m, i) => (
          <HoverPreview key={m.id} media={m}>
          <div className="rank-item" onClick={() => navigate(`/anime/${m.id}`)} role="link" tabIndex={0}>
            <span className="rank-num">{i + 1}</span>
            <img src={m.cover} alt="" loading="lazy" />
            <div style={{ minWidth: 0 }}>
              <div className="name clamp-2">{titleOf(m, lang)}</div>
              <div className="row">
                {m.score && (
                  <span className="chip">
                    <Star size={10} fill="var(--warn)" color="var(--warn)" /> {(m.score / 10).toFixed(1)}
                  </span>
                )}
                <span className="chip">{formatLabel(m.format)}</span>
                {m.episodes && <span className="chip">{m.episodes} eps</span>}
              </div>
            </div>
          </div>
          </HoverPreview>
        ))}
      </div>
    </>
  );
}
