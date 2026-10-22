import { parse } from 'node-html-parser';
import { decodeEntities } from '../util';

/**
 * Generic website adapter helpers. A configured site is never scraped for
 * streams: AniVerse only discovers how to search it, then opens the site's own
 * pages inside an isolated, ad-blocked session.
 */

export type DiscoveryVia = 'opensearch' | 'form' | 'jsonld';

export interface SearchDiscovery {
  template: string;
  via: DiscoveryVia;
}

const QUERY_NAMES = /^(q|query|keyword|keywords|search|s|k|term|title|name)$/i;

export function findOpenSearchHref(html: string, baseUrl: string): string | null {
  const root = parse(html);
  const link = root.querySelectorAll('link').find((l) => (l.getAttribute('type') ?? '').toLowerCase() === 'application/opensearchdescription+xml');
  const href = link?.getAttribute('href');
  return href ? safeResolve(href, baseUrl) : null;
}

/** Parses an OpenSearch description document into a `{query}` template. */
export function parseOpenSearch(xml: string): string | null {
  const urls = [...xml.matchAll(/<Url\b[^>]*>/gi)].map((m) => m[0]);
  const html = urls.find((u) => /type=["']text\/html["']/i.test(u)) ?? urls[0];
  const template = html?.match(/template=["']([^"']+)["']/i)?.[1];
  if (!template) return null;
  return decodeEntities(template)
    .replace(/\{searchTerms\}/g, '{query}')
    .replace(/&?[\w-]+=\{[\w:]+\?\}/g, '')
    .replace(/\?&/, '?');
}

/** Finds a GET search form on the page and turns it into a `{query}` template. */
export function findSearchForm(html: string, baseUrl: string): string | null {
  const root = parse(html);
  const candidates = root
    .querySelectorAll('form')
    .filter((form) => (form.getAttribute('method') ?? 'get').toLowerCase() === 'get')
    .map((form) => {
      const inputs = form.querySelectorAll('input');
      const query = inputs.find((i) => {
        const type = (i.getAttribute('type') ?? 'text').toLowerCase();
        const name = i.getAttribute('name') ?? '';
        return name && (type === 'search' || ((type === 'text' || type === '') && QUERY_NAMES.test(name)));
      });
      if (!query) return null;
      const action = safeResolve(form.getAttribute('action') || baseUrl, baseUrl);
      if (!action) return null;
      const url = new URL(action);
      for (const hidden of inputs) {
        const name = hidden.getAttribute('name');
        if (!name || hidden === query || (hidden.getAttribute('type') ?? '').toLowerCase() !== 'hidden') continue;
        url.searchParams.set(name, hidden.getAttribute('value') ?? '');
      }
      url.searchParams.set(query.getAttribute('name')!, '__QUERY__');
      const score = (query.getAttribute('type') === 'search' ? 2 : 0) + (/search|filter|browse/i.test(url.pathname) ? 1 : 0);
      return { template: url.toString().replace('__QUERY__', '{query}'), score };
    })
    .filter((c): c is { template: string; score: number } => !!c)
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.template ?? null;
}

/** schema.org WebSite SearchAction (`"urlTemplate": "…{search_term_string}"`). */
export function findJsonLdSearch(html: string, baseUrl: string): string | null {
  const m = html.match(/"urlTemplate"\s*:\s*"([^"]+\{search_term_string\}[^"]*)"/);
  if (!m) return null;
  const resolved = safeResolve(m[1].replace(/\\\//g, '/').replace('{search_term_string}', '__QUERY__'), baseUrl);
  return resolved ? resolved.replace('__QUERY__', '{query}') : null;
}

/** Runs the HTML-only strategies in order of reliability. */
export function discoverFromHtml(html: string, baseUrl: string): SearchDiscovery | null {
  const form = findSearchForm(html, baseUrl);
  if (form) return { template: form, via: 'form' };
  const jsonld = findJsonLdSearch(html, baseUrl);
  if (jsonld) return { template: jsonld, via: 'jsonld' };
  return null;
}

export function buildSearchUrl(template: string, query: string): string {
  const encoded = encodeURIComponent(query.trim());
  const inQueryString = template.indexOf('?') !== -1 && template.indexOf('?') < template.indexOf('{query}');
  return template.replace('{query}', inQueryString ? encoded.replace(/%20/g, '+') : encoded);
}

export function isValidTemplate(template: string): boolean {
  if (!template.includes('{query}')) return false;
  try {
    const u = new URL(template.replace('{query}', 'x'));
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Registrable-ish domain used to decide which navigations stay inside a source session. */
export function siteDomain(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const sld = parts[parts.length - 2];
  // Handle common second-level public suffixes (co.uk, com.br…).
  if (['co', 'com', 'net', 'org', 'ac', 'gov', 'edu'].includes(sld) && parts[parts.length - 1].length === 2) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

function safeResolve(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}
