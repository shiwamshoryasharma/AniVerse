import { focusManager, type QueryClient } from '@tanstack/react-query';
import { refreshSourcesOnFocus } from './refreshManager';

type ObserveMinimized = (listener: (minimized: boolean) => void) => () => void;
type VisibilityState = { visible: boolean; listeners: Set<() => void>; stop?: () => void };
const states = new WeakMap<QueryClient, VisibilityState>();

export function automaticQueriesVisible(client: QueryClient) {
  return states.get(client)?.visible ?? false;
}
export function subscribeAutomaticVisibility(client: QueryClient, listener: () => void) {
  const state = states.get(client);
  if (!state) return () => {};
  state.listeners.add(listener);
  return () => { state.listeners.delete(listener); };
}

/** Native minimize state controls automatic queries; pending IPC and explicit user jobs are not cancelled. */
export function initializeDesktopRefresh(
  client: QueryClient,
  observe: ObserveMinimized = listener => window.aniverse!.onWindowMinimized!(listener),
): () => void {
  const state = states.get(client) ?? { visible: false, listeners: new Set<() => void>() };
  state.stop?.();
  states.set(client, state);
  let active = true, synced = false, minimized = true;
  const publish = (visible: boolean) => {
    const previous = state.visible;
    state.visible = visible;
    focusManager.setFocused(visible);
    if (previous !== visible) state.listeners.forEach(listener => listener());
    return previous;
  };
  publish(false);
  const update = () => {
    if (!active) return;
    const visible = synced && !minimized && !document.hidden;
    const previous = publish(visible);
    if (visible && !previous) void refreshSourcesOnFocus(client, true);
  };
  const refresh = () => {
    if (active) void refreshSourcesOnFocus(client, state.visible);
  };
  window.addEventListener('visibilitychange', update);
  window.addEventListener('focus', refresh);
  const unlisten = observe(value => {
    if (!active) return;
    synced = true; minimized = value; update();
  });
  const stop = () => {
    if (!active) return;
    active = false;
    unlisten();
    window.removeEventListener('visibilitychange', update);
    window.removeEventListener('focus', refresh);
    window.removeEventListener('pagehide', stop);
    publish(false);
    focusManager.setFocused(undefined);
  };
  state.stop = stop;
  window.addEventListener('pagehide', stop, { once: true });
  return stop;
}