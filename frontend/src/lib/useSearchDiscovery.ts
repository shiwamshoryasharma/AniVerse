import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { MediaCard, MediaDetails, PrivacyState } from '../../../app/shared/types';
import { call } from './bridge';
import { keys } from './queries';
import { addSearchHistory, completedInLibrary, rankSuggestions, searchCatalogue, type SearchHistory } from './searchDiscovery';

const recentHistory = [...keys.history, 'search-discovery'] as const;
const historyPageSize = 500;
const privateSet = new Set<number>();

function allowed(privacy: PrivacyState | undefined, id?: number) {
  return !!privacy && !privacy.incognito && (id == null || !privacy.privateMediaIds.includes(id));
}

export function useSearchDiscovery(open: boolean, privacy: PrivacyState | undefined) {
  const client = useQueryClient();
  const personalize = open && allowed(privacy);
  const { data: catalogueData, isPending: readingCatalogue } = useQuery({
    queryKey: keys.home, queryFn: () => call('meta.home'), staleTime: 5 * 60_000, enabled: open,
  });
  const { data: historyData, isPending: readingHistory } = useQuery({
    queryKey: recentHistory, enabled: personalize, staleTime: 60_000, refetchOnWindowFocus: false, retry: false,
    queryFn: async ({ signal }) => {
      const history: SearchHistory = { watched: new Set(), recent: [] };
      for (let offset = 0; ; offset += historyPageSize) {
        if (signal.aborted || !allowed(client.getQueryData<PrivacyState>(['privacy']))) return null;
        const page = await call('library.history', { limit: historyPageSize, offset });
        addSearchHistory(history, page);
        if (page.length < historyPageSize || offset >= 1_000_000) return history;
      }
    },
  });
  const catalogue = useMemo(() => searchCatalogue(catalogueData), [catalogueData]);
  const privateIds = useMemo(() => privacy ? new Set(privacy.privateMediaIds) : privateSet, [privacy]);
  const history = personalize ? historyData : null;
  const recent = history?.recent.filter(id => !privateIds.has(id)) ?? [];
  const known = recent.map(id => client.getQueryData<MediaDetails>(keys.details(id)) ?? catalogue.find(media => media.id === id));
  const missing = recent.filter((_, index) => !known[index]).slice(0, 2);
  const learned = useQueries({ queries: missing.map(id => ({
    queryKey: ['search-discovery-metadata', id], staleTime: 30 * 60_000, retry: false, refetchOnWindowFocus: false,
    queryFn: () => allowed(client.getQueryData<PrivacyState>(['privacy']), id) ? call('meta.details', { id }) : null,
  })) });
  const details = learned.flatMap(({ data }) => data && !privateIds.has(data.id) ? [data] : []);
  const seeds = recent.map((id, index) => known[index] ?? details.find(media => media.id === id));
  const related = [...known, ...details].flatMap(media => media && 'recommendations' in media ? (media as MediaDetails).recommendations : []);
  const excluded = useMemo(() => new Set([...(history?.watched ?? []), ...privateIds]), [history, privateIds]);
  const pending = open && (!privacy || (readingCatalogue && !details.length) || (personalize && readingHistory));
  return !open || pending || (personalize && !history) ? { items: [], personalized: false, pending } : { ...rankSuggestions(catalogue, seeds, related, excluded), pending };
}

export function useCompletedResults(items: MediaCard[], privacy: PrivacyState | undefined) {
  const client = useQueryClient();
  const eligible = items.filter(media => allowed(privacy, media.id));
  const states = useQueries({ queries: eligible.map(({ id }) => ({
    queryKey: [...keys.libraryState(id), 'search'], staleTime: 60_000, retry: false, refetchOnWindowFocus: false,
    queryFn: () => allowed(client.getQueryData<PrivacyState>(['privacy']), id) ? call('library.state', { mediaId: id }) : null,
  })) });
  return new Set(eligible.filter((media, index) => completedInLibrary(media, states[index]?.data)).map(media => media.id));
}
