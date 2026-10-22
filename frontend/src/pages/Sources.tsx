import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Cookie, FileText, LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { Empty, Loading, SourceIcon } from '../components/common';
import { WebSession } from '../components/WebSession';
import { call, errorText } from '../lib/bridge';
import { cx } from '../lib/format';
import { keys, useAdblockStats, useSessionInfo, useSources } from '../lib/queries';
import { useToast } from '../lib/useToast';

export function SourcesPage() {
  const { data: sources, isLoading } = useSources();
  const stats = useAdblockStats().data;
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();

  const reload = async () => {
    try {
      const list = await call('sources.reload');
      qc.setQueryData(keys.sources, list);
      toast.push({ level: 'success', message: `Loaded ${list.length} sources from streaming-sites.txt.` });
    } catch (err) {
      toast.push({ level: 'error', message: errorText(err) });
    }
  };

  if (isLoading) return <Loading />;
  return (
    <div className="page">
      <div className="row between">
        <div>
          <h1 className="page-title">Sources</h1>
          <p className="page-sub">Each website opens in its own isolated session — separate cookies, logins and storage — with ads, trackers and redirects blocked.</p>
        </div>
        <div className="row">
          <button className="btn sm" onClick={() => void call('sources.openConfig').catch((e) => toast.push({ level: 'error', message: errorText(e) }))}>
            <FileText size={14} /> Edit streaming-sites.txt
          </button>
          <button className="btn sm" onClick={() => void reload()}>
            <RefreshCw size={14} /> Reload
          </button>
        </div>
      </div>
      {!sources?.length ? (
        <Empty title="No sources configured">Add one URL per line to config/streaming-sites.txt — the list reloads automatically.</Empty>
      ) : (
        <div className="source-tiles">
          {sources.map((s) => (
            <div key={s.id} className={cx('card source-tile', !s.enabled && 'disabled')} role="link" tabIndex={0} onClick={() => navigate(`/sources/${s.id}`)}>
              <div className="row">
                <span className="fav">
                  <SourceIcon source={s} size={20} />
                </span>
                <div className="grow">
                  <div style={{ fontWeight: 700 }} className="ellipsis">
                    {s.name}
                  </div>
                  <div className="faint ellipsis" style={{ fontSize: 'var(--fs-xs)' }}>
                    {s.url}
                  </div>
                </div>
              </div>
              <div className="row wrap" style={{ gap: 5 }}>
                <span className={cx('chip', s.kind === 'youtube' ? 'err' : 'accent')}>{s.kind === 'youtube' ? 'Official channel' : 'Website'}</span>
                {!s.enabled && <span className="chip">Disabled</span>}
                {s.kind === 'web' && <span className={cx('chip', s.searchTemplate ? 'ok' : undefined)}>{s.searchTemplate ? 'Search ready' : s.searchCheckedAt ? 'No site search' : 'Search not checked'}</span>}
                {s.adblock && (
                  <span className="chip ok">
                    <ShieldCheck size={11} /> {(stats?.blocked[s.id] ?? 0) + (stats?.popupsBlocked[s.id] ?? 0)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SourceBrowserPage() {
  const { id } = useParams();
  const { data: sources } = useSources();
  const navigate = useNavigate();
  const source = sources?.find((s) => s.id === id);
  const session = useSessionInfo(id ?? '');
  const toast = useToast();
  const qc = useQueryClient();

  if (!sources) return <Loading />;
  if (!source) return <Empty title="Unknown source">It may have been removed from streaming-sites.txt.</Empty>;
  if (!source.enabled) return <Empty title={`${source.name} is disabled`}>Enable it in Settings → Sources.</Empty>;

  const signOut = async () => {
    try {
      await call('sources.clearSession', { id: source.id });
      void qc.invalidateQueries({ queryKey: keys.session(source.id) });
      toast.push({ level: 'success', message: `Signed out of ${source.name} and cleared its data.` });
    } catch (err) {
      toast.push({ level: 'error', message: errorText(err) });
    }
  };

  return (
    <div className="page wide" style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 12 }}>
      <div className="row">
        <button className="btn sm ghost" onClick={() => navigate('/sources')}>
          <ArrowLeft size={14} /> Sources
        </button>
        <SourceIcon source={source} size={16} />
        <strong>{source.name}</strong>
        <span className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
          isolated session · {source.partition.replace('persist:', '')}
        </span>
        <div className="grow" />
        <span className="chip" title="Cookies stored in this site's isolated session">
          <Cookie size={11} /> {session.data?.cookies ?? '…'} cookies
        </span>
        {session.data?.signedIn && <span className="chip ok" title="Detected from this site's login cookies">Likely signed in</span>}
        <button className="btn sm" onClick={() => void signOut()} title="Clears cookies, storage and cache for this site only">
          <LogOut size={14} /> Sign out & clear
        </button>
      </div>
      <div className="card" style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <WebSession source={source} src={source.url} onNavigate={() => void qc.invalidateQueries({ queryKey: keys.session(source.id) })} />
      </div>
    </div>
  );
}
