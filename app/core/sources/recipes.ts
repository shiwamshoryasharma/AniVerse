import { isValidTemplate, siteDomain } from './web';

/**
 * Optional per-site navigation hints, loaded from `config/site-recipes.json`.
 * The site navigator works without them (generic heuristics); a recipe only
 * narrows where it looks. Recipes never describe how to extract streams —
 * they point at the site's own search, title and episode pages.
 */
export interface SiteRecipe {
  /** Search page with `{query}`, e.g. `https://site/search?q={query}`. */
  search?: string;
  /** CSS selector for links to title pages on search results. */
  titleLink?: string;
  /** CSS selector for the link from a title page to its watch page. */
  watchLink?: string;
  /** CSS selector for episode links/buttons; `{n}` is replaced by the episode number. */
  episodeLink?: string;
  /** CSS selector for the player element used by focus mode. */
  player?: string;
  /** Set to false for sites whose page links are short-lived tokens (always search again). */
  cacheLinks?: boolean;
  /** Free-form notes from the site survey. */
  notes?: string;
}

export type RecipeBook = Record<string, SiteRecipe>;

const KEYS = ['search', 'titleLink', 'watchLink', 'episodeLink', 'player', 'notes'] as const;

/** Parses the recipe file, dropping unknown keys and invalid search templates. */
export function parseRecipes(text: string): { recipes: RecipeBook; warnings: string[] } {
  const recipes: RecipeBook = {};
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { recipes, warnings: [`site-recipes.json is not valid JSON: ${(err as Error).message}`] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { recipes, warnings: ['site-recipes.json must be an object keyed by host.'] };
  for (const [host, value] of Object.entries(raw as Record<string, unknown>)) {
    if (host.startsWith('$') || !value || typeof value !== 'object') continue;
    const recipe: SiteRecipe = {};
    for (const key of KEYS) {
      const v = (value as Record<string, unknown>)[key];
      if (typeof v === 'string' && v.trim()) recipe[key] = v.trim();
    }
    if (typeof (value as Record<string, unknown>).cacheLinks === 'boolean') recipe.cacheLinks = (value as Record<string, boolean>).cacheLinks;
    if (recipe.search && !isValidTemplate(recipe.search)) {
      warnings.push(`${host}: "search" must be an http(s) URL containing {query}.`);
      delete recipe.search;
    }
    recipes[host.toLowerCase().replace(/^www\./, '')] = recipe;
  }
  return { recipes, warnings };
}

/** Finds the recipe for a host (exact host first, then its registrable domain). */
export function recipeFor(book: RecipeBook, host: string): SiteRecipe | null {
  const h = host.toLowerCase().replace(/^www\./, '');
  return book[h] ?? book[siteDomain(h)] ?? null;
}
