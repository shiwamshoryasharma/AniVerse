import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { UiRenderingMode, UiRenderingState } from '../app/shared/graphics';

/** Device-local startup preference: composition changes must precede GPU initialization. */
export class UiRenderingPreferences {
  private preferred: UiRenderingMode;
  private readonly active: UiRenderingMode;
  constructor(private file: string, platform: string, forceStable = false) {
    this.preferred = platform === 'win32' ? 'stable' : 'accelerated';
    try {
      const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const mode = saved && typeof saved === 'object' && 'mode' in saved ? saved.mode : null;
      if (mode === 'stable' || mode === 'accelerated') this.preferred = mode;
    } catch { /* Missing/corrupt local preference uses the platform default. */ }
    this.active = forceStable ? 'stable' : this.preferred;
  }
  snapshot(): UiRenderingState {
    return { active: this.active, preferred: this.preferred, restartRequired: this.active !== this.preferred };
  }
  set(mode: UiRenderingMode): UiRenderingState {
    if (mode !== 'stable' && mode !== 'accelerated') throw new Error('Invalid UI rendering mode.');
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    writeFileSync(temporary, JSON.stringify({ mode })+'\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.file);
    this.preferred = mode;
    return this.snapshot();
  }
}
