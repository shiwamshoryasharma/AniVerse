// When a title (or one of its episodes) can actually be watched. Shared by the
// core (home sections) and the renderer (cards, Details, the Watch gate).
import type { MediaCard } from './types';

export interface PendingRelease {
  /** premiere: the title hasn't started; episode: one upcoming episode of an airing show; cinema: a film still in theatres. */
  reason: 'premiere' | 'episode' | 'cinema';
  /** The title as a whole can't be watched yet (premiere or cinema). */
  title: boolean;
  /** The episode this is about. */
  episode: number;
  /** Unix time it becomes watchable, when known. */
  at: number | null;
  /** `at` is the exact broadcast time (otherwise a date or an estimate). */
  exact: boolean;
  /** Full label, e.g. "Saturday, 14 November 2026 at 21:30", "November 2026", "Fall 2026", "TBA". */
  label: string;
  /** Compact label for chips, e.g. "in 3d 4h", "14 Nov", "Fall 2026". */
  short: string;
  /** Button text, e.g. "Releases 14 Nov", "EP 7 in 2d 4h", "In cinemas". */
  action: string;
}

const DAY = 86400;
const SEASON = { WINTER: 'Winter', SPRING: 'Spring', SUMMER: 'Summer', FALL: 'Fall' } as const;
const dateLong = (at: number) => new Date(at * 1000).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dateShort = (at: number) => new Date(at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const timeOf = (at: number) => new Date(at * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** "3d 4h", "5h 10m", "12m". */
export function span(seconds: number): string {
  const s = Math.max(0, seconds);
  const d = Math.floor(s / DAY);
  const h = Math.floor((s % DAY) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** When a title (or one of its episodes) can be watched, or null if it already can. */
export function pendingRelease(m: MediaCard, episode = 1, now = Date.now() / 1000): PendingRelease | null {
  const next = m.nextAiring;
  if (next && episode >= next.episode && next.airingAt > now) {
    // Later episodes: assume the usual weekly slot.
    const exact = episode === next.episode;
    const at = next.airingAt + (episode - next.episode) * 7 * DAY;
    const premiere = next.episode === 1;
    const short = at - now < 7 * DAY ? `in ${span(at - now)}` : dateShort(at);
    return {
      reason: premiere ? 'premiere' : 'episode',
      title: premiere,
      episode,
      at,
      exact,
      label: exact ? `${dateLong(at)} at ${timeOf(at)}` : `around ${dateLong(at)}`,
      short,
      action: premiere ? `Premieres ${short}` : `EP ${episode} ${at - now < 7 * DAY ? short : `on ${short}`}`,
    };
  }

  const d = m.startDate;
  const start = d?.year && d.month && d.day ? new Date(d.year, d.month - 1, d.day).getTime() / 1000 : null;
  const premiere = (label: string, short: string, at: number | null): PendingRelease => ({ reason: 'premiere', title: true, episode, at, exact: false, label, short, action: `Releases ${short}` });
  // A dated premiere that is still ahead, whatever the status says (AniList flips it early).
  if (start !== null && start > now) return premiere(dateLong(start), dateShort(start), start);

  if (m.status === 'NOT_YET_RELEASED') {
    if (start !== null) {
      // AniList can lag behind a premiere; a day after the listed date, let the sources try.
      return start + DAY < now ? null : premiere(`today, ${dateLong(start)}`, 'today', null);
    }
    if (d?.year && d.month) {
      const first = new Date(d.year, d.month - 1, 1);
      return premiere(first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), first.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }), null);
    }
    const year = m.seasonYear ?? d?.year ?? null;
    const label = [m.season ? SEASON[m.season] : null, year].filter(Boolean).join(' ') || 'TBA';
    return premiere(label, label, null);
  }

  // Films run in cinemas for months before they can be streamed.
  if (m.format === 'MOVIE' && m.status === 'RELEASING') {
    return { reason: 'cinema', title: true, episode, at: null, exact: false, label: start ? `in cinemas since ${dateLong(start)}` : 'in cinemas now', short: 'In cinemas', action: 'In cinemas' };
  }
  return null;
}
