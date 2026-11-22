import { afterEach, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../frontend/src/lib/bridge', () => ({
  isAniVerse2: true,
  call: (method: string) => { transport.calls.push(method); return Promise.resolve({ items: [] }); },
}));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('starts no latest job before settings readiness, pauses hidden polling, and resumes one stale job on focus', async () => {
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', { hidden: false, visibilityState: 'visible' });
  const { QueryClient, QueryObserver, focusManager, isServer } = await import('@tanstack/react-query');
  const { latestQueryOptions } = await import('../../frontend/src/lib/queries');
  const { refreshSourcesOnFocus } = await import('../../frontend/src/lib/refreshManager');
  expect(isServer).toBe(false);
  vi.useFakeTimers();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const observer = new QueryObserver(client, latestQueryOptions(1, true, false));
  const stop = observer.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(transport.calls).toEqual([]);
  client.setQueryData(['settings'], {});
  observer.setOptions(latestQueryOptions(1, true, true));
  await vi.advanceTimersByTimeAsync(0);
  expect(transport.calls).toEqual(['meta.latest']);
  focusManager.setFocused(false);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(transport.calls).toEqual(['meta.latest']);
  focusManager.setFocused(true);
  await refreshSourcesOnFocus(client, true);
  await vi.advanceTimersByTimeAsync(0);
  expect(transport.calls).toEqual(['meta.latest', 'meta.latest']);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(transport.calls).toEqual(['meta.latest', 'meta.latest', 'meta.latest']);
  stop(); client.clear(); focusManager.setFocused(undefined);
});