import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

const view = vi.hoisted(() => ({ client: null as unknown as QueryClient, ready: true, spin: false, fetching: 0 }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: () => [view.spin, (value: boolean) => { view.spin = value; }],
}));
vi.mock('@tanstack/react-query', async original => ({
  ...await original<typeof import('@tanstack/react-query')>(),
  useQueryClient: () => view.client,
  useIsFetching: () => view.fetching,
}));
vi.mock('../../frontend/src/lib/queries', () => ({ useSettingsReady: () => view.ready }));
vi.mock('../../frontend/src/lib/bridge', () => ({ isAniVerse2: true }));
const componentPath = '../../frontend/src/components/RefreshButton';

describe('manual desktop refresh lifecycle', () => {
  let unsubscribe: () => void;
  let complete: (() => void)[];
  let calls: number;

  beforeEach(() => {
    view.client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    view.ready = true; view.spin = false; view.fetching = 0; calls = 0; complete = [];
    view.client.setQueryData(['settings'], {});
    view.client.setQueryData(['home'], { items: [] });
    const observer = new QueryObserver(view.client, {
      queryKey: ['home'], staleTime: Infinity,
      queryFn: () => { calls++; return new Promise(resolve => complete.push(() => resolve({ items: [] }))); },
    });
    unsubscribe = observer.subscribe(() => {});
    vi.stubGlobal('document', { visibilityState: 'visible', hidden: false });
  });
  afterEach(async () => {
    complete.forEach(resolve => resolve());
    await Promise.resolve();
    unsubscribe(); view.client.clear(); vi.unstubAllGlobals();
  });

  it('does not start refresh work before settings initialization succeeds', async () => {
    view.ready = false; view.client.removeQueries({ queryKey: ['settings'] });
    const { RefreshButton } = await import(componentPath);
    RefreshButton().props.onClick();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toBe(0);
  });

  it('joins repeated clicks instead of restarting unabortable bridge requests', async () => {
    const { RefreshButton } = await import(componentPath);
    const button = RefreshButton();
    button.props.onClick();
    button.props.onClick();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toBe(1);
  });

  it('keeps ordinary background fetching separate from manual refresh feedback', async () => {
    view.fetching = 1;
    const { RefreshButton } = await import(componentPath);
    const button = RefreshButton();
    expect(button.props.children.props.className).toBeUndefined();
    expect(view.spin).toBe(false);
  });
});