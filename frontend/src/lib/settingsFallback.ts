import type { Settings } from '../../../app/shared/types';

/** Used only until the main process answers `settings.get` (mirrors app/core/settings.ts defaults). */
export const DEFAULT_SETTINGS_FALLBACK: Settings = {
  profile: { name: 'Viewer', bio: '', avatar: null, banner: null },
  appearance: { style: 'classic', accent: 'ember', density: 'compact', fontFamily: 'inter', reduceMotion: false, titleLanguage: 'english', showAdult: false, spoilerShield:true },
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
    upscale: { enabled: false, mode: 'A', darken: false, thin: false },
    subtitleStyle: { size:28, color:'white', background:0.65, offset:0 },
  },
  accounts: {
    youtubeApiKey: '',
    autoSync: true,
    twoWay: true,
  },
  privacy: { adblock: true, blockPopups: true, autoCloudflare: true, watchInsights:false },
  updates: { autoCheck: true, autoDownload: true },
};
