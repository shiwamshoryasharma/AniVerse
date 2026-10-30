import type { AccentName, DeepPartial, Settings } from '../shared/types';
import type { Store } from './db/store';
import { clamp, deepMerge } from './util';
import { DEFAULT_UPSCALE, upscaleSchema } from '../shared/upscale';

export const DEFAULT_SETTINGS: Settings = {
  profile: { name: 'Viewer', bio: '', avatar: null, banner: null },
  appearance: {
    style: 'classic',
    accent: 'ember',
    density: 'compact',
    fontFamily: 'inter',
    reduceMotion: false,
    titleLanguage: 'english',
    showAdult: false,
    spoilerShield: true,
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
    upscale: { ...DEFAULT_UPSCALE },
    subtitleStyle: { size:28, color:'white', background:0.65, offset:0 },
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
    watchInsights: false,
  },
  updates: {
    autoCheck: true,
    autoDownload: true,
  },
};

const KEY = 'settings';

export class SettingsService {
  private cache: Settings;
  private listeners = new Set<(s: Settings) => void>();

  constructor(private store: Store) {
    this.cache = sanitize(deepMerge(DEFAULT_SETTINGS, store.getKv<unknown>(KEY, {})));
  }

  reload(): Settings {
    this.cache = sanitize(deepMerge(DEFAULT_SETTINGS, this.store.getKv<unknown>(KEY, {})));
    for (const listener of this.listeners) listener(this.cache);
    return this.cache;
  }

  get(): Settings {
    return this.cache;
  }

  /** One seasonal rollout; users can opt out immediately. Stored only on this device. */
  applySeasonalTheme(now=new Date()):void {
    const key='theme:festival-2026';
    const expired=now.getTime()>=new Date(2027,0,1).getTime();
    const state=this.store.getKv<{previous:AccentName;automatic:boolean}|null>(key,null);
    if(!state){
      const previous=this.cache.appearance.accent==='festival'?'ember':this.cache.appearance.accent;
      this.store.setKv(key,{previous,automatic:!expired});
      if(!expired)this.persist({...this.cache,appearance:{...this.cache.appearance,accent:'festival'}});
    }else if(state.automatic&&expired){
      this.store.setKv(key,{...state,automatic:false});
      if(this.cache.appearance.accent==='festival')this.persist({...this.cache,appearance:{...this.cache.appearance,accent:state.previous}});
    }
  }
  private persist(next:Settings):Settings {
    this.cache=sanitize(next);this.store.setKv(KEY,this.cache);
    for(const listener of this.listeners)listener(this.cache);
    return this.cache;
  }
  update(patch: DeepPartial<Settings>): Settings {
    if(patch.appearance?.accent){
      const previous=this.cache.appearance.accent==='festival'
        ?this.store.getKv<{previous:AccentName}>('theme:festival-2026',{previous:'ember'}).previous:this.cache.appearance.accent;
      this.store.setKv('theme:festival-2026',{previous,automatic:patch.appearance.accent==='festival'&&Date.now()<new Date(2027,0,1).getTime()});
    }
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
    appearance: {
      ...s.appearance,
      style: ['classic', 'aurora', 'paper'].includes(s.appearance.style) ? s.appearance.style : 'classic',
      spoilerShield: s.appearance.spoilerShield !== false,
      fontFamily: ['inter', 'system', 'arial', 'serif', 'mono'].includes(s.appearance.fontFamily) ? s.appearance.fontFamily : 'inter',
    },
    profile: {
      name: (s.profile.name || 'Viewer').slice(0, 40),
      bio: (s.profile.bio ?? '').slice(0, 280),
      avatar: s.profile.avatar ?? null,
      banner: s.profile.banner ?? null,
    },
    player: {
      ...s.player,
      upscale: upscaleSchema.safeParse(s.player.upscale).success ? upscaleSchema.parse(s.player.upscale) : { ...DEFAULT_UPSCALE },
      volume: clamp(Number(s.player.volume) || 0, 0, 1),
      speed: clamp(Number(s.player.speed) || 1, 0.25, 3),
      seekStep: clamp(Math.round(Number(s.player.seekStep) || 10), 1, 60),
      skipStep: clamp(Math.round(Number(s.player.skipStep) || 85), 5, 300),
      completeThreshold: clamp(Number(s.player.completeThreshold) || 0.85, 0.5, 1),
      subtitleStyle: {
        size: clamp(Number(s.player.subtitleStyle?.size)||28,16,48),
        color: ['white','yellow','cyan','green'].includes(s.player.subtitleStyle?.color) ? s.player.subtitleStyle.color : 'white',
        background: clamp(Number.isFinite(s.player.subtitleStyle?.background)?s.player.subtitleStyle.background:0.65,0,1),
        offset: clamp(Number(s.player.subtitleStyle?.offset)||0,-15,15),
      },
    },
    // Built explicitly so keys from older versions (user-entered client IDs / redirect URLs) are dropped.
    accounts: {
      youtubeApiKey: String(s.accounts.youtubeApiKey ?? '').trim(),
      autoSync: s.accounts.autoSync !== false,
      twoWay: s.accounts.twoWay !== false,
    },
    updates: {
      autoCheck: s.updates?.autoCheck !== false,
      autoDownload: s.updates?.autoDownload !== false,
    },
  };
}
