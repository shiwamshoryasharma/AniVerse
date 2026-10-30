import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './db/store';
import { SettingsService, sanitize } from './settings';
import { deepMerge } from './util';
import { backupSchema, type AppBackup } from '../shared/backup';
import { BACKUP_LIMIT, type BackupSummary } from '../shared/drive';
import { themePresetSchema, type SavedTheme } from '../shared/theme';

type Row = Record<string, string | number | null>;
export class BackupService {
  constructor(private store: Store) {}
  validate(input: unknown): AppBackup {
    if (Buffer.byteLength(JSON.stringify(input) ?? '') > BACKUP_LIMIT) throw new Error('Backup exceeds the 25 MB app-data limit.');
    const parsed = backupSchema.safeParse(input);
    if (!parsed.success) throw new Error('This backup is invalid or uses an unsupported format. No data was imported.');
    return parsed.data;
  }
  summary(input: unknown): BackupSummary {
    const b = this.validate(input);
    return { createdAt: b.createdAt, appVersion: b.appVersion, library: b.library.length, progress: b.progress.length, favourites: b.favourites.length,
      bookmarks: b.bookmarks.length, skips: b.skips.length, history: b.history.length, themes: b.themes.length, hasPlan: !!b.plan };
  }
  create(appVersion: string): AppBackup {
    if(this.store.isIncognito())throw new Error('Exit incognito before exporting app data.');
    const rows = (table: string) => (this.store.db.prepare('SELECT * FROM ' + table).all() as Row[]).filter(r=>!this.store.isPrivate(Number(r.media_id)));
    const settings = new SettingsService(this.store).get();
    const library = rows('library').map((r) => ({ mediaId: Number(r.media_id), status: r.status, progress: r.progress, score: r.score, updatedAt: r.updated_at }));
    const progress = rows('progress').map((r) => ({ mediaId: Number(r.media_id), episode: r.episode, position: r.position, duration: r.duration, completed: !!r.completed, updatedAt: r.updated_at }));
    const history = rows('history').map((r) => ({ mediaId: Number(r.media_id), episode: r.episode, position: r.position, duration: r.duration, watchedAt: r.watched_at }));
    const favourites = rows('favourites').map((r) => ({ mediaId: Number(r.media_id), addedAt: r.added_at }));
    const bookmarks = rows('scene_bookmarks').map((r) => ({ mediaId: Number(r.media_id), episode: r.episode, position: r.position, duration: r.duration, note: r.note, tags: JSON.parse(String(r.tags)), createdAt: r.created_at }));
    const skips = rows('skip_ranges').map((r) => ({ mediaId: Number(r.media_id), kind: r.kind, start: r.start, end: r.end, duration: r.duration }));
    const ids = new Set([...library, ...progress, ...history, ...favourites, ...bookmarks, ...skips].map((r) => r.mediaId));
    const media = [...ids].map((id) => this.store.getSnapshot(id) ?? { id, idMal: null, title: 'Unknown title', cover: '', banner: null, format: null, episodes: null });
    const themes = this.store.getKv<SavedTheme[]>('themes:v1', []).map((t) => t.preset).filter((t) => themePresetSchema.safeParse(t).success)
      .map(preset=>({...preset,appearance:{...preset.appearance,accent:preset.appearance.accent==='festival'?'ember' as const:preset.appearance.accent}}));
    // Preserve the established v1 portable palette values. The seasonal rollout is device-local.
    const previous=this.store.getKv<{previous:string}>('theme:festival-2026',{previous:'ember'}).previous;
    const portableAccent=['ember','aqua','violet','sakura','crimson'].includes(previous)?previous:'ember';
    const appearance={...settings.appearance,accent:settings.appearance.accent==='festival'?portableAccent:settings.appearance.accent};
    return this.validate({ format: 'aniverse.backup', version: 1, appVersion, createdAt: new Date().toISOString(),
      settings: { appearance, player: settings.player }, media, library, progress, history, favourites, bookmarks, skips, themes,
      plan: this.privatePlan(this.store.getKv('planner:v1', null)) });
  }
  private privatePlan(plan:AppBackup['plan']):AppBackup['plan'] {
    return plan?{...plan,days:plan.days.map(day=>{const items=day.items.filter(item=>!this.store.isPrivate(item.media.id));return {...day,items,minutes:items.reduce((sum,item)=>sum+item.minutes,0)};})}:null;
  }
  restore(input: unknown, applySettings: boolean): BackupSummary {
    if(this.store.isIncognito())throw new Error('Exit incognito before importing app data.');
    const raw=this.validate(input);
    const b:AppBackup={...raw,media:raw.media.filter(m=>!this.store.isPrivate(m.id)),library:raw.library.filter(r=>!this.store.isPrivate(r.mediaId)),progress:raw.progress.filter(r=>!this.store.isPrivate(r.mediaId)),history:raw.history.filter(r=>!this.store.isPrivate(r.mediaId)),favourites:raw.favourites.filter(r=>!this.store.isPrivate(r.mediaId)),bookmarks:raw.bookmarks.filter(r=>!this.store.isPrivate(r.mediaId)),skips:raw.skips.filter(r=>!this.store.isPrivate(r.mediaId)),plan:this.privatePlan(raw.plan)};
    const summary = this.summary(b);
    const mediaById = new Map(b.media.map((m) => [m.id, m]));
    // Validate everything before opening a transaction. Merge never deletes local records.
    this.store.tx(() => {
      for (const media of b.media) if (!this.store.getSnapshot(media.id)) this.store.upsertSnapshot(media);
      for (const r of b.library) {
        const current = this.store.getLibraryEntry(r.mediaId);
        const deleted = this.store.getTombstone(r.mediaId);
        if ((!current || current.updatedAt < r.updatedAt) && (deleted === null || deleted < r.updatedAt))
          this.store.setLibraryEntry(mediaById.get(r.mediaId)!, r.status, r.progress, r.score, r.updatedAt);
      }
      const progress = this.store.db.prepare(`INSERT INTO progress(media_id,episode,position,duration,completed,source_id,updated_at) VALUES(?,?,?,?,?,NULL,?)
        ON CONFLICT(media_id,episode) DO UPDATE SET position=excluded.position,duration=excluded.duration,completed=excluded.completed,source_id=NULL,updated_at=excluded.updated_at WHERE excluded.updated_at>progress.updated_at`);
      for (const r of b.progress) progress.run(r.mediaId, r.episode, r.position, r.duration, Number(r.completed), r.updatedAt);
      const history = this.store.db.prepare(`INSERT INTO history(media_id,episode,source_id,position,duration,watched_at) VALUES(?,?,NULL,?,?,?)
        ON CONFLICT(media_id,episode) DO UPDATE SET position=excluded.position,duration=excluded.duration,watched_at=excluded.watched_at WHERE excluded.watched_at>history.watched_at`);
      for (const r of b.history) history.run(r.mediaId, r.episode, r.position, r.duration, r.watchedAt);
      for (const r of b.favourites) this.store.db.prepare('INSERT OR IGNORE INTO favourites(media_id,added_at) VALUES(?,?)').run(r.mediaId, r.addedAt);
      const bookmark = this.store.db.prepare(`INSERT INTO scene_bookmarks(media_id,episode,position,duration,source_id,note,tags,created_at)
        SELECT ?,?,?,?,NULL,?,?,? WHERE NOT EXISTS(SELECT 1 FROM scene_bookmarks WHERE media_id=? AND episode=? AND position=? AND created_at=? AND note=?)`);
      for (const r of b.bookmarks) bookmark.run(r.mediaId, r.episode, r.position, r.duration, r.note, JSON.stringify(r.tags), r.createdAt, r.mediaId, r.episode, r.position, r.createdAt, r.note);
      // Source/edition identities are not portable: imported ranges are off pending review.
      const skip = this.store.db.prepare('INSERT OR IGNORE INTO skip_ranges(media_id,kind,start,end,enabled,source_id,duration) VALUES(?,?,?,?,0,NULL,?)');
      for (const r of b.skips) skip.run(r.mediaId, r.kind, r.start, r.end, r.duration);
      const themes = this.store.getKv<SavedTheme[]>('themes:v1', []);
      const fingerprint = (preset: unknown) => createHash('sha256').update(JSON.stringify(preset)).digest('hex');
      const seen = new Set(themes.map((t) => fingerprint(t.preset)));
      for (const preset of b.themes) if (!seen.has(fingerprint(preset)) && themes.length < 30) {
        themes.push({ id: randomUUID(), preset }); seen.add(fingerprint(preset));
      }
      this.store.setKv('themes:v1', themes);
      if (b.plan && !this.store.getKv('planner:v1', null)) this.store.setKv('planner:v1', b.plan);
      if (applySettings) this.store.setKv('settings', sanitize(deepMerge(new SettingsService(this.store).get(), b.settings)));
    });
    // A manual Drive import does not enqueue pushes to AniList/MAL.
    return summary;
  }
}
