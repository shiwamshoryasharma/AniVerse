import type { CommentItem, MediaRef, SourceEpisode, SourceInfo, SourceMatch, Stream } from '../../shared/types';
import type { SiteEntry } from '../config/sitesConfig';
import type { Store } from '../db/store';
import { type FetchFn, requestJson } from '../net/http';
import { AppError, decodeEntities } from '../util';
import { parseEpisodeNumber, videoScore } from './text';
import type { SiteFetcher, SourceAdapter } from './types';

const API = 'https://www.googleapis.com/youtube/v3';
const MATCH_THRESHOLD = 0.6;

interface ChannelInfo {
  channelId: string;
  title: string | null;
}

interface VideoCandidate {
  videoId: string;
  title: string;
  thumbnail: string | null;
  publishedAt: number | null;
}

/**
 * Official anime channels on YouTube (Muse Asia, Ani-One, …). Episodes come from
 * the YouTube Data API when the user supplies a key, otherwise from the
 * channel's public RSS feed (latest uploads only). Playback uses YouTube's
 * official embed player.
 */
export class YouTubeAdapter implements SourceAdapter {
  readonly kind = 'youtube' as const;

  constructor(
    private fetchFn: FetchFn,
    private site: SiteFetcher,
    private store: Store,
    private apiKey: () => string,
  ) {}

  capabilities() {
    return { search: true, episodes: true, streams: true, comments: !!this.apiKey(), login: true };
  }

  async match(source: SourceInfo, entry: SiteEntry, media: MediaRef): Promise<SourceMatch> {
    const channel = await this.resolveChannel(source.id, entry);
    const cacheKey = `yt:eps:${channel.channelId}:${media.id}:${this.apiKey() ? 'api' : 'rss'}`;
    const cached = this.store.cacheGet<{ episodes: SourceEpisode[]; note: string | null }>(cacheKey);
    const result = cached ?? (this.apiKey() ? await this.episodesViaApi(channel, media) : await this.episodesViaRss(source.id, channel, media));
    if (!cached) this.store.cacheSet(cacheKey, result, result.episodes.length ? 6 * 3600 : 1800);
    return {
      sourceId: source.id,
      mode: 'episodes',
      pageUrl: `https://www.youtube.com/channel/${channel.channelId}`,
      pinned: false,
      titleUrl: null,
      episodeUrls: {},
      episodes: result.episodes,
      note: result.note,
    };
  }

  async streams(_source: SourceInfo, _entry: SiteEntry, ref: string): Promise<Stream[]> {
    if (!/^[\w-]{11}$/.test(ref)) throw new AppError('invalid-input', 'Invalid YouTube video id.');
    return [{ type: 'youtube', videoId: ref, label: 'YouTube · official embed' }];
  }

  async comments(videoId: string): Promise<CommentItem[]> {
    const key = this.apiKey();
    if (!key) return [];
    const res = await requestJson<{ items: YtCommentThread[] }>(this.fetchFn, {
      url: `${API}/commentThreads?part=snippet&maxResults=40&order=relevance&textFormat=plainText&videoId=${encodeURIComponent(videoId)}&key=${encodeURIComponent(key)}`,
    });
    return (res.items ?? []).map((t) => {
      const s = t.snippet.topLevelComment.snippet;
      return {
        id: `yt-${t.id}`,
        provider: 'youtube' as const,
        author: { name: s.authorDisplayName, avatar: s.authorProfileImageUrl ?? null, url: s.authorChannelUrl ?? null },
        body: s.textDisplay,
        createdAt: Math.floor(Date.parse(s.publishedAt) / 1000),
        likes: s.likeCount ?? null,
        url: `https://www.youtube.com/watch?v=${videoId}&lc=${t.id}`,
      };
    });
  }

