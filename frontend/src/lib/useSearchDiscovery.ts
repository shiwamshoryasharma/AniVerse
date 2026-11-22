import { useQueries, useQuery, type Query } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { MediaCard, PrivacyState } from '../../../app/shared/types';
import { call } from './bridge';
import { keys } from './queries';
import { completedInLibrary, rankSuggestions, searchCatalogue } from './searchDiscovery';

function allowed(privacy: PrivacyState | undefined, id?: number) {
  return !!privacy && !privacy.incognito && (id == null || !privacy.privateMediaIds.includes(id));
}

function useSearchProfile(enabled: boolean) {
  return useQuery({
    queryKey: keys.searchContext, enabled, staleTime: 60_000, refetchOnWindowFocus: false, retry: false,
    queryFn: () => call('library.searchContext'),
  });
}

export function useSearchDiscovery(open: boolean, privacy: PrivacyState | undefined, showAdult: boolean) {

  const personalize = open && allowed(privacy);
  const home = useQuery({
    queryKey: keys.home, queryFn: () => call('meta.home'), staleTime: 5 * 60_000,
    enabled: query => open && !!privacy && query.state.data === undefined, refetchOnWindowFocus: false, retry: false,
  });
  const profile = useSearchProfile(personalize);
  const history = personalize ? profile.data : undefined;
  const catalogue = useMemo(() => searchCatalogue(home.data), [home.data]);
  const byId = useMemo(() => new Map(catalogue.map(media => [media.id, media])), [catalogue]);
  const privateIds = useMemo(() => new Set(privacy?.privateMediaIds), [privacy]);
  const recent = history?.recent.filter(id => !privateIds.has(id)) ?? [];
  const missing = recent.filter(id => !byId.get(id)?.genres?.length).slice(0, 2);
  const enrich = new Set(missing.length ? missing : recent.slice(0, 1));
  const learned = useQueries({ queries: recent.map(id => ({
    queryKey: keys.details(id), staleTime: 30 * 60_000, retry: false, refetchOnWindowFocus: false,
    enabled: (query: Query) => enrich.has(id) && query.state.data === undefined,
    queryFn: () => call('meta.details', { id }),
  })) });
  const seeds = recent.map((id, index) => learned[index]?.data ?? byId.get(id));
  const related = learned.flatMap(({ data }) => data?.recommendations ?? []);
  const excluded = useMemo(() => new Set([...(history?.watched ?? []), ...privateIds]), [history, privateIds]);
  const ready = open && !!privacy && (!personalize || !!history);
  const ranked = ready ? rankSuggestions(catalogue, seeds, related, excluded, showAdult) : { items: [], personalized: false };
  return {
    ...ranked,
    pending: open && (!privacy || (personalize && profile.isPending) || (!ranked.items.length && ready &&
      (home.isFetching || learned.some(query => query.isFetching)))),
    unavailable: (personalize && profile.isError && !history) || (ready && home.isError && !ranked.items.length),
  };
}

export function useCompletedResults(items: MediaCard[], privacy: PrivacyState | undefined) {
  const eligible = items.filter(media => allowed(privacy, media.id));
  const profile = useSearchProfile(eligible.length > 0);
  const completed = useMemo(() => new Set(profile.data?.completed), [profile.data]);
  const watched = useMemo(() => new Set(profile.data?.watched), [profile.data]);
  const legacy = eligible.filter(media => watched.has(media.id) && !completed.has(media.id) &&
    media.status === 'FINISHED' && !!media.episodes);
  const states = useQueries({ queries: legacy.map(({ id }) => ({
    queryKey: keys.libraryState(id), staleTime: 60_000, retry: false, refetchOnWindowFocus: false,
    queryFn: () => call('library.state', { mediaId: id }),
  })) });
  return new Set([
    ...eligible.filter(media => completed.has(media.id)).map(({ id }) => id),
    ...legacy.filter((media, index) => completedInLibrary(media, states[index]?.data)).map(({ id }) => id),
  ]);
}
