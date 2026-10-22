# AniVerse architecture

## Layers

```
┌──────────────── renderer (frontend/, sandboxed, contextIsolation) ────────────────┐
│ React pages ─ TanStack Query hooks ─ lib/bridge.call()  ◄── events (sources,       │
│ <webview partition="persist:src-<id>"> for sites / YouTube embeds   cloudflare,    │
│ VideoPlayer (hls.js / dash.js / native)                              sync, adblock)│
└───────────────────────────────▲───────────────────────────────────────────────────┘
                                │ preload: window.aniverse.invoke(method, input)
┌───────────────────────────────┴──── main (electron/) ─────────────────────────────┐
│ ipc.ts      one channel, zod schema per method, trusted-sender check              │
│ main.ts     composition root + handlers                                            │
│ sessions.ts per-source partitions: UA, permissions, downloads, webview guard,     │
│             popup/redirect policy, Cloudflare title watch, SiteFetcher            │
│ adblock.ts  Ghostery engine wired into each partition (+ config/filters.txt)      │
│ cloudflare.ts real-browser verification window in the source's session            │
│ oauth.ts    sign-in transactions (system browser → aniverse:// deep link)         │
│ accounts.ts tokens, MAL refresh, reconnect · deepLink.ts aniverse:// registration │
│ media.ts    app:// (renderer), media:// (picked local files), <video> probe        │
└───────────────────────────────▲───────────────────────────────────────────────────┘
                                │ plain TypeScript, no Electron imports
┌───────────────────────────────┴──── core (app/core) ──────────────────────────────┐
│ config/sitesConfig  parse streaming-sites.txt                                      │
│ db/store            node:sqlite — progress, history, library, favourites, pins,  │
│                     overrides, accounts (encrypted), sync queue, http cache        │
│ metadata/anilist    GraphQL client (token bucket, cache, stale fallback)          │
│ sources/registry    SourceInfo from config + overrides; dispatch to adapters      │
│ sources/web         search discovery (OpenSearch, GET form, SearchAction)         │
│ sources/youtube     channel → episodes (Data API or RSS) → official embed         │
│ comments            AniList threads (read/post), MAL topics, YouTube comments      │
│ sync/*              AniList & MAL providers, local-first queue with backoff        │
└────────────────────────────────────────────────────────────────────────────────────┘
```

## Source adapters (Kotatsu-style)

`SourceAdapter` (`app/core/sources/types.ts`) has `capabilities()`, `match(source, entry, media, pinned)` and `streams(source, entry, ref)`. One adapter instance serves every source of its kind; per-source state lives in the registry and the store.

- **web** — `match` returns `mode: 'web'` with a page URL: a pinned page, the site's search for the title, or its homepage. The renderer opens it in the site's partition. No scraping of episodes or streams.
- **youtube** — `match` returns `mode: 'episodes'` built from channel uploads (season-aware title matching, `SxEy` preferred over absolute numbers). `streams` returns `{ type: 'youtube', videoId }`, played through the official embed with an app referrer.

To add a kind, implement the interface, register it in `electron/main.ts`, and extend `SourceKind` plus the URL classification in `sitesConfig.ts`.

## Site navigator (website sources)

`electron/siteNavigator.ts` drives a source webview from the main process using scripts run in an isolated JS world (`electron/sitePage.ts`):

1. Learned page for the episode (`site_links` table) → load it; or derive it from a sibling episode URL (`?ep=N`, `/ep-N`, `-episode-N`, `/watch/<id>/N`).
2. Otherwise find the series: pinned/learned title page, or the site's search — recipe/discovered URL, else the site's own search box (button → modal → type → Enter), learning the resulting search URL. Candidates are scored against all titles with season awareness; the landed page's heading is verified.
3. Find episode N on the title page (data attributes, URL patterns, "EP N" badges) or its "Watch now" page, then open it.
4. Re-apply the remembered SUB/DUB + server preference, isolate the player (focus CSS), unmute, and click the player once if nothing is playing.

