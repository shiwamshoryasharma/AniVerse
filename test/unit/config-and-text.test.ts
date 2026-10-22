import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSitesConfig } from '../../app/core/config/sitesConfig';
import { isCloudflareChallenge, isChallengeTitle } from '../../app/core/net/cloudflare';
import { cleanVideoTitle, episodeFromUrl, normalizeTitle, parseEpisodeNumber, seasonOf, titleScore, videoScore } from '../../app/core/sources/text';
import { isEpisodeThread } from '../../app/core/comments';
import { anilistToMarkdown, bbcodeToMarkdown, htmlToMarkdown } from '../../app/core/commentText';
import { deepMerge, stripHtml } from '../../app/core/util';

describe('parseSitesConfig', () => {
  it('reads one URL per line, skipping comments, numbering and duplicates', () => {
    const text = [
      '# comment',
      '',
      '1. https://stream-one.test/home',
      'https://stream-two.test/home',
      '5. https://stream-three.test/',
      '6. https://stream-three.test/',
      'not a url',
      'https://www.youtube.com/@MuseAsia/channels',
      'https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx',
    ].join('\n');
    const { entries, warnings } = parseSitesConfig(text);
    expect(entries.map((e) => e.id)).toEqual(['stream-one-test', 'stream-two-test', 'stream-three-test', 'yt-museasia', 'yt-ucxxxxxxxxxxxxxxxxxxxxxx']);
    expect(entries[3]).toMatchObject({ kind: 'youtube', url: 'https://www.youtube.com/@MuseAsia', youtube: { handle: '@MuseAsia' } });
    expect(entries[0]).toMatchObject({ kind: 'web', host: 'stream-one.test', line: 3 });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/Line 6: duplicate/);
    expect(warnings[1]).toMatch(/Line 7: no http/);
  });

  it('parses the shipped config file', () => {
    const text = readFileSync(new URL('../../config/streaming-sites.txt', import.meta.url), 'utf8');
    const { entries, warnings } = parseSitesConfig(text);
    expect(warnings).toEqual([]);
    expect(entries.length).toBeGreaterThanOrEqual(15);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });
});

describe('episode parsing and title matching', () => {
  it.each([
    ['Frieren: Beyond Journey’s End Episode 12 [Multi-Subs]', 12],
    ['【Multi-Subs】Spy x Family Ep.05', 5],
    ['葬送のフリーレン 第3話「人を殺す魔法」', 3],
    ['Kaiju No. 8 S2E04', 4],
    ['Dandadan #7 | Muse Asia', 7],
    ['Some Show - 09 (English Sub)', 9],
  ])('parses %s', (title, n) => {
    expect(parseEpisodeNumber(title)).toBe(n);
  });

  it('ignores trailers and clips', () => {
    expect(parseEpisodeNumber('Frieren Season 2 | Official Trailer')).toBeNull();
    expect(parseEpisodeNumber('Episode 3 Preview')).toBeNull();
    expect(parseEpisodeNumber('Kaiju No. 8 opening song')).toBeNull();
  });

  it('scores titles', () => {
    expect(titleScore('Frieren: Beyond Journey’s End Episode 1', ['Frieren: Beyond Journey’s End'])).toBe(1);
    expect(titleScore('Totally unrelated cooking show', ['Frieren: Beyond Journey’s End'])).toBeLessThan(0.3);
    expect(normalizeTitle('Re:ZERO -Starting Life-')).toBe('re zero starting life');
  });

  it('prefers season-relative codes and matches seasons', () => {
    const video = 'Sasaki and Peeps - Episode 15 (S2E03) [English Sub]';
    expect(parseEpisodeNumber(video)).toBe(3);
    expect(cleanVideoTitle(video)).toBe('Sasaki and Peeps Season 2');
    expect(seasonOf('Sasaki to Pii-chan 2nd Season')).toBe(2);
    expect(videoScore(video, ['Sasaki and Peeps Season 2', 'Sasaki to Pii-chan 2nd Season'])).toBe(1);
    expect(videoScore(video, ['Sasaki and Peeps', 'Sasaki to Pii-chan'])).toBe(0);
    expect(videoScore('DANDIVINE - Episode 03 [English Sub]', ['Dandivine', 'Juuou Mujin no Dandivine'])).toBe(1);
    expect(videoScore('A Certain Magical Index - Episode 21 (S1E21) [English Sub]', ['A Certain Magical Index'])).toBe(1);
  });

  it('reads episode numbers from site URLs', () => {
    expect(episodeFromUrl('https://site.to/watch/black-clover?ep=5')).toBe(5);
    expect(episodeFromUrl('https://site.to/one-piece-episode-1120')).toBe(1120);
    expect(episodeFromUrl('https://site.to/watch/x/ep-3/')).toBe(3);
    expect(episodeFromUrl('https://site.to/home')).toBeNull();
  });
});

