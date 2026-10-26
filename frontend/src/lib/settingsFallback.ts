import type { Settings } from '../../../app/shared/types';

/** Used only until the main process answers `settings.get` (mirrors app/core/settings.ts defaults). */
export const DEFAULT_SETTINGS_FALLBACK: Settings = {
  profile: { name: 'Viewer', bio: '', avatar: null, banner: null },
  appearance: { accent: 'ember', density: 'compact', fontFamily: 'inter', reduceMotion: false, titleLanguage: 'english', showAdult: false },
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
  privacy: { adblock: true, blockPopups: true, autoCloudflare: true },
  updates: { autoCheck: true, autoDownload: true },
};
