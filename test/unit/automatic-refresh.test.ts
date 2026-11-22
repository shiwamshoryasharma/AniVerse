import { afterEach, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  calls: [] as string[],
  pending: null as null | (() => Promise<unknown>),
}));
vi.mock('../../frontend/src/lib/bridge', () => ({
  isAniVerse2: true,
  call: (method: string) => {
    transport.calls.push(method);
    return transport.pending ? transport.pending() : Promise.resolve({ items: [] });
  },
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).reverse().forEach(stop => stop());
  transport.calls.length = 0; transport.pending = null;
  vi.useRealTimers(); vi.unstubAllGlobals();
});
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };

async function setup() {
  const window = new EventTarget();
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', { hidden: false, visibilityState: 'visible' });
  const { QueryClient, QueryObserver } = await import('@tanstack/react-query');
  const manager = await import('../../frontend/src/lib/automaticRefresh');
  const { latestQueryOptions } = await import('../../frontend/src/lib/queries');
  vi.useFakeTimers();
  const client = new QueryClient({ defaultOptions: { queries: {
    retry: false, gcTime: Infinity, refetchOnWindowFocus: false,
  } } });
  client.mount(); client.setQueryData(['settings'], {});
  cleanups.push(() => { client.unmount(); client.clear(); });
  let native = (_minimized: boolean) => {};
  const unlisten = vi.fn();
  const stop = manager.initializeDesktopRefresh(client, listener => { native = listener; return unlisten; });
  cleanups.push(stop);
  const options = () => latestQueryOptions(1, true, manager.automaticQueriesVisible(client));
  const observer = new QueryObserver(client, options());
  const off = observer.subscribe(() => {});
  const offVisibility = manager.subscribeAutomaticVisibility(client, () => observer.setOptions(options()));
  cleanups.push(offVisibility, off);
  return { client, observer, native: (value: boolean) => native(value), stop, unlisten, manager, window };
}

it('starts no automatic RPC before the native snapshot or during already-minimized startup', async () => {
  const context = await setup();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(transport.calls).toEqual([]);
  context.native(true);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(document.hidden).toBe(false); // Reproduces WebView2 native-minimize / DOM-visibility mismatch.
  expect(transport.calls).toEqual([]);
  context.window.dispatchEvent(new Event('focus'));
  expect(transport.calls).toEqual([]);
  context.native(false); await flush();
  expect(transport.calls).toEqual(['meta.latest']);
  for (let n = 0; n < 20; n++) {
    context.native(false); context.window.dispatchEvent(new Event('focus'));
  }
  await flush();
  expect(transport.calls).toEqual(['meta.latest']);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(transport.calls).toEqual(['meta.latest', 'meta.latest']);
});

it('keeps an admitted RPC alive while minimized and resumes one stale job on repeated restore/focus', async () => {
  let complete!: (value: unknown) => void;
  transport.pending = () => new Promise(resolve => { complete = resolve; });
  const context = await setup();
  context.native(false); await flush();
  expect(transport.calls).toHaveLength(1);
  context.native(true);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(transport.calls).toHaveLength(1);
  complete({ items: ['preserved'] }); await flush();
  expect(context.client.getQueryData(['latest', 1])).toEqual({ items: ['preserved'] });
  await vi.advanceTimersByTimeAsync(61_000);
  context.native(false); await flush();
  expect(transport.calls).toHaveLength(2);
  for (let n = 0; n < 20; n++) {
    context.native(false); context.window.dispatchEvent(new Event('focus'));
  }
  await flush();
  expect(transport.calls).toHaveLength(2);
  complete({ items: ['restored'] }); await flush();
  expect(context.client.getQueryData(['latest', 1])).toEqual({ items: ['restored'] });
});

it('cleans up native listeners and timers, ignores late snapshots, and supports a new binding', async () => {
  const context = await setup();
  context.native(false); await flush();
  expect(transport.calls).toHaveLength(1);
  context.stop();
  expect(context.unlisten).toHaveBeenCalledOnce();
  context.native(false); context.window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(transport.calls).toHaveLength(1);
  expect(context.manager.automaticQueriesVisible(context.client)).toBe(false);
  let receive = (_value: boolean) => {};
  const stop = context.manager.initializeDesktopRefresh(context.client, listener => {
    receive = listener; return () => {};
  });
  cleanups.push(stop);
  context.stop(); context.native(true); // Old cleanup/callback must not damage the replacement.
  receive(false); await flush();
  expect(context.manager.automaticQueriesVisible(context.client)).toBe(true);
  expect(transport.calls).toHaveLength(2);
});
it('does not cancel a user download mutation admitted before native minimize', async () => {
  const context = await setup();
  context.native(false); await flush();
  const { MutationObserver } = await import('@tanstack/react-query');
  let complete!: (result: { saved: boolean }) => void;
  const download = new MutationObserver(context.client, {
    mutationFn: () => new Promise<{ saved: boolean }>(resolve => { complete = resolve; }),
  });
  const result = download.mutate();
  await flush();
  expect(download.getCurrentResult().status).toBe('pending');
  context.native(true);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(download.getCurrentResult().status).toBe('pending');
  complete({ saved: true });
  await expect(result).resolves.toEqual({ saved: true });
  expect(download.getCurrentResult().status).toBe('success');
  expect(context.manager.automaticQueriesVisible(context.client)).toBe(false);
});