import { DatabaseSync } from 'node:sqlite';
import type {
  ContinueItem,
  FavouriteEntry,
  HistoryEntry,
  LibraryEntry,
  ListStatus,
  MediaSnapshot,
  ProgressEntry,
  ProgressSave,
  Provider,
  SourceOverridePatch,
} from '../../shared/types';
import { nowSec } from '../util';

type Row = Record<string, unknown>;
type SqlValue = string | number | bigint | null | Uint8Array;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE source_overrides (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE source_pins (
    source_id TEXT NOT NULL, media_id INTEGER NOT NULL, url TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, media_id)
  );
  CREATE TABLE media_snapshot (id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE progress (
    media_id INTEGER NOT NULL, episode INTEGER NOT NULL, position REAL NOT NULL, duration REAL NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0, source_id TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY (media_id, episode)
  );
  CREATE INDEX progress_updated ON progress (updated_at DESC);
  CREATE TABLE history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, media_id INTEGER NOT NULL, episode INTEGER NOT NULL,
    source_id TEXT, position REAL NOT NULL, duration REAL NOT NULL, watched_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX history_media_episode ON history (media_id, episode);
  CREATE INDEX history_watched ON history (watched_at DESC);
  CREATE TABLE favourites (media_id INTEGER PRIMARY KEY, added_at INTEGER NOT NULL);
  CREATE TABLE library (
    media_id INTEGER PRIMARY KEY, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0,
    score REAL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE accounts (provider TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, op TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    created_at INTEGER NOT NULL, next_at INTEGER NOT NULL
  );
  CREATE TABLE http_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);
  `,
  // v2: pages the site navigator learned (episode 0 = the title's page).
  `
  CREATE TABLE site_links (
    source_id TEXT NOT NULL, media_id INTEGER NOT NULL, episode INTEGER NOT NULL, url TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, media_id, episode)
  );
  `,
  // v3: when a title was removed from the list, so two-way sync can tell a removal from "never added".
  `
  CREATE TABLE library_tombstones (media_id INTEGER PRIMARY KEY, deleted_at INTEGER NOT NULL);
  `,
  // v4: private Episode Toolkit and viewing insights; existing library/sync data is retained.
  `
  CREATE TABLE scene_bookmarks (
    id INTEGER PRIMARY KEY, media_id INTEGER NOT NULL, episode INTEGER NOT NULL CHECK(episode>0),
    position REAL NOT NULL CHECK(position>=0), duration REAL NOT NULL, source_id TEXT,
    note TEXT NOT NULL, tags TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX scene_bookmarks_media ON scene_bookmarks(media_id,episode);
  CREATE TABLE skip_ranges (
    media_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('intro','outro')),
    start REAL NOT NULL CHECK(start>=0), end REAL NOT NULL CHECK(end>start),
    enabled INTEGER NOT NULL, source_id TEXT, duration REAL NOT NULL, PRIMARY KEY(media_id,kind)
  );
  CREATE TABLE local_media (
    id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, bytes INTEGER NOT NULL,
    query TEXT NOT NULL, episode INTEGER, media_id INTEGER, missing INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE watch_sessions (
    id TEXT PRIMARY KEY, media_id INTEGER NOT NULL, episode INTEGER NOT NULL, source_id TEXT,
    started_at INTEGER NOT NULL, last_at INTEGER NOT NULL, watched_seconds REAL NOT NULL DEFAULT 0,
    total_frames INTEGER NOT NULL DEFAULT 0, dropped_frames INTEGER NOT NULL DEFAULT 0, samples INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX watch_sessions_started ON watch_sessions(started_at);
  `,
  `CREATE TABLE private_titles (media_id INTEGER PRIMARY KEY CHECK(media_id>0));`,
];

export interface StoredAccount {
  provider: Provider;
  token: string;
  refreshToken: string | null;
  expiresAt: number | null;
  userId: number | null;
  userName: string | null;
  avatar: string | null;
  lastSyncAt: number | null;
  lastError: string | null;
  /** The service rejected the session (expired/revoked): keep the account visible, ask to reconnect. */
  needsReconnect?: boolean;
}

/**
 * entry: make the service's list entry match AniVerse's current one (read at push
 * time, so status/progress/score changes coalesce and can't arrive out of order;
 * no local entry = remove). favourite: set the favourite flag.
 */
export type SyncOp = 'entry' | 'favourite';
/** Queue rows written by older versions; all of them mean "entry". */
const LEGACY_ENTRY_OPS = ['progress', 'status', 'remove'];

export interface SyncJob {
  id: number;
  provider: Provider;
  op: SyncOp;
  payload: SyncPayload;
  attempts: number;
}

export interface SyncPayload {
  mediaId: number;
  idMal: number | null;
  favourite?: boolean;
}

/** Encrypts secrets at rest. The Electron layer passes a safeStorage-backed codec. */
export interface SecretCodec {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

const plainCodec: SecretCodec = { encrypt: (s) => s, decrypt: (s) => s };

export class Store {
  readonly db: DatabaseSync;
  private incognito = false;
  private privacyEpoch=0;
  cacheContext(){return this.privacyEpoch;}
  private privateSnapshots = new Map<number,MediaSnapshot>();
  private privateCache = new Map<string,{value:unknown;expires:number}>();
  isIncognito(){return this.incognito;}
  setIncognito(on:boolean){this.privacyEpoch++;this.incognito=on;this.privateSnapshots.clear();this.privateCache.clear();return this.privacyState();}
  isPrivate(mediaId:number){return this.incognito||!!this.get('SELECT 1 FROM private_titles WHERE media_id=?',mediaId);}
  privacyState(){return {incognito:this.incognito,privateMediaIds:this.all<{media_id:number}>('SELECT media_id FROM private_titles ORDER BY media_id').map(r=>Number(r.media_id))};}
  setTitlePrivate(mediaId:number,on:boolean){
    this.privacyEpoch++;
    if(on){this.run('INSERT OR IGNORE INTO private_titles(media_id) VALUES(?)',mediaId);this.run("DELETE FROM sync_queue WHERE json_extract(payload,'$.mediaId')=?",mediaId);}
    else this.run('DELETE FROM private_titles WHERE media_id=?',mediaId);
    return this.privacyState();
  }

  constructor(
    path: string,
    private codec: SecretCodec = plainCodec,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close() {
    this.db.close();
  }

  private migrate() {
    const current = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version ?? 0);
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private run(sql: string, ...params: SqlValue[]) {
    return this.db.prepare(sql).run(...params);
  }

  // ------------------------------------------------------------------ kv

  getKv<T>(key: string, fallback: T): T {
    const row = this.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  setKv(key: string, value: unknown) {
    this.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  // ------------------------------------------------------------------ sources

  getSourceOverrides(): Record<string, SourceOverridePatch> {
    const out: Record<string, SourceOverridePatch> = {};
    for (const row of this.all<{ id: string; data: string }>('SELECT id, data FROM source_overrides')) {
      out[row.id] = JSON.parse(row.data);
    }
    return out;
  }

  patchSourceOverride(id: string, patch: SourceOverridePatch): SourceOverridePatch {
    const current = this.getSourceOverrides()[id] ?? {};
    const next = { ...current, ...patch };
    this.run(
      'INSERT INTO source_overrides (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      id,
      JSON.stringify(next),
    );
    return next;
  }

  getPins(mediaId: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.all<{ source_id: string; url: string }>('SELECT source_id, url FROM source_pins WHERE media_id = ?', mediaId)) {
      out[row.source_id] = row.url;
    }
    return out;
  }

  getPin(sourceId: string, mediaId: number): string | null {
    return this.get<{ url: string }>('SELECT url FROM source_pins WHERE source_id = ? AND media_id = ?', sourceId, mediaId)?.url ?? null;
  }

  setPin(sourceId: string, mediaId: number, url: string | null) {
    if(this.isPrivate(mediaId))return;
    if (url === null) {
      this.run('DELETE FROM source_pins WHERE source_id = ? AND media_id = ?', sourceId, mediaId);
      return;
    }
    this.run(
      `INSERT INTO source_pins (source_id, media_id, url, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(source_id, media_id) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`,
      sourceId,
      mediaId,
      url,
      nowSec(),
    );
  }

  /** Learned site pages for a title: key 0 is the title page, others are episodes. */
  getSiteLinks(sourceId: string, mediaId: number): Record<number, string> {
    const out: Record<number, string> = {};
    for (const row of this.all<{ episode: number; url: string }>('SELECT episode, url FROM site_links WHERE source_id = ? AND media_id = ?', sourceId, mediaId)) {
      out[Number(row.episode)] = row.url;
    }
    return out;
  }

  setSiteLink(sourceId: string, mediaId: number, episode: number, url: string) {
    if(this.isPrivate(mediaId))return;
    this.run(
      `INSERT INTO site_links (source_id, media_id, episode, url, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_id, media_id, episode) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`,
      sourceId,
      mediaId,
      episode,
      url,
      nowSec(),
    );
  }

  clearSiteLinks(sourceId: string, mediaId: number) {
    if(this.isPrivate(mediaId))return;
    this.run('DELETE FROM site_links WHERE source_id = ? AND media_id = ?', sourceId, mediaId);
  }

  // ------------------------------------------------------------------ snapshots

  upsertSnapshot(snap: MediaSnapshot) {
    if(this.incognito){this.privateSnapshots.set(snap.id,snap);return;}
    this.run(
      `INSERT INTO media_snapshot (id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      snap.id,
      JSON.stringify(snap),
      nowSec(),
    );
  }

  getSnapshot(id: number): MediaSnapshot | null {
    if(this.incognito&&this.privateSnapshots.has(id))return this.privateSnapshots.get(id)!;
    const row = this.get<{ data: string }>('SELECT data FROM media_snapshot WHERE id = ?', id);
    return row ? (JSON.parse(row.data) as MediaSnapshot) : null;
  }

  private snapshotOrStub(id: number): MediaSnapshot {
    return this.getSnapshot(id) ?? { id, idMal: null, title: `AniList #${id}`, cover: '', banner: null, format: null, episodes: null };
  }

  // ------------------------------------------------------------------ progress & history

  /**
   * Records playback position. Returns `completedNow` the first time an episode
   * crosses the completion threshold so callers can trigger list sync once.
   */
  saveProgress(save: ProgressSave, threshold: number): { completedNow: boolean; libraryProgress: number | null } {
    if(this.isPrivate(save.media.id))return {completedNow:false,libraryProgress:null};
    return this.tx(() => {
      this.upsertSnapshot(save.media);
      const ts = nowSec();
      const prev = this.get<{ completed: number }>('SELECT completed FROM progress WHERE media_id = ? AND episode = ?', save.media.id, save.episode);
      const reached = save.duration > 0 && save.position / save.duration >= threshold;
      const completed = reached || prev?.completed === 1;
      this.run(
        `INSERT INTO progress (media_id, episode, position, duration, completed, source_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(media_id, episode) DO UPDATE SET position = excluded.position, duration = excluded.duration,
           completed = excluded.completed, source_id = excluded.source_id, updated_at = excluded.updated_at`,
        save.media.id,
        save.episode,
        save.position,
        save.duration,
        completed ? 1 : 0,
        save.sourceId,
        ts,
      );
      this.touchHistory(save.media.id, save.episode, save.sourceId, save.position, save.duration, ts);
      const completedNow = reached && prev?.completed !== 1;
      const libraryProgress = completedNow ? this.bumpLibraryProgress(save.media, save.episode) : null;
      return { completedNow, libraryProgress };
    });
  }

  setWatched(media: MediaSnapshot, episode: number, watched: boolean): number {
    if(this.isPrivate(media.id))return this.getLibraryEntry(media.id)?.progress??0;
    return this.tx(() => {
      this.upsertSnapshot(media);
      const ts = nowSec();
      const existing = this.get<{ duration: number }>('SELECT duration FROM progress WHERE media_id = ? AND episode = ?', media.id, episode);
      const duration = existing?.duration ?? 0;
      this.run(
        `INSERT INTO progress (media_id, episode, position, duration, completed, source_id, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(media_id, episode) DO UPDATE SET completed = excluded.completed, position = excluded.position, updated_at = excluded.updated_at`,
        media.id,
        episode,
        watched ? duration : 0,
        duration,
        watched ? 1 : 0,
        ts,
      );
      if (watched) {
        this.touchHistory(media.id, episode, null, duration, duration, ts);
        return this.bumpLibraryProgress(media, episode);
      }
      const entry = this.getLibraryEntry(media.id);
      const highest = this.get<{ ep: number | null }>('SELECT MAX(episode) AS ep FROM progress WHERE media_id = ? AND completed = 1', media.id)?.ep ?? 0;
      if (entry && entry.progress >= episode) {
        this.run('UPDATE library SET progress = ?, updated_at = ? WHERE media_id = ?', highest ?? 0, ts, media.id);
      }
      return highest ?? 0;
    });
  }

  private touchHistory(mediaId: number, episode: number, sourceId: string | null, position: number, duration: number, ts: number) {
    this.run(
      `INSERT INTO history (media_id, episode, source_id, position, duration, watched_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(media_id, episode) DO UPDATE SET source_id = COALESCE(excluded.source_id, history.source_id),
         position = excluded.position, duration = excluded.duration, watched_at = excluded.watched_at`,
      mediaId,
      episode,
      sourceId,
      position,
      duration,
      ts,
    );
  }

  private bumpLibraryProgress(media: MediaSnapshot, episode: number): number {
    const entry = this.getLibraryEntry(media.id);
    const progress = Math.max(entry?.progress ?? 0, episode);
    const finished = media.episodes !== null && progress >= media.episodes;
    const status: ListStatus = finished ? 'COMPLETED' : entry?.status === 'REPEATING' ? 'REPEATING' : 'CURRENT';
    this.run(
      `INSERT INTO library (media_id, status, progress, score, updated_at) VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(media_id) DO UPDATE SET status = excluded.status, progress = excluded.progress, updated_at = excluded.updated_at`,
      media.id,
      status,
      progress,
      nowSec(),
    );
    this.run('DELETE FROM library_tombstones WHERE media_id = ?', media.id);
    return progress;
  }

  getProgress(mediaId: number): ProgressEntry[] {
    return this.all<Row>('SELECT * FROM progress WHERE media_id = ? ORDER BY episode', mediaId).map(mapProgress);
  }

  continueWatching(limit = 20): ContinueItem[] {
    if(this.incognito)return [];
    const rows = this.all<Row>(
      `SELECT p.* FROM progress p
       JOIN (SELECT media_id, MAX(updated_at) AS mu FROM progress GROUP BY media_id) latest
         ON latest.media_id = p.media_id AND latest.mu = p.updated_at
       WHERE NOT EXISTS(SELECT 1 FROM private_titles hidden WHERE hidden.media_id=p.media_id)
       ORDER BY p.updated_at DESC, p.episode DESC LIMIT ?`,
      limit * 2,
    );
    const items: ContinueItem[] = [];
    const seen = new Set<number>();
    const dismissed = this.getKv<Record<string, number>>('continue-dismissed', {});
    const clearedAt = this.getKv<number>('continue-cleared-at', 0);
    for (const row of rows) {
      const p = mapProgress(row);
      if (seen.has(p.mediaId)) continue;
      seen.add(p.mediaId);
      // Removed from Continue watching / history: hidden until the title is watched again.
      if (p.updatedAt <= Math.max(clearedAt, dismissed[p.mediaId] ?? 0)) continue;
      const media = this.snapshotOrStub(p.mediaId);
      if (p.completed) {
        // Offer the next episode unless the series is finished.
        if (media.episodes !== null && p.episode >= media.episodes) continue;
        items.push({ media, episode: p.episode + 1, position: 0, duration: 0, completed: false, sourceId: p.sourceId, updatedAt: p.updatedAt });
      } else {
        items.push({ media, episode: p.episode, position: p.position, duration: p.duration, completed: false, sourceId: p.sourceId, updatedAt: p.updatedAt });
      }
      if (items.length >= limit) break;
    }
    return items;
  }

  listHistory(limit: number, offset: number): HistoryEntry[] {
    if(this.incognito)return [];
    return this.all<Row>('SELECT * FROM history WHERE NOT EXISTS(SELECT 1 FROM private_titles p WHERE p.media_id=history.media_id) ORDER BY watched_at DESC, id DESC LIMIT ? OFFSET ?', limit, offset).map((row) => ({
      id: Number(row.id),
      media: this.snapshotOrStub(Number(row.media_id)),
      episode: Number(row.episode),
      sourceId: (row.source_id as string | null) ?? null,
      position: Number(row.position),
      duration: Number(row.duration),
      watchedAt: Number(row.watched_at),
    }));
  }

  /** Deletes history (one row or all) and drops the affected titles from Continue watching. */
  clearHistory(id: number | null) {
    if (id === null) {
      this.run('DELETE FROM history');
      this.setKv('continue-cleared-at', nowSec());
      this.setKv('continue-dismissed', {});
      return;
    }
    const row = this.get<{ media_id: number }>('SELECT media_id FROM history WHERE id = ?', id);
    this.run('DELETE FROM history WHERE id = ?', id);
    if (row) this.dismissContinue(Number(row.media_id));
  }

  /** Hides a title from Continue watching until it is watched again. */
  dismissContinue(mediaId: number) {
    const dismissed = this.getKv<Record<string, number>>('continue-dismissed', {});
    dismissed[mediaId] = nowSec();
    this.setKv('continue-dismissed', dismissed);
  }

  // ------------------------------------------------------------------ favourites & library

  isFavourite(mediaId: number): boolean {
    return !!this.get('SELECT 1 AS x FROM favourites WHERE media_id = ?', mediaId);
  }

  setFavourite(media: MediaSnapshot, favourite: boolean, addedAt = nowSec()) {
    if(this.incognito)throw new Error('Exit incognito before changing saved favourites.');
    this.upsertSnapshot(media);
    if (favourite) this.run('INSERT OR IGNORE INTO favourites (media_id, added_at) VALUES (?, ?)', media.id, addedAt);
    else this.run('DELETE FROM favourites WHERE media_id = ?', media.id);
  }

  toggleFavourite(media: MediaSnapshot): boolean {
    const next = !this.isFavourite(media.id);
    this.setFavourite(media, next);
    return next;
  }

  listFavourites(): FavouriteEntry[] {
    return this.all<Row>('SELECT * FROM favourites ORDER BY added_at DESC').map((row) => ({
      media: this.snapshotOrStub(Number(row.media_id)),
      addedAt: Number(row.added_at),
    }));
  }

  getLibraryEntry(mediaId: number): LibraryEntry | null {
    const row = this.get<Row>('SELECT * FROM library WHERE media_id = ?', mediaId);
    return row ? this.mapLibrary(row) : null;
  }

  setLibraryEntry(media: MediaSnapshot, status: ListStatus | null, progress?: number, score?: number | null, updatedAt = nowSec()) {
    if(this.incognito)throw new Error('Exit incognito before changing the saved library.');
    this.upsertSnapshot(media);
    if (status === null) {
      this.run('DELETE FROM library WHERE media_id = ?', media.id);
      this.run('INSERT INTO library_tombstones (media_id, deleted_at) VALUES (?, ?) ON CONFLICT(media_id) DO UPDATE SET deleted_at = excluded.deleted_at', media.id, updatedAt);
      return;
    }
    this.run('DELETE FROM library_tombstones WHERE media_id = ?', media.id);
    const current = this.getLibraryEntry(media.id);
    this.run(
      `INSERT INTO library (media_id, status, progress, score, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(media_id) DO UPDATE SET status = excluded.status, progress = excluded.progress,
         score = excluded.score, updated_at = excluded.updated_at`,
      media.id,
      status,
      progress ?? current?.progress ?? 0,
      score === undefined ? (current?.score ?? null) : score,
      updatedAt,
    );
  }

  listLibrary(status: ListStatus | null): LibraryEntry[] {
    const rows = status
      ? this.all<Row>('SELECT * FROM library WHERE status = ? ORDER BY updated_at DESC', status)
      : this.all<Row>('SELECT * FROM library ORDER BY updated_at DESC');
    return rows.map((row) => this.mapLibrary(row));
  }

  /** When the title was removed from the list (null if it wasn't). */
  getTombstone(mediaId: number): number | null {
    const row = this.get<{ deleted_at: number }>('SELECT deleted_at FROM library_tombstones WHERE media_id = ?', mediaId);
    return row ? Number(row.deleted_at) : null;
  }

  listTombstones(): { mediaId: number; deletedAt: number }[] {
    return this.all<{ media_id: number; deleted_at: number }>('SELECT media_id, deleted_at FROM library_tombstones').map((r) => ({ mediaId: Number(r.media_id), deletedAt: Number(r.deleted_at) }));
  }

  libraryIds(): number[] {
    return this.all<{ media_id: number }>('SELECT media_id FROM library').map((r) => Number(r.media_id));
  }

  private mapLibrary(row: Row): LibraryEntry {
    return {
      media: this.snapshotOrStub(Number(row.media_id)),
      status: row.status as ListStatus,
      progress: Number(row.progress),
      score: row.score === null ? null : Number(row.score),
      updatedAt: Number(row.updated_at),
    };
  }

  // ------------------------------------------------------------------ accounts

  getAccount(provider: Provider): StoredAccount | null {
    const row = this.get<{ data: string }>('SELECT data FROM accounts WHERE provider = ?', provider);
    if (!row) return null;
    const stored = JSON.parse(row.data) as StoredAccount;
    try {
      return {
        ...stored,
        token: this.codec.decrypt(stored.token),
        refreshToken: stored.refreshToken ? this.codec.decrypt(stored.refreshToken) : null,
      };
    } catch {
      // Secrets written on another machine/user cannot be decrypted: treat as signed out.
      return null;
    }
  }

  saveAccount(account: StoredAccount) {
    const data: StoredAccount = {
      ...account,
      token: this.codec.encrypt(account.token),
      refreshToken: account.refreshToken ? this.codec.encrypt(account.refreshToken) : null,
    };
    this.run(
      'INSERT INTO accounts (provider, data) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET data = excluded.data',
      account.provider,
      JSON.stringify(data),
    );
  }

  patchAccount(provider: Provider, patch: Partial<StoredAccount>) {
    const current = this.getAccount(provider);
    if (current) this.saveAccount({ ...current, ...patch });
  }

  deleteAccount(provider: Provider) {
    this.run('DELETE FROM accounts WHERE provider = ?', provider);
    this.run('DELETE FROM sync_queue WHERE provider = ?', provider);
  }

  // ------------------------------------------------------------------ sync queue

  enqueueSync(provider: Provider, op: SyncOp, payload: SyncPayload) {
    if(this.isPrivate(payload.mediaId))return;
    const key = `${provider}:${op}:${payload.mediaId}`;
    const ts = nowSec();
    if (op === 'entry') this.dropLegacyEntryJobs(provider, payload.mediaId);
    this.run(
      `INSERT INTO sync_queue (provider, op, dedupe_key, payload, attempts, last_error, created_at, next_at)
       VALUES (?, ?, ?, ?, 0, NULL, ?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET payload = excluded.payload, attempts = 0, last_error = NULL, next_at = excluded.next_at`,
      provider,
      op,
      key,
      JSON.stringify(payload),
      ts,
      ts,
    );
  }

  dueSyncJobs(provider: Provider, now = nowSec(), limit = 25): SyncJob[] {
    return this.all<Row>('SELECT * FROM sync_queue WHERE provider = ? AND next_at <= ? ORDER BY id LIMIT ?', provider, now, limit).map((row) => ({
      id: Number(row.id),
      provider: row.provider as Provider,
      op: LEGACY_ENTRY_OPS.includes(String(row.op)) ? 'entry' : (row.op as SyncOp),
      payload: JSON.parse(String(row.payload)) as SyncPayload,
      attempts: Number(row.attempts),
    }));
  }

  /** Forgets a queued push that a newer edit on the service has superseded. */
  dropSyncJob(provider: Provider, op: SyncOp, mediaId: number) {
    this.run('DELETE FROM sync_queue WHERE dedupe_key = ?', `${provider}:${op}:${mediaId}`);
    if (op === 'entry') this.dropLegacyEntryJobs(provider, mediaId);
  }

  hasSyncJob(provider: Provider, op: SyncOp, mediaId: number): boolean {
    const keys = [`${provider}:${op}:${mediaId}`, ...(op === 'entry' ? LEGACY_ENTRY_OPS.map((o) => `${provider}:${o}:${mediaId}`) : [])];
    return !!this.get(`SELECT 1 AS x FROM sync_queue WHERE dedupe_key IN (${keys.map(() => '?').join(',')})`, ...keys);
  }

  clearSyncQueue(provider: Provider) {
    this.run('DELETE FROM sync_queue WHERE provider = ?', provider);
  }

  private dropLegacyEntryJobs(provider: Provider, mediaId: number) {
    for (const op of LEGACY_ENTRY_OPS) this.run('DELETE FROM sync_queue WHERE dedupe_key = ?', `${provider}:${op}:${mediaId}`);
  }

  completeSyncJob(id: number) {
    this.run('DELETE FROM sync_queue WHERE id = ?', id);
  }

  failSyncJob(id: number, error: string, attempts: number) {
    const backoff = Math.min(3600, 30 * 2 ** attempts);
    this.run('UPDATE sync_queue SET attempts = ?, last_error = ?, next_at = ? WHERE id = ?', attempts + 1, error, nowSec() + backoff, id);
  }

  pendingSync(provider: Provider): number {
    return Number(this.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_queue WHERE provider = ?', provider)?.n ?? 0);
  }

  // ------------------------------------------------------------------ http cache

  cacheGet<T>(key: string): T | null {
    const memory=this.incognito?this.privateCache.get(key):null;if(memory&&memory.expires>=nowSec())return memory.value as T;
    const row = this.get<{ value: string; expires_at: number }>('SELECT value, expires_at FROM http_cache WHERE key = ?', key);
    if (!row || Number(row.expires_at) < nowSec()) return null;
    return JSON.parse(row.value) as T;
  }

  /** Returns a cached value even if expired (used as an offline fallback). */
  cacheGetStale<T>(key: string): T | null {
    if(this.incognito&&this.privateCache.has(key))return this.privateCache.get(key)!.value as T;
    const row = this.get<{ value: string }>('SELECT value FROM http_cache WHERE key = ?', key);
    return row ? (JSON.parse(row.value) as T) : null;
  }

  cacheSet(key: string, value: unknown, ttlSec: number, context=this.privacyEpoch) {
    if(context!==this.privacyEpoch)return;
    if(this.incognito){if(this.privateCache.size>500)this.privateCache.clear();this.privateCache.set(key,{value,expires:nowSec()+ttlSec});return;}
    this.run(
      `INSERT INTO http_cache (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      key,
      JSON.stringify(value),
      nowSec() + ttlSec,
    );
  }

  cachePurge(all = false) {
    if (all) this.run('DELETE FROM http_cache');
    else this.run('DELETE FROM http_cache WHERE expires_at < ?', nowSec() - 7 * 86400);
  }
}

function mapProgress(row: Row): ProgressEntry {
  return {
    mediaId: Number(row.media_id),
    episode: Number(row.episode),
    position: Number(row.position),
    duration: Number(row.duration),
    completed: Number(row.completed) === 1,
    sourceId: (row.source_id as string | null) ?? null,
    updatedAt: Number(row.updated_at),
  };
}