describe('cloudflare detection', () => {
  it('detects the block page fixture', () => {
    const body = readFileSync(new URL('../fixtures/cloudflare-block.html', import.meta.url), 'utf8');
    expect(isCloudflareChallenge(403, { Server: 'cloudflare', 'CF-RAY': 'x' }, body)).toBe(true);
  });
  it('detects cf-mitigated header and ignores normal pages', () => {
    expect(isCloudflareChallenge(403, { 'cf-mitigated': 'challenge' }, '')).toBe(true);
    expect(isCloudflareChallenge(200, { server: 'cloudflare' }, '<title>Just a moment...</title>')).toBe(false);
    expect(isCloudflareChallenge(503, { server: 'nginx' }, '<title>Just a moment...</title>')).toBe(false);
    expect(isChallengeTitle('Just a moment...')).toBe(true);
    expect(isChallengeTitle('Home - Anime')).toBe(false);
  });
});

describe('comment helpers', () => {
  it('matches episode threads', () => {
    expect(isEpisodeThread('[Spoilers] One Piece - Episode 1175 Discussion', 1175)).toBe(true);
    expect(isEpisodeThread('[Spoilers] One Piece - Episode 1175 Discussion', 117)).toBe(false);
    expect(isEpisodeThread('Black Clover Episode 05 Discussion', 5)).toBe(true);
  });
  it('cleans markup', () => {
    expect(stripHtml('Line<br>two &amp; <i>three</i>')).toBe('Line\ntwo & three');
  });
  it('normalises comment bodies from every source to one Markdown dialect', () => {
    // MyAnimeList: BBCode + HTML line breaks + entities (the broken case from the app)
    expect(bbcodeToMarkdown('That&#039;s also true <br />\r\n<br />\r\nNext [b]Great[/b] [spoiler]he dies[/spoiler]')).toBe("That's also true\n\nNext **Great** ~!he dies!~");
    expect(bbcodeToMarkdown('[quote=Ann message=12]first[/quote]reply [url=https://x.io/a]link[/url] [img]https://x.io/i.png[/img]')).toBe(
      '> **Ann** wrote:\n> first\nreply [link](https://x.io/a) ![image](https://x.io/i.png)',
    );
    expect(bbcodeToMarkdown('[url=javascript:alert(1)]bad[/url] <script>x</script>')).toBe('bad x');
    // AniList: its own Markdown plus HTML
    expect(anilistToMarkdown('nice img220(https://x.io/y.png) ~!secret!~ <b>bold</b><br><a href="https://x.io">site</a>')).toBe(
      'nice ![image](https://x.io/y.png) ~!secret!~ **bold**\n[site](https://x.io)',
    );
    expect(htmlToMarkdown('a &amp; b<br/>c <i>d</i>')).toBe('a & b\nc _d_');
  });
});

describe('deepMerge', () => {
  it('merges nested objects and replaces arrays', () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2] })).toEqual({ a: { b: 1, c: 3 }, d: [2] });
  });
});
