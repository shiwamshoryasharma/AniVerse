import type { MediaRef, SourceInfo, SourceMatch, SourceOverridePatch, Stream } from '../../shared/types';
import type { SiteEntry } from '../config/sitesConfig';
import type { Store } from '../db/store';
import { AppError, nowSec } from '../util';
import { recipeFor, type RecipeBook } from './recipes';
import type { SiteFetcher, SourceAdapter } from './types';
import { buildSearchUrl, discoverFromHtml, findOpenSearchHref, isValidTemplate, parseOpenSearch, type SearchDiscovery } from './web';

interface StoredDiscovery {
  template: string;
  via: SearchDiscovery['via'] | 'ui';
  at: number;
}

/** Every website gets its own persistent partition; all YouTube channels share one. */
export function partitionFor(id: string, kind: SourceInfo['kind']): string {
  return kind === 'youtube' ? 'persist:src-youtube' : `persist:src-${id}`;
}

/** Generic website: isolated session browsing, discovered site search, no stream extraction. */
export class WebSiteAdapter implements SourceAdapter {
  readonly kind = 'web' as const;

  capabilities() {
    return { search: true, episodes: false, streams: false, comments: false, login: true };
  }

  async match(source: SourceInfo, _entry: SiteEntry, media: MediaRef, pinned: string | null): Promise<SourceMatch> {
    const base = { sourceId: source.id, mode: 'web' as const, titleUrl: null, episodeUrls: {}, episodes: [] };
    if (pinned) return { ...base, pageUrl: pinned, pinned: true, note: null };
    if (source.searchTemplate) return { ...base, pageUrl: buildSearchUrl(source.searchTemplate, media.titles[0] ?? ''), pinned: false, note: null };
    // No known search URL: the site navigator uses the site's own search box from the homepage.
    return { ...base, pageUrl: source.url, pinned: false, note: null };
  }

  async streams(source: SourceInfo, _entry: SiteEntry, ref: string): Promise<Stream[]> {
    return [{ type: 'web', url: ref || source.url, label: `${source.name} · website` }];
  }
}

export class SourceRegistry {
  private entries: SiteEntry[] = [];
  private adapters = new Map<SourceInfo['kind'], SourceAdapter>();
  private discovering = new Map<string, Promise<SourceInfo>>();

  constructor(
    private store: Store,
    private fetcher: SiteFetcher,
    adapters: SourceAdapter[],
    private recipes: () => RecipeBook = () => ({}),
  ) {
    for (const adapter of adapters) this.adapters.set(adapter.kind, adapter);
  }

  setEntries(entries: SiteEntry[]) {
    this.entries = entries;
  }

  list(): SourceInfo[] {
    const overrides = this.store.getSourceOverrides();
    return this.entries
      .map((entry, index) => this.toInfo(entry, index, overrides[entry.id] ?? {}))
      .sort((a, b) => a.order - b.order);
  }

  get(id: string): SourceInfo {
    const info = this.list().find((s) => s.id === id);
    if (!info) throw new AppError('not-found', `Unknown source "${id}". It may have been removed from the config file.`);
    return info;
  }

  entry(id: string): SiteEntry {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw new AppError('not-found', `Unknown source "${id}".`);
    return entry;
  }

  /** Looks up a source by host (used by the session layer for navigation policy). */
  byPartition(partition: string): SourceInfo | null {
    return this.list().find((s) => s.partition === partition) ?? null;
  }

  update(id: string, patch: SourceOverridePatch): SourceInfo {
    this.entry(id);
    if (patch.searchTemplate !== undefined && patch.searchTemplate !== null && patch.searchTemplate.trim() !== '') {
      if (!isValidTemplate(patch.searchTemplate.trim())) {
        throw new AppError('invalid-input', 'The search URL must be an http(s) URL containing {query}.');
      }
      patch = { ...patch, searchTemplate: patch.searchTemplate.trim() };
    }
    if (patch.searchTemplate === '') patch = { ...patch, searchTemplate: null };
    this.store.patchSourceOverride(id, patch);
    return this.get(id);
  }

