import type Hls from 'hls.js';
import type { MediaPlayerClass, Representation } from 'dashjs';
import {
  Cast as CastIcon,
  FastForward,
  Gauge,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RectangleHorizontal,
  Rewind,
  Settings2,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { CastDevice, Settings, SubtitleTrack } from '../../../app/shared/types';
import { call, errorText } from '../lib/bridge';
import { CastMenu, CastOverlay } from './Cast';
import { isCasting, useCastState } from './useCastState';
import { Range } from '../components/controls';
import { clock, cx } from '../lib/format';
import { Anime4KPanel, Anime4KSurface } from '../components/Anime4K';
import { SubtitleStudio } from './SubtitleStudio';

export interface PlayerSource {
  type: 'hls' | 'dash' | 'mp4';
  url: string;
  subtitles: SubtitleTrack[];
}

export interface PlayerControls {
  seekBy(seconds: number): void;
  seekTo(seconds: number): void;
  state(): { position:number; duration:number; paused:boolean; totalFrames:number|null; droppedFrames:number|null } | null;
  toggle(): void;
  openCast(): void;
}

interface Props {
  source: PlayerSource;
  title?: string;
  /** Shown on the TV while casting. */
  subtitle?: string;
  poster?: string;
  startAt?: number;
  prefs: Settings['player'];
  theater?: boolean;
  controlsRef?: RefObject<PlayerControls | null>;
  hasPrev?: boolean;
  hasNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  onTheater?: () => void;
  /** Called every ~10 s while playing, and immediately on pause/seek/end. */
  onProgress?: (position: number, duration: number) => void;
  onEnded?: () => void;
  onVolume?: (volume: number) => void;
}

interface Level {
  index: number;
  label: string;
  height: number;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** Custom player for HLS (hls.js), DASH (dash.js) and progressive MP4/WebM. */
export function VideoPlayer({ source, title, subtitle, poster, startAt, prefs, theater, controlsRef, hasPrev, hasNext, onPrev, onNext, onTheater, onProgress, onEnded, onVolume }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const engine = useRef<{ hls: Hls | null; dash: MediaPlayerClass | null }>({ hls: null, dash: null });
  const lastReport = useRef(0);
  const idleTimer = useRef<number>(0);
  const flashTimer = useRef<number>(0);
  const cb = useRef({ onProgress, onEnded });
  useEffect(() => {
    cb.current = { onProgress, onEnded };
  });

  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(prefs.volume);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(prefs.speed);
  const [levels, setLevels] = useState<Level[]>([]);
  const [level, setLevel] = useState(-1);
  const [menu, setMenu] = useState<'speed' | 'quality' | 'upscale' | null>(null);
  const [idle, setIdle] = useState(false);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFs, setIsFs] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const cast = useCastState();
  const casting = isCasting(cast);
  const [castMenu, setCastMenu] = useState(false);
  const castEnded = useRef(false);

  // While the TV plays, keep recording progress from the TV's position.
  useEffect(() => {
    if (!casting || !cast.duration) return;
    const now = Date.now();
    if (now - lastReport.current > 10000) {
      lastReport.current = now;
      cb.current.onProgress?.(cast.currentTime, cast.duration);
    }
    if (cast.status === 'ended' && !castEnded.current) {
      castEnded.current = true;
      cb.current.onProgress?.(cast.duration, cast.duration);
      cb.current.onEnded?.();
    }
  }, [casting, cast.currentTime, cast.duration, cast.status]);

  const startCast = async (device: CastDevice, upscale4k = false) => {
    setCastMenu(false);
    const v = video.current!;
    v.pause();
    castEnded.current = false;
    try {
      await call('cast.start', {
        deviceId: device.id,
        media: {
          url: source.url,
          kind: source.type,
          upscale4k,
          title: title ?? 'AniVerse',
          subtitle,
          image: poster && /^https?:/.test(poster) ? poster : undefined,
          startAt: v.currentTime,
          subtitles: source.subtitles.filter((s) => /^https?:/.test(s.url)),
        },
      });
    } catch (err) {
      showFlash(errorText(err));
    }
  };
  const stopCast = async () => {
    setCastMenu(false);
    const resumeAt = cast.currentTime;
    await call('cast.stop').catch(() => undefined);
    if (resumeAt > 0 && video.current) video.current.currentTime = resumeAt;
  };

  const showFlash = (text: string) => {
    setFlash(text);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 700);
  };

  // ---------------------------------------------------------------- engine
  useEffect(() => {
    const v = video.current!;
    setError(null);
    setLevels([]);
    setLevel(-1);
    setWaiting(true);
    let networkRetries = 0;
    const start = startAt && startAt > 5 ? startAt : 0;
    const autoplay = () => {
      if (prefs.autoplay) v.play().catch(() => setPlaying(false));
    };

    let cancelled = false;
    const playNative = () => {
      // Native HLS (if any), MP4, WebM, local files.
      v.src = source.url;
      const onMeta = () => {
        if (start) v.currentTime = start;
        autoplay();
      };
      v.addEventListener('loadedmetadata', onMeta, { once: true });
    };

    // hls.js and dash.js are loaded on demand to keep the initial bundle small.
    if (source.type === 'hls') {
      void import('hls.js').then(({ default: HlsJs }) => {
        if (cancelled) return;
        if (!HlsJs.isSupported()) return playNative();
        const hls = new HlsJs({ enableWorker: true, capLevelToPlayerSize: true, startPosition: start || -1 });
        engine.current.hls = hls;
        hls.on(HlsJs.Events.MANIFEST_PARSED, (_e, data) => {
          const list = data.levels.map((l, i) => ({ index: i, height: l.height, label: l.height ? `${l.height}p` : `${Math.round(l.bitrate / 1000)} kbps` }));
          setLevels(list);
          const preferred = prefs.preferredQuality === 'auto' ? -1 : list.findIndex((l) => l.height === Number(prefs.preferredQuality));
          if (preferred >= 0) {
            hls.currentLevel = preferred;
            setLevel(preferred);
          }
          autoplay();
        });
        hls.on(HlsJs.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (data.type === HlsJs.ErrorTypes.NETWORK_ERROR && networkRetries < 3) {
            networkRetries++;
            hls.startLoad();
          } else if (data.type === HlsJs.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            setError(`Stream error: ${data.details}`);
          }
        });
        hls.loadSource(source.url);
        hls.attachMedia(v);
      });
    } else if (source.type === 'dash') {
      void import('dashjs').then(({ MediaPlayer }) => {
        if (cancelled) return;
        const dash = MediaPlayer().create();
        engine.current.dash = dash;
        dash.initialize(v, source.url, prefs.autoplay, start || undefined);
        dash.on(MediaPlayer.events.STREAM_INITIALIZED, () => {
          const reps = dash.getRepresentationsByType('video');
          setLevels(reps.map((r: Representation, i: number) => ({ index: i, height: r.height ?? 0, label: r.height ? `${r.height}p` : `${Math.round(r.bandwidth / 1000)} kbps` })));
        });
        dash.on(MediaPlayer.events.ERROR, (e: unknown) => {
          const msg = (e as { error?: { message?: string } }).error?.message;
          setError(`Stream error${msg ? `: ${msg}` : ''}`);
        });
      });
    } else {
      playNative();
    }
    if (start) showFlash(`Resumed at ${clock(start)}`);

    return () => {
      cancelled = true;
      engine.current.hls?.destroy();
      engine.current.dash?.reset();
      engine.current = { hls: null, dash: null };
      v.removeAttribute('src');
      v.load();
    };
    // Re-initialise only when the stream itself changes (or on retry).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.url, source.type, attempt]);

  useEffect(() => {
    const v = video.current!;
    v.volume = volume;
    v.muted = muted;
  }, [volume, muted]);

  useEffect(() => {
    video.current!.playbackRate = speed;
  }, [speed]);

  // ---------------------------------------------------------------- media events
  useEffect(() => {
    const v = video.current!;
    const report = (force: boolean) => {
      if (!v.duration || !Number.isFinite(v.duration)) return;
      const now = Date.now();
      if (force || now - lastReport.current > 10000) {
        lastReport.current = now;
        cb.current.onProgress?.(v.currentTime, v.duration);
      }
    };
    const handlers: [string, () => void][] = [
      ['play', () => setPlaying(true)],
      ['pause', () => (setPlaying(false), report(true))],
      ['waiting', () => setWaiting(true)],
      ['playing', () => setWaiting(false)],
      ['canplay', () => setWaiting(false)],
      ['seeked', () => report(true)],
      ['durationchange', () => setDuration(v.duration)],
      ['loadedmetadata', () => setDuration(v.duration)],
      [
        'timeupdate',
        () => {
          setTime(v.currentTime);
          if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
          report(false);
        },
      ],
      ['ended', () => (report(true), cb.current.onEnded?.())],
      ['error', () => setError(v.error?.message || 'This video could not be played.')],
    ];
    for (const [name, fn] of handlers) v.addEventListener(name, fn);
    return () => {
      for (const [name, fn] of handlers) v.removeEventListener(name, fn);
    };
  }, []);

  useEffect(() => {
    const onFs = () => setIsFs(document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // ---------------------------------------------------------------- actions
  const toggle = () => {
    const v = video.current!;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  };
  const seekTo = (t: number) => {
    const v = video.current!;
    v.currentTime = Math.max(0, Math.min(t, (v.duration || t) - 0.2));
  };
  const seekBy = (d: number) => {
    seekTo(video.current!.currentTime + d);
    showFlash(`${d > 0 ? '+' : '−'}${Math.abs(d)}s`);
  };
  useEffect(() => {
    if (controlsRef) controlsRef.current = { seekBy, seekTo, toggle, openCast: () => setCastMenu(true), state: () => {
      const v=video.current;
      if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return null;
      const quality=v.getVideoPlaybackQuality?.();
      return {position:v.currentTime,duration:v.duration,paused:v.paused,totalFrames:quality?.totalVideoFrames ?? null,droppedFrames:quality?.droppedVideoFrames ?? null};
    } };
  });

  useEffect(() => () => { if (controlsRef) controlsRef.current = null; }, [controlsRef]);

  const changeVolume = (v: number) => {
    const next = Math.max(0, Math.min(1, v));
    setVolume(next);
    setMuted(next === 0);
    onVolume?.(next);
  };
  const toggleFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current!.requestFullscreen();
  };
  const togglePip = async () => {
    const v = video.current!;
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await v.requestPictureInPicture().catch(() => showFlash('Picture-in-picture unavailable'));
  };
  const pickLevel = (index: number) => {
    const { hls, dash } = engine.current;
    if (hls) hls.currentLevel = index;
    if (dash) {
      dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: index === -1 } } } });
      if (index >= 0) dash.setRepresentationForTypeByIndex('video', index, true);
    }
    setLevel(index);
    setMenu(null);
  };

  const wake = () => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2600);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') toggle();
    else if (k === 'j' || k === 'arrowleft') seekBy(k === 'j' ? -prefs.seekStep : -5);
    else if (k === 'l' || k === 'arrowright') seekBy(k === 'l' ? prefs.seekStep : 5);
    else if (k === 'arrowup') changeVolume(volume + 0.05);
    else if (k === 'arrowdown') changeVolume(volume - 0.05);
    else if (k === 'm') setMuted((m) => !m);
    else if (k === 'f') toggleFs();
    else if (k === 't') onTheater?.();
    else if (k === 's') seekBy(prefs.skipStep);
    else if (k === 'n' && e.shiftKey) onNext?.();
    else if (k === 'p' && e.shiftKey) onPrev?.();
    else if (k === '>' || k === '.') setSpeed((s) => SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(s) + 1)] ?? s);
    else if (k === '<' || k === ',') setSpeed((s) => SPEEDS[Math.max(0, SPEEDS.indexOf(s) - 1)] ?? s);
    else if (/^[0-9]$/.test(k) && duration) seekTo((Number(k) / 10) * duration);
    else return;
    e.preventDefault();
    wake();
  };

  useEffect(() => {
    box.current?.focus();
  }, [source.url]);

  const pct = (n: number) => (duration ? `${Math.min(100, (n / duration) * 100)}%` : '0%');
  const seekFromEvent = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * duration;
  };
  const VolIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div
      ref={box}
      className={cx('player', idle && playing && !menu && 'idle')}
      tabIndex={0}
      onKeyDown={onKey}
      onMouseMove={wake}
      onMouseLeave={() => playing && setIdle(true)}
      aria-label="Video player"
    >
      <video ref={video} playsInline crossOrigin={source.subtitles.length || source.url.startsWith('media:') ? 'anonymous' : undefined} onClick={toggle} onDoubleClick={toggleFs}>
        {source.subtitles.map((s, i) => (
          <track key={s.url} kind="subtitles" src={s.url} srcLang={s.lang} label={s.label} default={i === 0} />
        ))}
      </video>

      <Anime4KSurface key={source.url + JSON.stringify(prefs.upscale)} video={video} sourceKey={source.url} disabled={casting} />
      <SubtitleStudio key={source.url} video={video} style={prefs.subtitleStyle} />
      {title && <div className="player-title ellipsis">{title}</div>}

      <div className="player-center">
        {waiting && playing && !error ? (
          <span className="spinner lg" />
        ) : (
          !playing &&
          !error && (
            <button className="player-bigplay" aria-label="Play" onClick={toggle}>
              <Play size={30} fill="currentColor" />
            </button>
          )
        )}
      </div>
      {flash && <div className="player-flash">{flash}</div>}

      {casting && <CastOverlay state={cast} poster={poster} onStop={() => void stopCast()} />}
      {castMenu && <CastMenu state={cast} canUpscale={source.url.startsWith('media://local/')} onPick={(d, upscale4k) => void startCast(d, upscale4k)} onStop={() => void stopCast()} onClose={() => setCastMenu(false)} />}

      {error && (
        <div className="player-error">
          <div className="stack" style={{ alignItems: 'center' }}>
            <strong>{error}</strong>
            <span className="muted">The stream may be offline, geo-restricted or require a different source.</span>
            <button className="btn" onClick={() => setAttempt((a) => a + 1)}>
              Retry
            </button>
          </div>
        </div>
      )}

      {menu && (
        <div className={cx('player-menu', menu === 'upscale' && 'anime4k-menu')} onMouseLeave={() => setMenu(null)}>
          {menu === 'upscale' && <Anime4KPanel />}
          {menu === 'speed' && (
            <>
              <h5>Playback speed</h5>
              {SPEEDS.map((s) => (
                <button key={s} className={cx(s === speed && 'on')} onClick={() => (setSpeed(s), setMenu(null))}>
                  {s === 1 ? 'Normal' : `${s}×`}
                </button>
              ))}
            </>
          )}
          {menu === 'quality' && (
            <>
              <h5>Quality</h5>
              <button className={cx(level === -1 && 'on')} onClick={() => pickLevel(-1)}>
                Auto
              </button>
              {[...levels]
                .sort((a, b) => b.height - a.height)
                .map((l) => (
                  <button key={l.index} className={cx(l.index === level && 'on')} onClick={() => pickLevel(l.index)}>
                    {l.label}
                  </button>
                ))}
            </>
          )}
        </div>
      )}

      <div className="player-controls">
        <div
          className="seek"
          onMouseMove={(e) => setHover({ x: e.nativeEvent.offsetX, t: seekFromEvent(e) })}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => seekTo(seekFromEvent(e))}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
        >
          <div className="seek-track">
            <div className="seek-buffer" style={{ width: pct(buffered) }} />
            <div className="seek-played" style={{ width: pct(time) }} />
            <div className="seek-thumb" style={{ left: pct(time) }} />
          </div>
          {hover && (
            <div className="seek-tip" style={{ left: hover.x }}>
              {clock(hover.t)}
            </div>
          )}
        </div>
        <div className="player-row">
          <button className="icon-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>
            {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
          </button>
          <button className="icon-btn" aria-label="Previous episode" disabled={!hasPrev} onClick={onPrev}>
            <SkipBack size={17} />
          </button>
          <button className="icon-btn" aria-label="Next episode" disabled={!hasNext} onClick={onNext}>
            <SkipForward size={17} />
          </button>
          <button className="icon-btn" aria-label={`Back ${prefs.seekStep} seconds`} onClick={() => seekBy(-prefs.seekStep)}>
            <Rewind size={17} />
          </button>
          <button className="icon-btn" aria-label={`Forward ${prefs.seekStep} seconds`} onClick={() => seekBy(prefs.seekStep)}>
            <FastForward size={17} />
          </button>
          <div className="row vol-wrap" style={{ gap: 0 }}>
            <button className="icon-btn" aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => setMuted((m) => !m)}>
              <VolIcon size={18} />
            </button>
            <div className="volume">
              <Range value={muted ? 0 : volume} step={0.02} onChange={changeVolume} ariaLabel="Volume" width={76} />
            </div>
          </div>
          <span className="player-time">
            {clock(time)} / {clock(duration)}
          </span>
          <div className="grow" />
          <button className="btn xs" style={{ background: 'rgba(255,255,255,.12)', border: 0, color: '#fff' }} onClick={() => seekBy(prefs.skipStep)} title="Skip opening (S)">
            Skip +{prefs.skipStep}s
          </button>
          <button className={cx('btn xs', prefs.upscale.enabled && 'on')} aria-label="Anime4K Upscale" onClick={() => setMenu(menu === 'upscale' ? null : 'upscale')}>4K</button>
          <button className="icon-btn" aria-label="Speed" onClick={() => setMenu(menu === 'speed' ? null : 'speed')}>
            <Gauge size={17} />
          </button>
          {levels.length > 1 && (
            <button className="icon-btn" aria-label="Quality" onClick={() => setMenu(menu === 'quality' ? null : 'quality')}>
              <Settings2 size={17} />
            </button>
          )}
          <button className={cx('icon-btn', casting && 'on')} aria-label="Cast to a TV" title="Cast to TV · Windows wireless display or Google Cast" onClick={() => setCastMenu((v) => !v)}>
            <CastIcon size={17} />
          </button>
          <button className="icon-btn" aria-label="Picture in picture" onClick={() => void togglePip()}>
            <PictureInPicture2 size={17} />
          </button>
          {onTheater && (
            <button className={cx('icon-btn', theater && 'on')} aria-label="Theater mode" onClick={onTheater}>
              <RectangleHorizontal size={18} />
            </button>
          )}
          <button className="icon-btn" aria-label={isFs ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFs}>
            {isFs ? <Minimize size={17} /> : <Maximize size={17} />}
          </button>
        </div>
      </div>
    </div>
  );
}
