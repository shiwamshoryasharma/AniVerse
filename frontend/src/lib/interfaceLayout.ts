import { useSyncExternalStore } from 'react';
import { interfaceStyle } from '../../../app/shared/interface';
import { isAniVerse2 } from './bridge';

export const ANIVERSE2_LAYOUTS = [
  { id: 'dock', layout: 'dock', name: 'Dock', label: 'Streaming dashboard', description: 'Bottom navigation, a centred spotlight and a horizontal shelf of episodes.' },
  { id: 'atlas', layout: 'atlas', name: 'Atlas', label: 'Catalogue and episode inspector', description: 'Right-hand navigation, compact discovery and episodes to the left of playback.' },
] as const;
export type AniVerse2Layout = typeof ANIVERSE2_LAYOUTS[number]['id'];

const key = 'aniverse2.layout';
const listeners = new Set<() => void>();

function loadLayout(): AniVerse2Layout | null {
  if (!isAniVerse2) return null;
  try {
    const saved = localStorage.getItem(key);
    return saved === 'dock' || saved === 'atlas' ? saved : null;
  } catch { return null; }
}

let selected = loadLayout();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAniVerse2Layout() {
  return useSyncExternalStore(subscribe, () => selected);
}

export function useInterfaceLayout(style: string) {
  return useAniVerse2Layout() ?? interfaceStyle(style).layout;
}

export function setAniVerse2Layout(layout: AniVerse2Layout | null) {
  if (!isAniVerse2 || layout === selected) return;
  if (layout) localStorage.setItem(key, layout);
  else localStorage.removeItem(key);
  selected = layout;
  for (const listener of listeners) listener();
}