  /** Discovers how to search a website (OpenSearch → GET form → schema.org SearchAction). */
  discover(id: string, force = false): Promise<SourceInfo> {
    const running = this.discovering.get(id);
    if (running) return running;
    const job = this.runDiscovery(id, force).finally(() => this.discovering.delete(id));
    this.discovering.set(id, job);
    return job;
  }

  private async runDiscovery(id: string, force: boolean): Promise<SourceInfo> {
    const source = this.get(id);
    if (source.kind !== 'web') return source;
    const stored = this.store.getKv<StoredDiscovery | null>(`discovery:${id}`, null);
    if (stored && !force && nowSec() - stored.at < 7 * 86400) return source;

    const page = await this.fetcher.get(id, source.url);
    let found: SearchDiscovery | null = null;
    const osHref = findOpenSearchHref(page.text, page.url);
    if (osHref) {
      try {
        const xml = await this.fetcher.get(id, osHref, { accept: 'application/opensearchdescription+xml' });
        const template = parseOpenSearch(xml.text);
        if (template && isValidTemplate(template)) found = { template, via: 'opensearch' };
      } catch {
        // fall through to HTML strategies
      }
    }
    found ??= discoverFromHtml(page.text, page.url);
    this.store.setKv(`discovery:${id}`, found ? { ...found, at: nowSec() } : { template: '', via: 'form', at: nowSec() });
    return this.get(id);
  }

  async match(id: string, media: MediaRef): Promise<SourceMatch> {
    const source = this.get(id);
    if (!source.enabled) throw new AppError('invalid-input', `${source.name} is disabled in Settings → Sources.`);
    const adapter = this.adapter(source.kind);
    let current = source;
    if (source.kind === 'web' && !source.searchTemplate && !this.store.isPrivate(media.id)) {
      current = await this.discover(id).catch(() => source);
    }
    const result = await adapter.match(current, this.entry(id), media, this.store.getPin(id, media.id));
    if (source.kind !== 'web') return result;
    const { 0: titleUrl, ...episodeUrls } = this.store.getSiteLinks(id, media.id);
    return { ...result, titleUrl: titleUrl ?? null, episodeUrls };
  }

  /** Records a search URL the site navigator learned by using the site's own search box. */
  learnSearch(id: string, template: string) {
    if (!isValidTemplate(template)) return;
    const stored = this.store.getKv<StoredDiscovery | null>(`discovery:${id}`, null);
    if (stored?.template && stored.via !== 'ui') return;
    this.store.setKv(`discovery:${id}`, { template, via: 'ui', at: nowSec() } satisfies StoredDiscovery);
  }

  async streams(id: string, ref: string): Promise<Stream[]> {
    const source = this.get(id);
    return this.adapter(source.kind).streams(source, this.entry(id), ref);
  }

  private adapter(kind: SourceInfo['kind']): SourceAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new AppError('internal', `No adapter registered for ${kind} sources.`);
    return adapter;
  }

  private toInfo(entry: SiteEntry, index: number, o: SourceOverridePatch): SourceInfo {
    const discovery = this.store.getKv<StoredDiscovery | null>(`discovery:${entry.id}`, null);
    const userTemplate = o.searchTemplate ?? null;
    const recipeTemplate = entry.kind === 'web' ? (recipeFor(this.recipes(), entry.host)?.search ?? null) : null;
    const discovered = discovery?.template || null;
    return {
      id: entry.id,
      name: o.name || entry.name,
      url: entry.url,
      host: entry.host,
      kind: entry.kind,
      enabled: o.enabled ?? true,
      order: o.order ?? index,
      // Per-source switches; the session layer combines them with the global privacy settings.
      adblock: o.adblock ?? true,
      autoCloudflare: o.autoCloudflare ?? true,
      searchTemplate: entry.kind === 'web' ? (userTemplate ?? recipeTemplate ?? discovered) : null,
      searchTemplateSource: entry.kind !== 'web' ? null : userTemplate ? 'user' : recipeTemplate ? 'recipe' : discovered ? discovery!.via : null,
      searchCheckedAt: entry.kind === 'web' ? (discovery?.at ?? null) : null,
      capabilities: this.adapter(entry.kind).capabilities(entry),
      partition: partitionFor(entry.id, entry.kind),
      line: entry.line,
    };
  }
}
