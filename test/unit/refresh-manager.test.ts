import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusManager, QueryClient, QueryObserver } from '@tanstack/react-query';
import { homeQueryOptions, latestQueryOptions } from '../../frontend/src/lib/queries';
import { refreshSourcesOnFocus, refreshVisibleQueries, retryQuery } from '../../frontend/src/lib/refreshManager';

const transport = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../frontend/src/lib/bridge', () => ({
  isAniVerse2: true,
  call: (method: string) => { transport.calls.push(method); return Promise.resolve({ items: [] }); },
}));

afterEach(() => { focusManager.setFocused(undefined); transport.calls.length = 0; vi.unstubAllGlobals(); });

describe('Tauri query manager and healer', () => {
  it('gates initial Home and latest requests on the actual settings result', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const home = new QueryObserver(client, homeQueryOptions(false));
    const latest = new QueryObserver(client, latestQueryOptions(1, true, false));
    const stops = [home.subscribe(() => {}), latest.subscribe(() => {})];
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(transport.calls).toEqual([]);
    home.setOptions(homeQueryOptions(true)); latest.setOptions(latestQueryOptions(1, true, true));
    await vi.waitFor(() => expect(transport.calls).toEqual(['meta.home', 'meta.latest']));
    stops.forEach(stop => stop()); client.clear();
  });

  it('keeps slow focus jobs single-flight, throttles focus noise, and recovers after the cooldown', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['settings'], {}); client.setQueryData(['sources'], []);
    let resolve: () => void = () => {};
    let calls = 0;
    const observer = new QueryObserver(client, { queryKey: ['sources'], staleTime: Infinity,
      queryFn: () => { calls++; return new Promise(done => { resolve = () => done([]); }); } });
    const stop = observer.subscribe(() => {});
    await refreshSourcesOnFocus(client, false, 0);
    expect(calls).toBe(0);
    const first = refreshSourcesOnFocus(client, true, 0);
    const second = refreshSourcesOnFocus(client, true, 10);
    expect(second).toBe(first); expect(calls).toBe(1);
    const joined = refreshSourcesOnFocus(client, true, 31_000);
    expect(joined).toBe(first);
    expect(calls).toBe(1);
    resolve(); await Promise.all([first, joined]);
    await refreshSourcesOnFocus(client, true, 32_000);
    expect(calls).toBe(1);
    const recovered = refreshSourcesOnFocus(client, true, 62_000);
    expect(calls).toBe(2);
    resolve(); await recovered;
    stop(); client.clear();
  });

  it('joins a manual refresh to slow active work without cancelling its unabortable request', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['settings'], {}); client.setQueryData(['home'], {});
    let resolve: () => void = () => {}; let calls = 0;
    const observer = new QueryObserver(client, { queryKey: ['home'], staleTime: Infinity,
      queryFn: () => { calls++; return new Promise(done => { resolve = () => done({}); }); } });
    const stop = observer.subscribe(() => {});
    const first = refreshVisibleQueries(client, true);
    const second = refreshVisibleQueries(client, true);
    expect(second).toBe(first); expect(calls).toBe(1);
    resolve(); await first;
    stop(); client.clear();
  });

  it('limits healing to one retry and leaves permanent errors and rate limits visible', () => {
    expect(retryQuery(0, { code: 'network' })).toBe(true);
    expect(retryQuery(1, { code: 'network' })).toBe(false);
    for (const code of ['rate-limited', 'invalid-input', 'not-found', 'cancelled', 'config', 'auth', 'unknown']) {
      expect(retryQuery(0, { code })).toBe(false);
    }
    expect(latestQueryOptions(1, true, true).refetchIntervalInBackground).toBe(false);
    expect(latestQueryOptions(1, true, true).refetchOnWindowFocus).toBe(false);
  });
});