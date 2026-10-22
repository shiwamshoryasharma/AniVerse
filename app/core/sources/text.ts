/** Title normalisation, fuzzy matching and episode-number parsing used by adapters. */

export function normalizeTitle(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text: string): string[] {
  return normalizeTitle(text)
    .split(' ')
    .filter((t) => t.length >= 2 || /\d/.test(t));
}

/** Dice coefficient over word tokens, 0..1. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return (2 * common) / (ta.size + tb.size);
}

/**
 * Scores how well a candidate (video/playlist title) refers to a media title.
 * Containment of a full title scores 1; otherwise the best token similarity.
 */
export function titleScore(candidate: string, titles: string[]): number {
  const c = normalizeTitle(candidate);
  let best = 0;
  for (const title of titles) {
    const t = normalizeTitle(title);
    if (!t) continue;
    if (t.length >= 4 && (` ${c} `.includes(` ${t} `) || c === t)) return 1;
    best = Math.max(best, tokenSimilarity(candidate, title));
  }
  return best;
}

const NOT_AN_EPISODE = /\b(pv|trailer|teaser|preview|promo|creditless|non[- ]?credit|cm\d*|announcement|commercial)\b/i;

const EPISODE_PATTERNS: RegExp[] = [
  // Season-relative codes first: channels often print absolute numbers next to
  // them ("Episode 15 (S2E03)") while AniList numbers episodes per season.
  /\bS\d{1,2}\s*E(\d{1,4})\b/i,
  /\b(?:episode|episodio|épisode|folge|ep|eps|epi)\.?\s*#?\s*(\d{1,4})(?!\d)/i,
  /第\s*(\d{1,4})\s*[話话集回]/,
  /#\s*(\d{1,4})(?!\d)/,
  /\[(\d{1,4})\]/,
  /\s[-–|]\s*(\d{1,4})(?=\s|$|\[|\(|v\d)/,
];

/** Extracts an episode number from a video title, or null for trailers/clips. */
export function parseEpisodeNumber(title: string): number | null {
  if (NOT_AN_EPISODE.test(title)) return null;
  for (const pattern of EPISODE_PATTERNS) {
    const m = title.match(pattern);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n < 5000) return n;
    }
  }
  return null;
}

/** Extracts an episode number from a site URL such as `/watch/x?ep=5` or `/x-episode-5`. */
export function episodeFromUrl(url: string): number | null {
  try {
    const u = new URL(url);
    for (const key of ['ep', 'episode', 'e']) {
      const v = u.searchParams.get(key);
      if (v && /^\d{1,4}$/.test(v)) return Number(v);
    }
    const m = u.pathname.match(/(?:episode|ep)[-_/]?(\d{1,4})(?:\/|$|-|\.)/i);
    if (m) return Number(m[1]);
    // `/watch/<id>/<n>` — the episode number as the last path segment of a watch page.
    const w = u.pathname.match(/\/watch\/[^/]+\/(\d{1,4})\/?$/i);
    return w ? Number(w[1]) : null;
  } catch {
    return null;
  }
}

/** Season number mentioned in a title ("Season 2", "2nd Season", "S2E03", "S2"), or null. */
export function seasonOf(text: string): number | null {
  const m =
    text.match(/\bseason\s*(\d{1,2})\b/i) ??
    text.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i) ??
    text.match(/\bS(\d{1,2})\s*E\d{1,4}\b/i) ??
    text.match(/\bS(\d{1,2})\b/);
  return m ? Number(m[1]) : null;
}

/** Strips episode markers, language tags and brackets from a video title, keeping its season. */
export function cleanVideoTitle(title: string): string {
  const season = seasonOf(title);
  let t = title
    .replace(/[[【(（][^\]】)）]*[\]】)）]/g, ' ')
    .replace(/[《》「」『』]/g, ' ')
    .replace(/\b(?:episode|episodio|ep|eps)\.?\s*#?\s*\d{1,4}\b[\s\S]*$/i, ' ')
    .replace(/第\s*\d{1,4}\s*[話话集回][\s\S]*$/, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s\-–|:]+$/, '')
    .trim();
  if (season && season > 1 && seasonOf(t) === null) t += ` Season ${season}`;
  return t;
}

/**
 * Whether a channel video belongs to this media entry: the cleaned title must
 * match and the season must agree (AniList keeps one entry per season).
 */
export function videoScore(videoTitle: string, titles: string[]): number {
  const cleaned = cleanVideoTitle(videoTitle);
  const videoSeason = seasonOf(cleaned) ?? 1;
  const mediaSeason = Math.max(1, ...titles.map((t) => seasonOf(t) ?? 1));
  if (videoSeason !== mediaSeason) return 0;
  return titleScore(cleaned, titles);
}
