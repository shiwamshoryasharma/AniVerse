import type { Store } from './db/store';
import { RELEASES, type ChangelogState } from '../shared/changelog';
export class ChangelogService {
  constructor(private store: Store, private version: string) {}
  state(): ChangelogState {
    const seen = this.store.getKv<string | null>('changelog:lastSeen', null);
    return { version: this.version, seen, unread: RELEASES.some((release) => release.version === this.version) && seen !== this.version };
  }
  markSeen(version: string): ChangelogState {
    if (version !== this.version) throw new Error('Only this app version can be acknowledged.');
    this.store.setKv('changelog:lastSeen', version);
    return this.state();
  }
}
