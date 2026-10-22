export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const nowSec = () => Math.floor(Date.now() / 1000);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  // typographic ones MyAnimeList posts are full of
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  lsaquo: '‹',
  rsaquo: '›',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  minus: '−',
  bull: '•',
  middot: '·',
  prime: '′',
  times: '×',
  divide: '÷',
  deg: '°',
  copy: '©',
  reg: '®',
  trade: '™',
  hearts: '♥',
  star: '☆',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  iexcl: '¡',
  iquest: '¿',
  shy: '',
  zwj: '‍',
  zwnj: '‌',
};

// Accented letters: &eacute; &Uuml; &ntilde; &ccedil; &aring; …
const ACCENTS: Record<string, string> = { acute: '́', grave: '̀', circ: '̂', uml: '̈', tilde: '̃', cedil: '̧', ring: '̊' };
const accented = (code: string) => {
  const m = /^([a-z])(acute|grave|circ|uml|tilde|cedil|ring)$/i.exec(code);
  return m ? (m[1] + ACCENTS[m[2].toLowerCase()]).normalize('NFC') : undefined;
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code] ?? ENTITIES[code.toLowerCase()] ?? accented(code) ?? match;
  });
}

/** Converts AniList/MAL style HTML-ish text into plain text with paragraph breaks. */
export function stripHtml(text: string | null | undefined): string | null {
  if (!text) return null;
  const plain = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '');
  return decodeEntities(plain)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** AniList markdown flavour → readable plain text (images and spoilers collapsed). */
export function anilistMarkdownToText(text: string): string {
  return decodeEntities(
    text
      .replace(/img\d*%?\((https?:[^)]+)\)/gi, '(image)')
      .replace(/youtube\((https?:[^)]+)\)/gi, '(video) $1')
      .replace(/webm\((https?:[^)]+)\)/gi, '(video) $1')
      .replace(/~!([\s\S]*?)!~/g, 'Spoiler: $1')
      .replace(/~~~([\s\S]*?)~~~/g, '$1')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  ).trim();
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Deep merge for plain objects; arrays and primitives in `patch` replace values. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(out[key]) && isPlainObject(value) ? deepMerge(out[key], value) : value;
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class AppError extends Error {
  constructor(
    public code: 'invalid-input' | 'not-found' | 'unauthorised' | 'network' | 'cloudflare' | 'config' | 'internal',
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
