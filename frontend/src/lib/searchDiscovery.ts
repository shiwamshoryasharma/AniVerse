import type { HistoryEntry, HomeData, MediaCard, MediaLibraryState } from '../../../app/shared/types';

export interface SearchHistory {
  watched: Set<number>;
  recent: number[];
}

export function addSearchHistory(history: SearchHistory, rows: HistoryEntry[]) {
  for (const { media } of rows) {
    if (!history.watched.has(media.id) && history.recent.length < 6) history.recent.push(media.id);
    history.watched.add(media.id);
  }
}

export function searchCatalogue(home: HomeData | undefined) {
  return home ? [...home.trending, ...home.popularSeason, ...home.topRated, ...home.spotlight] : [];
}

export function rankSuggestions(
  catalogue: MediaCard[],
  seeds: (MediaCard | undefined)[],
  related: MediaCard[],
  excluded: ReadonlySet<number>,
) {
  const genres = new Map<string, number>();
  for (const [index, seed] of seeds.entries()) {
    for (const genre of seed?.genres ?? []) genres.set(genre, (genres.get(genre) ?? 0) + seeds.length - index);
  }
  const relatedIds = new Set(related.map(({ id }) => id));
  const distinct = new Map<number, MediaCard>();
  for (const media of [...catalogue, ...related]) {
    if (!excluded.has(media.id) && !distinct.has(media.id)) distinct.set(media.id, media);
  }
  const ranking = [...distinct.values()].map((media, index) => ({
    media,
    index,
    taste: media.genres.reduce((score, genre) => score + (genres.get(genre) ?? 0), relatedIds.has(media.id) ? 4 : 0),
  }));
  ranking.sort((a, b) => b.taste - a.taste || a.index - b.index);
  const matching = ranking.filter(({ taste }) => taste > 0);
  return {
    personalized: matching.length > 0,
    items: (matching.length ? matching : ranking).slice(0, 6).map(({ media }) => media),
  };
}

export function completedInLibrary(media: MediaCard, state: MediaLibraryState | null | undefined) {
  if (state?.entry?.status === 'COMPLETED') return true;
  if (!media.episodes || media.status !== 'FINISHED') return false;
  const total = media.episodes;
  const finished = new Set(state?.progress.filter(row => row.completed && row.episode >= 1 && row.episode <= total).map(row => row.episode));
  return finished.size === total;
}