The renderer only sees a loader and status lines; the site's URL bar is hidden. Optional per-site hints live in `config/site-recipes.json` (search URL, selectors, `cacheLinks`). `test/e2e/site-survey.mjs` measures every configured site.

## Casting

`electron/cast/` implements a minimal CASTV2 sender (TLS + protobuf framing), mDNS discovery (`_googlecast._tcp`) and a session service. The Default Media Receiver streams the URL itself (media only, no mirroring); local files are served from a token-protected LAN HTTP server that exists only while casting. Website sources are not castable because their streams are not extracted.

## Watch flow

1. `WatchPage` loads AniList details, sources and the local library state.
2. Source choice: `?source=` → last source used for this title → first enabled source.
3. `sources.match` → web page URL or episode list; `sources.streams` → stream for the chosen episode.
4. Progress: the native player reports every ~10 s and on pause, seek and end. Webviews are probed every 3 s through `player.probe`, which reads the page's `<video>`, including cross-origin player frames.
5. `library.saveProgress` → `completedNow` at the threshold → local list progress → sync queue → AniList/MAL.

## Security model

- Renderer: `sandbox`, `contextIsolation`, no Node, CSP injected at build time, navigation locked to the app origin, `window.open` denied (http links open in the OS browser).
- IPC: a single channel; each method validated with zod; requests accepted only from the main window's top frame; errors returned as data.
- Webviews: `will-attach-webview` strips preloads/Node, forces sandbox + isolation, and allows only configured source partitions with an on-site URL. Guests: popups denied (same-site links reload in place), cross-site top-level navigations blocked except identity providers, downloads blocked, permissions limited to fullscreen/clipboard-write.
- Sessions: one persistent partition per website (YouTube channels share one). "Sign out & clear" wipes only that partition.
- Accounts: AniList / MyAnimeList sign-in happens in the system browser and returns through `aniverse://oauth/…`; the main process matches the link to a single-use, 10-minute transaction (random `state`, MAL PKCE). Client IDs are compiled in; no secrets ship. See [ACCOUNTS.md](ACCOUNTS.md).
- Secrets: tokens are encrypted with `safeStorage` (OS credential store) and bound to the profile's `profile.id` before reaching SQLite; without an OS store they live for the session only. The renderer never receives tokens.

## Accounts & sync

`SyncService` (`app/core/sync/syncService.ts`) queues one "entry" job per title per service (pushes AniVerse's current status/progress/score at send time, or removes it) plus favourite jobs, with exponential backoff. `AccountManager` (`electron/accounts.ts`) supplies tokens: MAL refresh a day before expiry or after a rejection (single-flight), AniList re-sign-in after a year; a confirmed rejection marks the account "reconnect needed" and keeps its queue. Two-way mode pulls both lists and runs `reconcile()` per title: newest edit wins, superseded local pushes are dropped, winners propagate to the other service, local removals are tombstoned (`library_tombstones`) and sent, and titles missing on a service are re-added only if changed since that service's last sync.
- Cloudflare: challenges run in a real Chromium window that shares the source's session. Nothing clicks, solves or spoofs; interactive checks are shown to the user.

## Self-update

`electron/updater.ts` wraps electron-updater with the GitHub Releases feed from `electron-builder.yml`. It checks at start-up and every 6 hours, downloads differentially using blockmaps, and installs silently on restart or quit. Only installed, signed Windows builds update. Every download must pass `electron/updateSignature.ts`: an intact Authenticode signature from a certificate pinned in `config/signing.json`. State reaches the UI as `update.status` events. Details: [UPDATES.md](UPDATES.md).

## Notable constraints

- AniList rate limit is ~30 req/min: token bucket (burst 12, 28/min) + SQLite response cache + stale fallback when offline.
- AniList mishandles some `null` arguments (`id_not_in`, `format_in` → HTTP 500; `countryOfOrigin` → empty), so browse queries declare only the filters that are set.
- Ghostery's Electron helper registers global IPC per session; AniVerse wires the engine per partition itself and applies `filters.txt` with `updateFromDiff`.
