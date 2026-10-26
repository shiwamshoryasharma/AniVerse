import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../../app/core/db/store';
import { LocalCollection } from '../../electron/collection';
import type { MediaProtocols } from '../../electron/media';
const mocked = vi.hoisted(() => ({ choose: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showOpenDialog: mocked.choose } }));
const base = path.resolve('test/cache/collection-unit');
let root: string, store: Store, collection: LocalCollection;
const grant = vi.fn((file: string) => 'media://local/test-token' + path.extname(file));
beforeEach(async () => {
  await mkdir(base, { recursive: true });
  root = await mkdtemp(path.join(base, 'run-'));
  store = new Store(':memory:');
  grant.mockClear();
  collection = new LocalCollection(store, { grantFile: grant } as unknown as MediaProtocols, () => null);
  mocked.choose.mockResolvedValue({ canceled: false, filePaths: [root] });
});
afterEach(async () => {
  store.close();
  if (!root.startsWith(base + path.sep)) throw new Error('Unsafe cleanup');
  await rm(root, { recursive: true, force: true });
});
describe('local collection boundaries', () => {
  it('indexes selected videos, exposes filenames only, and opens through a capability token', async () => {
    await writeFile(path.join(root, 'Fixture Show - 03.mp4'), 'fixture');
    await writeFile(path.join(root, 'private.txt'), 'not video');
    const { files } = await collection.scan(true);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: 'Fixture Show - 03.mp4', episode: 3, query: 'Fixture Show', missing: false });
    expect(JSON.stringify(files)).not.toContain(root);
    const opened = await collection.open(files[0].id);
    expect(opened.url).toMatch(/^media:\/\/local\//);
    expect(grant).toHaveBeenCalledWith(path.join(root, 'Fixture Show - 03.mp4'));
    collection.remove(files[0].id);
    expect(collection.list()).toEqual([]);
    await expect(import('node:fs/promises').then((fs) => fs.stat(path.join(root, 'Fixture Show - 03.mp4')))).resolves.toBeDefined();
  });
  it('marks removed files missing and refuses paths outside selected roots', async () => {
    const video = path.join(root, 'Fixture.mp4');
    await writeFile(video, 'fixture');
    const { files } = await collection.scan(true);
    await rm(video);
    await collection.scan(false);
    expect(collection.list()[0].missing).toBe(true);
    await expect(collection.open(files[0].id)).rejects.toThrow(/moved|outside/);
    store.db.prepare('UPDATE local_media SET path=? WHERE id=?').run(path.resolve('test/fixtures/outside.mp4'), files[0].id);
    await expect(collection.open(files[0].id)).rejects.toThrow();
  });
  it('locks before the folder dialog so concurrent scans cannot race', async () => {
    let release!: (value: unknown) => void;
    mocked.choose.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = collection.scan(true);
    await expect(collection.scan(true)).rejects.toThrow(/already running/);
    release({ canceled: true, filePaths: [] });
    await first;
  });
  it('keeps user-confirmed episode matching across refreshes', async () => {
    await writeFile(path.join(root, 'Fixture - 02.webm'), 'fixture');
    const { files } = await collection.scan(true);
    collection.match(files[0].id, { id: 7, idMal: null, title: 'Confirmed title', cover: '', banner: null, format: 'TV', episodes: 12 }, 4);
    await collection.scan(false);
    expect(collection.list()[0]).toMatchObject({ episode: 4, media: { id: 7, title: 'Confirmed title' } });
  });
});
