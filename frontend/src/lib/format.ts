import { pendingRelease } from '../../../app/shared/release';
import type { ListStatus, MediaCard, MediaDetails, MediaFormat, MediaRef, MediaSnapshot, MediaStatus, Settings } from '../../../app/shared/types';

export type TitleLanguage = Settings['appearance']['titleLanguage'];

export function titleOf(m: Pick<MediaCard, 'title'>, lang: TitleLanguage): string {
  const t = m.title;
  if (lang === 'english') return t.english || t.userPreferred || t.romaji || '';
  if (lang === 'native') return t.native || t.userPreferred;
  return t.romaji || t.userPreferred;
}

export function snapshotOf(m: MediaCard, lang: TitleLanguage): MediaSnapshot {
  return { id: m.id, idMal: m.idMal, title: titleOf(m, lang), cover: m.cover, banner: m.banner, format: m.format, episodes: m.episodes };
}

/** Titles ordered for searching on third-party sites (English first, then romaji, synonyms). */
export function searchTitles(m: MediaCard | MediaDetails, first?: string): string[] {
  const list = [first, m.title.english, m.title.romaji, m.title.native, m.title.userPreferred, ...('synonyms' in m ? m.synonyms.slice(0, 3) : []), m.title.native];
  return [...new Set(list.filter((t): t is string => !!t && t.trim().length > 0))].slice(0, 8);
}

export function mediaRefOf(m: MediaCard | MediaDetails, firstTitle?: string): MediaRef {
  return { id: m.id, idMal: m.idMal, titles: searchTitles(m, firstTitle), episodes: m.episodes, format: m.format, seasonYear: m.seasonYear };
}

const FORMAT: Record<MediaFormat, string> = {
  TV: 'TV',
  TV_SHORT: 'TV Short',
  MOVIE: 'Movie',
  SPECIAL: 'Special',
  OVA: 'OVA',
  ONA: 'ONA',
  MUSIC: 'Music',
};

export const formatLabel = (f: MediaFormat | null) => (f ? FORMAT[f] : '—');

const STATUS: Record<MediaStatus, string> = {
  FINISHED: 'Finished',
  RELEASING: 'Airing',
  NOT_YET_RELEASED: 'Upcoming',
  CANCELLED: 'Cancelled',
  HIATUS: 'Hiatus',
};

export const statusLabel = (s: MediaStatus | null) => (s ? STATUS[s] : '—');

export const seasonLabel = (s: string | null, y: number | null) => [s ? s[0] + s.slice(1).toLowerCase() : null, y].filter(Boolean).join(' ');

/** Number of episodes that exist right now (aired or announced). */
export function availableEpisodes(m: MediaCard, extra = 0): number {
  if (m.nextAiring) return Math.max(m.nextAiring.episode - 1, extra);
  if (pendingRelease(m)?.title) return extra;
  if (m.episodes) return m.episodes;
  return Math.max(extra, 1);
}

export { pendingRelease, type PendingRelease } from '../../../app/shared/release';

export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function timeAgo(unix: number): string {
  const diff = Date.now() / 1000 - unix;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unix * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function countdown(unix: number, now = Date.now() / 1000): string {
  const diff = Math.max(0, unix - now);
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export function airTime(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function fuzzyDate(d: { year: number | null; month: number | null; day: number | null } | null): string {
  if (!d?.year) return '—';
  if (!d.month) return String(d.year);
  return new Date(d.year, d.month - 1, d.day ?? 1).toLocaleDateString(undefined, { day: d.day ? 'numeric' : undefined, month: 'short', year: 'numeric' });
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export const LIST_STATUSES: [ListStatus, string][] = [
  ['CURRENT', 'Watching'],
  ['PLANNING', 'Plan to watch'],
  ['COMPLETED', 'Completed'],
  ['PAUSED', 'Paused'],
  ['DROPPED', 'Dropped'],
  ['REPEATING', 'Rewatching'],
];

/** Infers the stream type from a URL or file name (HLS .m3u8, DASH .mpd, otherwise progressive). */
export function detectStreamType(url: string): 'hls' | 'dash' | 'mp4' {
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith('.m3u8') || /[?&]format=m3u8/.test(url)) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  return 'mp4';
}
