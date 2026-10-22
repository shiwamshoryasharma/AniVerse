import { describe, expect, it } from 'vitest';
import { Store } from '../../app/core/db/store';
import { parseRecipes, recipeFor } from '../../app/core/sources/recipes';
import { deriveEpisodeUrl, searchQueries, titleKey } from '../../electron/siteNavigator';
import { pageScript } from '../../electron/sitePage';

describe('site navigator helpers', () => {
  it('derives sibling episode URLs from query and path patterns', () => {
    expect(deriveEpisodeUrl({ 1: 'https://stream-one.test/watch/frieren-x1?ep=1&lang=sub' }, 3)).toBe('https://stream-one.test/watch/frieren-x1?ep=3&lang=sub');
    expect(deriveEpisodeUrl({ 0: 'https://stream-two.test/anime/frieren', 2: 'https://stream-two.test/watch/frieren-6ri4s/ep-2' }, 11)).toBe('https://stream-two.test/watch/frieren-6ri4s/ep-11');
    expect(deriveEpisodeUrl({ 4: 'https://x.to/frieren-episode-4' }, 5)).toBe('https://x.to/frieren-episode-5');
    // No numeric pattern → nothing to derive.
    expect(deriveEpisodeUrl({ 1: 'https://x.to/watch/abc123' }, 2)).toBeNull();
    expect(deriveEpisodeUrl({ 0: 'https://x.to/anime/frieren' }, 2)).toBeNull();
  });

  it('compares pages of the same title regardless of episode', () => {
    expect(titleKey('https://stream-one.test/watch/frieren?ep=1&lang=sub')).toBe(titleKey('https://www.stream-one.test/watch/frieren?ep=7'));
    expect(titleKey('https://stream-two.test/watch/frieren/ep-1')).toBe(titleKey('https://stream-two.test/watch/frieren/ep-12'));
    expect(titleKey('https://stream-two.test/watch/frieren/ep-1')).not.toBe(titleKey('https://stream-two.test/watch/other/ep-1'));
  });

  it('builds search-friendly queries', () => {
    expect(searchQueries(['Frieren: Beyond Journey’s End', 'Sousou no Frieren'])).toEqual(['Frieren Beyond Journeys End', 'Frieren', 'Sousou no Frieren']);
    expect(searchQueries(['Re:ZERO -Starting Life in Another World-'])).toEqual(['Re ZERO Starting Life in Another World']);
    expect(searchQueries(['One Piece', 'ONE PIECE'])).toEqual(['One Piece']);
  });

  it('serialises the in-page script with its arguments', () => {
    const code = pageScript({ op: 'findEpisode', episode: 7, slug: 'frieren' });
    expect(code).toContain('"episode":7');
    expect(() => new Function(code)).not.toThrow();
  });
});

describe('site recipes', () => {
  it('parses recipes, drops bad search templates and resolves by domain', () => {
    const { recipes, warnings } = parseRecipes(
      JSON.stringify({
        $comment: 'ignored',
        'www.stream-one.test': { search: 'https://stream-one.test/search?q={query}', episodeLink: 'a[data-episode="{n}"]', bogus: 1 },
        'bad.to': { search: 'https://bad.to/search' },
      }),
    );
    expect(recipes['stream-one.test']).toEqual({ search: 'https://stream-one.test/search?q={query}', episodeLink: 'a[data-episode="{n}"]' });
    expect(recipes['bad.to']).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(recipeFor(recipes, 'sub.stream-one.test')?.search).toContain('{query}');
    expect(parseRecipes('{oops').warnings[0]).toMatch(/not valid JSON/);
  });
});

describe('learned site links', () => {
  it('stores, lists and clears links per title', () => {
    const store = new Store(':memory:');
    store.setSiteLink('stream-two-test', 7, 0, 'https://stream-two.test/anime/x');
    store.setSiteLink('stream-two-test', 7, 3, 'https://stream-two.test/watch/x/ep-3');
    store.setSiteLink('stream-two-test', 7, 3, 'https://stream-two.test/watch/x/ep-3?server=2');
    expect(store.getSiteLinks('stream-two-test', 7)).toEqual({ 0: 'https://stream-two.test/anime/x', 3: 'https://stream-two.test/watch/x/ep-3?server=2' });
    store.clearSiteLinks('stream-two-test', 7);
    expect(store.getSiteLinks('stream-two-test', 7)).toEqual({});
  });
});
