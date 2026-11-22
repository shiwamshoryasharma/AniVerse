import { describe, expect, it } from 'vitest';
import { episodeDownloadFilename } from '../../app/shared/download-filename';

describe('episode download filenames', () => {
  it('uses series, explicit season, and zero-padded episode rather than a manifest basename', () => {
    expect(episodeDownloadFilename({ title: 'Example Series', season: 2, episode: 7 })).toBe('Example Series - S02E07.mp4');
    expect(episodeDownloadFilename({ title: 'Example Series', episode: 120 })).toBe('Example Series - S01E120.mp4');
  });
  it('keeps Unicode and makes the suggestion a single Windows filename', () => {
    expect(episodeDownloadFilename({ title: '  例の物語 / 帰還: 「空」?  ', season: 3, episode: 9 })).toBe('例の物語 _ 帰還_ 「空」_ - S03E09.mp4');
    expect(episodeDownloadFilename({ title: '../CON', episode: 1 })).not.toMatch(/[\\/<>:"|?*]/);
    expect(episodeDownloadFilename({ title: 'CON', episode: 1 })).toBe('_CON - S01E01.mp4');
    expect(episodeDownloadFilename({ title: ' ... ', episode: 1 })).toBe('Series - S01E01.mp4');
  });
  it('bounds Unicode length without splitting surrogate pairs', () => {
    const name = episodeDownloadFilename({ title: '🌙'.repeat(140), season: 99, episode: 10_000 });
    expect(name).toBe('🌙'.repeat(100) + ' - S99E10000.mp4');
    expect(name!.length).toBeLessThan(255);
  });
  it('rejects malformed context without using it as a pathname or media permission', () => {
    for (const context of [{ title: '', episode: 1 }, { title: 'Series', season: 0, episode: 1 },
      { title: 'Series', episode: 1.5 }, { title: 'Series', episode: 0 }, { title: 'Series', episode: 10_001 },
      { title: 'x'.repeat(301), episode: 1 }, { title: 'Series', episode: 1, destination: 'C:\\other' }]) {
      expect(episodeDownloadFilename(context)).toBeNull();
    }
  });
});