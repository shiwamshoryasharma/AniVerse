import { describe, expect, it, vi } from 'vitest';
import { Store } from '../../app/core/db/store';
import { DEFAULT_SETTINGS, SettingsService } from '../../app/core/settings';
import type { SyncProvider } from '../../app/core/sync/providers';
import { SyncService, type TokenSource } from '../../app/core/sync/syncService';
import { AppError } from '../../app/core/util';
import type { MediaSnapshot } from '../../app/shared/types';

const media = (id: number, episodes: number | null = 12): MediaSnapshot => ({
  id,
  idMal: id + 1000,
  title: `Show ${id}`,
  cover: `https://img/${id}.jpg`,
  banner: null,
  format: 'TV',
  episodes,
});

describe('Store', () => {
  it('migrates and tracks progress, completion and continue-watching', () => {
    const store = new Store(':memory:');
    const a = media(1, 2);
    const first = store.saveProgress({ media: a, episode: 1, position: 100, duration: 1400, sourceId: 'src' }, 0.85);
    expect(first).toEqual({ completedNow: false, libraryProgress: null });
    const done = store.saveProgress({ media: a, episode: 1, position: 1300, duration: 1400, sourceId: 'src' }, 0.85);
    expect(done.completedNow).toBe(true);
    expect(done.libraryProgress).toBe(1);
    // Crossing the threshold again does not re-trigger sync.
    expect(store.saveProgress({ media: a, episode: 1, position: 1350, duration: 1400, sourceId: 'src' }, 0.85).completedNow).toBe(false);

    const cont = store.continueWatching();
    expect(cont[0]).toMatchObject({ episode: 2, position: 0, media: { id: 1 } });
    expect(store.getLibraryEntry(1)).toMatchObject({ status: 'CURRENT', progress: 1 });

    store.saveProgress({ media: a, episode: 2, position: 1390, duration: 1400, sourceId: null }, 0.85);
    expect(store.getLibraryEntry(1)).toMatchObject({ status: 'COMPLETED', progress: 2 });
    // Finished series disappear from continue-watching.
    expect(store.continueWatching()).toEqual([]);
    expect(store.listHistory(10, 0).map((h) => h.episode)).toEqual([2, 1]);
  });

  it('marks watched / unwatched and adjusts list progress', () => {
    const store = new Store(':memory:');
    const a = media(2, 24);
    expect(store.setWatched(a, 3, true)).toBe(3);
    expect(store.getProgress(2)[0]).toMatchObject({ episode: 3, completed: true });
    expect(store.setWatched(a, 3, false)).toBe(0);
    expect(store.getLibraryEntry(2)?.progress).toBe(0);
  });

  it('toggles favourites, pins, overrides and cache', () => {
    const store = new Store(':memory:');
    expect(store.toggleFavourite(media(3))).toBe(true);
    expect(store.listFavourites()[0].media.title).toBe('Show 3');
    expect(store.toggleFavourite(media(3))).toBe(false);
    store.setPin('stream-two-test', 3, 'https://stream-two.test/watch/x');
    expect(store.getPins(3)).toEqual({ 'stream-two-test': 'https://stream-two.test/watch/x' });
    store.setPin('stream-two-test', 3, null);
    expect(store.getPin('stream-two-test', 3)).toBeNull();
    store.patchSourceOverride('a', { enabled: false });
    store.patchSourceOverride('a', { name: 'A' });
    expect(store.getSourceOverrides().a).toEqual({ enabled: false, name: 'A' });
    store.cacheSet('k', { v: 1 }, 60);
    expect(store.cacheGet('k')).toEqual({ v: 1 });
    store.cacheSet('old', 1, -10);
    expect(store.cacheGet('old')).toBeNull();
    expect(store.cacheGetStale('old')).toBe(1);
  });

  it('encrypts account secrets with the supplied codec', () => {
    const codec = { encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.replace(/^enc:/, '') };
    const store = new Store(':memory:', codec);
    store.saveAccount({ provider: 'anilist', token: 'tok', refreshToken: null, expiresAt: null, userId: 5, userName: 'u', avatar: null, lastSyncAt: null, lastError: null });
    const raw = store.db.prepare('SELECT data FROM accounts').get() as { data: string };
    expect(raw.data).toContain('enc:tok');
    expect(store.getAccount('anilist')?.token).toBe('tok');
  });
});

