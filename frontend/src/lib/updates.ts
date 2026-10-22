import type { UpdateState } from '../../../app/shared/types';
import { call, errorText } from './bridge';
import { timeAgo } from './format';
import { useToast } from './useToast';

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

/** One line describing where the self-update stands. */
export function updateSummary(u: UpdateState): string {
  switch (u.status) {
    case 'disabled':
      return u.reason ?? 'Automatic updates are off for this copy.';
    case 'idle':
      return 'Not checked yet.';
    case 'checking':
      return 'Checking for updates…';
    case 'not-available':
      return `You’re up to date${u.checkedAt ? ` · checked ${timeAgo(Math.floor(u.checkedAt / 1000))}` : ''}.`;
    case 'available':
      return `AniVerse ${u.version} is available.`;
    case 'downloading':
      return u.progress
        ? `Downloading ${u.version}… ${Math.floor(u.progress.percent)}% (${mb(u.progress.transferred)} of ${mb(u.progress.total)})`
        : `Downloading ${u.version}…`;
    case 'downloaded':
      return `AniVerse ${u.version} is ready. Restart to install it; your library, settings and accounts stay.`;
    case 'error':
      return u.error ?? 'The update check failed.';
  }
}

/** Restarts into the downloaded update. */
export function useInstallUpdate() {
  const toast = useToast();
  return () => call('update.install').catch((err) => toast.push({ level: 'error', message: errorText(err) }));
}
