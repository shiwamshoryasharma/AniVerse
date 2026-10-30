import { randomUUID } from 'node:crypto';
import type { Store } from './db/store';
import { AppError } from './util';
import type { Settings, MediaSnapshot } from '../shared/types';
import type { BookmarkInput, SceneBookmark, SkipRange, PlaybackPoint, WatchInsights } from '../shared/workspace';
import { themePresetSchema, type SavedTheme, type ThemePreset } from '../shared/theme';

function bookmarkFromRow(r: Record<string, unknown>): SceneBookmark {
  return {
    id: Number(r.id),
    media: JSON.parse(String(r.data)) as MediaSnapshot,
    episode: Number(r.episode),
    position: Number(r.position),
    duration: Number(r.duration),
    sourceId: r.source_id as string | null,
    note: String(r.note),
    tags: JSON.parse(String(r.tags)) as string[],
    createdAt: Number(r.created_at),
  };
}

export class WorkspaceService {
  private previous = new Map<string, PlaybackPoint & { at: number }>();
  constructor(
    private store: Store,
    private now: () => number = Date.now,
  ) {}
  bookmarks(input: { mediaId?: number; search?: string }): SceneBookmark[] {
    const query = '%' + (input.search ?? '').trim().toLowerCase() + '%';
    const rows = this.store.db
      .prepare(
        `SELECT b.*,m.data FROM scene_bookmarks b JOIN media_snapshot m ON m.id=b.media_id
      WHERE (? IS NULL OR b.media_id=?) AND (lower(b.note) LIKE ? OR lower(b.tags) LIKE ? OR lower(m.data) LIKE ?)
      ORDER BY b.created_at DESC,b.id DESC LIMIT 500`,
      )
      .all(input.mediaId ?? null, input.mediaId ?? null, query, query, query) as Record<string, unknown>[];
    return rows.map(bookmarkFromRow);
  }
  saveBookmark(input: BookmarkInput): SceneBookmark {
    if (!Number.isFinite(input.position) || input.position < 0 || input.position > input.duration || input.duration > 604800 || input.episode < 1)
      throw new AppError('invalid-input', 'Bookmark position is outside the episode.');
    const note = input.note.trim().slice(0, 1000),
      tags = [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 8);
    this.store.upsertSnapshot(input.media);
    let id = input.id;
    if (id) {
      const row = this.store.db.prepare('SELECT media_id FROM scene_bookmarks WHERE id=?').get(id);
      if (!row || Number(row.media_id) !== input.media.id) throw new AppError('not-found', 'Bookmark not found.');
      this.store.db.prepare('UPDATE scene_bookmarks SET note=?,tags=?,position=? WHERE id=?').run(note, JSON.stringify(tags), input.position, id);
    } else {
      const result = this.store.db
        .prepare('INSERT INTO scene_bookmarks(media_id,episode,position,duration,source_id,note,tags,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(input.media.id, input.episode, input.position, input.duration, input.sourceId, note, JSON.stringify(tags), this.now());
      id = Number(result.lastInsertRowid);
    }
    return bookmarkFromRow(
      this.store.db.prepare('SELECT b.*,m.data FROM scene_bookmarks b JOIN media_snapshot m ON m.id=b.media_id WHERE b.id=?').get(id) as Record<
        string,
        unknown
      >,
    );
  }
  deleteBookmark(id: number) {
    this.store.db.prepare('DELETE FROM scene_bookmarks WHERE id=?').run(id);
  }
  skips(mediaId: number): SkipRange[] {
    return (this.store.db.prepare('SELECT * FROM skip_ranges WHERE media_id=? ORDER BY start').all(mediaId) as Record<string, unknown>[]).map((row) => ({
      mediaId,
      kind: row.kind as SkipRange['kind'],
      start: Number(row.start),
      end: Number(row.end),
      enabled: !!row.enabled,
      sourceId: row.source_id as string | null,
      duration: Number(row.duration),
    }));
  }
  saveSkip(range: SkipRange): SkipRange[] {
    if (
      !Number.isFinite(range.start) ||
      !Number.isFinite(range.end) ||
      range.start < 0 ||
      range.end <= range.start ||
      range.end > range.duration ||
      range.duration > 604800
    )
      throw new AppError('invalid-input', 'A skip range must have an end after its start, inside the episode.');
    this.store.db
      .prepare(
        'INSERT INTO skip_ranges(media_id,kind,start,end,enabled,source_id,duration) VALUES(?,?,?,?,?,?,?) ON CONFLICT(media_id,kind) DO UPDATE SET start=excluded.start,end=excluded.end,enabled=excluded.enabled,source_id=excluded.source_id,duration=excluded.duration',
      )
      .run(range.mediaId, range.kind, range.start, range.end, Number(range.enabled), range.sourceId, range.duration);
    return this.skips(range.mediaId);
  }
  deleteSkip(mediaId: number, kind: SkipRange['kind']) {
    this.store.db.prepare('DELETE FROM skip_ranges WHERE media_id=? AND kind=?').run(mediaId, kind);
  }
  resetObservation(){this.previous.clear();}
  record(point: PlaybackPoint) {
    if(this.store.isPrivate(point.mediaId)){this.previous.delete(point.sessionId);return;}
    const now = this.now(),
      previous = this.previous.get(point.sessionId);
    let seconds = 0,
      frames = 0,
      dropped = 0;
    if (
      previous &&
      previous.mediaId === point.mediaId &&
      previous.episode === point.episode &&
      previous.sourceId === point.sourceId &&
      !previous.paused &&
      !point.paused
    ) {
      const elapsed = (now - previous.at) / 1000,
        advance = point.position - previous.position;
      if (elapsed > 0 && elapsed <= 15 && advance > 0 && advance <= elapsed * 4 + 2) {
        seconds = elapsed;
        frames = point.totalFrames != null && previous.totalFrames != null ? Math.max(0, point.totalFrames - previous.totalFrames) : 0;
        dropped =
          point.droppedFrames != null && previous.droppedFrames != null ? Math.min(frames, Math.max(0, point.droppedFrames - previous.droppedFrames)) : 0;
      }
    }
    this.previous.set(point.sessionId, { ...point, at: now });
    if (this.previous.size > 200) for (const [key, value] of this.previous) if (now - value.at > 60000) this.previous.delete(key);
    if (this.previous.size > 500) this.previous.delete(this.previous.keys().next().value!);
    this.store.db
      .prepare(
        `INSERT INTO watch_sessions(id,media_id,episode,source_id,started_at,last_at,watched_seconds,total_frames,dropped_frames,samples)
      VALUES(?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET last_at=excluded.last_at,watched_seconds=watched_seconds+excluded.watched_seconds,total_frames=total_frames+excluded.total_frames,dropped_frames=dropped_frames+excluded.dropped_frames,samples=samples+1`,
      )
      .run(point.sessionId, point.mediaId, point.episode, point.sourceId, now, now, seconds, frames, dropped);
  }
  insights(): WatchInsights {
    const total = this.store.db
      .prepare(
        'SELECT COALESCE(sum(watched_seconds),0) seconds,(SELECT count(*) FROM (SELECT media_id,episode FROM watch_sessions GROUP BY media_id,episode HAVING sum(watched_seconds)>=60)) episodes FROM watch_sessions',
      )
      .get()!;
    const daily = this.store.db
      .prepare(
        "SELECT date(started_at/1000,'unixepoch','localtime') date,sum(watched_seconds) seconds FROM watch_sessions GROUP BY date ORDER BY date DESC LIMIT 30",
      )
      .all() as { date: string; seconds: number }[];
    const sources = (
      this.store.db
        .prepare(
          'SELECT source_id sourceId,sum(watched_seconds) seconds,sum(samples) samples,sum(total_frames) frames,sum(dropped_frames) dropped FROM watch_sessions GROUP BY source_id ORDER BY seconds DESC',
        )
        .all() as { sourceId: string | null; seconds: number; samples: number; frames: number; dropped: number }[]
    ).map((row) => ({ sourceId: row.sourceId, seconds: row.seconds, samples: row.samples, dropPercent: row.frames ? (row.dropped / row.frames) * 100 : null }));
    const titles = (
      this.store.db
        .prepare(
          'SELECT w.media_id,sum(w.watched_seconds) seconds,m.data FROM watch_sessions w LEFT JOIN media_snapshot m ON m.id=w.media_id GROUP BY w.media_id ORDER BY seconds DESC LIMIT 12',
        )
        .all() as { media_id: number; seconds: number; data: string | null }[]
    ).map((row) => ({ title: row.data ? (JSON.parse(row.data) as MediaSnapshot).title : 'Title ' + row.media_id, seconds: row.seconds }));
    return { watchedSeconds: Number(total.seconds), episodes: Number(total.episodes), daily, sources, titles };
  }
  clearInsights() {
    this.previous.clear();
    this.store.db.exec('DELETE FROM watch_sessions');
  }
  themes(): SavedTheme[] {
    return this.store.getKv<SavedTheme[]>('themes:v1', []).filter((entry) => themePresetSchema.safeParse(entry.preset).success);
  }
  importTheme(input: unknown): SavedTheme {
    const parsed = themePresetSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError('invalid-input', 'This is not a valid AniVerse visual theme. Accounts, credentials and unknown fields are not accepted.');
    const entry = { id: randomUUID(), preset: parsed.data };
    this.store.setKv('themes:v1', [entry, ...this.themes()].slice(0, 30));
    return entry;
  }
  saveTheme(name: string, settings: Settings) {
    const { style, accent, density, fontFamily, reduceMotion } = settings.appearance,
      { theater, preferredQuality } = settings.player;
    return this.importTheme({ version: 1, name, appearance: { style, accent, density, fontFamily, reduceMotion }, player: { theater, preferredQuality } });
  }
  theme(id: string): ThemePreset {
    const entry = this.themes().find((theme) => theme.id === id);
    if (!entry) throw new AppError('not-found', 'Theme not found.');
    return entry.preset;
  }
  deleteTheme(id: string) {
    this.store.setKv(
      'themes:v1',
      this.themes().filter((entry) => entry.id !== id),
    );
  }
}
