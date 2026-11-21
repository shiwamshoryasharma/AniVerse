import { useSyncExternalStore } from 'react';
import { isAniVerse2 } from './bridge';

export const displayScales = ['auto', '85', '100', '115', '125'] as const;
export type DisplayScale = typeof displayScales[number];

const key = 'aniverse2.display-scale';
let selected: DisplayScale = 'auto';
const listeners = new Set<() => void>();

if (isAniVerse2) {
  const saved = localStorage.getItem(key);
  selected = displayScales.find(scale => scale === saved) ?? 'auto';
  document.documentElement.dataset.displayScale = selected;
}

export function useDisplayScale() {
  return useSyncExternalStore(subscribe, () => selected);
}

export function setDisplayScale(scale: DisplayScale) {
  if (!isAniVerse2 || !displayScales.includes(scale)) return;
  localStorage.setItem(key, scale);
  selected = scale;
  document.documentElement.dataset.displayScale = scale;
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}