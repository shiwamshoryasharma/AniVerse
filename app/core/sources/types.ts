import type { MediaRef, SourceEpisode, SourceInfo, SourceMatch, Stream } from '../../shared/types';
import type { SiteEntry } from '../config/sitesConfig';

export interface SiteResponse {
  status: number;
  url: string;
  text: string;
  headers: Record<string, string>;
}

/**
 * Fetches pages *inside a source's isolated session* (its cookies, user agent
 * and Cloudflare clearance). Implemented by the Electron layer, which runs a
 * Cloudflare challenge in a real browser window when one is detected.
 */
export interface SiteFetcher {
  get(sourceId: string, url: string, opts?: { accept?: string; timeoutMs?: number }): Promise<SiteResponse>;
}

/**
 * Kotatsu-style adapter contract. One adapter implementation serves every
 * source of its kind; per-source state lives in the registry.
 */
export interface SourceAdapter {
  readonly kind: SourceInfo['kind'];
  capabilities(entry: SiteEntry): SourceInfo['capabilities'];
  match(source: SourceInfo, entry: SiteEntry, media: MediaRef, pinned: string | null): Promise<SourceMatch>;
  streams(source: SourceInfo, entry: SiteEntry, ref: string): Promise<Stream[]>;
}

export type { SourceEpisode };
