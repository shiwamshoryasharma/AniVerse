import { describe, it, expect } from 'vitest';
import { Store } from '../../app/core/db/store';
import { SettingsService } from '../../app/core/settings';
import { WorkspaceService } from '../../app/core/workspace';
import { DEFAULT_SETTINGS_FALLBACK } from '../../frontend/src/lib/settingsFallback';

describe('version 1 settings migration and portable presets', () => {
  it('adds new defaults without discarding old appearance and player preferences', () => {
    const store = new Store(':memory:');
    store.setKv('settings', { appearance: { accent: 'aqua', fontFamily: 'serif' }, player: { volume: 0.4 }, privacy: { adblock: false } });
    const settings = new SettingsService(store).get();
    expect(settings).toMatchObject({
      appearance: { accent: 'aqua', fontFamily: 'serif', spoilerShield: true },
      player: { volume: 0.4, subtitleStyle: { size: 28, offset: 0 } },
      privacy: { adblock: false, watchInsights: false },
    });
    expect(DEFAULT_SETTINGS_FALLBACK.privacy.watchInsights).toBe(false);
    store.close();
  });
  it('roundtrips visual settings while retaining private settings in the destination', () => {
    const store = new Store(':memory:');
    const settings = new SettingsService(store);
    const workspace = new WorkspaceService(store);
    settings.update({ appearance: { accent: 'aqua', fontFamily: 'serif' }, accounts: { youtubeApiKey: 'private-fixture-key' } });
    const saved = workspace.saveTheme('Reading', settings.get());
    const text = JSON.stringify(saved.preset);
    expect(text).not.toMatch(/private-fixture|accounts|profile|privacy|spoilerShield/);
    const imported = workspace.importTheme(JSON.parse(text));
    settings.update({ appearance: { accent: 'crimson', fontFamily: 'mono' } });
    const preset = workspace.theme(imported.id);
    settings.update({ appearance: preset.appearance, player: preset.player });
    expect(settings.get().appearance.fontFamily).toBe('serif');
    expect(settings.get().accounts.youtubeApiKey).toBe('private-fixture-key');
    store.close();
  });
});
