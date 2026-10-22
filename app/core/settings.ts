import type { DeepPartial, Settings } from '../shared/types';
import type { Store } from './db/store';
import { clamp, deepMerge } from './util';

export const DEFAULT_SETTINGS: Settings = {
  profile: { name: 'Viewer', bio: '', avatar: null, banner: null },
  appearance: {
    accent: 'ember',
    density: 'compact',
    reduceMotion: false,
    titleLanguage: 'english',
    showAdult: false,
  },
  player: {
    autoplay: true,
    autoNext: true,
    resume: true,
    volume: 0.9,
    speed: 1,
    seekStep: 10,
    skipStep: 85,
    completeThreshold: 0.85,
    preferredQuality: 'auto',
    theater: false,
    siteFocus: true,
  },
  accounts: {
    youtubeApiKey: '',
    autoSync: true,
    twoWay: true,
  },
  privacy: {
    adblock: true,
    blockPopups: true,
    autoCloudflare: true,
  },
};

const KEY = 'settings';

export class SettingsService {
  private cache: Settings;
  private listeners = new Set<(s: Settings) => void>();

  constructor(private store: Store) {
    this.cache = sanitize(deepMerge(DEFAULT_SETTINGS, store.getKv<unknown>(KEY, {})));
  }

  get(): Settings {
    return this.cache;
  }

  update(patch: DeepPartial<Settings>): Settings {
    this.cache = sanitize(deepMerge(this.cache, patch));
    this.store.setKv(KEY, this.cache);
    for (const listener of this.listeners) listener(this.cache);
    return this.cache;
  }

  onChange(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function sanitize(s: Settings): Settings {
  return {
    ...s,
    profile: {
      name: (s.profile.name || 'Viewer').slice(0, 40),
      bio: (s.profile.bio ?? '').slice(0, 280),
      avatar: s.profile.avatar ?? null,
      banner: s.profile.banner ?? null,
    },
    player: {
      ...s.player,
      volume: clamp(Number(s.player.volume) || 0, 0, 1),
      speed: clamp(Number(s.player.speed) || 1, 0.25, 3),
      seekStep: clamp(Math.round(Number(s.player.seekStep) || 10), 1, 60),
      skipStep: clamp(Math.round(Number(s.player.skipStep) || 85), 5, 300),
      completeThreshold: clamp(Number(s.player.completeThreshold) || 0.85, 0.5, 1),
    },
    // Built explicitly so keys from older versions (user-entered client IDs / redirect URLs) are dropped.
    accounts: {
      youtubeApiKey: String(s.accounts.youtubeApiKey ?? '').trim(),
      autoSync: s.accounts.autoSync !== false,
      twoWay: s.accounts.twoWay !== false,
    },
  };
}
