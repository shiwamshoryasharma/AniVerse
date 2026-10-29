import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseSitesConfig } from '../../app/core/config/sitesConfig';
import { Store } from '../../app/core/db/store';
import { AniListClient, browseQuery, browseVariables, currentSeason, mapCard } from '../../app/core/metadata/anilist';
import { SourceRegistry, WebSiteAdapter } from '../../app/core/sources/registry';
import type { SiteFetcher } from '../../app/core/sources/types';
import { buildSearchUrl, discoverFromHtml, findSearchForm, isValidTemplate, parseOpenSearch, siteDomain } from '../../app/core/sources/web';
import { parseYouTubeFeed, toEpisodes, YouTubeAdapter } from '../../app/core/sources/youtube';
import type { MediaRef } from '../../app/shared/types';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

describe('web search discovery', () => {
  it('finds a GET search form', () => {
    expect(findSearchForm(fixture('site-form.html'), 'https://stream-two.test/home')).toBe('https://stream-two.test/filter?keyword={query}');
  });
  it('falls back to schema.org SearchAction', () => {
    expect(discoverFromHtml(fixture('site-jsonld.html'), 'https://www.stream-four.test/')).toEqual({ template: 'https://www.stream-four.test/search?query={query}', via: 'jsonld' });
  });
  it('parses OpenSearch descriptions', () => {
    const xml = '<OpenSearchDescription><Url type="text/html" template="https://x.to/search?q={searchTerms}&amp;page={startPage?}"/></OpenSearchDescription>';
    expect(parseOpenSearch(xml)).toBe('https://x.to/search?q={query}');
  });
  it('keeps hidden form inputs and builds URLs', () => {
    const html = '<form action="/browse"><input type="hidden" name="type" value="anime"><input name="q"></form>';
    const t = findSearchForm(html, 'https://a.to/');
    expect(t).toBe('https://a.to/browse?type=anime&q={query}');
    expect(buildSearchUrl(t!, 'Black Clover')).toBe('https://a.to/browse?type=anime&q=Black+Clover');
    expect(buildSearchUrl('https://a.to/search/{query}', 'a b')).toBe('https://a.to/search/a%20b');
    expect(isValidTemplate('javascript:{query}')).toBe(false);
    expect(siteDomain('www.sub.example.co.uk')).toBe('example.co.uk');
    expect(siteDomain('stream-one.test')).toBe('stream-one.test');
  });
});

describe('YouTube adapter helpers', () => {
  const feed = `<feed>
    <entry><yt:videoId>aaaaaaaaaaa</yt:videoId><title>Frieren Episode 2 [Multi-Subs]</title><published>2026-10-01T10:00:00+00:00</published><media:thumbnail url="https://i.ytimg.com/a.jpg"/></entry>
    <entry><yt:videoId>bbbbbbbbbbb</yt:videoId><title>Frieren Episode 1 [Multi-Subs]</title><published>2026-09-24T10:00:00+00:00</published></entry>
    <entry><yt:videoId>ccccccccccc</yt:videoId><title>Frieren | Official Trailer</title><published>2026-09-01T10:00:00+00:00</published></entry>
  </feed>`;
  it('parses the RSS feed into ordered episodes', () => {
    const videos = parseYouTubeFeed(feed);
    expect(videos).toHaveLength(3);
    expect(toEpisodes(videos).map((e) => [e.number, e.ref])).toEqual([
      [1, 'bbbbbbbbbbb'],
      [2, 'aaaaaaaaaaa'],
    ]);
  });

  it('matches episodes through the registry without an API key (RSS)', async () => {
    const store = new Store(':memory:');
    const fetcher: SiteFetcher = {
      get: vi.fn(async (_id: string, url: string) => {
        if (url.includes('/feeds/videos.xml')) return { status: 200, url, text: feed, headers: {} };
        return { status: 200, url, text: '<link rel="canonical" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv">', headers: {} };
      }),
    };
    const yt = new YouTubeAdapter(vi.fn(), fetcher, store, () => '');
    const registry = new SourceRegistry(store, fetcher, [new WebSiteAdapter(), yt]);
    registry.setEntries(parseSitesConfig('https://www.youtube.com/@MuseAsia/channels').entries);
    const ref: MediaRef = { id: 1, idMal: null, titles: ['Frieren'], episodes: 28, format: 'TV', seasonYear: 2023 };
    const match = await registry.match('yt-museasia', ref);
    expect(match.mode).toBe('episodes');
    expect(match.episodes.map((e) => e.number)).toEqual([1, 2]);
    expect(match.note).toMatch(/API key/);
    expect(await registry.streams('yt-museasia', 'aaaaaaaaaaa')).toEqual([{ type: 'youtube', videoId: 'aaaaaaaaaaa', label: 'YouTube · official embed' }]);
    // Channel id is resolved once and cached.
    await registry.match('yt-museasia', { ...ref, id: 2 });
    expect((fetcher.get as ReturnType<typeof vi.fn>).mock.calls.filter((c) => !String(c[1]).includes('feeds')).length).toBe(1);
  });
});

