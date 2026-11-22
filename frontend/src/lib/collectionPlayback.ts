import { useQuery } from '@tanstack/react-query';
import { useEffect, useId } from 'react';
import { call, isAniVerse2 } from './bridge';

function release(url: string) {
  return window.aniverse?.releasePlayerFile?.(url).catch(() => undefined);
}

export function useCollectionPlayback(id: number | null) {
  const view = useId();
  const file = useQuery({
    queryKey: isAniVerse2 ? ['local-open', id, view] : ['local-open', id],
    enabled: id !== null,
    retry: false,
    staleTime: isAniVerse2 ? 0 : Infinity,
    gcTime: isAniVerse2 ? 0 : undefined,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      const opened = await call('collection.open', { id: id! });
      if (isAniVerse2 && signal.aborted) {
        void release(opened.url);
        signal.throwIfAborted();
      }
      return opened;
    },
  });
  const url = isAniVerse2 ? file.data?.url : undefined;
  useEffect(() => {
    if (url) return () => { void release(url); };
  }, [url]);
  return file;
}
