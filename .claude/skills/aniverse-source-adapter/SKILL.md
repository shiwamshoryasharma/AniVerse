---
name: aniverse-source-adapter
description: Add or change a source adapter in AniVerse (app/core/sources). Use when a new kind of source must be supported (e.g. a licensed platform with an official API) or when web/YouTube matching behaviour changes.
---

# Source adapters

## Contract (`app/core/sources/types.ts`)
```ts
interface SourceAdapter {
  readonly kind: SourceKind;                       // 'web' | 'youtube' | …
  capabilities(entry): SourceCapabilities;         // search/episodes/streams/comments/login
  match(source, entry, media, pinned): Promise<SourceMatch>;   // mode 'web' (pageUrl) or 'episodes'
  streams(source, entry, ref): Promise<Stream[]>;  // hls/dash/mp4 | youtube | web
}
```
`SiteFetcher.get(sourceId, url)` fetches **inside the source's partition** (cookies, Chromium UA) and runs the Cloudflare window automatically — use it for any request to the site itself. Use the injected `FetchFn` only for official APIs.

## Rules
1. Only authorised data: official APIs, public feeds (RSS/OpenSearch), or the site rendered in its own session. No private/undocumented API scraping, no stream URL extraction from unlicensed sites, no DRM/Cloudflare circumvention.
2. Classify URLs in `app/core/config/sitesConfig.ts` (`kind`, stable `id`, display `name`).
3. Register the adapter in `electron/main.ts` (`new SourceRegistry(store, fetcher, [...])`), and give it a partition rule in `partitionFor()` if it should share sessions.
4. Allowed navigation domains for webviews: `SessionManager.isAllowedUrl` in `electron/sessions.ts`.
5. Cache remote lookups via `store.cacheSet` (episode lists 6 h, misses 30 min) and keep ids in `kv` when stable.
6. Title matching helpers in `sources/text.ts`: `titleScore`, `videoScore` (season-aware), `parseEpisodeNumber` (`SxEy` first), `episodeFromUrl`.
7. Add fixtures to `test/fixtures/` and unit tests in `test/unit/sources-metadata.test.ts`; add a live check to `test/e2e/sources.mjs`.

## Checklist
- [ ] `npm run typecheck && npm run lint && npm test`
- [ ] `npm run build && node test/e2e/sources.mjs`
- [ ] Watch page shows the source under the right group (Official / Websites) and the episode panel marks unavailable episodes.
