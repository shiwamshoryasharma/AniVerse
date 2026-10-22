import type { CommentChannel, CommentItem, CommentsQuery, CommentsResult, Settings } from '../shared/types';
import type { Store } from './db/store';
import type { AniListClient } from './metadata/anilist';
import { type FetchFn, requestJson } from './net/http';
import { titleScore } from './sources/text';
import type { YouTubeAdapter } from './sources/youtube';
import { anilistToMarkdown, bbcodeToMarkdown } from './commentText';
import { AppError, errorMessage } from './util';

interface RawThread {
  id: number;
  title: string;
  siteUrl: string;
}

interface RawThreadComment {
  id: number;
  comment: string;
  createdAt: number;
  likeCount: number;
  siteUrl: string;
  user: { name: string; avatar: { medium: string | null } | null; siteUrl: string } | null;
}

const THREADS = `query ($mediaId: Int, $search: String) {
  Page(perPage: 15) { threads(mediaCategoryId: $mediaId, search: $search, sort: [ID_DESC]) { id title siteUrl } }
}`;

const THREAD_COMMENTS = `query ($threadId: Int) {
  Page(perPage: 50) { threadComments(threadId: $threadId) { id comment(asHtml: false) createdAt likeCount siteUrl user { name avatar { medium } siteUrl } } }
}`;

const POST_COMMENT = `mutation ($threadId: Int, $comment: String) {
  SaveThreadComment(threadId: $threadId, comment: $comment) { id comment(asHtml: false) createdAt likeCount siteUrl user { name avatar { medium } siteUrl } }
}`;

/** Matches "[Spoilers] Title - Episode 5 Discussion" style thread titles. */
export function isEpisodeThread(title: string, episode: number): boolean {
  return new RegExp(`\\bepisode\\s*0*${episode}\\b`, 'i').test(title) && !/\bepisodes?\s*\d+\s*[-–]\s*\d+/i.test(title);
}

/**
 * Unified, source-labelled comments. Each provider is read through its
 * official API; posting is offered only where an authorised write API exists
 * (AniList forum threads).
 */
export class CommentsService {
  constructor(
    private anilist: AniListClient,
    private fetchFn: FetchFn,
    private store: Store,
    private settings: () => Settings,
    private youtube: YouTubeAdapter,
    /** AniVerse's MyAnimeList client ID (public; identifies the app for read-only requests). */
    private malClientId: () => string,
  ) {}

  async list(q: CommentsQuery): Promise<CommentsResult> {
    const settled = await Promise.all([this.fromAniList(q), this.fromMal(q), this.fromYouTube(q)]);
    const channels = settled.map((s) => s.channel).filter((c): c is CommentChannel => !!c);
    const items = settled.flatMap((s) => s.items).sort((a, b) => b.createdAt - a.createdAt);
    return { channels, items };
  }

  async post(threadId: number, body: string): Promise<CommentItem> {
    const text = body.trim();
    if (text.length < 2) throw new AppError('invalid-input', 'Write a little more before posting.');
    if (!this.store.getAccount('anilist')) throw new AppError('unauthorised', 'Connect AniList in Settings → Accounts to post.');
    const data = await this.anilist.query<{ SaveThreadComment: RawThreadComment }>(POST_COMMENT, { threadId, comment: text }, { auth: true });
    return mapAniListComment(data.SaveThreadComment);
  }

  private async fromAniList(q: CommentsQuery): Promise<{ channel: CommentChannel; items: CommentItem[] }> {
    const connected = !!this.store.getAccount('anilist');
    const channel: CommentChannel = {
      provider: 'anilist',
      label: 'AniList',
      status: 'ok',
      canPost: false,
      threadId: null,
      threadTitle: null,
      threadUrl: null,
      message: null,
      count: 0,
    };
    try {
      const threads = await this.anilist.query<{ Page: { threads: RawThread[] } }>(THREADS, { mediaId: q.mediaId, search: `Episode ${q.episode}` }, { ttl: 1800 });
      const thread = threads.Page.threads.find((t) => isEpisodeThread(t.title, q.episode));
      if (!thread) {
        return { channel: { ...channel, status: 'empty', message: `No AniList discussion thread for episode ${q.episode} yet.` }, items: [] };
      }
      const data = await this.anilist.query<{ Page: { threadComments: RawThreadComment[] } }>(THREAD_COMMENTS, { threadId: thread.id }, { ttl: 60 });
      const items = data.Page.threadComments.map(mapAniListComment);
      return {
        channel: {
          ...channel,
          status: items.length ? 'ok' : 'empty',
          canPost: connected,
          threadId: thread.id,
          threadTitle: thread.title,
          threadUrl: thread.siteUrl,
          message: connected ? null : 'Connect AniList in Settings → Accounts to post here.',
          count: items.length,
        },
        items,
      };
    } catch (err) {
      return { channel: { ...channel, status: 'error', message: errorMessage(err) }, items: [] };
    }
  }

