import { useQueryClient } from '@tanstack/react-query';
import { BookmarkCheck, BookmarkPlus, CalendarClock, Heart, Info, Play, TvMinimalPlay } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { MediaDetails } from '../../../app/shared/types';
import { call } from '../lib/bridge';
import { availableEpisodes, cx, formatLabel, seasonLabel, snapshotOf, titleOf, type PendingRelease } from '../lib/format';
import { keys, useLibraryState, useSetStatus, useSettings, useToggleFavourite } from '../lib/queries';
import { useToast } from '../lib/useToast';

/**
 * Shown on the Watch page instead of the player when the title hasn't premiered
 * or the requested episode hasn't aired yet: when it releases, with a live
 * countdown when the broadcast time is known.
 */
export function ReleasePanel({ media, pending, onReleased }: { media: MediaDetails; pending: PendingRelease; onReleased: () => void }) {
  const navigate = useNavigate();
  const lang = useSettings().appearance.titleLanguage;
  const { data: state } = useLibraryState(media.id);
  const setStatus = useSetStatus();
  const toggleFav = useToggleFavourite();
  const toast = useToast();
  const qc = useQueryClient();
  const title = titleOf(media, lang);
  const snapshot = snapshotOf(media, lang);
  const latest = availableEpisodes(media);
  const listed = state?.entry?.status;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const released = () => {
    void qc.invalidateQueries({ queryKey: keys.details(media.id) });
    onReleased();
  };

  return (
    <div className="page">
      <section className="release">
        <div className="release-bg" style={{ backgroundImage: `url("${media.banner ?? media.cover}")` }} />
        <div className="release-body">
          <img className="release-cover" src={media.cover} alt="" />
          <div className="release-info">
            <span className="chip accent release-kicker">
              <CalendarClock size={12} />{' '}
              {pending.reason === 'cinema' ? 'In cinemas — not on streaming yet' : pending.reason === 'premiere' ? 'Not released yet' : `Episode ${pending.episode} hasn’t aired yet`}
            </span>
            <h1 className="release-title clamp-2 selectable">{title}</h1>
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="chip">{formatLabel(media.format)}</span>
              {media.episodes && <span className="chip">{media.episodes} episodes</span>}
              {media.season && <span className="chip">{seasonLabel(media.season, media.seasonYear)}</span>}
              {media.studios[0] && <span className="chip">{media.studios[0]}</span>}
              {media.genres.slice(0, 3).map((g) => (
                <span key={g} className="chip">
                  {g}
                </span>
              ))}
            </div>

            <div className="release-when">
              <span className="faint">
                {pending.reason === 'cinema' ? 'Theatrical release' : pending.reason === 'premiere' ? (pending.exact ? 'Premieres' : 'Release') : pending.exact ? `Episode ${pending.episode} airs` : `Episode ${pending.episode} expected`}
              </span>
              <strong>{pending.label}</strong>
              {pending.exact && <span className="faint">Your time · {zone}</span>}
            </div>
            {pending.at !== null && <Countdown at={pending.at} onDone={released} />}
            {pending.reason === 'cinema' && <p className="faint" style={{ margin: 0 }}>Films usually reach streaming a few months after their cinema run. AniVerse will offer to play it once it’s listed as finished.</p>}

            {media.description && <p className="release-desc clamp-3">{media.description}</p>}

            <div className="row wrap" style={{ gap: 10 }}>
              {!pending.title && latest > 0 && (
                <button className="cta" onClick={() => navigate(`/watch/${media.id}/${latest}`)}>
                  <span className="row">
                    <Play size={15} fill="currentColor" /> Watch episode {latest}
                  </span>
                </button>
              )}
              <button
                className={cx('btn lg', listed && 'on')}
                disabled={!!listed || setStatus.isPending}
                onClick={() => setStatus.mutate({ media: snapshot, status: 'PLANNING' }, { onSuccess: () => toast.push({ level: 'success', message: `Added “${title}” to Plan to watch.` }) })}
              >
                {listed ? <BookmarkCheck size={16} /> : <BookmarkPlus size={16} />} {listed ? 'In your list' : 'Plan to watch'}
              </button>
              <button className={cx('btn lg', state?.favourite && 'on')} onClick={() => toggleFav.mutate(snapshot)} aria-pressed={!!state?.favourite}>
                <Heart size={16} fill={state?.favourite ? 'currentColor' : 'none'} /> {state?.favourite ? 'Favourited' : 'Favourite'}
              </button>
              {media.trailer?.site === 'youtube' && (
                <button className="btn lg ghost" onClick={() => void call('app.openExternal', { url: `https://www.youtube.com/watch?v=${media.trailer!.id}` })}>
                  <TvMinimalPlay size={16} /> Trailer
                </button>
              )}
              <button className="btn lg ghost" onClick={() => navigate(`/anime/${media.id}`)}>
                <Info size={15} /> Details
              </button>
            </div>
            <button className="release-anyway" onClick={() => navigate(`/watch/${media.id}/${pending.episode}?anyway=1`)}>
              Already out? Try the sources anyway
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function Countdown({ at, onDone }: { at: number; onDone: () => void }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  const left = Math.max(0, at - now);
  const fired = useRef(false);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (left > 0 || fired.current) return;
    fired.current = true;
    onDone();
  }, [left, onDone]);
  const parts: [number, string][] = [
    [Math.floor(left / 86400), 'days'],
    [Math.floor((left % 86400) / 3600), 'hours'],
    [Math.floor((left % 3600) / 60), 'min'],
    [Math.floor(left % 60), 'sec'],
  ];
  return (
    <div className="countdown" role="timer" aria-label="Time until release">
      {parts.map(([n, unit]) => (
        <div key={unit} className="countdown-cell">
          <b>{String(n).padStart(2, '0')}</b>
          <span>{unit}</span>
        </div>
      ))}
    </div>
  );
}