describe('SettingsService', () => {
  it('merges and clamps patches', () => {
    const store = new Store(':memory:');
    const settings = new SettingsService(store);
    const next = settings.update({ player: { volume: 4, completeThreshold: 0.2 }, appearance: { accent: 'aqua' } });
    expect(next.player.volume).toBe(1);
    expect(next.player.completeThreshold).toBe(0.5);
    expect(next.appearance.accent).toBe('aqua');
    expect(new SettingsService(store).get().appearance.accent).toBe('aqua');
    expect(next.accounts).toEqual(DEFAULT_SETTINGS.accounts);
  });

  it('drops client IDs and redirect URLs saved by older versions', () => {
    const store = new Store(':memory:');
    store.setKv('settings', { accounts: { anilistClientId: '123', malRedirectUri: 'http://localhost:1', autoSync: false } });
    expect(new SettingsService(store).get().accounts).toEqual({ youtubeApiKey: '', autoSync: false, twoWay: true });
  });
});

describe('SyncService', () => {
  type Remote = Awaited<ReturnType<SyncProvider['pull']>>['entries'];
  function setup(opts: { pushEntry?: SyncProvider['pushEntry']; pushFavourite?: SyncProvider['pushFavourite']; remote?: Remote; lastSyncAt?: number | null; rejected?: () => Promise<string | null> } = {}) {
    const store = new Store(':memory:');
    const settings = new SettingsService(store);
    store.saveAccount({ provider: 'anilist', token: 't', refreshToken: null, expiresAt: null, userId: 1, userName: 'me', avatar: null, lastSyncAt: opts.lastSyncAt ?? null, lastError: null });
    const provider: SyncProvider = {
      profile: async () => ({ userId: 1, userName: 'me', avatar: null }),
      pushEntry: opts.pushEntry ?? vi.fn(async () => 'done' as const),
      pushFavourite: opts.pushFavourite ?? vi.fn(async () => 'done' as const),
      pull: async () => ({ entries: opts.remote ?? [], favourites: [media(10)] }),
    };
    const events: string[] = [];
    const tokens: TokenSource = {
      token: async () => store.getAccount('anilist')!.token,
      rejected: opts.rejected ?? (async () => null),
      status: () => ({ configured: true, signingIn: false, secureStorage: true }),
    };
    const sync = new SyncService(store, { anilist: provider, mal: provider }, () => settings.get(), (e) => events.push(`${e.provider}:${e.state}`), tokens);
    return { store, sync, events, settings, provider };
  }

  it('pushes the current entry (status, episodes, score) to connected services only', async () => {
    const pushEntry = vi.fn(async () => 'done' as const);
    const { store, sync, events } = setup({ pushEntry });
    store.setLibraryEntry(media(1), 'CURRENT', 3, 8.5);
    sync.queue('entry', media(1));
    sync.queue('entry', media(1)); // coalesces into one job
    await vi.waitFor(() => expect(store.pendingSync('anilist')).toBe(0));
    expect(pushEntry).toHaveBeenCalledTimes(1);
    expect(pushEntry).toHaveBeenCalledWith('t', { mediaId: 1, idMal: 1001 }, { status: 'CURRENT', progress: 3, score: 8.5 }, 1);
    expect(events).toContain('anilist:ok');
    expect(sync.accounts().find((a) => a.provider === 'mal')).toMatchObject({ connected: false, needsReconnect: false });
  });

  it('retries once with a refreshed token when the service rejects one', async () => {
    let calls = 0;
    const pushEntry = vi.fn(async (token: string) => {
      calls++;
      if (token === 't') throw new AppError('unauthorised', 'expired');
      return 'done' as const;
    });
    const { store, sync } = setup({ pushEntry, rejected: async () => 'fresh' });
    store.setLibraryEntry(media(2), 'PLANNING');
    store.enqueueSync('anilist', 'entry', { mediaId: 2, idMal: 1002 });
    const result = await sync.flush('anilist');
    expect(result).toMatchObject({ pushed: 1, failed: 0 });
    expect(calls).toBe(2);
    expect(pushEntry.mock.calls[1][0]).toBe('fresh');
  });

  it('keeps failed jobs with backoff and reads legacy queue rows as entries', async () => {
    const { store, sync } = setup({
      pushFavourite: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    store.enqueueSync('anilist', 'favourite', { mediaId: 4, idMal: null, favourite: true });
    store.db.prepare("INSERT INTO sync_queue (provider, op, dedupe_key, payload, created_at, next_at) VALUES ('anilist', 'progress', 'anilist:progress:5', '{\"mediaId\":5,\"idMal\":null}', 0, 0)").run();
    const report = await sync.flush('anilist');
    expect(report).toMatchObject({ pushed: 1, failed: 1 });
    expect(store.pendingSync('anilist')).toBe(1);
    expect(store.dueSyncJobs('anilist')).toEqual([]);
  });

  it('two-way: imports remote entries, lets the newer edit win and propagates removals', async () => {
    const pushEntry = vi.fn(async () => 'done' as const);
    const { store, sync } = setup({
      pushEntry,
      lastSyncAt: 1_000,
      remote: [
        { media: media(9), status: 'PLANNING', progress: 0, score: null, updatedAt: 2_000 }, // only remote → imported
        { media: media(11), status: 'COMPLETED', progress: 12, score: 9, updatedAt: 3_000 }, // newer than the pending local edit
        { media: media(12), status: 'CURRENT', progress: 2, score: null, updatedAt: 1_500 }, // older than the local edit
        { media: media(13), status: 'CURRENT', progress: 5, score: null, updatedAt: 1_200 }, // removed locally afterwards
      ],
    });
    store.setLibraryEntry(media(11), 'CURRENT', 4, null, 2_500);
    store.enqueueSync('anilist', 'entry', { mediaId: 11, idMal: 1011 });
    store.setLibraryEntry(media(12), 'CURRENT', 6, null, 2_600);
    store.setLibraryEntry(media(13), null, undefined, undefined, 2_700);

    const report = await sync.sync(null);
    expect(store.getLibraryEntry(9)).toMatchObject({ status: 'PLANNING', updatedAt: 2_000 });
    expect(store.getLibraryEntry(11)).toMatchObject({ status: 'COMPLETED', progress: 12, score: 9 });
    expect(store.getLibraryEntry(12)?.progress).toBe(6);
    expect(store.getLibraryEntry(13)).toBeNull();
    expect(report).toMatchObject({ pulled: 3, resolved: 1 }); // 9, 11 and the favourite
    const pushed = Object.fromEntries((pushEntry.mock.calls as unknown as [string, { mediaId: number }, unknown][]).map(([, ref, entry]) => [ref.mediaId, entry]));
    expect(pushed).toEqual({ 12: { status: 'CURRENT', progress: 6, score: null }, 13: null }); // never 11: its stale push was dropped
    expect(store.getAccount('anilist')?.lastSyncAt).toBeGreaterThan(1_000);
  });

  it('push-only mode never pulls', async () => {
    const pull = vi.fn();
    const { sync, settings, provider } = setup();
    provider.pull = pull;
    settings.update({ accounts: { twoWay: false } });
    await sync.sync(null);
    expect(pull).not.toHaveBeenCalled();
  });
});

describe('Continue watching removal', () => {
  it('drops titles removed from history or dismissed until watched again', async () => {
    const store = new Store(':memory:');
    store.saveProgress({ media: media(21), episode: 1, position: 100, duration: 1400, sourceId: null }, 0.85);
    store.saveProgress({ media: media(22), episode: 2, position: 100, duration: 1400, sourceId: null }, 0.85);
    expect(store.continueWatching().map((c) => c.media.id).sort()).toEqual([21, 22]);

    const row = store.listHistory(10, 0).find((h) => h.media.id === 21)!;
    store.clearHistory(row.id);
    expect(store.continueWatching().map((c) => c.media.id)).toEqual([22]);

    store.dismissContinue(22);
    expect(store.continueWatching()).toEqual([]);

    // Watching again brings the title back.
    await new Promise((r) => setTimeout(r, 1100));
    store.saveProgress({ media: media(22), episode: 3, position: 50, duration: 1400, sourceId: null }, 0.85);
    expect(store.continueWatching().map((c) => c.media.id)).toEqual([22]);

    store.clearHistory(null);
    expect(store.continueWatching()).toEqual([]);
    expect(store.listHistory(10, 0)).toEqual([]);
  });
});
