import { useSyncExternalStore } from 'react';

const key = 'aniverse.desktop-theme';
const listeners = new Set<() => void>();
let midnight = localStorage.getItem(key) === 'midnight';

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useMidnightTheme() {
  return useSyncExternalStore(subscribe, () => midnight);
}

export function setMidnightTheme(enabled: boolean) {
  localStorage.setItem(key, enabled ? 'midnight' : 'standard');
  midnight = enabled;
  for (const listener of listeners) listener();
}
