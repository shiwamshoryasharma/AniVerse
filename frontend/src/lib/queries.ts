import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { BrowseQuery, CommentsQuery, DeepPartial, ListStatus, MediaRef, MediaSnapshot, ProgressSave, Settings, SourceOverridePatch } from '../../../app/shared/types';
import { call, onEvent } from './bridge';
import { DEFAULT_SETTINGS_FALLBACK } from './settingsFallback';

export const keys = {
  home: ['home'] as const,
  browse: (q: BrowseQuery) => ['browse', q] as const,
  details: (id: number) => ['details', id] as const,
  search: (q: string) => ['search', q] as const,
  schedule: (from: number) => ['schedule', from] as const,
  genres: ['genres'] as const,
  sources: ['sources'] as const,
  session: (id: string) => ['session', id] as const,
  match: (sourceId: string, mediaId: number, title: string) => ['match', sourceId, mediaId, title] as const,
  streams: (sourceId: string, ref: string) => ['streams', sourceId, ref] as const,
  libraryState: (id: number) => ['library', 'state', id] as const,
  continue: ['library', 'continue'] as const,
  history: ['library', 'history'] as const,
  favourites: ['library', 'favourites'] as const,
  entries: (status: ListStatus | null) => ['library', 'entries', status] as const,
  accounts: ['accounts'] as const,
  comments: (q: CommentsQuery) => ['comments', q.mediaId, q.episode, q.youtubeVideoId ?? null] as const,
  settings: ['settings'] as const,
  adblock: ['adblock'] as const,
  info: ['app-info'] as const,
  update: ['update'] as const,
};

export const useHome = () => useQuery({ queryKey: keys.home, queryFn: () => call('meta.home'), staleTime: 5 * 60_000 });

export const useDetails = (id: number) =>
  useQuery({ queryKey: keys.details(id), queryFn: () => call('meta.details', { id }), enabled: id > 0, staleTime: 30 * 60_000 });

export const useSearch = (q: string) =>
  useQuery({ queryKey: keys.search(q), queryFn: () => call('meta.search', { q }), enabled: q.trim().length >= 2, staleTime: 10 * 60_000 });

export const useSchedule = (from: number, to: number) =>
  useQuery({ queryKey: keys.schedule(from), queryFn: () => call('meta.schedule', { from, to }), staleTime: 10 * 60_000 });

export const useGenres = () => useQuery({ queryKey: keys.genres, queryFn: () => call('meta.genres'), staleTime: Infinity });

export const useBrowse = (q: BrowseQuery) =>
  useInfiniteQuery({
    queryKey: keys.browse(q),
    queryFn: ({ pageParam }) => call('meta.browse', { ...q, page: pageParam, perPage: 30 }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasNext ? last.page + 1 : undefined),
    staleTime: 5 * 60_000,
  });

export const useSources = () => useQuery({ queryKey: keys.sources, queryFn: () => call('sources.list'), staleTime: Infinity });

export const useSessionInfo = (id: string) => useQuery({ queryKey: keys.session(id), queryFn: () => call('sources.session', { id }), staleTime: 15_000 });

export const useMatch = (sourceId: string | null, media: MediaRef | null) =>
  useQuery({
    queryKey: keys.match(sourceId ?? '', media?.id ?? 0, media?.titles[0] ?? ''),
    queryFn: () => call('sources.match', { sourceId: sourceId!, media: media! }),
    enabled: !!sourceId && !!media,
    staleTime: 10 * 60_000,
    retry: false,
  });

export const useStreams = (sourceId: string | null, ref: string | null) =>
  useQuery({
    queryKey: keys.streams(sourceId ?? '', ref ?? ''),
    queryFn: () => call('sources.streams', { sourceId: sourceId!, ref: ref! }),
    enabled: !!sourceId && ref !== null,
    staleTime: 10 * 60_000,
    retry: false,
  });

export const useLibraryState = (mediaId: number) =>
  useQuery({ queryKey: keys.libraryState(mediaId), queryFn: () => call('library.state', { mediaId }), enabled: mediaId > 0 });

