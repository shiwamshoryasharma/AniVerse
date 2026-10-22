import type { SourceKind } from '../../shared/types';

export interface SiteEntry {
  id: string;
  url: string;
  host: string;
  kind: SourceKind;
  name: string;
  line: number;
  /** YouTube @handle or channel id, when kind === 'youtube'. */
  youtube: { handle: string | null; channelId: string | null } | null;
}

export interface ParsedSitesConfig {
  entries: SiteEntry[];
  warnings: string[];
}

const URL_IN_LINE = /https?:\/\/[^\s'"<>]+/i;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);

/**
 * Parses `config/streaming-sites.txt`: one URL per line. Blank lines and lines
 * starting with `#` or `//` are ignored. Numbered list prefixes ("3. https://…")
 * are tolerated so a copied list works as-is. Duplicates are dropped.
 */
export function parseSitesConfig(text: string): ParsedSitesConfig {
  const entries: SiteEntry[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const ids = new Set<string>();

  text.split(/\r?\n/).forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) return;
    const match = line.match(URL_IN_LINE);
    if (!match) {
      warnings.push(`Line ${lineNo}: no http(s) URL found — ignored.`);
      return;
    }
    let url: URL;
    try {
      url = new URL(match[0].replace(/[),.;]+$/, ''));
    } catch {
      warnings.push(`Line ${lineNo}: "${match[0]}" is not a valid URL — ignored.`);
      return;
    }
    const host = url.hostname.toLowerCase();
    const youtube = YOUTUBE_HOSTS.has(host) ? parseYouTubePath(url.pathname) : null;
    const kind: SourceKind = youtube ? 'youtube' : 'web';
    const normalized = kind === 'youtube' ? `yt:${(youtube!.handle ?? youtube!.channelId)!.toLowerCase()}` : `${host}${url.pathname.replace(/\/+$/, '')}`;
    if (seen.has(normalized)) {
      warnings.push(`Line ${lineNo}: duplicate of an earlier entry — ignored.`);
      return;
    }
    seen.add(normalized);

    let id = kind === 'youtube' ? `yt-${slug((youtube!.handle ?? youtube!.channelId)!)}` : slug(host.replace(/^www\./, ''));
    if (ids.has(id)) {
      let n = 2;
      while (ids.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    ids.add(id);

    entries.push({
      id,
      url: kind === 'youtube' ? canonicalYouTubeUrl(youtube!) : url.toString(),
      host,
      kind,
      name: kind === 'youtube' ? `${youtube!.handle ?? youtube!.channelId}` : host.replace(/^www\./, ''),
      line: lineNo,
      youtube,
    });
  });

  return { entries, warnings };
}

export function parseYouTubePath(pathname: string): { handle: string | null; channelId: string | null } | null {
  const handle = pathname.match(/^\/(@[\w.-]+)/);
  if (handle) return { handle: handle[1], channelId: null };
  const channel = pathname.match(/^\/channel\/(UC[\w-]{22})/);
  if (channel) return { handle: null, channelId: channel[1] };
  return null;
}

function canonicalYouTubeUrl(yt: { handle: string | null; channelId: string | null }): string {
  return yt.handle ? `https://www.youtube.com/${yt.handle}` : `https://www.youtube.com/channel/${yt.channelId}`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const DEFAULT_SITES_FILE = `# AniVerse streaming sources — one URL per line.
# Lines starting with # are ignored. Edit and save: the app reloads automatically.
# YouTube channel URLs (https://www.youtube.com/@Handle) become official-episode sources.
`;
