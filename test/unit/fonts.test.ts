import { describe, expect, it } from 'vitest';
import { Store } from '../../app/core/db/store';
import { DEFAULT_SETTINGS, SettingsService, sanitize } from '../../app/core/settings';
import type { Settings } from '../../app/shared/types';
import { DEFAULT_SETTINGS_FALLBACK } from '../../frontend/src/lib/settingsFallback';

describe('persisted UI font preference', () => {
  it('defaults new profiles to Inter', () => {
    const store = new Store(':memory:');
    try {
      expect(DEFAULT_SETTINGS.appearance.fontFamily).toBe('inter');
      expect(new SettingsService(store).get().appearance.fontFamily).toBe('inter');
    } finally {
      store.close();
    }
  });

  it.each(['inter', 'system', 'arial', 'serif', 'mono'] as const)(
    'saves %s and restores it through a new SettingsService',
    (fontFamily) => {
      const store = new Store(':memory:');
      try {
        const settings = new SettingsService(store);
        expect(settings.update({ appearance: { fontFamily } }).appearance.fontFamily).toBe(fontFamily);
        expect(new SettingsService(store).get().appearance.fontFamily).toBe(fontFamily);
      } finally {
        store.close();
      }
    },
  );

  it('replaces an unknown saved font with Inter', () => {
    const store = new Store(':memory:');
    try {
      store.setKv('settings', { appearance: { fontFamily: 'unknown-font', accent: 'aqua' } });
      const appearance = new SettingsService(store).get().appearance;
      expect(appearance.fontFamily).toBe('inter');
      expect(appearance.accent).toBe('aqua');
    } finally {
      store.close();
    }
  });

  it('sanitizes an unsupported font without discarding other appearance preferences', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      appearance: { ...DEFAULT_SETTINGS.appearance, fontFamily: 'url(https://font.test/file.woff2)', density: 'comfortable' },
    } as unknown as Settings;
    const appearance = sanitize(settings).appearance;
    expect(appearance.fontFamily).toBe('inter');
    expect(appearance.density).toBe('comfortable');
  });

  it('loads settings saved before the font preference was introduced', () => {
    const store = new Store(':memory:');
    try {
      store.setKv('settings', { appearance: { accent: 'aqua', reduceMotion: true } });
      const appearance = new SettingsService(store).get().appearance;
      expect(appearance.fontFamily).toBe('inter');
      expect(appearance.accent).toBe('aqua');
      expect(appearance.reduceMotion).toBe(true);
    } finally {
      store.close();
    }
  });

  it('sanitizes old complete settings that lack fontFamily to Inter', () => {
    const appearance: Partial<Settings['appearance']> = { ...DEFAULT_SETTINGS.appearance };
    delete appearance.fontFamily;
    expect(sanitize({ ...DEFAULT_SETTINGS, appearance } as Settings).appearance.fontFamily).toBe('inter');
  });

  it('keeps the renderer fallback font equal to the core default', () => {
    expect(DEFAULT_SETTINGS_FALLBACK.appearance.fontFamily).toBe('inter');
    expect(DEFAULT_SETTINGS_FALLBACK.appearance.fontFamily).toBe(DEFAULT_SETTINGS.appearance.fontFamily);
  });
});