  async resolveChannel(sourceId: string, entry: SiteEntry): Promise<ChannelInfo> {
    const yt = entry.youtube;
    if (!yt) throw new AppError('config', `${entry.url} is not a YouTube channel URL.`);
    if (yt.channelId) return { channelId: yt.channelId, title: null };
    const kvKey = `yt:channel:${yt.handle!.toLowerCase()}`;
    const known = this.store.getKv<ChannelInfo | null>(kvKey, null);
    if (known) return known;

    let info: ChannelInfo | null = null;
    const key = this.apiKey();
    if (key) {
      const res = await requestJson<{ items?: { id: string; snippet: { title: string } }[] }>(this.fetchFn, {
        url: `${API}/channels?part=id,snippet&forHandle=${encodeURIComponent(yt.handle!)}&key=${encodeURIComponent(key)}`,
      });
      const item = res.items?.[0];
      if (item) info = { channelId: item.id, title: item.snippet.title };
    } else {
      // One-time lookup of the public channel page to read its canonical channel id.
      const page = await this.site.get(sourceId, `https://www.youtube.com/${yt.handle}`);
      const id =
        page.text.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] ??
        page.text.match(/"externalId":"(UC[\w-]{22})"/)?.[1] ??
        page.text.match(/<meta itemprop="identifier" content="(UC[\w-]{22})"/)?.[1];
      const title = page.text.match(/<meta property="og:title" content="([^"]+)"/)?.[1];
      if (id) info = { channelId: id, title: title ? decodeEntities(title) : null };
    }
    if (!info) throw new AppError('not-found', `Could not resolve YouTube channel ${yt.handle}.`);
    this.store.setKv(kvKey, info);
    return info;
  }

  private async episodesViaApi(channel: ChannelInfo, media: MediaRef): Promise<{ episodes: SourceEpisode[]; note: string | null }> {
    const key = encodeURIComponent(this.apiKey());
    const query = encodeURIComponent(media.titles[0] ?? '');
    const playlists = await requestJson<{ items?: { id: { playlistId: string }; snippet: { title: string } }[] }>(this.fetchFn, {
      url: `${API}/search?part=snippet&type=playlist&maxResults=10&channelId=${channel.channelId}&q=${query}&key=${key}`,
    });
    const best = (playlists.items ?? [])
      .map((p) => ({ id: p.id.playlistId, score: videoScore(decodeEntities(p.snippet.title), media.titles) }))
      .sort((a, b) => b.score - a.score)[0];

    let videos: VideoCandidate[] = [];
    if (best && best.score >= MATCH_THRESHOLD) {
      let pageToken = '';
      for (let i = 0; i < 6; i++) {
        const page = await requestJson<{ nextPageToken?: string; items?: YtPlaylistItem[] }>(this.fetchFn, {
          url: `${API}/playlistItems?part=snippet&maxResults=50&playlistId=${best.id}&key=${key}${pageToken ? `&pageToken=${pageToken}` : ''}`,
        });
        for (const item of page.items ?? []) {
          const vid = item.snippet.resourceId?.videoId;
          if (!vid || item.snippet.title === 'Private video' || item.snippet.title === 'Deleted video') continue;
          videos.push({
            videoId: vid,
            title: decodeEntities(item.snippet.title),
            thumbnail: item.snippet.thumbnails?.medium?.url ?? item.snippet.thumbnails?.default?.url ?? null,
            publishedAt: item.snippet.publishedAt ? Math.floor(Date.parse(item.snippet.publishedAt) / 1000) : null,
          });
        }
        if (!page.nextPageToken) break;
        pageToken = page.nextPageToken;
      }
    } else {
      const search = await requestJson<{ items?: { id: { videoId: string }; snippet: YtSnippet }[] }>(this.fetchFn, {
        url: `${API}/search?part=snippet&type=video&maxResults=50&order=date&channelId=${channel.channelId}&q=${query}&key=${key}`,
      });
      videos = (search.items ?? [])
        .map((v) => ({
          videoId: v.id.videoId,
          title: decodeEntities(v.snippet.title),
          thumbnail: v.snippet.thumbnails?.medium?.url ?? null,
          publishedAt: v.snippet.publishedAt ? Math.floor(Date.parse(v.snippet.publishedAt) / 1000) : null,
        }))
        .filter((v) => videoScore(v.title, media.titles) >= MATCH_THRESHOLD);
    }
    const episodes = toEpisodes(videos);
    return { episodes, note: episodes.length ? null : 'No official uploads matched this title on this channel.' };
  }

  private async episodesViaRss(sourceId: string, channel: ChannelInfo, media: MediaRef): Promise<{ episodes: SourceEpisode[]; note: string | null }> {
    const feed = await this.site.get(sourceId, `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channelId}`, { accept: 'application/atom+xml' });
    const videos = parseYouTubeFeed(feed.text).filter((v) => videoScore(v.title, media.titles) >= MATCH_THRESHOLD);
    const episodes = toEpisodes(videos);
    return {
      episodes,
      note: 'Showing recent uploads only. Add a YouTube Data API key in Settings → Accounts to search the whole channel.',
    };
  }
}

export function parseYouTubeFeed(xml: string): VideoCandidate[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const block = m[1];
    return {
      videoId: block.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/)?.[1] ?? '',
      title: decodeEntities(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ''),
      thumbnail: block.match(/<media:thumbnail url="([^"]+)"/)?.[1] ?? null,
      publishedAt: (() => {
        const p = block.match(/<published>([^<]+)<\/published>/)?.[1];
        return p ? Math.floor(Date.parse(p) / 1000) : null;
      })(),
    };
  }).filter((v) => v.videoId);
}

export function toEpisodes(videos: VideoCandidate[]): SourceEpisode[] {
  const byNumber = new Map<number, SourceEpisode>();
  for (const v of videos) {
    const n = parseEpisodeNumber(v.title);
    if (n === null || byNumber.has(n)) continue;
    byNumber.set(n, { number: n, title: v.title, thumbnail: v.thumbnail, ref: v.videoId, publishedAt: v.publishedAt });
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

interface YtSnippet {
  title: string;
  publishedAt?: string;
  thumbnails?: Record<string, { url: string } | undefined>;
}

interface YtPlaylistItem {
  snippet: YtSnippet & { resourceId?: { videoId?: string } };
}

interface YtCommentThread {
  id: string;
  snippet: {
    topLevelComment: {
      snippet: {
        authorDisplayName: string;
        authorProfileImageUrl?: string;
        authorChannelUrl?: string;
        textDisplay: string;
        likeCount?: number;
        publishedAt: string;
      };
    };
  };
}
