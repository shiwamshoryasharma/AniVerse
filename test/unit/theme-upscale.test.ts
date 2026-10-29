import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ ipcMain: { handle() {} } }));
import { schemas } from '../../electron/ipc';
import { Store } from '../../app/core/db/store';
import { SettingsService } from '../../app/core/settings';
import { themePresetSchema } from '../../app/shared/theme';
import { DEFAULT_UPSCALE, upscaleSize } from '../../app/shared/upscale';

describe('1.5.2 appearance and Anime4K settings', () => {
  it('does not insert defaults into a partial IPC upscale update', () => {
    const patch = { player: { upscale: { mode: 'B' } } };
    expect(schemas['settings.set'].parse(patch)).toEqual(patch);
  });
  it('retains the original appearance when opening an older profile', () => {
    const store = new Store(':memory:');
    store.setKv('settings', { appearance: { accent: 'aqua' }, player: { volume: 0.4 } });
    const settings = new SettingsService(store);
    expect(settings.get().appearance).toMatchObject({ style: 'classic', accent: 'aqua' });
    expect(settings.get().player.upscale).toEqual(DEFAULT_UPSCALE);
    settings.update({ appearance: { style: 'paper' }, player: { upscale: { enabled: true, mode: 'B', darken: true } } });
    const reopened = new SettingsService(store).get();
    expect(reopened.appearance.style).toBe('paper');
    expect(reopened.player.upscale).toMatchObject({ enabled: true, mode: 'B', darken: true });
    store.close();
  });
  it('accepts old portable themes and retains the new style on a round trip', () => {
    const old = { version: 1, name: 'Older theme', appearance: { accent: 'ember', density: 'compact', fontFamily: 'inter', reduceMotion: false }, player: { theater: false, preferredQuality: 'auto' } };
    expect(themePresetSchema.parse(old).appearance.style).toBe('classic');
    expect(themePresetSchema.parse({ ...old, appearance: { ...old.appearance, style: 'aurora' } }).appearance.style).toBe('aurora');
    expect(themePresetSchema.safeParse({ ...old, appearance: { ...old.appearance, style: 'unknown' } }).success).toBe(false);
  });
  it('fits 4K output without stretching or exceeding GPU texture limits', () => {
    expect(upscaleSize(1920, 1080, 8192)).toEqual({ width: 3840, height: 2160 });
    expect(upscaleSize(1440, 1080, 8192)).toEqual({ width: 2880, height: 2160 });
    expect(upscaleSize(1920, 1080, 2048)).toEqual({ width: 2048, height: 1152 });
    expect(upscaleSize(0, 1080, 8192)).toBeNull();
  });
});