describe('SourceRegistry (web)', () => {
  it('discovers search, honours overrides and pins', async () => {
    const store = new Store(':memory:');
    const fetcher: SiteFetcher = { get: vi.fn(async (_id: string, url: string) => ({ status: 200, url, text: fixture('site-form.html'), headers: {} })) };
    const registry = new SourceRegistry(store, fetcher, [new WebSiteAdapter()]);
    registry.setEntries(parseSitesConfig('https://stream-two.test/home\nhttps://stream-one.test/home').entries);
    const ref: MediaRef = { id: 7, idMal: null, titles: ['Black Clover'], episodes: null, format: 'TV', seasonYear: 2017 };

    const match = await registry.match('stream-two-test', ref);
    expect(match.pageUrl).toBe('https://stream-two.test/filter?keyword=Black+Clover');
    expect(registry.get('stream-two-test').searchTemplateSource).toBe('form');

    registry.update('stream-two-test', { searchTemplate: 'https://stream-two.test/search?q={query}' });
    expect((await registry.match('stream-two-test', ref)).pageUrl).toBe('https://stream-two.test/search?q=Black+Clover');
    expect(() => registry.update('stream-two-test', { searchTemplate: 'https://stream-two.test/search' })).toThrow(/\{query\}/);

    store.setPin('stream-two-test', 7, 'https://stream-two.test/watch/black-clover');
    expect(await registry.match('stream-two-test', ref)).toMatchObject({ pageUrl: 'https://stream-two.test/watch/black-clover', pinned: true });

    registry.update('stream-one-test', { enabled: false });
    await expect(registry.match('stream-one-test', ref)).rejects.toThrow(/disabled/);
    expect(registry.list().map((s) => s.partition)).toEqual(['persist:src-stream-two-test', 'persist:src-stream-one-test']);
  });
});

describe('AniList client', () => {
  const home = JSON.parse(fixture('anilist-home.json'));

  it('maps media cards', () => {
    const card = mapCard(home.data.trending.media[0]);
    expect(card.id).toBeTypeOf('number');
    expect(card.cover).toMatch(/^https:\/\//);
    expect(Array.isArray(card.genres)).toBe(true);
  });

  it('builds browse variables', () => {
    const vars = browseVariables({ search: ' frieren ', genres: ['Drama'], sort: 'SCORE_DESC', minScore: 70, excludeLibrary: true }, [5, 6], false);
    expect(vars).toMatchObject({ search: 'frieren', genre_in: ['Drama'], sort: ['SEARCH_MATCH', 'SCORE_DESC'], averageScore_greater: 69, id_not_in: [5, 6], isAdult: false });
    // Unset filters are omitted, never sent as null (AniList 500s on some null args).
    expect(browseVariables({}, [], true)).toEqual({ page: 1, perPage: 30, sort: ['POPULARITY_DESC'] });
    const q = browseQuery(['genre_in', 'sort']);
    expect(q).toContain('$genre_in: [String]');
    expect(q).toContain('genre_in: $genre_in');
    expect(q).not.toContain('id_not_in');
  });

  it('computes AniList seasons', () => {
    expect(currentSeason(new Date(2026, 9, 22))).toEqual({ season: 'FALL', year: 2026 });
    expect(currentSeason(new Date(2026, 11, 5))).toEqual({ season: 'WINTER', year: 2027 });
  });

  it('caches nearby home requests and fails offline without cached data', async () => {
    const initialNow=Date.now();
    const bucketStart=initialNow-initialNow%300000;
    const clock=vi.spyOn(Date,'now').mockReturnValue(bucketStart+10000);
    const store=new Store(':memory:');
    try {
      const fetchFn=vi.fn(async()=>new Response(JSON.stringify(home),{status:200}));
      const client=new AniListClient(fetchFn,store,{showAdult:()=>false,token:()=>null});
      const first=await client.home();
      expect(first.trending.length).toBe(20);
      expect(first.spotlight.every(m=>m.banner)).toBe(true);
      clock.mockReturnValue(bucketStart+12000);
      await client.home();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      store.cachePurge(true);
      const offline=new AniListClient(vi.fn(async()=>{throw new Error('offline');}),store,{showAdult:()=>false,token:()=>null});
      await expect(offline.home()).rejects.toThrow(/failed/);
    } finally { store.close();clock.mockRestore(); }
  });

  it('requires a token for authenticated operations', async () => {
    const client = new AniListClient(vi.fn(), new Store(':memory:'), { showAdult: () => false, token: () => null });
    await expect(client.query('query { Viewer { id } }', {}, { auth: true })).rejects.toThrow(/Connect your AniList/);
  });
});