  private async fromMal(q: CommentsQuery): Promise<{ channel: CommentChannel; items: CommentItem[] }> {
    const clientId = this.malClientId();
    const channel: CommentChannel = {
      provider: 'mal',
      label: 'MyAnimeList',
      status: 'ok',
      canPost: false,
      threadId: null,
      threadTitle: null,
      threadUrl: null,
      message: 'Read-only: MyAnimeList’s API does not allow posting.',
      count: 0,
    };
    if (!clientId) return { channel: { ...channel, status: 'needs-config', message: 'Add a MyAnimeList client ID in Settings → Accounts to load MAL discussions.' }, items: [] };
    const title = q.titles[0] ?? '';
    try {
      const headers = { 'X-MAL-CLIENT-ID': clientId };
      const cacheKey = `mal:topic:${q.mediaId}:${q.episode}`;
      let topicId = this.store.cacheGet<number | 0>(cacheKey);
      if (topicId === null) {
        const topics = await requestJson<{ data: { id: number; title: string }[] }>(this.fetchFn, {
          url: `https://api.myanimelist.net/v2/forum/topics?limit=15&q=${encodeURIComponent(`${title} Episode ${q.episode} Discussion`)}`,
          headers,
        });
        const topic = topics.data.find((t) => isEpisodeThread(t.title, q.episode) && titleScore(t.title.replace(/episode.*$/i, ''), q.titles) >= 0.5);
        topicId = topic?.id ?? 0;
        this.store.cacheSet(cacheKey, topicId, topicId ? 86400 : 3600);
      }
      if (!topicId) return { channel: { ...channel, status: 'empty', message: `No MyAnimeList discussion found for episode ${q.episode}.` }, items: [] };
      const topic = await requestJson<{ data: { title: string; posts: { id: number; created_at: string; body: string; created_by: { name: string; forum_avator?: string } }[] } }>(this.fetchFn, {
        url: `https://api.myanimelist.net/v2/forum/topic/${topicId}?limit=60`,
        headers,
      });
      const url = `https://myanimelist.net/forum/?topicid=${topicId}`;
      const items: CommentItem[] = topic.data.posts
        .filter((p) => p.body.trim())
        .map((p) => ({
          id: `mal-${p.id}`,
          provider: 'mal' as const,
          author: { name: p.created_by.name, avatar: p.created_by.forum_avator || null, url: `https://myanimelist.net/profile/${encodeURIComponent(p.created_by.name)}` },
          body: bbcodeToMarkdown(p.body),
          createdAt: Math.floor(Date.parse(p.created_at) / 1000),
          likes: null,
          url: `${url}&show=0#msg${p.id}`,
        }));
      return { channel: { ...channel, threadId: topicId, threadTitle: topic.data.title, threadUrl: url, count: items.length, status: items.length ? 'ok' : 'empty' }, items };
    } catch (err) {
      return { channel: { ...channel, status: 'error', message: errorMessage(err) }, items: [] };
    }
  }

  private async fromYouTube(q: CommentsQuery): Promise<{ channel: CommentChannel | null; items: CommentItem[] }> {
    if (!q.youtubeVideoId) return { channel: null, items: [] };
    const channel: CommentChannel = {
      provider: 'youtube',
      label: 'YouTube',
      status: 'ok',
      canPost: false,
      threadId: null,
      threadTitle: null,
      threadUrl: `https://www.youtube.com/watch?v=${q.youtubeVideoId}`,
      message: 'Read-only here — reply on YouTube.',
      count: 0,
    };
    if (!this.settings().accounts.youtubeApiKey) {
      return { channel: { ...channel, status: 'needs-config', message: 'Add a YouTube Data API key in Settings → Accounts to load YouTube comments.' }, items: [] };
    }
    try {
      const items = await this.youtube.comments(q.youtubeVideoId);
      return { channel: { ...channel, count: items.length, status: items.length ? 'ok' : 'empty' }, items };
    } catch (err) {
      return { channel: { ...channel, status: 'error', message: errorMessage(err) }, items: [] };
    }
  }
}

function mapAniListComment(c: RawThreadComment): CommentItem {
  return {
    id: `al-${c.id}`,
    provider: 'anilist',
    author: { name: c.user?.name ?? 'Deleted user', avatar: c.user?.avatar?.medium ?? null, url: c.user?.siteUrl ?? null },
    body: anilistToMarkdown(c.comment ?? ''),
    createdAt: c.createdAt,
    likes: c.likeCount,
    url: c.siteUrl,
  };
}
