import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Info, Play, Star } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import type { MediaCard } from '../../../app/shared/types';
import { call, isAniVerse2 } from '../lib/bridge';
import { availableEpisodes, countdown, pendingRelease, formatLabel, seasonLabel, statusLabel, titleOf } from '../lib/format';
import { useSettings } from '../lib/queries';
import {AudioTags,type HoverAudioProps} from './AudioTags';

const OPEN_DELAY = 420;
const CLOSE_DELAY = 140;
const hoverQuery = (id: number) => ({
  queryKey: ['hover', id],
  queryFn: () => call('meta.hover', { id }),
  staleTime: Infinity,
  retry: false,
});

/**
 * Shows a rich preview next to any media card after a short hover: rating,
 * episodes, genres, studio, original creator and synopsis. Extra details are
 * fetched once per title (cached) only when a preview actually opens.
 */
export function HoverPreview({ media, children, watchTo, ...audio }: HoverAudioProps&{ media: MediaCard; children: ReactNode; watchTo?: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const openTimer = useRef(0);
  const closeTimer = useRef(0);
  const host = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLElement>(null);
  const returningFocus = useRef(false);
  const prefetchTimer = useRef(0);
  const queryClient = useQueryClient();

  const scheduleOpen = () => {
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(openTimer.current);
    window.clearTimeout(prefetchTimer.current);
    if (isAniVerse2) {
      prefetchTimer.current = window.setTimeout(() => void queryClient.prefetchQuery(hoverQuery(media.id)), 160);
    }
    openTimer.current = window.setTimeout(() => {
      const el = host.current?.firstElementChild;
      if (el) setAnchor(el.getBoundingClientRect());
    }, OPEN_DELAY);
  };
  const scheduleClose = () => {
    window.clearTimeout(prefetchTimer.current);
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setAnchor(null), CLOSE_DELAY);
  };

  useEffect(() => {
    if (!anchor) return;
    const hide = (event: Event) => {
      if (isAniVerse2 && event.target instanceof Node && panel.current?.contains(event.target)) return;
      setAnchor(null);
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = launcher.current;
      if (target?.isConnected && panel.current?.contains(document.activeElement)) {
        event.preventDefault();
        returningFocus.current = true;
        target.focus();
        returningFocus.current = false;
      }
      window.clearTimeout(closeTimer.current);
      setAnchor(null);
    };
    if (isAniVerse2) window.addEventListener('keydown', dismiss);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('keydown', dismiss);
    };
  }, [anchor]);

  useEffect(
    () => () => {
      window.clearTimeout(prefetchTimer.current);
      window.clearTimeout(openTimer.current);
      window.clearTimeout(closeTimer.current);
    },
    [],
  );

  return (
    <div
      ref={host}
      style={{ display: 'contents' }}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocus={(event) => {
        if (!isAniVerse2) return;
        if (panel.current?.contains(event.target)) { window.clearTimeout(closeTimer.current); return; }
        if (!returningFocus.current && event.target instanceof HTMLElement && event.target.matches(':focus-visible')) {
          launcher.current = event.target;
          scheduleOpen();
        }
      }}
      onBlur={(event) => {
        if (isAniVerse2 && !host.current?.contains(event.relatedTarget) && !panel.current?.contains(event.relatedTarget)) scheduleClose();
      }}
      onKeyDown={(event) => {
        if (!isAniVerse2 || event.key !== 'ArrowDown' || !host.current?.contains(event.target as Node)) return;
        const action = panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
        if (action) {
          event.preventDefault();
          action.focus();
        }
      }}
      // Portal clicks bubble through React; only a press on the card itself closes the preview.
      onMouseDown={(e) => host.current?.contains(e.target as Node) && setAnchor(null)}
    >
      {children}
      {anchor &&
        createPortal(
          <PreviewCard {...audio} panel={panel} media={media} anchor={anchor} watchTo={watchTo} onEnter={() => window.clearTimeout(closeTimer.current)} onLeave={scheduleClose} onNavigate={() => setAnchor(null)} />,
          document.body,
        )}
    </div>
  );
}

