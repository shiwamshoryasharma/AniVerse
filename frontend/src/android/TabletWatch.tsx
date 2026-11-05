import { ArrowLeft, ChevronLeft, ChevronRight, EyeOff, FileVideo, Globe, ListVideo, Maximize, Play, RefreshCw, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Empty, ErrorState, Loading } from '../components/common';
import { Select } from '../components/controls';
import { useDetails, useSources, useSettings } from '../lib/queries';
import { usePrivacy } from '../lib/privacy';
import { formatLabel, searchTitles, titleOf } from '../lib/format';
import { seriesMarkers } from '../../../app/core/sources/text';
import { nativeCall } from './native';
import { episodeChoices, nextEnabledSource } from './playback';

type PlayerState = 'loading' | 'ready' | 'website' | 'needs-site' | 'certificate' | 'error';
interface PlayerStatus { session: string; state: PlayerState; message: string; episodes?:{episode:number;audio:string[]}[]; episodesKnown?:boolean; confirmedEpisode?:number|null }

export function TabletWatch() {
  const params = useParams();
  const [query] = useSearchParams();
  const navigate = useNavigate();
  const id = Number(params.id);
  const episode = Math.max(1, Math.trunc(Number(params.episode) || 1));
  const details = useDetails(id);
  const sources = useSources();
  const privacy = usePrivacy();
  const settings = useSettings();
  const available = useMemo(()=>sources.data?.filter(source=>source.enabled)??[],[sources.data]);
  const selected = available.find(source => source.id === query.get('source')) ?? available[0];
  const sourceId = selected?.id;
  const media = details.data;
  const language = settings.appearance.titleLanguage;
  const snapshot = useMemo(() => {
    if (!media) return null;
    const titles = searchTitles(media);
    return {
      id: media.id, idMal: media.idMal, title: titleOf(media, language), cover: media.cover,
      banner: media.banner, format: media.format, episodes: media.episodes, titles,
      season: seriesMarkers(titles.join(' ')).season ?? 1,
    };
  }, [media, language]);
  const isPrivate = !!privacy.data?.incognito || !!privacy.data?.privateMediaIds.includes(id);
  const privacyReady = !!privacy.data;
  const [retry, setRetry] = useState(0);
  const [status, setStatus] = useState<PlayerStatus>({ session: '', state: 'loading', message: 'Opening episode…' });
  const stage = useRef<HTMLDivElement>(null);
  const session = useRef('');
  const attempted = useRef(new Set<string>());
  const [jump,setJump]=useState('');
  useEffect(()=>{attempted.current.clear();},[id,episode]);

  useEffect(() => {
    const slot = stage.current;
    if (!slot || !snapshot || !sourceId || !privacyReady) return;
    const id = crypto.randomUUID();
    session.current = id;
    attempted.current.add(sourceId);
    setStatus({ session: id, state: 'loading', message: 'Finding the episode…' });
    const main = slot.closest('main');
    let active = true;
    let attached = false;
    let frame = 0;
    let last = '';
    let expired=false;
    const deadline=setTimeout(()=>{expired=true;if(active)setStatus(current=>current.session===id&&current.state==='loading'?{...current,state:'error',message:'This source took too long. Trying another enabled source when available.'}:current);},45000);

    const place = () => {
      frame = 0;
      if (!active || !attached) return;
      const r = slot.getBoundingClientRect();
      const clip = main?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
      const dialog = document.querySelector('[aria-modal="true"], .select-pop, [role="menu"], .tablet-search-results, .tablet-search-dismiss');
      const visible = !document.hidden && !dialog && r.width > 0 && r.height > 0;
      const bounds = visible ? {
        visible, viewportWidth: innerWidth,
        left: r.left, top: r.top, right: r.right, bottom: r.bottom,
        clipLeft: clip.left, clipTop: clip.top, clipRight: clip.right, clipBottom: clip.bottom,
      } : { visible: false };
      const key = JSON.stringify(bounds);
      if (last === key) return;
      last = key;
      void nativeCall('playback.place', { session: id, ...bounds }).catch(() => { last = ''; });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
    const onStatus = (event: Event) => {
      const next = (event as CustomEvent<PlayerStatus>).detail;
      if (active && next?.session === id && !(expired&&next.state==='loading')) setStatus(next);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(slot);
    if (main) resize.observe(main);
    const layers = new MutationObserver(schedule);
    layers.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('tablet-playback', onStatus);
    document.addEventListener('visibilitychange', schedule);
    void nativeCall<boolean>('playback.open', { session: id, id: sourceId, episode, media: snapshot })
      .then(open => {
        if (!active) return;
        if (!open) throw new Error('Playback was interrupted. Try again.');
        attached = true;
        schedule();
      })
      .catch((error: Error) => {
        if (active) setStatus({ session: id, state: 'error', message: error.message });
      });
    return () => {
      active = false;
      session.current = '';
      cancelAnimationFrame(frame);
      clearTimeout(deadline);
      resize.disconnect();
      layers.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('tablet-playback', onStatus);
      document.removeEventListener('visibilitychange', schedule);
      void nativeCall('playback.close', { session: id }).catch(() => undefined);
    };
  }, [episode, sourceId, snapshot, privacyReady, isPrivate, retry]);

  useEffect(()=>{
    if(!['error','needs-site'].includes(status.state)||status.session!==session.current)return;
    const next=nextEnabledSource(available.map(source=>source.id),attempted.current);
    if(!next)return;
    const timer=setTimeout(()=>navigate('/watch/'+id+'/'+episode+'?source='+encodeURIComponent(next),{replace:true}),1800);
    return()=>clearTimeout(timer);
  },[status,available,id,episode,navigate]);

  const action = (name: string) => {
    const id = session.current;
    if (!id) return;
    void nativeCall('playback.action', { session: id, action: name }).catch((error: Error) => {
      if (session.current === id) setStatus({ session: id, state: 'error', message: error.message });
    });
  };
  const go = (next: number, source = sourceId, replace = false) => {
    navigate('/watch/' + id + '/' + next + (source ? '?source=' + encodeURIComponent(source) : ''), { replace });
  };
  if (details.isLoading) return <div className="page"><Loading/></div>;
  if (details.error) return <div className="page"><ErrorState error={details.error} onRetry={() => void details.refetch()}/></div>;
  if (!snapshot || !media) return null;
  const confirmed=status.episodesKnown?status.episodes?.map(item=>item.episode)??[]:null;
  const choices=episodeChoices(episode,confirmed,snapshot.episodes);
  const previous=confirmed!==null?[...choices].reverse().find(value=>value<episode):episode>1?episode-1:undefined;
  const next=confirmed!==null?choices.find(value=>value>episode):snapshot.episodes===null||episode<snapshot.episodes?episode+1:undefined;
  const visible = status.state === 'ready' || status.state === 'website';
  const certificateBlocked = status.state === 'certificate';
  const blocked = certificateBlocked || status.state === 'error';
  const websiteMode = status.state === 'website';
  const episodeTitles = new Map<number, string>();
  for (const entry of media.streamingEpisodes) {
    const title = entry.title.match(/^(?:episode|ep)\s*(\d+)\s*[-:–]\s*(.+)$/i);
    if (title) episodeTitles.set(Number(title[1]), title[2]);
  }

  return <div className="page tablet-watch">
    <header className="tablet-watch-heading">
      {snapshot.banner && <img className="tablet-watch-banner" src={snapshot.banner} alt=""/>}
      {snapshot.cover && <img className="tablet-watch-cover" src={snapshot.cover} alt=""/>}
      <div className="tablet-watch-title">
        <Link className="tablet-watch-back" to={'/anime/' + id}><ArrowLeft size={17}/> Anime details</Link>
        <span className="tablet-watch-eyebrow">NOW WATCHING</span>
        <h1>{snapshot.title}</h1>
        <div className="tablet-watch-meta">
          <strong>Episode {episode}</strong>
          {snapshot.format && <span>{formatLabel(snapshot.format)}</span>}
          {media.seasonYear && <span>{media.seasonYear}</span>}
          {media.duration && <span>{media.duration} min</span>}
          {isPrivate && <span><EyeOff size={14}/> Private</span>}
        </div>
      </div>
      {!!available.length && <div className="tablet-watch-source">
        <span className="tablet-watch-eyebrow"><Globe size={14}/> PLAYBACK SOURCE</span>
        <Select ariaLabel="Playback source" value={sourceId ?? null}
          onChange={value => {attempted.current.clear();go(episode, value, true);}}
          options={available.map(source => ({ value: source.id, label: source.name }))}/>
      </div>}
    </header>

    <div className="tablet-watch-layout">
      <section className="tablet-watch-main" aria-label="Watch episode">
        {sourceId ? <div className="tablet-watch-theater">
          <div className="tablet-player-slot" ref={stage} aria-label="Episode player" data-player-state={status.state} data-confirmed-episode={status.confirmedEpisode??undefined}>
            {!visible && <div className="tablet-player-placeholder">
              {blocked ? <ShieldAlert size={30}/> : status.state === 'loading' ? <Loading label=""/> : <Play size={28}/>}
              {blocked && <h2>{certificateBlocked ? 'Secure connection blocked' : 'Playback unavailable'}</h2>}
              <p role="status">{status.message}</p>
              {certificateBlocked && available.length > 1 && <p>Retry or select a different source above.</p>}
            </div>}
          </div>
          <div className="tablet-player-actions">
            <div className="tablet-player-navigation">
              <button className="btn" disabled={previous===undefined} onClick={() => previous!==undefined&&go(previous)}><ChevronLeft size={18}/> Previous</button>
              <button className="btn" disabled={next===undefined} onClick={() => next!==undefined&&go(next)}>Next <ChevronRight size={18}/></button>
            </div>
            <div className="tablet-player-tools">
              <button className="btn ghost" onClick={() => {attempted.current.clear();setRetry(value => value + 1);}}><RefreshCw size={17}/> Retry</button>
              {websiteMode ? <>
                <button className="btn ghost" onClick={() => action('back')} aria-label="Website back"><ChevronLeft size={18}/></button>
                <button className="btn ghost" onClick={() => action('forward')} aria-label="Website forward"><ChevronRight size={18}/></button>
                <button className="btn primary" onClick={() => action('player')}><Maximize size={17}/> Player only</button>
              </> : <button className="btn ghost" disabled={certificateBlocked} onClick={() => action('website')}><Globe size={17}/> Show website</button>}
            </div>
          </div>
        </div> : <Empty title="Add your first source"><Link className="btn primary" to="/sources"><Globe size={17}/> Add source URL</Link></Empty>}
        <Link className="btn ghost tablet-watch-offline" to="/local"><FileVideo size={18}/> Watch saved episodes offline</Link>
      </section>

      <aside className="tablet-watch-episodes" aria-labelledby="tablet-episodes-heading">
        <div className="tablet-episodes-heading">
          <h2 id="tablet-episodes-heading"><ListVideo size={22}/> Episodes</h2>
          <span>{confirmed!==null?'From source':snapshot.episodes??'Unknown'}</span>
        </div>
        <p className="faint">{confirmed!==null?'Episodes found on this source.':'Series metadata; source availability is checked when opening an episode.'}</p>
        <form className="row gap" onSubmit={event=>{event.preventDefault();const value=Number(jump);if(Number.isSafeInteger(value)&&value>0&&value<=100000){go(value);setJump('');}}}>
          <input type="number" min="1" max="100000" inputMode="numeric" aria-label="Episode number" placeholder="Episode number" value={jump} onChange={event=>setJump(event.target.value)}/>
          <button className="btn" type="submit" disabled={!jump}>Go</button>
        </form>
        <div className="tablet-episode-list">
          {choices.map(value => {
            const current = value === episode;
            const title = episodeTitles.get(value);
            return <button key={value} className="tablet-episode" aria-label={'Episode ' + value}
              aria-current={current ? 'true' : undefined} onClick={() => go(value)}>
              <span className="tablet-episode-icon">{current ? <Play size={16} fill="currentColor"/> : String(value).padStart(2, '0')}</span>
              <span className="tablet-episode-copy">
                <strong>Episode {value}</strong>
                {(title || current) && <span>{title ?? 'Selected'}</span>}
              </span>
              <ChevronRight size={17} className="tablet-episode-arrow"/>
            </button>;
          })}
        </div>
      </aside>
    </div>
  </div>;
}
