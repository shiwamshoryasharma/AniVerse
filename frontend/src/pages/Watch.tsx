import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FastForward,
  Heart,
  Info,
  Lightbulb,
  Pin,
  PinOff,
  RectangleHorizontal,
  Repeat,
  RotateCcw,
  RotateCw,
  Crop,
  Globe,
  ChevronUp,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { episodeFromUrl } from '../../../app/core/sources/text';
import { playbackHealth, type PlaybackHealth, type PlaybackSample } from '../../../app/shared/playback';
import type { MediaDetails, ProbeResult, SiteOptions, SourceInfo, Stream } from '../../../app/shared/types';
import { CommentsPanel } from '../components/CommentsPanel';
import { CatLoader } from '../components/CatLoader';
import { Empty, ErrorState, Loading, SourceIcon } from '../components/common';
import { EpisodeToolkit } from '../components/EpisodeToolkit';
import { SpoilerGuard } from '../components/SpoilerGuard';
import { EpisodePanel } from '../components/EpisodePanel';
import { ReleasePanel } from '../components/ReleasePanel';
import { PlaybackRescue } from '../components/PlaybackRescue';
import { WebSession, type WebSessionControls } from '../components/WebSession';
import { call, errorText, onEvent } from '../lib/bridge';
import { availableEpisodes, countdown, cx, formatLabel, mediaRefOf, pendingRelease, snapshotOf, statusLabel, titleOf } from '../lib/format';
import { keys, useDetails, useLibraryState, useMarkWatched, useMatch, useSaveProgress, useSettings, useSources, useStreams, useToggleFavourite, useUpdateSettings } from '../lib/queries';
import { useToast } from '../lib/useToast';
import { SiteAnime4K } from '../components/Anime4K';
import { VideoPlayer, type PlayerControls } from '../player/VideoPlayer';

/** YouTube asks embedded players in native apps to identify themselves with an app referrer. */
const APP_REFERRER = 'https://aniverse.app';

export function WatchPage() {
  const params = useParams();
  const mediaId = Number(params.id);
  const { data, error, refetch } = useDetails(mediaId);
  const { data: sources } = useSources();
  const { data: state } = useLibraryState(mediaId);
  const [search] = useSearchParams();
  const [, setReleased] = useState(0);
  if (error) {
    return (
      <div className="page">
        <ErrorState error={error} onRetry={() => void refetch()} />
      </div>
    );
  }
  if (!data || !sources || !state) return <Loading label="Preparing player…" />;
  const episode = Math.max(1, Number(params.episode) || 1);
  // Not out yet: show when it releases instead of opening a player or a site.
  const pending = search.get('anyway') || search.has('local') ? null : pendingRelease(data, episode);
  if (pending) return <ReleasePanel media={data} pending={pending} onReleased={() => setReleased((n) => n + 1)} />;
  return <Watch media={data} sources={sources} episode={episode} />;
}

