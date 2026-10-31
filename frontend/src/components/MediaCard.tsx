import { BookmarkPlus, CalendarClock, ChevronLeft, ChevronRight, Copy, ExternalLink, Heart, Info, ListVideo, Mic, Play, Star, Subtitles, X } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { MediaCard as Media } from '../../../app/shared/types';
import { call } from '../lib/bridge';
import { availableEpisodes, formatLabel, pendingRelease, snapshotOf, titleOf } from '../lib/format';
import { useSetStatus, useSettings, useToggleFavourite } from '../lib/queries';
import { useToast } from '../lib/useToast';
import { useContextMenu, type MenuItem } from './contextMenuContext';
import { HoverPreview } from './HoverCard';
import type {HoverAudioProps} from './AudioTags';

interface Props extends HoverAudioProps {
  media: Media;
  /** Overrides the destination (e.g. resume a specific episode). */
  to?: string;
  badge?: ReactNode;
  progress?: number;
  subtitle?: ReactNode;
  /** Shows a remove (✕) button and menu item, e.g. "Remove from Continue watching". */
  onRemove?: { label: string; run: () => void };
}

export function MediaCard({ media, to, badge, progress, subtitle, onRemove, audioCounts, audioCategory, audioSource }: Props) {
  const navigate = useNavigate();
  const lang = useSettings().appearance.titleLanguage;
  const title = titleOf(media, lang);
  const aired = availableEpisodes(media);
  const pending = pendingRelease(media);
  const release = pending?.title ? pending : null;
  const open = () => navigate(to ?? `/anime/${media.id}`);
  const menu = useContextMenu();
  const setStatus = useSetStatus();
  const toggleFav = useToggleFavourite();
  const toast = useToast();
  const watchTo = to?.startsWith('/watch/') ? to : `/watch/${media.id}/1`;

  const items = (): MenuItem[] => {
    const snap = snapshotOf(media, lang);
    const list: MenuItem[] = [
      release
        ? { label: release.action, icon: <CalendarClock size={15} />, onSelect: () => navigate(watchTo) }
        : { label: to?.startsWith('/watch/') ? 'Resume' : 'Watch', icon: <Play size={15} />, onSelect: () => navigate(watchTo) },
      { label: 'Details', icon: <Info size={15} />, onSelect: () => navigate(`/anime/${media.id}`) },
      { label: '', separator: true },
      { label: 'Add to Plan to watch', icon: <BookmarkPlus size={15} />, onSelect: () => setStatus.mutate({ media: snap, status: 'PLANNING' }, { onSuccess: () => toast.push({ level: 'success', message: `Added “${title}” to Plan to watch.` }) }) },
      { label: 'Toggle favourite', icon: <Heart size={15} />, onSelect: () => toggleFav.mutate(snap, { onSuccess: (r) => toast.push({ level: 'success', message: r.favourite ? 'Added to favourites.' : 'Removed from favourites.' }) }) },
      { label: 'Copy title', icon: <Copy size={15} />, onSelect: () => void navigator.clipboard.writeText(title) },
      { label: 'Open on AniList', icon: <ExternalLink size={15} />, onSelect: () => void call('app.openExternal', { url: `https://anilist.co/anime/${media.id}` }) },
    ];
    if (onRemove) list.push({ label: '', separator: true }, { label: onRemove.label, icon: <X size={15} />, danger: true, onSelect: onRemove.run });
    return list;
  };

  return (
    <HoverPreview media={media} audioCounts={audioCounts} audioCategory={audioCategory} audioSource={audioSource} watchTo={to?.startsWith('/watch/') ? to : undefined}>
    <div className="mcard" role="link" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === 'Enter' && open()} onContextMenu={(e) => menu.open(e, items(), { title, subtitle: [formatLabel(media.format), media.seasonYear, media.episodes ? `${media.episodes} eps` : null].filter(Boolean).join(' · '), image: media.cover })}>
      <div className="mcard-poster" style={{ backgroundColor: media.coverColor ?? undefined }}>
        {onRemove && (
          <button
            className="mcard-remove"
            aria-label={onRemove.label}
            title={onRemove.label}
            onClick={(e) => {
              e.stopPropagation();
              onRemove.run();
            }}
          >
            <X size={14} />
          </button>
        )}
        <img src={media.cover} alt="" loading="lazy" decoding="async" />
        <div className="top">
          {media.score ? (
            <span className="chip glass">
              <Star size={11} fill="var(--warn)" color="var(--warn)" /> {(media.score / 10).toFixed(1)}
            </span>
          ) : (
            <span />
          )}
          {badge ?? (release ? <span className="chip accent">{release.reason === 'cinema' ? 'In cinemas' : 'Upcoming'}</span> : media.isAdult && <span className="chip err">18+</span>)}
        </div>
        <div className="bottom">
          {audioCounts?<span className="chip glass" title="Source episode counts"><Subtitles size={11}/> {audioCounts.sub??'?'} <Mic size={11}/> {audioCounts.dub??'?'} / {audioCounts.total??'?'}</span>:(aired>0||media.episodes) ? (
            <span className="chip glass" title="Episodes available / total">
              <ListVideo size={11}/> {aired||'?'}{media.episodes&&media.episodes!==aired?' / '+media.episodes:''}
            </span>
          ):null}
          {release ? (
            <span className="chip glass" title="Release">
              <CalendarClock size={11} /> {release.short}
            </span>
          ) : (
            media.nextAiring && <span className="chip accent">EP {media.nextAiring.episode} soon</span>
          )}
        </div>
        <div className="mcard-play">
          <span>{release ? <CalendarClock size={20} /> : <Play size={20} fill="currentColor" />}</span>
        </div>
        {progress !== undefined && progress > 0 && (
          <div className="mcard-progress">
            <i style={{ width: `${Math.min(100, progress * 100)}%` }} />
          </div>
        )}
      </div>
      <div className="mcard-title">
        {media.status === 'RELEASING' && <span className="dot" title="Airing" />}
        <span className="clamp-2">{title}</span>
      </div>
      <div className="mcard-meta">{subtitle ?? [formatLabel(media.format), media.seasonYear, media.duration ? `${media.duration}m` : null].filter(Boolean).join(' · ')}</div>
    </div>
    </HoverPreview>
  );
}

export function SkeletonCards({ count = 8 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="mcard">
          <div className="skeleton" style={{ aspectRatio: '2 / 3' }} />
          <div className="skeleton" style={{ height: 12, width: '80%' }} />
        </div>
      ))}
    </>
  );
}

/** Horizontally scrolling section with arrow controls. */
export function CardRail({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const scroll = (dir: number) => track.current?.scrollBy({ left: dir * track.current.clientWidth * 0.85, behavior: 'smooth' });
  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">{title}</h2>
        <div className="more">{action}</div>
        <div className="rail-arrows">
          <button className="icon-btn bordered" aria-label="Scroll left" onClick={() => scroll(-1)}>
            <ChevronLeft size={16} />
          </button>
          <button className="icon-btn bordered" aria-label="Scroll right" onClick={() => scroll(1)}>
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <div className="rail-track" ref={track}>
        {children}
      </div>
    </section>
  );
}
