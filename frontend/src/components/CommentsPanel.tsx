import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, MessageSquare, RotateCw, Send, ThumbsUp } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { CommentChannel, CommentProvider, CommentsQuery } from '../../../app/shared/types';
import { call, errorText } from '../lib/bridge';
import { cx, timeAgo } from '../lib/format';
import { keys, useComments } from '../lib/queries';
import { useToast } from '../lib/useToast';
import { Spinner } from './common';
import { RichText } from './RichText';
import { Select } from './controls';

const LABEL: Record<CommentProvider, string> = { anilist: 'AniList', mal: 'MAL', youtube: 'YouTube' };

/** Unified, source-labelled comments. Posting goes only to the selected provider that supports it. */
export function CommentsPanel({ query }: { query: CommentsQuery }) {
  const { data, isLoading, error, refetch, isFetching } = useComments(query);
  const [only, setOnly] = useState<CommentProvider | 'all'>('all');
  const [sort, setSort] = useState<'new' | 'top'>('new');
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [target, setTarget] = useState<CommentProvider | null>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const channels = data?.channels ?? [];
  const writable = channels.filter((c) => c.canPost);
  const postTo = channels.find((c) => c.provider === (target ?? writable[0]?.provider)) ?? null;
  const items = (data?.items ?? []).filter((c) => only === 'all' || c.provider === only).sort((a, b) => (sort === 'top' ? (b.likes ?? 0) - (a.likes ?? 0) : b.createdAt - a.createdAt));

  const post = async () => {
    if (!postTo?.threadId || postTo.provider !== 'anilist') return;
    setPosting(true);
    try {
      const created = await call('comments.post', { provider: 'anilist', threadId: postTo.threadId, body: draft });
      setDraft('');
      qc.setQueryData(keys.comments(query), (old: typeof data) =>
        old ? { ...old, items: [created, ...old.items], channels: old.channels.map((c) => (c.provider === 'anilist' ? { ...c, count: c.count + 1 } : c)) } : old,
      );
      toast.push({ level: 'success', message: 'Posted to AniList.' });
    } catch (err) {
      toast.push({ level: 'error', message: errorText(err) });
    } finally {
      setPosting(false);
    }
  };

  return (
    <section className="card comments">
      <div className="row between">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <MessageSquare size={18} /> Comments — Episode {query.episode}
        </h3>
        <div className="row">
          <div className="tabs">
            <button className={cx('tab', sort === 'new' && 'active')} onClick={() => setSort('new')}>
              Newest
            </button>
            <button className={cx('tab', sort === 'top' && 'active')} onClick={() => setSort('top')}>
              Top
            </button>
          </div>
          <button className="icon-btn bordered" aria-label="Refresh comments" onClick={() => void refetch()}>
            {isFetching ? <Spinner size="sm" /> : <RotateCw size={14} />}
          </button>
        </div>
      </div>

      <div className="comment-channels">
        <button className={cx('channel', only === 'all' && 'on')} onClick={() => setOnly('all')}>
          All <span className="count">{data?.items.length ?? 0}</span>
        </button>
        {channels.map((c) => (
          <ChannelChip key={c.provider} channel={c} on={only === c.provider} onClick={() => setOnly(c.provider)} />
        ))}
      </div>

      {channels
        .filter((c) => c.message && (only === 'all' || only === c.provider) && c.status !== 'ok')
        .map((c) => (
          <div key={c.provider} className="row faint" style={{ fontSize: 'var(--fs-sm)', marginBottom: 6 }}>
            <span className={`provider-badge ${c.provider}`}>{LABEL[c.provider]}</span>
            <span className="grow">{c.message}</span>
            {(c.status === 'needs-config' || c.status === 'needs-login') && (
              <button className="btn xs" onClick={() => navigate('/settings/accounts')}>
                Set up
              </button>
            )}
          </div>
        ))}

      <div className="composer" style={{ margin: '10px 0 4px' }}>
        {writable.length === 0 ? (
          <span className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
            Posting is available on AniList episode threads once your AniList account is connected. MyAnimeList and YouTube comments are read-only here.
          </span>
        ) : (
          <>
            <textarea className="textarea" maxLength={5000} placeholder={`Write a comment for ${postTo ? LABEL[postTo.provider] : ''}…`} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Comment" />
            <div className="row between">
              <div className="row">
                <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>
                  Post to
                </span>
                <Select<CommentProvider> ariaLabel="Post to" size="sm" value={postTo?.provider ?? null} onChange={setTarget} options={writable.map((c) => ({ value: c.provider, label: c.label }))} />
                {postTo?.threadTitle && <span className="faint ellipsis" style={{ fontSize: 'var(--fs-xs)', maxWidth: 260 }}>{postTo.threadTitle}</span>}
              </div>
              <button className="btn primary sm" disabled={posting || draft.trim().length < 2} onClick={() => void post()}>
                {posting ? <Spinner size="sm" /> : <Send size={14} />} Post
              </button>
            </div>
          </>
        )}
      </div>

      {isLoading ? (
        <div className="state">
          <Spinner />
        </div>
      ) : error ? (
        <div className="state">{errorText(error)}</div>
      ) : items.length === 0 ? (
        <div className="state" style={{ padding: 28 }}>
          No comments yet for this episode.
        </div>
      ) : (
        items.map((c) => (
          <article key={c.id} className="comment">
            <span className="avatar">{c.author.avatar ? <img src={c.author.avatar} alt="" loading="lazy" /> : c.author.name[0]?.toUpperCase()}</span>
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 8 }}>
                <strong className="ellipsis">{c.author.name}</strong>
                <span className={`provider-badge ${c.provider}`}>{LABEL[c.provider]}</span>
                <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>
                  {timeAgo(c.createdAt)}
                </span>
                <div className="grow" />
                {c.likes !== null && (
                  <span className="faint row" style={{ gap: 4, fontSize: 'var(--fs-xs)' }}>
                    <ThumbsUp size={12} /> {c.likes}
                  </span>
                )}
                {c.url && (
                  <button className="icon-btn xs" aria-label="Open original" title="Open original" onClick={() => void call('app.openExternal', { url: c.url! })}>
                    <ExternalLink size={12} />
                  </button>
                )}
              </div>
              <div className="comment-body selectable">
                <RichText source={c.body} />
              </div>
            </div>
          </article>
        ))
      )}
    </section>
  );
}

function ChannelChip({ channel, on, onClick }: { channel: CommentChannel; on: boolean; onClick: () => void }) {
  const tone = channel.status === 'error' ? 'var(--err)' : channel.status === 'needs-config' || channel.status === 'needs-login' ? 'var(--warn)' : undefined;
  return (
    <button className={cx('channel', on && 'on')} onClick={onClick} title={channel.threadTitle ?? channel.message ?? channel.label}>
      <span className={`provider-badge ${channel.provider}`}>{LABEL[channel.provider]}</span>
      <span className="count" style={{ color: tone }}>
        {channel.status === 'needs-config' ? 'setup' : channel.status === 'error' ? 'error' : channel.count}
      </span>
      {channel.threadUrl && (
        <ExternalLink
          size={12}
          onClick={(e) => {
            e.stopPropagation();
            void call('app.openExternal', { url: channel.threadUrl! });
          }}
        />
      )}
    </button>
  );
}
