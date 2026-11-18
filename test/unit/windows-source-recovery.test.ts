import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { RustPolicy } from '../../app/core/security/rustPolicy';
import { SiteNavigator } from '../../electron/siteNavigator';
import { SourceFallback } from '../../app/shared/sourceFallback';

const source = { id: 'old', name: 'Old', url: 'https://old.test', host: 'old.test', partition: 'persist:src-old' };
const target = { id: 'new', enabled: true };
const wes = new RustPolicy(readFileSync('dist/electron/security.wasm'));

it('recognizes only the exact HTTPS destination for a source handoff', () => {
  const req = { context: 'handoff' as const, source: 'https://new.test' };
  expect(wes.decide({ ...req, url: 'https://new.test/watch/2' }).allowed).toBe(true);
  for (const url of ['https://sub.new.test/watch/2', 'http://new.test/watch/2', 'https://new.test:444/watch/2']) {
    expect(wes.decide({ ...req, url }).allowed).toBe(false);
  }
});

it('tries the configured redirect destination first without re-entering previously failed sources', () => {
  const fallback = new SourceFallback();
  const sources = [{ id: 'old', enabled: true }, { id: 'other', enabled: true }, target];
  expect(fallback.unavailable('episode-2', 'old', sources, 'new')).toEqual({ kind: 'switch', sourceId: 'new' });
  expect(fallback.unavailable('episode-2', 'new', sources, 'old')).toEqual({ kind: 'switch', sourceId: 'other' });
});

it('ends a redirected cached episode without inspecting or saving the previous page', async () => {
  const setSiteLink = vi.fn();
  const store = { getSiteLinks: () => ({ 2: 'https://old.test/watch/2' }), getPin: () => null,
    isPrivate: () => false, getKv: () => null, setSiteLink };
  const navigator = new SiteNavigator(store as never, {} as never, '', vi.fn(), async () => null, () => false);
  const wc = {
    id: 1, isDestroyed: () => false, getURL: () => 'https://old.test/watch/1', getTitle: () => 'Episode 1',
    isLoading: () => false, setAudioMuted: vi.fn(), executeJavaScriptInIsolatedWorld: vi.fn(async () => null),
    loadURL: vi.fn(async () => { navigator.navigationBlocked(wc as never, 'new'); }),
  };
  const result = await navigator.openEpisode(wc as never, source as never,
    { webContentsId: 1, sourceId: 'old', mediaId: 23, titles: ['Fixture'], episode: 2 });
  expect(result).toMatchObject({ ok: false, failure: 'redirect', destinationSourceId: 'new' });
  expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  expect(setSiteLink).not.toHaveBeenCalled();
  expect(wc.setAudioMuted).toHaveBeenLastCalledWith(false);
});

it('allows public, same-origin HTTPS MP4 downloads and rejects pages and private destinations', () => {
  const decide = (url: string, origin = 'https://old.test') => wes.decide({ context: 'mp4' as const, url, source: origin }).allowed;
  expect(decide('https://old.test/clip.MP4?v=2')).toBe(true);
  for (const url of ['https://old.test/watch', 'https://old.test/clip.m3u8', 'https://new.test/clip.mp4', 'http://old.test/clip.mp4']) {
    expect(decide(url)).toBe(false);
  }
  expect(decide('https://127.0.0.1/clip.mp4', 'https://127.0.0.1')).toBe(false);
  expect(wes.isMp4Header(Buffer.from('000000146674797069736f6d000000006d703432', 'hex'))).toBe(true);
  expect(wes.isMp4Header(Buffer.from('0000001466747970717420200000000071742020', 'hex'))).toBe(false);
  expect(wes.isMp4Header(Buffer.from('<html>Not a video.</html>'))).toBe(false);
});
