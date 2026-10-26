import { dialog, type BrowserWindow } from 'electron';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '../app/core/db/store';
import { AppError } from '../app/core/util';
import type { MediaSnapshot } from '../app/shared/types';
import { parseLocalFilename, type LocalMedia } from '../app/shared/workspace';
import type { MediaProtocols } from './media';

const VIDEO = /\.(mp4|m4v|mkv|webm|mov)$/i;
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
};
export class LocalCollection {
  private scanning = false;
  constructor(
    private store: Store,
    private protocols: MediaProtocols,
    private window: () => BrowserWindow | null,
  ) {}
  list(): LocalMedia[] {
    return (this.store.db.prepare('SELECT * FROM local_media ORDER BY missing ASC,name COLLATE NOCASE LIMIT 2000').all() as Record<string, unknown>[]).map(
      (row) => ({
        id: Number(row.id),
        name: String(row.name),
        bytes: Number(row.bytes),
        query: String(row.query),
        episode: row.episode === null ? null : Number(row.episode),
        media: row.media_id === null ? null : this.store.getSnapshot(Number(row.media_id)),
        missing: !!row.missing,
      }),
    );
  }
  async scan(choose: boolean): Promise<{ files: LocalMedia[]; skipped: number }> {
    if (this.scanning) throw new AppError('invalid-input', 'A folder scan is already running.');
    this.scanning = true;
    try {
      let roots = this.store.getKv<string[]>('collection:roots', []);
      if (choose || !roots.length) {
        const options = { title: 'Choose your local video folder', properties: ['openDirectory' as const] };
        const win = this.window();
        const selected = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
        if (selected.canceled || !selected.filePaths[0]) return { files: this.list(), skipped: 0 };
        const root = await realpath(selected.filePaths[0]);
        roots = [...new Set([...roots, root])].slice(-10);
        this.store.setKv('collection:roots', roots);
      }
      let skipped = 0,
        count = 0;
      for (const root of roots) {
        const existing = this.store.db.prepare('SELECT id,path FROM local_media').all() as { id: number; path: string }[];
        const seen = new Set<string>();
        let complete = true;
        const pending = [{ folder: root, depth: 0 }];
        while (pending.length && count < 2000) {
          const { folder, depth } = pending.shift()!;
          const entries = await readdir(folder, { withFileTypes: true }).catch(() => {
            skipped++;
            complete = false;
            return [];
          });
          for (const entry of entries) {
            if (count >= 2000) {
              skipped++;
              complete = false;
              break;
            }
            if (entry.isSymbolicLink()) continue;
            const file = path.join(folder, entry.name);
            if (entry.isDirectory() && depth < 6 && !entry.name.startsWith('.')) pending.push({ folder: file, depth: depth + 1 });
            else if (entry.isFile() && VIDEO.test(entry.name)) {
              const info = await stat(file).catch(() => null);
              if (!info) {
                skipped++;
                continue;
              }
              const parsed = parseLocalFilename(entry.name);
              this.store.db
                .prepare(
                  'INSERT INTO local_media(path,name,bytes,query,episode,missing) VALUES(?,?,?,?,?,0) ON CONFLICT(path) DO UPDATE SET bytes=excluded.bytes,missing=0',
                )
                .run(file, entry.name, info.size, parsed.query, parsed.episode);
              seen.add(file);
              count++;
            }
          }
        }
        if (pending.length) {
          skipped += pending.length;
          complete = false;
        }
        if (complete)
          this.store.tx(() => {
            for (const row of existing)
              if (inside(root, row.path) && !seen.has(row.path)) this.store.db.prepare('UPDATE local_media SET missing=1 WHERE id=?').run(row.id);
          });
      }
      return { files: this.list(), skipped };
    } finally {
      this.scanning = false;
    }
  }
  match(id: number, media: MediaSnapshot, episode: number) {
    const exists = this.store.db.prepare('SELECT id FROM local_media WHERE id=?').get(id);
    if (!exists) throw new AppError('not-found', 'This file is no longer in the collection.');
    this.store.upsertSnapshot(media);
    this.store.db.prepare('UPDATE local_media SET media_id=?,episode=? WHERE id=?').run(media.id, episode, id);
    return this.list().find((file) => file.id === id)!;
  }
  remove(id: number) {
    this.store.db.prepare('DELETE FROM local_media WHERE id=?').run(id);
  }
  async open(id: number) {
    const row = this.store.db.prepare('SELECT * FROM local_media WHERE id=?').get(id) as
      { path: string; name: string; media_id: number | null; episode: number | null } | undefined;
    if (!row) throw new AppError('not-found', 'This local file is no longer listed.');
    const file = await realpath(row.path).catch(() => null);
    const roots = this.store.getKv<string[]>('collection:roots', []);
    if (!file || !roots.some((root) => inside(root, file)) || !VIDEO.test(file))
      throw new AppError('not-found', 'The file moved or is outside the folders you selected. Scan the folder again.');
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new AppError('not-found', 'The local video is unavailable.');
    return {
      url: this.protocols.grantFile(file),
      name: row.name,
      media: row.media_id === null ? null : this.store.getSnapshot(row.media_id),
      episode: row.episode,
    };
  }
}
