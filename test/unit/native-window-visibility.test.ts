import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';

const script = readFileSync(new URL('../../native/aniverse2/src/desktop-bridge.js', import.meta.url), 'utf8');
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let n = 0; n < 15; n++) await Promise.resolve(); };
function nativeWindow() {
  const resize: Array<() => void> = [], focus: Array<() => void> = [];
  let minimized = true, active = 0, peak = 0, reads = 0, unlistens = 0;
  const waiting: ReturnType<typeof deferred<boolean>>[] = [];
  let delayed = false;
  const native = {
    onResized: async (listener: () => void) => { resize.push(listener); return () => { unlistens++; }; },
    onFocusChanged: async (listener: () => void) => { focus.push(listener); return () => { unlistens++; }; },
    isMinimized: async () => {
      reads++; active++; peak = Math.max(peak, active);
      try {
        if (!delayed) return minimized;
        const value = deferred<boolean>(); waiting.push(value); return await value.promise;
      } finally { active--; }
    },
  };
  const window = { top: null as unknown, __TAURI__: { window: { getCurrentWindow: () => native } } };
  window.top = window;
  vm.runInNewContext(script, { window, location: { origin: 'https://tauri.localhost' }, console });
  return {
    bridge: (window as unknown as { aniverse: { onWindowMinimized: (listener: (value: boolean) => void) => () => void } }).aniverse,
    resize, focus, waiting,
    delay() { delayed = true; },
    state(value: boolean) { minimized = value; },
    stats() { return { active, peak, reads, unlistens }; },
  };
}

it('reports an already minimized native window before any resize or DOM focus event', async () => {
  const host = nativeWindow(), states: boolean[] = [];
  expect(typeof host.bridge.onWindowMinimized).toBe('function');
  const stop = host.bridge.onWindowMinimized(value => states.push(value));
  await flush();
  expect(states).toEqual([true]);
  host.state(false); host.resize[0](); await flush();
  expect(states).toEqual([true, false]);
  stop();
  expect(host.stats().unlistens).toBe(2);
});

it('coalesces native event bursts and discards snapshots overtaken by a newer state', async () => {
  const host = nativeWindow(), states: boolean[] = [];
  host.delay();
  const stop = host.bridge.onWindowMinimized(value => states.push(value));
  await flush();
  expect(host.stats().reads).toBe(1);
  for (let n = 0; n < 100; n++) host.resize[0]();
  host.waiting[0].resolve(false); await flush();
  expect(states).toEqual([]);
  expect(host.stats().reads).toBe(2);
  host.waiting[1].resolve(true); await flush();
  expect(states).toEqual([true]);
  expect(host.stats().peak).toBe(1);
  stop();
  host.resize[0](); host.focus[0](); await flush();
  expect(host.stats().reads).toBe(2);
});

it('unsubscribes registrations that resolve after cleanup and ignores a pending snapshot', async () => {
  const registration = deferred<() => void>(), snapshot = deferred<boolean>();
  let unlistens = 0;
  const window = { top: null as unknown, __TAURI__: { window: { getCurrentWindow: () => ({
    onResized: () => registration.promise,
    onFocusChanged: async () => () => { unlistens++; },
    isMinimized: () => snapshot.promise,
  }) } } };
  window.top = window;
  vm.runInNewContext(script, { window, location: { origin: 'https://tauri.localhost' }, console });
  const states: boolean[] = [];
  const bridge = (window as unknown as { aniverse: { onWindowMinimized: (listener: (value: boolean) => void) => () => void } }).aniverse;
  const stop = bridge.onWindowMinimized(value => states.push(value));
  stop();
  registration.resolve(() => { unlistens++; }); snapshot.resolve(false); await flush();
  expect(states).toEqual([]);
  expect(unlistens).toBe(2);
});