import { describe, expect, it } from 'vitest';
import { Store } from '../../app/core/db/store';
import { WorkspaceService } from '../../app/core/workspace';
import { buildWatchPlan, parseLocalFilename, hideEpisode, canAutoSkip } from '../../app/shared/workspace';
import { themePresetSchema } from '../../app/shared/theme';

const media = { id: 7, idMal: null, title: 'Fixture series', cover: '', banner: null, format: 'TV' as const, episodes: 12 };
describe('Episode Toolkit persistence', () => {
  it('saves, edits, searches and deletes scene bookmarks without changing playback history', () => {
    const store = new Store(':memory:');
    const service = new WorkspaceService(store);
    const mark = service.saveBookmark({
      media,
      episode: 3,
      position: 91.5,
      duration: 1440,
      sourceId: 'source-test',
      note: ' A great scene ',
      tags: [' favourite ', 'favourite'],
    });
    expect(service.bookmarks({ mediaId: 7 })[0]).toMatchObject({ id: mark.id, episode: 3, position: 91.5, note: 'A great scene', tags: ['favourite'] });
    service.saveBookmark({ ...mark, media, note: 'Revised note' });
    expect(service.bookmarks({ search: 'revised' })).toHaveLength(1);
    expect(store.listHistory(100, 0)).toEqual([]);
    service.deleteBookmark(mark.id);
    expect(service.bookmarks({})).toEqual([]);
    store.close();
  });
  it('returns the edited bookmark even when it is older than the latest 500 scenes', () => {
    const store = new Store(':memory:');
    const service = new WorkspaceService(store);
    const first = service.saveBookmark({ media, episode: 1, position: 10, duration: 1440, sourceId: null, note: 'First', tags: [] });
    const insert = store.db.prepare(
      "INSERT INTO scene_bookmarks(media_id,episode,position,duration,source_id,note,tags,created_at) VALUES(7,1,10,1440,NULL,'Newer','[]',?)",
    );
    for (let i = 0; i < 501; i++) insert.run(Date.now() + i + 1000);
    expect(service.saveBookmark({ ...first, note: 'Still editable' })).toMatchObject({ id: first.id, note: 'Still editable' });
    store.close();
  });
  it('validates skip ranges, persists them, and replaces the chosen intro/outro only', () => {
    const store = new Store(':memory:');
    const service = new WorkspaceService(store);
    service.saveSkip({ mediaId: 7, kind: 'intro', start: 20, end: 105, enabled: true, sourceId: null, duration: 1440 });
    service.saveSkip({ mediaId: 7, kind: 'outro', start: 1320, end: 1440, enabled: false, sourceId: null, duration: 1440 });
    expect(() => service.saveSkip({ mediaId: 7, kind: 'intro', start: 100, end: 90, enabled: true, sourceId: null, duration: 1440 })).toThrow();
    expect(service.skips(7)).toHaveLength(2);
    service.deleteSkip(7, 'intro');
    expect(service.skips(7)[0].kind).toBe('outro');
    store.close();
  });
  it('measures real viewing intervals without counting seeks, pauses or duplicate samples', () => {
    const store = new Store(':memory:');
    let now = 100000;
    const service = new WorkspaceService(store, () => now);
    const point = {
      sessionId: 'fixture-session',
      mediaId: 7,
      episode: 1,
      sourceId: 'source-test',
      position: 10,
      duration: 1440,
      paused: false,
      droppedFrames: 0,
      totalFrames: 10,
    };
    service.record(point);
    now += 5000;
    service.record({ ...point, position: 15, totalFrames: 130 });
    service.record({ ...point, position: 15, totalFrames: 130 });
    now += 5000;
    service.record({ ...point, position: 200, totalFrames: 140 });
    now += 5000;
    service.record({ ...point, position: 200, paused: true, totalFrames: 140 });
    expect(service.insights().watchedSeconds).toBe(5);
    store.close();
  });
});
describe('skip edition boundaries', () => {
  const range = { mediaId: 7, kind: 'intro' as const, start: 10, end: 90, enabled: true, sourceId: 'fixture-source', duration: 1440 };
  it('does not reuse ranges across sources or substantially different editions', () => {
    expect(canAutoSkip(range, 1441, 'fixture-source')).toBe(true);
    expect(canAutoSkip(range, 1440, 'other-source')).toBe(false);
    expect(canAutoSkip(range, 1300, 'fixture-source')).toBe(false);
    expect(canAutoSkip(range, Number.NaN, 'fixture-source')).toBe(false);
  });
});
describe('insight aggregation', () => {
  it('combines separate viewing sessions of the same episode', () => {
    const store = new Store(':memory:');
    let now = 100000;
    const service = new WorkspaceService(store, () => now);
    for (const sessionId of ['first', 'second']) {
      for (let i = 0; i <= 4; i++) {
        service.record({ sessionId, mediaId: 7, episode: 1, sourceId: null, position: i * 10, duration: 1440, paused: false });
        now += 10000;
      }
    }
    expect(service.insights().watchedSeconds).toBe(80);
    expect(service.insights().episodes).toBe(1);
    expect(service.insights().sources[0].sourceId).toBeNull();
    store.close();
  });
});
describe('weekly planning and filenames', () => {
  it('never exceeds the budget or plans an already watched/unavailable episode', () => {
    const plan = buildWatchPlan([{ media, progress: 2, available: 4, minutes: 24, estimated: false }], 30, '2026-10-26');
    expect(plan.days).toHaveLength(7);
    expect(plan.days.flatMap((day) => day.items).map((item) => item.episode)).toEqual([3, 4]);
    expect(plan.days.every((day) => day.minutes <= 30)).toBe(true);
  });
  it('leaves oversized movies unscheduled rather than exceeding the daily budget', () => {
    const plan = buildWatchPlan([{ media: { ...media, episodes: 1 }, progress: 0, available: 1, minutes: 110, estimated: false }], 30, '2026-10-26');
    expect(plan.days.flatMap((day) => day.items)).toEqual([]);
    expect(plan.unscheduled).toBe(1);
  });
  it('parses episode numbering without confusing resolution with episode numbers', () => {
    expect(parseLocalFilename('[Group] My.Show.S02E03.1080p.mkv')).toMatchObject({ query: 'My Show Season 2', episode: 3 });
    expect(parseLocalFilename('My Show - 012 [1080p].mp4')).toMatchObject({ query: 'My Show', episode: 12 });
    expect(parseLocalFilename('A Film 1080p.mp4').episode).toBeNull();
  });
  it('hides only unreached episode names and thumbnails', () => {
    expect(hideEpisode(5, 3, new Set([1, 2]), true)).toBe(true);
    expect(hideEpisode(3, 3, new Set(), true)).toBe(false);
    expect(hideEpisode(5, 3, new Set([5]), true)).toBe(false);
  });
});
describe('portable themes', () => {
  const preset = {
    version: 1,
    name: 'Night',
    appearance: { accent: 'aqua', density: 'compact', fontFamily: 'inter', reduceMotion: false },
    player: { theater: true, preferredQuality: '1080' },
  };
  it('accepts visual settings while rejecting secrets and unknown properties', () => {
    expect(themePresetSchema.parse(preset)).toEqual({ ...preset, appearance: { ...preset.appearance, style: 'classic' } });
    expect(() => themePresetSchema.parse({ ...preset, accounts: { token: 'never-import' } })).toThrow();
    expect(() => themePresetSchema.parse({ ...preset, appearance: { ...preset.appearance, fontFamily: 'url(unsafe)' } })).toThrow();
  });
});
