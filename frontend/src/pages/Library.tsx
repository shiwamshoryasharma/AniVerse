import { Heart, Play, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { ListStatus, MediaSnapshot } from '../../../app/shared/types';
import { Empty, Loading } from '../components/common';
import { cx, formatLabel, LIST_STATUSES, timeAgo } from '../lib/format';
import { useContinue, useEntries, useFavourites, useHistory, useSetStatus } from '../lib/queries';
import { call, errorText } from '../lib/bridge';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../lib/useToast';
import { Select } from '../components/controls';

type Tab = 'continue' | ListStatus | 'favourites';

export function LibraryPage() {
  const [tab, setTab] = useState<Tab>('continue');
  return (
    <div className="page">
      <h1 className="page-title">Library</h1>
      <p className="page-sub">Stored locally in SQLite and synced to AniList / MyAnimeList when connected.</p>
      <div className="tabs" style={{ marginBottom: 18 }}>
        <button className={cx('tab', tab === 'continue' && 'active')} onClick={() => setTab('continue')}>
          Continue watching
        </button>
        {LIST_STATUSES.map(([s, label]) => (
          <button key={s} className={cx('tab', tab === s && 'active')} onClick={() => setTab(s)}>
            {label}
          </button>
        ))}
        <button className={cx('tab', tab === 'favourites' && 'active')} onClick={() => setTab('favourites')}>
          Favourites
        </button>
      </div>
      {tab === 'continue' ? <ContinueList /> : tab === 'favourites' ? <FavouriteList /> : <EntryList status={tab} />}
    </div>
  );
}

function Poster({ media, sub, right, to }: { media: MediaSnapshot; sub: string; right?: React.ReactNode; to: string }) {
  const navigate = useNavigate();
  return (
    <div className="list-row" role="link" tabIndex={0} onClick={() => navigate(to)} style={{ cursor: 'pointer' }}>
      {media.cover ? <img src={media.cover} alt="" loading="lazy" /> : <div className="skeleton" style={{ width: 46, height: 64 }} />}
      <div style={{ minWidth: 0 }}>
        <div className="ellipsis" style={{ fontWeight: 650 }}>
          {media.title}
        </div>
        <div className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
          {sub}
        </div>
      </div>
      <div className="row" onClick={(e) => e.stopPropagation()}>
        {right}
      </div>
    </div>
  );
}

function ContinueList() {
  const { data, isLoading } = useContinue();
  const navigate = useNavigate();
  if (isLoading) return <Loading />;
  if (!data?.length) return <Empty title="Nothing in progress">Episodes you start watching appear here.</Empty>;
  return (
    <div className="card">
      {data.map((c) => (
        <Poster
          key={c.media.id}
          media={c.media}
          to={`/anime/${c.media.id}`}
          sub={`Episode ${c.episode}${c.duration ? ` · ${Math.round((c.position / c.duration) * 100)}%` : ' · up next'} · ${timeAgo(c.updatedAt)}`}
          right={
            <button className="btn primary sm" onClick={() => navigate(`/watch/${c.media.id}/${c.episode}${c.sourceId ? `?source=${c.sourceId}` : ''}`)}>
              <Play size={13} fill="currentColor" /> Resume
            </button>
          }
        />
      ))}
    </div>
  );
}

function EntryList({ status }: { status: ListStatus }) {
  const { data, isLoading } = useEntries(status);
  const setStatus = useSetStatus();
  const toast = useToast();
  if (isLoading) return <Loading />;
  if (!data?.length) return <Empty title="This list is empty">Use “Add to list” on any anime page.</Empty>;
  return (
    <div className="card">
      {data.map((e) => (
        <Poster
          key={e.media.id}
          media={e.media}
          to={`/anime/${e.media.id}`}
          sub={`${formatLabel(e.media.format)} · ${e.progress}/${e.media.episodes ?? '?'} episodes${e.score ? ` · score ${e.score}` : ''} · updated ${timeAgo(e.updatedAt)}`}
          right={
            <>
              <Select<ListStatus>
                ariaLabel="Change list"
                size="sm"
                width={150}
                value={e.status}
                onChange={(status) => setStatus.mutate({ media: e.media, status }, { onError: (err) => toast.push({ level: 'error', message: err.message }) })}
                options={LIST_STATUSES.map(([s, l]) => ({ value: s, label: l }))}
              />
              <button className="icon-btn" aria-label="Remove from list" title="Remove from list" onClick={() => setStatus.mutate({ media: e.media, status: null })}>
                <Trash2 size={15} />
              </button>
            </>
          }
        />
      ))}
    </div>
  );
}

function FavouriteList() {
  const { data, isLoading } = useFavourites();
  const qc = useQueryClient();
  const toast = useToast();
  if (isLoading) return <Loading />;
  if (!data?.length) return <Empty title="No favourites yet">Tap the heart on any anime to keep it here.</Empty>;
  const unfavourite = async (media: MediaSnapshot) => {
    try {
      await call('library.toggleFavourite', { media });
      void qc.invalidateQueries({ queryKey: ['library'] });
    } catch (err) {
      toast.push({ level: 'error', message: errorText(err) });
    }
  };
  return (
    <div className="card">
      {data.map((f) => (
        <Poster
          key={f.media.id}
          media={f.media}
          to={`/anime/${f.media.id}`}
          sub={`${formatLabel(f.media.format)} · added ${timeAgo(f.addedAt)}`}
          right={
            <button className="icon-btn on" aria-label="Remove favourite" onClick={() => void unfavourite(f.media)}>
              <Heart size={16} fill="currentColor" />
            </button>
          }
        />
      ))}
    </div>
  );
}

export function HistoryPage() {
  const { data, isLoading } = useHistory();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const clear = async (id: number | null) => {
    try {
      await call('library.clearHistory', { id });
      void qc.invalidateQueries({ queryKey: ['library'] });
    } catch (err) {
      toast.push({ level: 'error', message: errorText(err) });
    }
  };
  return (
    <div className="page">
      <div className="row between">
        <div>
          <h1 className="page-title">Watch history</h1>
          <p className="page-sub">Every episode you opened, newest first.</p>
        </div>
        {!!data?.length && (
          <button className="btn danger sm" onClick={() => void clear(null)}>
            <Trash2 size={14} /> Clear history
          </button>
        )}
      </div>
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty title="No history yet">Episodes you watch are recorded here.</Empty>
      ) : (
        <div className="card">
          {data.map((h) => (
            <Poster
              key={h.id}
              media={h.media}
              to={`/watch/${h.media.id}/${h.episode}${h.sourceId ? `?source=${h.sourceId}` : ''}`}
              sub={`Episode ${h.episode}${h.duration ? ` · ${Math.min(100, Math.round((h.position / h.duration) * 100))}% watched` : ''} · ${timeAgo(h.watchedAt)}${h.sourceId ? ` · ${h.sourceId}` : ''}`}
              right={
                <>
                  <button className="btn sm" onClick={() => navigate(`/watch/${h.media.id}/${h.episode}${h.sourceId ? `?source=${h.sourceId}` : ''}`)}>
                    <Play size={13} /> Play
                  </button>
                  <button className="icon-btn" aria-label="Remove from history" onClick={() => void clear(h.id)}>
                    <Trash2 size={15} />
                  </button>
                </>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
