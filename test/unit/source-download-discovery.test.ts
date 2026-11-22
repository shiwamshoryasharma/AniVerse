import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const script = readFileSync('electron/sourceMp4Guest.js', 'utf8');
function inspect(resources: string[], overrides: Record<string, unknown> = {}) {
  const track = { mode: 'showing', kind: 'subtitles', language: 'en', label: 'English' };
  const video = { clientWidth: 640, clientHeight: 360, checkVisibility: () => true,
    readyState: 4, videoWidth: 640, duration: 120, currentSrc: 'blob:https://player.example.test/playing',
    mediaKeys: null, srcObject: null, textTracks: [track],
    querySelectorAll: () => [{ track, src: 'https://captions.example.test/en.vtt?opaque=1' }], ...overrides };
  return runInNewContext(script, { URL, HTMLIFrameElement: class {},
    document: { querySelector: () => null, querySelectorAll: () => [video] },
    performance: { getEntriesByType: () => resources.map(name => ({ name, initiatorType: 'xmlhttprequest' })) } });
}
describe('owned playing HLS discovery', () => {
  it('keeps bounded playlist and opaque fragment observations without guessing from suffixes', () => {
    const result = inspect(['https://media.example.test/master.m3u8?opaque=1',
      'https://media.example.test/video.m3u8?opaque=2', 'https://media.example.test/part-1.png?opaque=3',
      'https://media.example.test/part-2.webp?opaque=4', 'https://media.example.test/unrelated.json']);
    expect(result.expectedDuration).toBe(120);
    expect(result.playlists).toEqual(['https://media.example.test/video.m3u8?opaque=2', 'https://media.example.test/master.m3u8?opaque=1']);
    expect(result.observations).toContain('https://media.example.test/part-2.webp?opaque=4');
    expect(result.subtitle).toEqual({ url: 'https://captions.example.test/en.vtt?opaque=1', language: 'en', label: 'English' });
  });
  it('never treats standalone image requests as a playlist', () => {
    expect(inspect(['https://media.example.test/picture.png'])).toBeNull();
  });
  it('retains ownership, finite-duration and protected-video checks', () => {
    const resources = ['https://media.example.test/video.m3u8', 'https://media.example.test/a.png'];
    expect(inspect(resources, { mediaKeys: {} })).toBeNull();
    expect(inspect(resources, { duration: Infinity })).toBeNull();
    expect(inspect(resources, { clientWidth: 20 })).toBeNull();
  });
  it('bounds noisy histories and excludes credentialized resource URLs', () => {
    const result = inspect(['https://media.example.test/episode.m3u8',
      ...Array.from({ length: 80 }, (_, i) => `https://media.example.test/${i}.webp?part=${i}`),
      'https://user:password@media.example.test/private.webp']);
    expect(result.observations).toHaveLength(32);
    expect(result.observations.some((url: string) => url.includes('password'))).toBe(false);
  });
});
