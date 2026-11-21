import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { App } from 'electron';

import type { DesktopGpuPreference, DesktopGpuState } from '../app/shared/graphics';

const HIGH = 'force_high_performance_gpu';
const LOW = 'force_low_power_gpu';

function preferenceOf(value: unknown): DesktopGpuPreference | null {
  switch (value) {
    case 'system': case 'high-performance': case 'power-saving': return value;
    default: return null;
  }
}

export class DesktopGpuPreferences {
  private preferred: DesktopGpuPreference;
  private readonly applied: DesktopGpuPreference;
  private readonly supported: boolean;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private file: string, platform: string, switches: App['commandLine']) {
    this.supported = platform === 'win32' && !switches.hasSwitch('disable-gpu');
    this.preferred = 'high-performance'; // Existing Electron Windows default.
    try {
      const text = readFileSync(file,'utf8');
      if (text.length <= 1024) {
        const value = preferenceOf(JSON.parse(text)?.preference);
        if (value) this.preferred = value;
      }
    } catch { /* Existing installations may have no device preference file. */ }
    const inherited = switches.hasSwitch(LOW) ? 'power-saving'
      : switches.hasSwitch(HIGH) ? 'high-performance'
      : preferenceOf(process.env.ANIVERSE_GPU_PREFERENCE);
    this.applied = this.supported ? inherited ?? this.preferred : 'system';
    if (!inherited && this.applied !== 'system') switches.appendSwitch(this.applied === 'power-saving' ? LOW : HIGH);
    if (inherited && !switches.hasSwitch(LOW) && !switches.hasSwitch(HIGH) && this.applied !== 'system') {
      switches.appendSwitch(this.applied === 'power-saving' ? LOW : HIGH);
    }
  }

  snapshot(): DesktopGpuState {
    return { applied:this.applied,preferred:this.preferred,supported:this.supported,
      restartRequired:this.supported && this.applied !== this.preferred };
  }

  set(preference: DesktopGpuPreference): Promise<DesktopGpuState> {
    if (!preferenceOf(preference) || !this.supported) return Promise.reject(new Error('Choose a supported Windows GPU preference.'));
    const work = this.writing.catch(() => undefined).then(() => this.persist(preference));
    this.writing = work;
    return work;
  }

  private async persist(preference: DesktopGpuPreference): Promise<DesktopGpuState> {
    await mkdir(path.dirname(this.file),{recursive:true});
    const temp = this.file + '.' + randomUUID() + '.tmp';
    try {
      const handle = await open(temp,'wx',0o600);
      try {
        await handle.writeFile(JSON.stringify({preference})+'\n','utf8');
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temp,this.file);
      this.preferred = preference;
      return this.snapshot();
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
}
