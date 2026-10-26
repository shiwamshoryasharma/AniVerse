import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Bookmark, CalendarDays, FolderOpen, Play, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { LocalMedia, SceneBookmark } from '../../../app/shared/workspace';
import { call, errorText } from '../lib/bridge';
import { clock, cx, snapshotOf, titleOf } from '../lib/format';
import { useMarkWatched, useSearch, useSettings, useSources, useUpdateSettings } from '../lib/queries';
import { useToast } from '../lib/useToast';
import { ErrorState, Loading, Switch } from '../components/common';

const TABS = [
  { id: 'bookmarks', label: 'Scene bookmarks', icon: Bookmark },
  { id: 'planner', label: 'Weekly planner', icon: CalendarDays },
  { id: 'collection', label: 'Local collection', icon: FolderOpen },
  { id: 'insights', label: 'Watch insights', icon: BarChart3 },
];
export function WorkspacePage() {
  const section = useParams().section ?? 'bookmarks';
  const navigate = useNavigate();
  return (
    <div className="page wide workspace">
      <h1 className="page-title">Your Workspace</h1>
      <p className="page-sub">Scene notes, a manageable watch week, and your own video library.</p>
      <nav className="workspace-tabs" aria-label="Workspace sections">
        {TABS.map((t) => (
          <button key={t.id} className={cx('btn', section === t.id && 'active')} onClick={() => navigate('/workspace/' + t.id)}>
            <t.icon size={17} />
            {t.label}
          </button>
        ))}
      </nav>
      {section === 'bookmarks' ? (
        <Bookmarks />
      ) : section === 'planner' ? (
        <Planner />
      ) : section === 'collection' ? (
        <Collection />
      ) : section === 'insights' ? (
        <Insights />
      ) : (
        <p>Choose a Workspace menu.</p>
      )}
    </div>
  );
}
function Bookmarks() {
  const [search, setSearch] = useState('');
  const result = useQuery({ queryKey: ['bookmarks', 'all', search], queryFn: () => call('toolkit.bookmarks', { search }) });
  const files = useQuery({ queryKey: ['collection'], queryFn: () => call('collection.list') });
  return (
    <>
      <div className="workspace-banner violet">
        <Bookmark />
        <div>
          <h2>Keep the moment</h2>
          <p>Press B on the Watch page, or save a scene in Episode Toolkit. Search notes, title names and tags here.</p>
        </div>
      </div>
      <label className="workspace-search">
        <Search size={17} />
        <input
          className="input"
          aria-label="Search scene bookmarks"
          placeholder="Search your scenes…"
          maxLength={200}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      {result.error ? (
        <ErrorState error={result.error} onRetry={() => void result.refetch()} />
      ) : !result.data ? (
        <Loading />
      ) : !result.data.length ? (
        <div className="card card-pad faint">No saved scenes match. Your notes stay local and are separate from list sync.</div>
      ) : (
        <div className="workspace-grid">
          {result.data.map((b) => (
            <Scene key={b.id} bookmark={b} localId={files.data?.find((f) => !f.missing && f.media?.id === b.media.id && f.episode === b.episode)?.id} />
          ))}
        </div>
      )}
    </>
  );
}
function Scene({ bookmark: b, localId }: { bookmark: SceneBookmark; localId?: number }) {
  const [note, setNote] = useState(b.note);
  const [tags, setTags] = useState(b.tags.join(', '));
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const save = async (remove = false) => {
    setBusy(true);
    try {
      if (remove) await call('toolkit.deleteBookmark', { id: b.id });
      else
        await call('toolkit.saveBookmark', {
          id: b.id,
          media: b.media,
          episode: b.episode,
          position: b.position,
          duration: b.duration,
          sourceId: b.sourceId,
          note,
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 8),
        });
      await qc.invalidateQueries({ queryKey: ['bookmarks'] });
    } catch (e) {
      toast.push({ level: 'error', message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const target =
    '/watch/' +
    b.media.id +
    '/' +
    b.episode +
    '?t=' +
    Math.floor(b.position) +
    (b.sourceId ? '&source=' + encodeURIComponent(b.sourceId) : localId ? '&local=' + localId : '');
  return (
    <article className="card card-pad scene-card">
      <div className="row">
        <Bookmark size={18} />
        <strong className="grow">{b.media.title}</strong>
        <span className="chip">EP {b.episode}</span>
      </div>
      <Link className="btn ghost" to={target}>
        <Play size={14} />
        {clock(b.position)} / {clock(b.duration)}
      </Link>
      <textarea className="input" aria-label="Edit scene note" maxLength={1000} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      <input className="input" aria-label="Edit scene tags" value={tags} maxLength={240} onChange={(e) => setTags(e.target.value)} />
      <div className="row">
        <button className="btn sm" disabled={busy} onClick={() => void save()}>
          Save note
        </button>
        <span className="grow" />
        <button className="btn ghost sm" disabled={busy} onClick={() => void save(true)}>
          <Trash2 size={14} />
          Delete
        </button>
      </div>
      <small className="faint">Scene positions can differ across editions.</small>
    </article>
  );
}
function Planner() {
  const [budget, setBudget] = useState(48);
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const watched = useMarkWatched();
  const plan = useQuery({ queryKey: ['planner'], queryFn: () => call('planner.get') });
  const build = async () => {
    setBusy(true);
    try {
      qc.setQueryData(['planner'], await call('planner.build', { budget, startDate }));
    } catch (e) {
      toast.push({ level: 'error', message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="workspace-banner aqua">
        <CalendarDays />
        <div>
          <h2>A week that fits</h2>
          <p>
            Build from up to 20 titles in Watching, Planning and Rewatching. AniList airing data limits future episodes; timing is estimated when metadata is
            missing.
          </p>
        </div>
      </div>
      <div className="card card-pad workspace-form">
        <label>
          Daily budget (minutes)
          <input
            className="input"
            aria-label="Daily watch budget"
            type="number"
            min="5"
            max="360"
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
          />
        </label>
        <label>
          First day
          <input className="input" aria-label="Planner first day" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <button className="btn primary" disabled={busy || budget < 5 || budget > 360 || !startDate} onClick={() => void build()}>
          {busy ? 'Building…' : 'Build week'}
        </button>
      </div>
      {plan.error ? (
        <ErrorState error={plan.error} onRetry={() => void plan.refetch()} />
      ) : plan.data ? (
        <>
          <p className="faint">{plan.data.unscheduled} remaining episodes outside this week · Rebuild after changing your list or progress.</p>
          <div className="planner-week">
            {plan.data.days.map((day) => (
              <section className="card card-pad" key={day.date}>
                <h3>{new Date(day.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</h3>
                <p className="faint">
                  {day.minutes} / {plan.data!.budget} min
                </p>
                {day.items.map((item) => (
                  <div className="plan-item" key={item.media.id + ':' + item.episode}>
                    <Link to={'/watch/' + item.media.id + '/' + item.episode}>
                      <strong>{item.media.title}</strong>
                      <span>
                        Episode {item.episode} · {item.estimated ? '~' : ''}
                        {item.minutes} min
                      </span>
                    </Link>
                    <button
                      className="btn xs"
                      disabled={watched.isPending}
                      onClick={() =>
                        watched.mutate(
                          { media: item.media, episode: item.episode, watched: true },
                          {
                            onSuccess: () => toast.push({ level: 'success', message: 'Marked watched. Rebuild to update the week.' }),
                            onError: (e) => toast.push({ level: 'error', message: e.message }),
                          },
                        )
                      }
                    >
                      Mark watched
                    </button>
                  </div>
                ))}
                {!day.items.length && <p className="faint">Room to rest.</p>}
              </section>
            ))}
          </div>
        </>
      ) : (
        <p className="faint">Add titles to your library, choose a budget and build your week.</p>
      )}
    </>
  );
}
function Collection() {
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [matchId, setMatchId] = useState<number | null>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const files = useQuery({ queryKey: ['collection'], queryFn: () => call('collection.list') });
  const scan = async (choose: boolean) => {
    setBusy(true);
    try {
      const result = await call('collection.scan', { choose });
      qc.setQueryData(['collection'], result.files);
      toast.push({ level: 'success', message: result.files.length + ' videos indexed' + (result.skipped ? ' · ' + result.skipped + ' entries skipped' : '') });
    } catch (e) {
      toast.push({ level: 'error', message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="workspace-banner amber">
        <FolderOpen />
        <div>
          <h2>Your collection, on your terms</h2>
          <p>
            Choose a folder to index video filenames. Matching is manual: confirm the title and episode before progress is tracked. Files stay in their original
            location.
          </p>
        </div>
      </div>
      <div className="row wrap">
        <button className="btn primary" disabled={busy} onClick={() => void scan(true)}>
          <FolderOpen size={15} />
          {busy ? 'Scanning…' : 'Choose folder'}
        </button>
        <button className="btn" disabled={busy} onClick={() => void scan(false)}>
          <RefreshCw size={15} />
          Refresh
        </button>
        <input
          className="input grow"
          aria-label="Filter local videos"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter filenames or matched titles…"
        />
      </div>
      <p className="faint">
        Scan limit: 2,000 entries, six folder levels. Symbolic links are skipped. Playback depends on Chromium codec support; some MKV files will not play.
      </p>
      {files.error ? (
        <ErrorState error={files.error} onRetry={() => void files.refetch()} />
      ) : !files.data ? (
        <Loading />
      ) : (
        <div className="collection-list">
          {files.data
            .filter((f) => (f.name + ' ' + (f.media?.title ?? '')).toLowerCase().includes(filter.toLowerCase()))
            .map((f) => (
              <article className="card card-pad" key={f.id}>
                <div className="row wrap">
                  <FolderOpen className="collection-icon" size={19} />
                  <div className="grow collection-name">
                    <strong>{f.name}</strong>
                    <p>
                      {f.media?.title ?? 'Unmatched'}
                      {f.episode ? ' · Episode ' + f.episode : ''} · {(f.bytes / 1048576).toFixed(1)} MB{f.missing ? ' · Missing' : ''}
                    </p>
                  </div>
                  <Link
                    className={cx('btn sm', f.missing && 'disabled')}
                    aria-disabled={f.missing}
                    onClick={(e) => f.missing && e.preventDefault()}
                    to={f.media && f.episode ? '/watch/' + f.media.id + '/' + f.episode + '?local=' + f.id : '/player?local=' + f.id}
                  >
                    <Play size={14} />
                    Play
                  </Link>
                  <button className="btn sm" onClick={() => setMatchId(matchId === f.id ? null : f.id)}>
                    Match title
                  </button>
                  <button
                    className="icon-btn"
                    aria-label="Remove collection entry"
                    onClick={() =>
                      void call('collection.remove', { id: f.id })
                        .then(() => qc.invalidateQueries({ queryKey: ['collection'] }))
                        .catch((e) => toast.push({ level: 'error', message: errorText(e) }))
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {matchId === f.id && <CollectionMatch file={f} onDone={() => setMatchId(null)} />}
              </article>
            ))}
          {!files.data.length && <div className="card card-pad faint">No folders indexed. Choose a folder containing your videos to begin.</div>}
        </div>
      )}
    </>
  );
}
function CollectionMatch({ file, onDone }: { file: LocalMedia; onDone: () => void }) {
  const [query, setQuery] = useState(file.query);
  const [episode, setEpisode] = useState(file.episode ?? 1);
  const [busy, setBusy] = useState(false);
  const search = useSearch(query);
  const settings = useSettings();
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <div className="collection-match">
      <div className="row">
        <input className="input grow" aria-label="Match title search" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label>
          Episode
          <input
            className="input"
            aria-label="Matched episode"
            type="number"
            min="1"
            max="99999"
            value={episode}
            onChange={(e) => setEpisode(Number(e.target.value))}
          />
        </label>
      </div>
      {search.error ? (
        <p role="alert">{errorText(search.error)}</p>
      ) : search.isFetching ? (
        <p className="faint">Searching AniList…</p>
      ) : (
        search.data?.slice(0, 6).map((m) => (
          <button
            className="btn ghost"
            disabled={busy || episode < 1 || !Number.isInteger(episode)}
            key={m.id}
            onClick={async () => {
              setBusy(true);
              try {
                await call('collection.match', { id: file.id, media: snapshotOf(m, settings.appearance.titleLanguage), episode });
                await qc.invalidateQueries({ queryKey: ['collection'] });
                onDone();
              } catch (e) {
                toast.push({ level: 'error', message: errorText(e) });
              } finally {
                setBusy(false);
              }
            }}
          >
            {titleOf(m, settings.appearance.titleLanguage)} · {m.seasonYear ?? m.startDate?.year ?? 'Unknown year'}
          </button>
        ))
      )}
    </div>
  );
}
function Insights() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: sources } = useSources();
  const result = useQuery({ queryKey: ['insights'], queryFn: () => call('toolkit.insights'), refetchInterval: 15000 });
  const data = result.data;
  const max = Math.max(1, ...(data?.daily.map((d) => d.seconds) ?? []));
  return (
    <>
      <div className="workspace-banner rose">
        <BarChart3 />
        <div>
          <h2>See how you watch</h2>
          <p>
            Local estimates from the Watch page: playing time, observed frames and source health. Seeks, pauses, hidden app windows and unobservable website
            players are excluded. Nothing here is sent as developer analytics.
          </p>
        </div>
      </div>
      <div className="row wrap">
        <div className="row">
          <Switch
            label="Record local watch insights"
            on={settings.privacy.watchInsights}
            disabled={update.isPending}
            onChange={(watchInsights) => update.mutate({ privacy: { watchInsights } }, { onError: (e) => toast.push({ level: 'error', message: e.message }) })}
          />
          <span>Record local watch insights</span>
        </div>
        <span className="grow" />
        <button
          className="btn sm"
          onClick={() => {
            if (window.confirm('Delete local watch insight samples? Your progress and bookmarks are kept.'))
              void call('toolkit.clearInsights')
                .then(() => qc.invalidateQueries({ queryKey: ['insights'] }))
                .catch((e) => toast.push({ level: 'error', message: errorText(e) }));
          }}
        >
          <Trash2 size={14} />
          Clear insights
        </button>
      </div>
      {result.error ? (
        <ErrorState error={result.error} onRetry={() => void result.refetch()} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <div className="insight-stats">
            <div className="card card-pad">
              <strong>{(data.watchedSeconds / 3600).toFixed(1)} h</strong>
              <span>Observed playing time</span>
            </div>
            <div className="card card-pad">
              <strong>{data.episodes}</strong>
              <span>Episodes with at least 1 minute</span>
            </div>
            <div className="card card-pad">
              <strong>{data.sources.length}</strong>
              <span>Observed sources</span>
            </div>
          </div>
          <section className="card card-pad">
            <h3>Recent days</h3>
            <div className="insight-chart">
              {data.daily.map((d) => (
                <div key={d.date} title={d.date + ' · ' + Math.round(d.seconds / 60) + ' min'}>
                  <span style={{ height: Math.max(2, (120 * d.seconds) / max) }} />
                  <small>{d.date.slice(5)}</small>
                </div>
              ))}
            </div>
            {!data.daily.length && <p className="faint">Play an episode to start collecting local insights.</p>}
          </section>
          <div className="workspace-grid">
            <section className="card card-pad">
              <h3>Source health</h3>
              <p className="faint">Dropped-frame ratio is an observation, not a measurement of audio sync or server quality.</p>
              {data.sources.map((s, i) => (
                <div className="insight-row" key={s.sourceId ?? i}>
                  <strong>{sources?.find((x) => x.id === s.sourceId)?.name ?? (s.sourceId ? 'Unavailable source' : 'Local / direct media')}</strong>
                  <span>
                    {Math.round(s.seconds / 60)} min · {s.samples} samples ·{' '}
                    {s.dropPercent === null ? 'No frame counters' : s.dropPercent.toFixed(2) + '% frames dropped'}
                  </span>
                </div>
              ))}
            </section>
            <section className="card card-pad">
              <h3>Time by title</h3>
              {data.titles.map((t) => (
                <div className="insight-row" key={t.title}>
                  <strong>{t.title}</strong>
                  <span>{Math.round(t.seconds / 60)} min</span>
                </div>
              ))}
            </section>
          </div>
        </>
      )}
    </>
  );
}
