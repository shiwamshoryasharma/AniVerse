import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const script = readFileSync('native/aniverse2/src/player/download-guest.js', 'utf8');
const playlist = 'https://media.example.test/episode.m3u8?ticket=opaque%2Fvalue';
const segment = 'https://media.example.test/part.webp?chunk=2';
function discover(options: { resources?: string[]; drm?: boolean; tracks?: object[]; videos?: number; currentSrc?: string } = {}) {
  const video = {
    clientWidth: 640, clientHeight: 360, checkVisibility: () => true,
    readyState: 4, videoWidth: 320, duration: 10, currentTime: 1,
    currentSrc: options.currentSrc ?? 'blob:https://source.example.test/selected', mediaKeys: options.drm ? {} : null, srcObject: null,
    querySelectorAll: () => options.tracks ?? [],
  };
  return runInNewContext(script, {
    document: { querySelector: () => null, querySelectorAll: () => Array(options.videos ?? 1).fill(video) },
    HTMLIFrameElement: class {}, URL, crypto: { randomUUID },
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

it('binds the same document/video node while request order advances and rejects replacement identity',()=>{
  let video={clientWidth:640,clientHeight:360,checkVisibility:()=>true,readyState:4,videoWidth:320,duration:120,currentSrc:'blob:https://source.example.test/selected',mediaKeys:null,srcObject:null,querySelectorAll:()=>[]};
  const resources=['https://media.example.test/master.m3u8','https://media.example.test/video.m3u8','https://media.example.test/1.webp'];
  const context=createContext({document:{querySelector:()=>null,querySelectorAll:()=>[video]},HTMLIFrameElement:class{},URL,crypto:{randomUUID},performance:{getEntriesByType:()=>resources.map(name=>({name,initiatorType:'fetch'}))}});
  const selected=runInContext(script,context);
  resources.push('https://media.example.test/audio.m3u8','https://media.example.test/2.png');
  const advanced=runInContext(script,context);
  expect(advanced.identity).toBe(selected.identity);
  expect(advanced.url).not.toBe(selected.url);
  video={...video};
  expect(runInContext(script,context).identity).not.toBe(selected.identity);
});

it('passes an extensionless direct player URL and exact received resource hints to the native observer', () => {
  const direct = 'https://media.example.test/episode?ticket=opaque%2Fvalue';
  expect(discover({ currentSrc: direct, resources: [direct] })).toMatchObject({
    media: direct, url: direct, resources: [direct],
  });
  expect(discover({ resources: ['https://media.example.test/manifest?id=1', segment] })).toMatchObject({
    resources: [segment, 'https://media.example.test/manifest?id=1'],
  });
});
