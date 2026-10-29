import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { EVENT_CHANNEL, RPC_CHANNEL, type AniverseBridge, type EventName, type RpcError } from '../app/shared/rpc';

// Every event in the contract must be listed (a missing one is a type error, not a runtime crash).
const EVENT_NAMES: Record<EventName, true> = {
  'sources.changed': true,
  'cloudflare.status': true,
  'sync.status': true,
  'adblock.stats': true,
  'app.notice': true,
  'site.status': true,
  'cast.status': true,
  'player.captureEnded': true,
  'update.status': true,
};
const EVENTS: ReadonlySet<string> = new Set(Object.keys(EVENT_NAMES));

class BridgeError extends Error {
  constructor(public code: RpcError['code'], message: string) {
    super(message);
    this.name = 'BridgeError';
  }
}

const listeners = new Map<string, Set<(payload: unknown) => void>>();
ipcRenderer.on(EVENT_CHANNEL, (_e: IpcRendererEvent, event: string, payload: unknown) => {
  for (const fn of listeners.get(event) ?? []) fn(payload);
});

const bridge: AniverseBridge = {
  platform: process.platform,
  async invoke(method, input) {
    const res = (await ipcRenderer.invoke(RPC_CHANNEL, method, input)) as { ok: true; data: never } | { ok: false; error: RpcError };
    if (!res.ok) throw new BridgeError(res.error.code, res.error.message);
    return res.data;
  },
  on(event, listener) {
    if (!EVENTS.has(event)) throw new Error(`Unknown event ${event}`);
    const set = listeners.get(event) ?? new Set();
    set.add(listener as (payload: unknown) => void);
    listeners.set(event, set);
    return () => set.delete(listener as (payload: unknown) => void);
  },
};

contextBridge.exposeInMainWorld('aniverse', bridge);
