import { describe, expect, it } from 'vitest';
import type { HistoryEntry, MediaCard, MediaLibraryState } from '../../app/shared/types';
import { addSearchHistory, completedInLibrary, rankSuggestions, type SearchHistory } from '../../frontend/src/lib/searchDiscovery';

const media = (id: number, genres: string[] = []): MediaCard => ({
  id, genres, idMal: null, title: { romaji: null, english: 'Series ' + id, native: null, userPreferred: 'Series ' + id },
  cover: '', coverColor: null, banner: null, format: 'TV', status: 'FINISHED', episodes: 3, duration: 24,
  score: null, season: null, seasonYear: 2025, isAdult: false, nextAiring: null, startDate: null, description: null,
});

describe('AniVerse2 search discovery', () => {
  it('uses recent distinct titles for taste and records older watched IDs for exact exclusion', () => {
    const history: SearchHistory = { watched: new Set(), recent: [] };
    const row = (id: number) => ({ media: { id } }) as HistoryEntry;
    addSearchHistory(history, [row(8), row(8), row(7), row(6), row(5)]);
    addSearchHistory(history, [row(4), row(3), row(2), row(1)]);
    expect(history.recent).toEqual([8, 7, 6, 5, 4, 3]);
    const typedResults = [media(1, ['Adventure']), media(9, ['Drama']), media(10, ['Adventure']), media(11, ['Adventure'])];
    const ranked = rankSuggestions(typedResults, [media(8, ['Adventure'])], [], new Set([...history.watched, 11]));
    expect(ranked.personalized).toBe(true);
    expect(ranked.items.map(card => card.id)).toEqual([10]);
    expect(typedResults.map(card => card.id)).toEqual([1, 9, 10, 11]);
  });

  it('falls back to public trends and de-duplicates when no taste matches', () => {
    const ranked = rankSuggestions([media(5), media(4), media(4), media(6)], [], [], new Set([5]));
    expect(ranked.personalized).toBe(false);
    expect(ranked.items.map(card => card.id)).toEqual([4, 6]);
  });

  it('requires complete library status or every episode, including numbering gaps', () => {
    const state: MediaLibraryState = { favourite: false, entry: null, progress: [], pinned: {} };
    const episode = (episode: number, completed = true) => ({
      mediaId: 1, episode, position: 10, duration: 10, completed, sourceId: null, updatedAt: 0,
    });
    let progress = [episode(1), episode(3), episode(4)];
    expect(completedInLibrary(media(1), { ...state, progress })).toBe(false);
    progress = [episode(1), episode(2), episode(3)];
    expect(completedInLibrary(media(1), { ...state, progress })).toBe(true);
    expect(completedInLibrary({ ...media(1), status: 'RELEASING' }, { ...state, progress })).toBe(false);
    expect(completedInLibrary({ ...media(1), episodes: null }, { ...state, entry: { status: 'COMPLETED' } as MediaLibraryState['entry'] })).toBe(true);
  });
});
