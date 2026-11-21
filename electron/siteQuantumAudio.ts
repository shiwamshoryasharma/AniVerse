import type { WebContents } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ownedPlayerTarget, type PlayerTarget } from './ownedPlayerFrame';

declare const __ANIVERSE_QUANTUM_GUEST_SCRIPT__: string;

type SiteQuantumState = 'off' | 'waiting' | 'unavailable' | 'active';
interface SiteQuantumStatus { state: SiteQuantumState }
interface SiteQuantumInput { action: 'enable' | 'off' | 'level' | 'status'; intensity?: number }

const OFF: SiteQuantumStatus = {state:'off'};
const WAITING: SiteQuantumStatus = {state:'waiting'};
const UNAVAILABLE: SiteQuantumStatus = {state:'unavailable'};

function stateOf(result: unknown): SiteQuantumStatus {
  if (typeof result !== 'object' || result === null || !('state' in result)) return OFF;
  if (result.state === 'active' || result.state === 'waiting' || result.state === 'unavailable') return {state:result.state};
  return OFF;
}

export class SiteQuantumAudio {
  private bindings = new WeakMap<WebContents,PlayerTarget>();
  private operations = new WeakMap<WebContents,Promise<SiteQuantumStatus>>();
  private assets: Promise<string> | null = null;

  constructor(private renderer: string) {}

  private guestAssets() {
    this.assets ??= Promise.all([
      readFile(path.join(this.renderer,'quantum-worklet.js'),'utf8'),
      readFile(path.join(this.renderer,'quantum-audio.wasm')),
    ]).then(([worklet,wasm]) => 'globalThis.__avQuantum ??= ' + __ANIVERSE_QUANTUM_GUEST_SCRIPT__ +
      '(' + JSON.stringify(worklet) + ',' + JSON.stringify(wasm.toString('base64')) + ')');
    return this.assets;
  }

  request(guest: WebContents, input: SiteQuantumInput): Promise<SiteQuantumStatus> {
    const earlier = this.operations.get(guest) ?? Promise.resolve(OFF);
    const work = earlier.catch(() => OFF).then(() => this.perform(guest,input)).catch(() => UNAVAILABLE);
    this.operations.set(guest,work);
    return work;
  }

  async stop(guest: WebContents): Promise<void> {
    await this.request(guest,{action:'off'});
  }

  private async perform(guest: WebContents, {action,intensity}: SiteQuantumInput): Promise<SiteQuantumStatus> {
    const previous = this.bindings.get(guest);
    if (guest.isDestroyed()) {
      this.bindings.delete(guest);
      return OFF;
    }
    if (action === 'off') {
      this.bindings.delete(guest);
      if (previous) await previous.cleanup('globalThis.__avQuantum?.("off")');
      return OFF;
    }
    const resolved = previous ?? (action === 'enable' ? await ownedPlayerTarget(guest) : null);
    if (!resolved) return action === 'enable' ? WAITING : OFF;
    const argument = JSON.stringify(action) + ',' + (intensity ?? 0);
    const call = action === 'enable'
      ? '(' + await this.guestAssets() + ')(' + argument + ')'
      : 'globalThis.__avQuantum?.(' + argument + ')';
    const raw = await resolved.evaluate(call,action === 'enable');
    if (raw === null && action === 'enable') return WAITING;
    const result = stateOf(raw);
    if (result.state === 'active') this.bindings.set(guest,resolved);
    else if (previous) {
      this.bindings.delete(guest);
      await previous.cleanup('globalThis.__avQuantum?.("off")');
    }
    return result;
  }
}
