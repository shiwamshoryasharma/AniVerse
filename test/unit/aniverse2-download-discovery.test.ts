import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const script = readFileSync('native/aniverse2/src/player/download-guest.js', 'utf8');
const playlist = 'https://media.example.test/episode.m3u8?ticket=opaque%2Fvalue';
const segment = 'https://media.example.test/part.webp?chunk=2';
function discover(options: { resources?: string[]; drm?: boolean; tracks?: object[]; videos?: number } = {}) {
  const video = {
    clientWidth: 640, clientHeight: 360, checkVisibility: () => true,
    readyState: 4, videoWidth: 320, duration: 10, currentTime: 1,
    currentSrc: 'blob:https://source.example.test/selected', mediaKeys: options.drm ? {} : null, srcObject: null,
    querySelectorAll: () => options.tracks ?? [],
  };
  return runInNewContext(script, {
    document: { querySelector: () => null, querySelectorAll: () => Array(options.videos ?? 1).fill(video) },
    HTMLIFrameElement: class {}, URL,
    performance: { getEntriesByType: () => (options.resources ?? [playlist, segment]).map(name => ({ name, initiatorType: 'fetch' })) },
  });
}
describe('selected-player HLS discovery', () => {
  it('keeps signed playlist and image-suffix fragment references as bounded evidence', () => {
    const offer = discover();
    expect(offer).toMatchObject({ media: 'blob:https://source.example.test/selected', url: playlist });
    expect(offer.playlists).toEqual([playlist]);
    expect(offer.observations).toContain(segment);
  });
  it('does not require a conventional TS suffix anywhere in the observed requests', () => {
    const manifest = 'https://media.example.test/episode.m3u8';
    const fragments = ['https://media.example.test/0.png', 'https://media.example.test/1.webp'];
    const offer = discover({ resources: [manifest, ...fragments] });
    expect(offer?.playlists).toEqual([manifest]);
    expect(offer?.observations).toEqual([...fragments].reverse());
  });
  it('retains only the selected accessible DOM text track as an explicit subtitle hint', () => {
    const subtitle = { src: 'https://captions.example.test/en.vtt?ticket=opaque', kind: 'subtitles', srclang: 'en', label: 'English',
      track: { mode: 'showing', language: 'en', label: 'English' }, getAttribute: (name: string) => name === 'kind' ? 'subtitles' : null };
    expect(discover({ tracks: [subtitle] })?.subtitle).toEqual({ url: subtitle.src, language: 'en', label: 'English' });
  });
  it('does not offer protected playback or an ambiguous pair of visible videos', () => {
    expect(discover({ drm: true })).toBeNull();
    expect(discover({ videos: 2 })).toBeNull();
  });
  it('bounds candidate lists and rejects credentials and fragment-bearing references', () => {
    const invalid = ['https://u:p@media.example.test/private.webp', 'https://media.example.test/a.png#private'];
    const offer = discover({ resources: [playlist, ...Array.from({ length: 80 }, (_, index) => 'https://media.example.test/'+index+'.png'), ...invalid] });
    expect(offer.observations.length).toBeLessThanOrEqual(32);
    expect(offer.observations.some((url: string) => invalid.includes(url))).toBe(false);
  });
});