export const useContinue = () => useQuery({ queryKey: keys.continue, queryFn: () => call('library.continue') });
export const useHistory = () => useQuery({ queryKey: keys.history, queryFn: () => call('library.history', { limit: 200, offset: 0 }) });
export const useFavourites = () => useQuery({ queryKey: keys.favourites, queryFn: () => call('library.favourites') });
export const useEntries = (status: ListStatus | null) => useQuery({ queryKey: keys.entries(status), queryFn: () => call('library.entries', { status }) });
export const useAccounts = () => useQuery({ queryKey: keys.accounts, queryFn: () => call('accounts.list') });
export const useAdblockStats = () => useQuery({ queryKey: keys.adblock, queryFn: () => call('adblock.stats') });
export const useAppInfo = () => useQuery({ queryKey: keys.info, queryFn: () => call('app.info'), staleTime: Infinity });
/** Self-update state; kept current by `update.status` events (useBridgeEvents). */
export const useUpdateState = () => useQuery({ queryKey: keys.update, queryFn: () => call('update.state'), staleTime: Infinity });

export const useComments = (q: CommentsQuery | null) =>
  useQuery({
    queryKey: q ? keys.comments(q) : ['comments', 'none'],
    queryFn: () => call('comments.list', q!),
    enabled: !!q,
    staleTime: 60_000,
  });

export function useSettings(): Settings {
  const { data } = useQuery({ queryKey: keys.settings, queryFn: () => call('settings.get'), staleTime: Infinity });
  return data ?? DEFAULT_SETTINGS_FALLBACK;
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: DeepPartial<Settings>) => call('settings.set', patch),
    onSuccess: (next) => {
      qc.setQueryData(keys.settings, next);
      void qc.invalidateQueries({ queryKey: keys.accounts });
      void qc.invalidateQueries({ queryKey: keys.home });
    },
  });
}

export function useUpdateSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; patch: SourceOverridePatch }) => call('sources.update', v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.sources });
      void qc.invalidateQueries({ queryKey: ['match'] });
    },
  });
}

function invalidateLibrary(qc: QueryClient, mediaId?: number) {
  void qc.invalidateQueries({ queryKey: ['library'] });
  if (mediaId) void qc.invalidateQueries({ queryKey: keys.libraryState(mediaId) });
}

export function useToggleFavourite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (media: MediaSnapshot) => call('library.toggleFavourite', { media }),
    onSuccess: (_r, media) => invalidateLibrary(qc, media.id),
  });
}

export function useSetStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { media: MediaSnapshot; status: ListStatus | null }) => call('library.setStatus', v),
    onSuccess: (_r, v) => invalidateLibrary(qc, v.media.id),
  });
}

export function useSetScore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { media: MediaSnapshot; score: number | null }) => call('library.setScore', v),
    onSuccess: (_r, v) => invalidateLibrary(qc, v.media.id),
  });
}

export function useDismissContinue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mediaId: number) => call('library.dismissContinue', { mediaId }),
    onSuccess: () => invalidateLibrary(qc),
  });
}

export function useMarkWatched() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { media: MediaSnapshot; episode: number; watched: boolean }) => call('library.markWatched', v),
    onSuccess: (_r, v) => invalidateLibrary(qc, v.media.id),
  });
}

export function useSaveProgress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: ProgressSave) => call('library.saveProgress', v),
    onSuccess: (r, v) => {
      if (r.completedNow) invalidateLibrary(qc, v.media.id);
    },
  });
}

/** Keeps the query cache in sync with events pushed from the main process. */
export function useBridgeEvents(qc: QueryClient) {
  useEffect(() => {
    const offs = [
      onEvent('sources.changed', (list) => {
        qc.setQueryData(keys.sources, list);
        void qc.invalidateQueries({ queryKey: ['match'] });
      }),
      onEvent('adblock.stats', (stats) => qc.setQueryData(keys.adblock, stats)),
      onEvent('update.status', (state) => qc.setQueryData(keys.update, state)),
      onEvent('sync.status', (e) => {
        if (e.state !== 'syncing') {
          void qc.invalidateQueries({ queryKey: keys.accounts });
          void qc.invalidateQueries({ queryKey: ['library'] });
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [qc]);
}
