import { describe, expect, it } from 'vitest';
import type { MediaCard } from '../../app/shared/types';
import { availableEpisodes, pendingRelease } from '../../frontend/src/lib/format';

const NOW = Date.UTC(2026, 9, 22, 12) / 1000; // 22 Oct 2026
const DAY = 86400;

const card = (over: Partial<MediaCard>): MediaCard => ({
  id: 1,
  idMal: null,
  title: { romaji: 'Test', english: null, native: null, userPreferred: 'Test' },
  cover: '',
  coverColor: null,
  banner: null,
  format: 'TV',
  status: 'RELEASING',
  episodes: 12,
  duration: 24,
  score: null,
  season: 'FALL',
  seasonYear: 2026,
  genres: [],
  isAdult: false,
  nextAiring: null,
  startDate: null,
  description: null,
  ...over,
});

describe('release gating', () => {
  it('blocks a title that has not premiered and reports its date', () => {
    const movie = card({ format: 'MOVIE', status: 'NOT_YET_RELEASED', episodes: 1, startDate: { year: 2026, month: 11, day: 14 } });
    const p = pendingRelease(movie, 1, NOW);
    expect(p).toMatchObject({ title: true, exact: false, episode: 1 });
    expect(p?.at).toBeGreaterThan(NOW);
    expect(availableEpisodes(movie)).toBe(0);
  });

  it('uses the exact broadcast time when AniList has one', () => {
    const show = card({ status: 'NOT_YET_RELEASED', nextAiring: { episode: 1, airingAt: NOW + 3 * DAY } });
    expect(pendingRelease(show, 1, NOW)).toMatchObject({ reason: 'premiere', title: true, exact: true, at: NOW + 3 * DAY, short: 'in 3d 0h' });
  });

  it('falls back to the season or TBA without a date', () => {
    expect(pendingRelease(card({ status: 'NOT_YET_RELEASED', season: 'WINTER', seasonYear: 2027 }), 1, NOW)?.label).toBe('Winter 2027');
    expect(pendingRelease(card({ status: 'NOT_YET_RELEASED', season: null, seasonYear: null }), 1, NOW)?.label).toBe('TBA');
  });

  it('lets sources try once a listed premiere date has passed', () => {
    expect(pendingRelease(card({ status: 'NOT_YET_RELEASED', startDate: { year: 2026, month: 10, day: 1 } }), 1, NOW)).toBeNull();
  });

  it('treats a future start date as unreleased even when AniList says RELEASING', () => {
    const film = card({ format: 'MOVIE', status: 'RELEASING', episodes: 1, startDate: { year: 2026, month: 10, day: 24 } });
    expect(pendingRelease(film, 1, NOW)).toMatchObject({ reason: 'premiere', title: true });
    expect(availableEpisodes(film)).toBe(0);
    const show = card({ status: 'RELEASING', startDate: { year: 2026, month: 10, day: 30 } });
    expect(pendingRelease(show, 1, NOW)?.title).toBe(true);
  });

  it('keeps films that are still in cinemas out of the player', () => {
    const film = card({ format: 'MOVIE', status: 'RELEASING', episodes: 1, startDate: { year: 2026, month: 10, day: 2 } });
    expect(pendingRelease(film, 1, NOW)).toMatchObject({ reason: 'cinema', title: true, at: null });
    expect(pendingRelease({ ...film, status: 'FINISHED' }, 1, NOW)).toBeNull();
  });

  it('blocks only the unaired episodes of an airing show', () => {
    const airing = card({ nextAiring: { episode: 7, airingAt: NOW + DAY } });
    expect(pendingRelease(airing, 6, NOW)).toBeNull();
    expect(pendingRelease(airing, 7, NOW)).toMatchObject({ reason: 'episode', title: false, exact: true });
    expect(pendingRelease(airing, 9, NOW)).toMatchObject({ exact: false, at: NOW + DAY + 14 * DAY });
    // Once the slot has passed, the episode is playable even with stale data.
    expect(pendingRelease(airing, 7, NOW + 2 * DAY)).toBeNull();
  });
});