function Watch({ media, sources, episode }: { media: MediaDetails; sources: SourceInfo[]; episode: number }) {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const lang = settings.appearance.titleLanguage;
  const { data: state } = useLibraryState(media.id);
  const saveProgress = useSaveProgress();
  const markWatched = useMarkWatched();
  const toggleFav = useToggleFavourite();
  const toast = useToast();
  const qc = useQueryClient();
  const snapshot = useMemo(() => snapshotOf(media, lang), [media, lang]);
  const title = titleOf(media, lang);

  const localId = Number(search.get('local')) || null;
  const local = useQuery({queryKey:['local-open',localId],queryFn:()=>call('collection.open',{id:localId!}),enabled:!!localId,retry:false,staleTime:Infinity});
  const localFiles = useQuery({queryKey:['collection'],queryFn:()=>call('collection.list'),enabled:!!localId});
  const adjacentLocal = (n:number) => localFiles.data?.find(f=>!f.missing && f.media?.id===media.id && f.episode===n);
  const enabled = sources.filter((s) => s.enabled);
  const lastUsed = state?.progress
    .filter((p) => p.sourceId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.sourceId;
  const sourceId = localId ? null : [search.get('source'), lastUsed, enabled[0]?.id].find((id) => id && enabled.some((s) => s.id === id)) ?? null;
  const source = enabled.find((s) => s.id === sourceId) ?? null;

  const titleVariants = [...new Set([media.title.english, media.title.romaji, media.title.native].filter((t): t is string => !!t))];
  const [searchTitle, setSearchTitle] = useState(titleVariants[0]);
  const ref = useMemo(() => mediaRefOf(media, searchTitle), [media, searchTitle]);
  const match = useMatch(sourceId, ref);
  const mode = match.data?.mode ?? null;
  const adapterEpisodes = match.data?.mode === 'episodes' ? match.data.episodes : null;
  const adapterEpisode = adapterEpisodes?.find((e) => e.number === episode) ?? null;
  const streams = useStreams(adapterEpisode ? sourceId : null, adapterEpisode?.ref ?? null);
  const stream: Stream | null = streams.data?.[0] ?? null;

  const watched = useMemo(() => new Set(state?.progress.filter((p) => p.completed).map((p) => p.episode)), [state]);
  const maxKnown = Math.max(episode, ...(adapterEpisodes?.map((e) => e.number) ?? [0]), ...(state?.progress.map((p) => p.episode) ?? [0]));
  const total = Math.max(availableEpisodes(media, maxKnown), 1);
  const available = adapterEpisodes ? new Set(adapterEpisodes.map((e) => e.number)) : null;
  const { titles, thumbs } = useMemo(() => episodeMeta(media, adapterEpisodes), [media, adapterEpisodes]);

  const [theater, setTheater] = useState(settings.player.theater);
  const [lightsOff, setLightsOff] = useState(false);
  const [webContentsId, setWebContentsId] = useState<number | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const player = useRef<PlayerControls | null>(null);
  const progressAt = useRef<{ position: number; duration: number } | null>(null);
  const [playbackProbe, setPlaybackProbe] = useState<ProbeResult | null>(null);
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackHealth | null>(null);

  // ---- Website sources: AniVerse drives the site (search → title → episode) and focuses its player.
  const siteKey = mode === 'web' && match.data && sourceId ? `${sourceId}:${media.id}` : null;
  const [siteStart, setSiteStart] = useState<{ key: string; url: string } | null>(null);
  if (siteKey && siteStart?.key !== siteKey && match.data) {
    // First page for this title on this site: best learned page, else search/title/home.
    setSiteStart({ key: siteKey, url: match.data.episodeUrls[episode] ?? match.data.titleUrl ?? match.data.pageUrl ?? source?.url ?? '' });
  }
  const siteSrc = siteStart && siteStart.key === siteKey ? siteStart.url : null;
  const navKey = siteKey && webContentsId ? `${siteKey}:${webContentsId}:${episode}` : null;
  const [navDone, setNavDone] = useState<string | null>(null);
  const [siteStatus, setSiteStatus] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [siteOptions, setSiteOptions] = useState<SiteOptions>({ types: [], servers: [] });
  const [choosing, setChoosing] = useState<string | null>(null);
  const [slowKey, setSlowKey] = useState<string | null>(null);
  const siteControls = useRef<WebSessionControls | null>(null);
  const siteBusy = !!siteKey && (!navKey || navDone !== navKey);
  // The site's security check needs the user: reveal the page instead of the loader.
  const needsUser = siteBusy && !!siteStatus?.startsWith('Waiting for the site');
  const adoptRef = useRef<number | null>(null);

  useEffect(() => {
    if (!siteBusy || !navKey) return;
    const t = window.setTimeout(() => setSlowKey(navKey), 15000);
    return () => window.clearTimeout(t);
  }, [siteBusy, navKey]);

  useEffect(() => onEvent('site.status', (e) => e.webContentsId === webContentsId && setSiteStatus(e.message)), [webContentsId]);

  useEffect(() => {
    if (!navKey || !webContentsId || !sourceId) return;
    let cancelled = false;
    const adopt = adoptRef.current === episode;
    adoptRef.current = null;
    const retries: number[] = [];
    call('site.openEpisode', { webContentsId, sourceId, mediaId: media.id, titles: ref.titles, episode, adopt, focus: settings.player.siteFocus })
      .then((r) => {
        if (cancelled) return;
        setFocused(r.focused);
        setSiteOptions(r.options);
        if (!r.ok && r.message) toast.push({ level: 'warn', message: r.message });
        // Some sites only render their audio/server switches seconds after the player loads.
        if (r.ok && !r.options.types.length && !r.options.servers.length) {
          let found = false;
          for (const delay of [4000, 10000]) {
            retries.push(
              window.setTimeout(() => {
                if (found || cancelled) return;
                void call('site.options', { webContentsId })
                  .then((o) => {
                    if (cancelled || (!o.types.length && !o.servers.length)) return;
                    found = true;
                    setSiteOptions(o);
                  })
                  .catch(() => undefined);
              }, delay),
            );
          }
        }
      })
      .catch((err) => !cancelled && toast.push({ level: 'error', message: errorText(err) }))
      .finally(() => !cancelled && setNavDone(navKey));
    return () => {
      cancelled = true;
      retries.forEach((t) => window.clearTimeout(t));
    };
    // The navigation key captures source, title, webview and episode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navKey]);

  const toggleFocus = async () => {
    if (!webContentsId) return;
    const want = !focused;
    updateSettings.mutate({ player: { siteFocus: want } });
    const r = await call('site.focus', { webContentsId, on: want }).catch(() => ({ focused: false }));
    setFocused(r.focused);
    if (want && !r.focused) toast.push({ level: 'info', message: 'No video player on this page yet — open an episode first.' });
  };

  /** Forgets what was learned for this title on this site and searches again. */
  const refind = async () => {
    if (!sourceId || !webContentsId) return;
    await call('site.forget', { sourceId, mediaId: media.id }).catch(() => undefined);
    void qc.invalidateQueries({ queryKey: keys.libraryState(media.id) });
    setNavDone(null);
    setFocused(false);
    call('site.openEpisode', { webContentsId, sourceId, mediaId: media.id, titles: ref.titles, episode, focus: settings.player.siteFocus })
      .then((r) => {
        setFocused(r.focused);
        setSiteOptions(r.options);
        if (!r.ok && r.message) toast.push({ level: 'warn', message: r.message });
      })
      .catch((err) => toast.push({ level: 'error', message: errorText(err) }))
      .finally(() => navKey && setNavDone(navKey));
  };

  /** Switches the site's audio type (SUB/DUB) or server, then re-isolates its player. */
  const chooseOption = async (kind: 'type' | 'server', value: string, label: string) => {
    if (!webContentsId || !sourceId) return;
    setChoosing(`Switching to ${label}…`);
    try {
      const r = await call('site.choose', { webContentsId, sourceId, kind, value });
      setSiteOptions(r.options);
      setFocused(r.focused);
    } catch (err) {
      toast.push({ level: 'error', message: errorText(err) });
    } finally {
      setChoosing(null);
    }
  };

  const goEpisode = (n: number, replace = false) => { const file=localId ? adjacentLocal(n) : null; navigate(`/watch/${media.id}/${n}${file ? `?local=${file.id}` : sourceId ? `?source=${sourceId}` : ''}`, { replace }); };
  const selectSource = (id: string) => navigate(`/watch/${media.id}/${episode}?source=${id}`, { replace: true });
  const hasNext = localId ? !!adjacentLocal(episode+1) : episode < total;
  const hasPrev = localId ? !!adjacentLocal(episode-1) : episode > 1;
  const next = () => hasNext && goEpisode(episode + 1);
  const prev = () => hasPrev && goEpisode(episode - 1);

  const record = (position: number, duration: number) => {
    if (!duration || duration < 30) return;
    progressAt.current = { position, duration };
    saveProgress.mutate(
      { media: snapshot, episode, position, duration, sourceId },
      {
        onSuccess: (r) => {
          if (r.completedNow) toast.push({ level: 'success', message: `Episode ${episode} marked as watched.` });
        },
      },
    );
  };

  // Progress + auto-next for site players and YouTube embeds, read from the page's <video>.
  const ended = useRef(false);
  useEffect(() => {
    ended.current = false;
    progressAt.current = null;
  }, [episode, sourceId]);
  useEffect(() => {
    if (!webContentsId) return;
    let last = 0;
    let disposed = false;
    let previousSample: PlaybackSample | null = null;
    setPlaybackProbe(null);
    setPlaybackStatus(null);
    const timer = window.setInterval(async () => {
      if (document.hidden) return;
      const probe = await call('player.probe', { webContentsId }).catch(() => null);
      if (disposed) return;
      setPlaybackProbe(probe);
      const sample = probe?.video ? { at: Date.now(), currentTime: probe.currentTime, paused: probe.paused, ended: probe.ended, ...probe.video } : null;
      setPlaybackStatus(sample ? playbackHealth(previousSample, sample) : null);
      previousSample = sample;
      if (!probe || probe.duration < 60) return;
      const now = Date.now();
      if (probe.ended || now - last > (probe.paused ? 20000 : 9000)) {
        last = now;
        record(probe.ended ? probe.duration : probe.currentTime, probe.duration);
      }
      if (probe.ended && !ended.current) {
        ended.current = true;
        if (settings.player.autoNext && hasNext && (mode === 'episodes' || mode === 'web')) goEpisode(episode + 1);
      }
    }, 3000);
    return () => { disposed = true; window.clearInterval(timer); };
    // record/goEpisode are recreated each render; the interval only needs the latest ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webContentsId, episode, sourceId, settings.player.autoNext, hasNext, mode]);

  // In site mode, follow episodes the user opens on the site itself (not AniVerse's own navigation).
  const onSiteNavigate = (url: string) => {
    setCurrentUrl(url);
    if (siteBusy) return;
    const n = episodeFromUrl(url);
    if (n && n !== episode && n <= total + 1) {
      adoptRef.current = n;
      goEpisode(n, true);
    }
  };

  const skip = () => {
    if (player.current) player.current.seekBy(settings.player.skipStep);
    else if (webContentsId && progressAt.current) void call('player.control', { webContentsId, action: 'seek', value: progressAt.current.position + settings.player.skipStep });
    else if (webContentsId) {
      void call('player.probe', { webContentsId }).then((p) => p && call('player.control', { webContentsId, action: 'seek', value: p.currentTime + settings.player.skipStep }));
    }
  };

  const pinned = sourceId ? state?.pinned[sourceId] : undefined;
  const pin = async () => {
    if (!sourceId) return;
    const url = pinned ? null : currentUrl;
    if (!pinned && !url) return;
    try {
      await call('sources.pin', { sourceId, mediaId: media.id, url });
      void qc.invalidateQueries({ queryKey: keys.libraryState(media.id) });
      void qc.invalidateQueries({ queryKey: ['match', sourceId, media.id] });
      toast.push({ level: 'success', message: url ? `Pinned this page for ${title} on ${source?.name}.` : 'Pin removed — AniVerse will search the site again.' });
    } catch (err) {
      toast.push({ level: 'error', message: errorText(err) });
    }
  };

  const toggleWatched = () =>
    markWatched.mutate({ media: snapshot, episode, watched: !watched.has(episode) }, { onError: (e) => toast.push({ level: 'error', message: e.message }) });

  const officialGroup = enabled.filter((s) => s.kind === 'youtube');
  const siteGroup = enabled.filter((s) => s.kind === 'web');

  let screen;
  if (localId) {
    const resume=state?.progress.find(p=>p.episode===episode && !p.completed);
    screen = local.error ? <ErrorState error={local.error} onRetry={()=>void local.refetch()} /> : !local.data ? <Loading label="Opening local video…" /> :
      <VideoPlayer key={local.data.url} source={{type:'mp4',url:local.data.url,subtitles:[]}} title={local.data.name} prefs={settings.player} controlsRef={player}
        startAt={settings.player.resume ? resume?.position : undefined} theater={theater} onTheater={()=>setTheater(t=>!t)}
        onProgress={record} onEnded={()=>settings.player.autoNext && next()} hasNext={hasNext} hasPrev={hasPrev} onNext={next} onPrev={prev} />;
  } else if (!source) {
    screen = (
      <Empty title="No streaming sources enabled">
        Add website or official channel URLs to <span className="code">config/streaming-sites.txt</span>, or enable sources in Settings → Sources.
      </Empty>
    );
  } else if (match.isLoading) {
    screen = <Loading label={`Looking up ${title} on ${source.name}…`} />;
  } else if (match.error) {
    screen = <ErrorState error={match.error} onRetry={() => void match.refetch()} title={`${source.name} is unavailable`} />;
  } else if (mode === 'web' && siteSrc) {
    screen = (
      <>
        <WebSession source={source} src={siteSrc} toolbar={false} controls={siteControls} onNavigate={onSiteNavigate} onWebContents={setWebContentsId} />
        {((siteBusy && !needsUser) || choosing) && (
          <CatLoader label={choosing ?? siteStatus ?? `Loading episode ${episode}…`} hint={slowKey === navKey && !choosing ? `${source.name} is taking a while.` : undefined}>
            {slowKey === navKey && !choosing && (
              <button className="btn sm" style={{ marginTop: 6 }} onClick={() => navKey && setNavDone(navKey)}>
                Show the site
              </button>
            )}
          </CatLoader>
        )}
      </>
    );
  } else if (mode === 'episodes' && !adapterEpisode) {
    screen = (
      <Empty title={`Episode ${episode} isn’t on ${source.name}`}>
        {adapterEpisodes?.length
          ? `This channel has episode${adapterEpisodes.length > 1 ? 's' : ''} ${summarise(adapterEpisodes.map((e) => e.number))}. Pick one on the right or try another source.`
          : (match.data?.note ?? 'No official uploads of this title were found on this channel.')}
      </Empty>
    );
  } else if (streams.isLoading) {
    screen = <Loading label="Loading stream…" />;
  } else if (streams.error || !stream) {
    screen = <ErrorState error={streams.error ?? new Error('No playable stream.')} onRetry={() => void streams.refetch()} />;
  } else if (stream.type === 'youtube') {
    screen = <WebSession source={source} src={`https://www.youtube.com/embed/${stream.videoId}?autoplay=${settings.player.autoplay ? 1 : 0}&rel=0&playsinline=1`} referrer={APP_REFERRER} toolbar={false} onWebContents={setWebContentsId} />;
  } else if (stream.type === 'web') {
    screen = <WebSession source={source} src={stream.url} onNavigate={onSiteNavigate} onWebContents={setWebContentsId} />;
  } else {
    const resume = settings.player.resume ? state?.progress.find((p) => p.episode === episode && !p.completed) : undefined;
    screen = (
      <VideoPlayer
        source={stream}
        title={`${title} · Episode ${episode}`}
        subtitle={`Episode ${episode}`}
        poster={media.banner ?? media.cover}
        startAt={resume && resume.duration - resume.position > 30 ? resume.position : undefined}
        prefs={settings.player}
        theater={theater}
        controlsRef={player}
        hasNext={hasNext}
        hasPrev={hasPrev}
        onNext={next}
        onPrev={prev}
        onTheater={() => setTheater((t) => !t)}
        onProgress={record}
        onEnded={() => settings.player.autoNext && next()}
        onVolume={(volume) => updateSettings.mutate({ player: { volume } })}
      />
    );
  }

  const isSite = mode === 'web';
  const commentsQuery = useMemo(
    () => ({
      mediaId: media.id,
      idMal: media.idMal,
      episode,
      titles: [media.title.romaji, media.title.english, ...media.synonyms.slice(0, 2)].filter((t): t is string => !!t).slice(0, 6),
      youtubeVideoId: stream?.type === 'youtube' ? stream.videoId : null,
    }),
    [media, episode, stream],
  );

  return (
    <div className={cx('page wide', lightsOff && 'lights-off')}>
      <div className={cx('watch', theater && 'theater')}>
        <div className="stage" style={{ minWidth: 0 }}>
          <div className={cx('screen', isSite && !focused && (!siteBusy || needsUser) && !choosing && 'site')}>{screen}</div>

          <div className="toolbar">
            <button className="btn ghost" disabled={!hasPrev} onClick={prev}>
              <ChevronLeft size={15} /> Prev
            </button>
            <button className="btn ghost" disabled={!hasNext} onClick={next}>
              Next <ChevronRight size={15} />
            </button>
            <span className="sep" />
            <button className={cx('btn ghost', settings.player.autoNext && 'on')} onClick={() => updateSettings.mutate({ player: { autoNext: !settings.player.autoNext } })} title="Play the next episode automatically">
              <Repeat size={14} /> Auto next
            </button>
            <button className="btn ghost" onClick={skip} disabled={!stream && !webContentsId && !local.data} title="Skip the opening">
              <FastForward size={14} /> Skip {settings.player.skipStep}s
            </button>
            <button className={cx('btn ghost', theater && 'on')} onClick={() => setTheater((t) => !t)}>
              <RectangleHorizontal size={14} /> Theater
            </button>
            <button className={cx('btn ghost', lightsOff && 'on')} onClick={() => setLightsOff((v) => !v)}>
              <Lightbulb size={14} /> {lightsOff ? 'Lights on' : 'Lights off'}
            </button>
            <span className="sep" />
            <button className={cx('btn ghost', watched.has(episode) && 'on')} onClick={toggleWatched}>
              <Check size={14} /> {watched.has(episode) ? 'Watched' : 'Mark watched'}
            </button>
            <button className={cx('btn ghost', state?.favourite && 'on')} onClick={() => toggleFav.mutate(snapshot)}>
              <Heart size={14} fill={state?.favourite ? 'currentColor' : 'none'} /> Favourite
            </button>
            <div className="grow" />
            {isSite && (
              <SiteMenu
                focused={focused}
                pinned={!!pinned}
                disabled={!webContentsId}
                onFocus={() => void toggleFocus()}
                onReload={() => siteControls.current?.reload()}
                onRefind={() => void refind()}
                onPin={() => void pin()}
                onExternal={() => {
                  const url = siteControls.current?.currentUrl() ?? currentUrl;
                  if (url) void call('app.openExternal', { url });
                }}
              />
            )}
            {stream?.type === 'youtube' && (
              <button className="btn ghost" onClick={() => void call('app.openExternal', { url: `https://www.youtube.com/watch?v=${stream.videoId}` })} title="Open on YouTube (e.g. if the embed is region-locked)">
                <ExternalLink size={14} /> YouTube
              </button>
            )}
          </div>

          {isSite && webContentsId && <SiteAnime4K key={siteKey + ':anime4k'} webContentsId={webContentsId} />}
          {isSite && webContentsId && <PlaybackRescue key={siteKey + ':' + episode} probe={playbackProbe} health={playbackStatus} webContentsId={webContentsId} busy={siteBusy || !!choosing} />}

          {(local.data || webContentsId || (stream && stream.type !== 'web' && stream.type !== 'youtube')) && <EpisodeToolkit key={media.id+':'+episode+':'+(sourceId ?? localId)} media={snapshot} episode={episode} sourceId={sourceId} webContentsId={localId?null:webContentsId} native={player} probe={localId?null:playbackProbe} initialTime={search.has('t') && Number.isFinite(Number(search.get('t'))) && Number(search.get('t'))>=0 ? Number(search.get('t')) : null} />}

          <div className="card source-bar">
            <div className="now">
              You are watching <b>Episode {episode}</b>
              {isSite ? (
                <p className="faint" style={{ margin: '6px 0 0', fontSize: 'var(--fs-xs)' }}>
                  Playing from {source?.name}. Pick episodes on the right; switch audio or server below if playback stalls.
                </p>
              ) : (
                <p className="faint" style={{ margin: '6px 0 0', fontSize: 'var(--fs-xs)' }}>
                  If playback fails, switch the source below.
                </p>
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              {officialGroup.length > 0 && (
                <div className="source-group">
                  <span className="label">Official</span>
                  {officialGroup.map((s) => (
                    <SourceButton key={s.id} source={s} active={s.id === sourceId} onClick={() => selectSource(s.id)} />
                  ))}
                </div>
              )}
              {siteGroup.length > 0 && (
                <div className="source-group">
                  <span className="label">Websites</span>
                  {siteGroup.map((s) => (
                    <SourceButton key={s.id} source={s} active={s.id === sourceId} onClick={() => selectSource(s.id)} />
                  ))}
                </div>
              )}
              {isSite && siteOptions.types.length > 0 && (
                <div className="source-group">
                  <span className="label">Audio</span>
                  {siteOptions.types.map((o) => (
                    <button key={o.label} className={cx('opt-btn', o.active && 'active')} disabled={!!choosing || siteBusy} onClick={() => void chooseOption('type', o.value, o.label)}>
                      {o.label.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
              {isSite && siteOptions.servers.length > 0 && (
                <div className="source-group">
                  <span className="label">Server</span>
                  {siteOptions.servers.map((o) => (
                    <button key={`${o.group}-${o.label}`} className={cx('opt-btn', o.active && 'active')} disabled={!!choosing || siteBusy} onClick={() => void chooseOption('server', o.value, o.label)}>
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
              {isSite && !pinned && titleVariants.length > 1 && (
                <div className="source-group">
                  <span className="label">Search as</span>
                  {titleVariants.map((t) => (
                    <button key={t} className={cx('chip', t === searchTitle && 'on')} onClick={() => setSearchTitle(t)} title={t}>
                      <span className="ellipsis" style={{ maxWidth: 220 }}>
                        {t}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {match.data?.note && (
                <p className="faint" style={{ margin: '8px 0 0', fontSize: 'var(--fs-xs)' }}>
                  {match.data.note}
                </p>
              )}
            </div>
          </div>

          {media.nextAiring && (
            <div className="card countdown">
              <CalendarClock size={18} color="var(--accent)" />
              <div className="grow">
                Episode {media.nextAiring.episode} airs{' '}
                {new Date(media.nextAiring.airingAt * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
              </div>
              <span className="big">{countdown(media.nextAiring.airingAt)}</span>
            </div>
          )}

          <div className="card card-pad row" style={{ alignItems: 'flex-start', gap: 16 }}>
            <img src={media.cover} alt="" style={{ width: 84, borderRadius: 10, aspectRatio: '2/3', objectFit: 'cover' }} />
            <div className="grow">
              <h2 style={{ margin: '0 0 6px', fontSize: 'var(--fs-xl)' }}>{title}</h2>
              <div className="row wrap" style={{ marginBottom: 8 }}>
                <span className="chip accent">{formatLabel(media.format)}</span>
                <span className="chip">{statusLabel(media.status)}</span>
                {media.score && <span className="chip">★ {(media.score / 10).toFixed(1)}</span>}
                {media.genres.slice(0, 4).map((g) => (
                  <span key={g} className="chip">
                    {g}
                  </span>
                ))}
              </div>
              <SpoilerGuard key={media.id} label="Synopsis"><p className="muted clamp-3 selectable" style={{ margin: 0 }}>{media.description}</p></SpoilerGuard>
            </div>
            <button className="btn sm" onClick={() => navigate(`/anime/${media.id}`)}>
              <Info size={14} /> Details
            </button>
          </div>

          <SpoilerGuard key={media.id+':'+episode} label="Comments"><CommentsPanel query={commentsQuery} /></SpoilerGuard>
        </div>

        <EpisodePanel
          total={total}
          current={episode}
          watched={watched}
          available={available}
          titles={titles}
          thumbs={thumbs}
          onSelect={(n) => goEpisode(n)}
          sourceLabel={localId ? 'Local collection' : source?.name}
          spoilerShield={settings.appearance.spoilerShield}
        />
      </div>
    </div>
  );
}

function SourceButton({ source, active, onClick }: { source: SourceInfo; active: boolean; onClick: () => void }) {
  return (
    <button className={cx('source-btn', active && 'active')} onClick={onClick} title={source.url}>
      <SourceIcon source={source} /> {source.name}
    </button>
  );
}

function episodeMeta(media: MediaDetails, adapterEpisodes: { number: number; title: string; thumbnail: string | null }[] | null) {
  const titles = new Map<number, string>();
  const thumbs = new Map<number, string>();
  for (const se of media.streamingEpisodes) {
    const n = Number(se.title.match(/(?:episode|ep)\s*(\d+)/i)?.[1]);
    if (!n) continue;
    titles.set(n, se.title.replace(/^episode\s*\d+\s*[-:–]\s*/i, ''));
    if (se.thumbnail) thumbs.set(n, se.thumbnail);
  }
  for (const e of adapterEpisodes ?? []) {
    if (!titles.has(e.number)) titles.set(e.number, e.title);
    if (e.thumbnail && !thumbs.has(e.number)) thumbs.set(e.number, e.thumbnail);
  }
  return { titles, thumbs };
}

function summarise(numbers: number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const n of sorted.slice(1).concat(Infinity)) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    ranges.push(start === prev ? String(start) : `${start}–${prev}`);
    start = prev = n;
  }
  return ranges.join(', ');
}

function SiteMenu({
  focused,
  pinned,
  disabled,
  onFocus,
  onReload,
  onRefind,
  onPin,
  onExternal,
}: {
  focused: boolean;
  pinned: boolean;
  disabled: boolean;
  onFocus: () => void;
  onReload: () => void;
  onRefind: () => void;
  onPin: () => void;
  onExternal: () => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);
  const item = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className="site-menu" onClick={(e) => e.stopPropagation()}>
      <button className={cx('btn ghost', open && 'on')} disabled={disabled} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <Globe size={14} /> Site <ChevronUp size={13} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button onClick={item(onFocus)}>
            <Crop size={15} /> {focused ? 'Show the whole site' : 'Show only the player'}
          </button>
          <button onClick={item(onReload)}>
            <RotateCw size={15} /> Reload
          </button>
          <button onClick={item(onRefind)}>
            <RotateCcw size={15} /> Wrong show? Search again
          </button>
          <button onClick={item(onPin)}>
            {pinned ? <PinOff size={15} /> : <Pin size={15} />} {pinned ? 'Unpin this page' : 'Pin this page for the series'}
          </button>
          <button onClick={item(onExternal)}>
            <ExternalLink size={15} /> Open in browser
          </button>
        </div>
      )}
    </div>
  );
}