function PreviewCard({
  panel,
  media,
  anchor,
  watchTo,
  onEnter,
  onLeave,
  onNavigate,
  ...audio
}: HoverAudioProps&{
  media: MediaCard;
  anchor: DOMRect;
  watchTo?: string;
  panel: RefObject<HTMLDivElement | null>;
  onEnter: () => void;
  onLeave: () => void;
  onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const settings = useSettings();
  const lang = settings.appearance.titleLanguage;
  const { data: extra, isLoading } = useQuery(hoverQuery(media.id));
  const [height, setHeight] = useState(440);
  useLayoutEffect(()=>{if(!panel.current)return;const observer=new ResizeObserver(()=>setHeight(panel.current?.getBoundingClientRect().height??440));observer.observe(panel.current);return ()=>observer.disconnect();},[panel]);
  const width = isAniVerse2 ? Math.min(320, Math.max(1, window.innerWidth - 16)) : 320;
  const gap = 12;
  const fitsRight = anchor.right + gap + width < window.innerWidth - 8;
  const left = fitsRight ? anchor.right + gap : Math.max(8, anchor.left - gap - width);
  const top = Math.max(64, Math.min(anchor.top - 10, window.innerHeight - height - 8));
  const aired = availableEpisodes(media);
  const pending = pendingRelease(media);
  const release = pending?.title ? pending : null;
  const go = (path: string) => {
    onNavigate();
    navigate(path);
  };

  return (
    <div ref={panel} className="hovercard" style={{ left, top, width, maxHeight:'calc(100dvh - 80px)', overflowY:'auto' }} onMouseEnter={onEnter} onMouseLeave={onLeave} role="dialog" aria-label={`${titleOf(media, lang)} preview`}>
      <div className="hovercard-head" style={{ backgroundImage: `url("${media.banner ?? media.cover}")` }} />
      <div className="hovercard-body">
        <div className="hovercard-title clamp-2">{titleOf(media, lang)}</div>
        <div className="row wrap" style={{ gap: 5 }}>
          {media.score ? (
            <span className="chip accent">
              <Star size={11} fill="currentColor" /> {(media.score / 10).toFixed(1)}
            </span>
          ) : null}
          <span className="chip">{formatLabel(media.format)}</span>
          <span className={media.status === 'RELEASING' ? 'chip ok' : 'chip'}>{statusLabel(media.status)}</span>
          {media.isAdult && <span className="chip err">18+</span>}
        </div>
        <AudioTags media={media} {...audio}/>
        <dl>
          <dt>Episodes</dt>
          <dd>
            {media.episodes ? `${media.episodes}` : aired ? `${aired}+` : '—'}
            {media.duration ? ` · ${media.duration} min` : ''}
            {media.nextAiring ? ` · EP ${media.nextAiring.episode} in ${countdown(media.nextAiring.airingAt)}` : ''}
          </dd>
          {release ? (
            <>
              <dt>Release</dt>
              <dd>{release.label}</dd>
            </>
          ) : (
            <>
              <dt>Season</dt>
              <dd>{seasonLabel(media.season, media.seasonYear) || '—'}</dd>
            </>
          )}
          <dt>Studio</dt>
          <dd className="ellipsis">{extra ? extra.studios.join(', ') || '—' : isLoading ? '…' : '—'}</dd>
          <dt>Creator</dt>
          <dd className="ellipsis">{extra ? extra.creators.join(', ') || 'Original' : isLoading ? '…' : '—'}</dd>
        </dl>
        {media.genres.length > 0 && (
          <div className="row wrap" style={{ gap: 5 }}>
            {media.genres.slice(0, 5).map((g) => (
              <span key={g} className="chip">
                {g}
              </span>
            ))}
          </div>
        )}
        {!settings.appearance.spoilerShield && (extra?.description ?? media.description) && <p className="hovercard-desc clamp-3">{extra?.description ?? media.description}</p>}
        <div className="row" style={{ marginTop: 2 }}>
          {release ? (
            <button className="btn primary sm grow" onClick={() => go(`/watch/${media.id}/1`)} title={release.label}>
              <CalendarClock size={13} /> {release.action}
            </button>
          ) : (
            <button className="btn primary sm grow" onClick={() => go(watchTo ?? `/watch/${media.id}/1`)}>
              <Play size={13} fill="currentColor" /> Watch
            </button>
          )}
          <button className="btn sm grow" onClick={() => go(`/anime/${media.id}`)}>
            <Info size={13} /> Details
          </button>
        </div>
      </div>
    </div>
  );
}
