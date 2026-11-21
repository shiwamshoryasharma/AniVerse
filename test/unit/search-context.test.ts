import { expect, it, vi } from 'vitest';
import { Store } from '../../app/core/db/store';
import { schemas } from '../../electron/ipc';

vi.mock('electron', () => ({ ipcMain: {} }));

const media = (id: number) => ({ id, idMal: null, title: 'Title ' + id, cover: '', banner: null, format: 'TV' as const, episodes: 12 });

it('validates the current recommendation IPC and the released history request limit', () => {
  expect(schemas['library.history'].safeParse({ limit: 500, offset: 0 }).success).toBe(false);
  expect(schemas['library.history'].safeParse({ limit: 200, offset: 0 }).success).toBe(true);
  expect(schemas['library.searchContext'].parse(undefined)).toBeUndefined();
});

it('combines progress-only imports, history and synced completions while honoring privacy', () => {
  const store = new Store(':memory:');
  try {
    for (const id of [1, 2, 3]) {
      store.saveProgress({ media: media(id), episode: 1, position: 50, duration: 100, sourceId: null }, 0.85);
    }
    store.db.exec('DELETE FROM history WHERE media_id = 2; UPDATE progress SET updated_at = 500 WHERE media_id = 2');
    store.db.exec('UPDATE history SET watched_at = 100 WHERE media_id = 1; UPDATE progress SET updated_at = 100 WHERE media_id = 1');
    store.setLibraryEntry(media(4), 'COMPLETED');
    store.setLibraryEntry(media(5), 'PLANNING');
    store.setLibraryEntry(media(6), 'PAUSED', 3);
    store.setTitlePrivate(3, true);
    expect(store.searchContext()).toEqual({ recent: [2, 1], watched: [2, 1, 6, 4], completed: [4] });
    store.dismissContinue(2);
    expect(store.searchContext().recent).toEqual([1]);
    store.clearHistory(null);
    expect(store.searchContext().recent).toEqual([]);
    expect(store.searchContext().watched).toEqual([2, 1, 6, 4]);
    store.setIncognito(true);
    expect(store.searchContext()).toEqual({ recent: [], watched: [], completed: [] });
  } finally {
    store.close();
  }
});