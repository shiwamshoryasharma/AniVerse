# Architecture and extension seams

Rechecked 2026-10-29; initially inspected 2026-10-26. See [the folder map](project-structure.md) for the maintained directory tree. Start with [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for the maintained architecture narrative and [package.json](../../package.json) for current scripts/dependencies.

## Directory map

| Path | Responsibility |
| --- | --- |
| `app/core/` | Plain TypeScript domain services: metadata, config parsing, SQLite, sources, settings, comments, sync. No Electron imports found in this layer. |
| `app/shared/` | Shared data types, typed RPC/events, release gating, graphics/playback, workspace/subtitle/theme helpers. |
| `electron/` | Main process, preload, IPC validation, session security, OAuth, site navigation, local media, casting, updater. |
| `frontend/` | React renderer, hash routes, TanStack Query, custom controls, native media player, theme styles. |
| `config/` | Local site list/recipes, adblock rules, OAuth setup, signing pins. Some files are intentionally untracked/private. |
| `scripts/` | Existing development, production build, asset import, packaging/signing/release tools. New testing scripts belong in `test/`. |
| `test/` | Unit and Electron E2E tests, fixtures, image inputs, ignored profiles/caches/evidence. |
| `docs/` | Architecture, accounts, installer, updater documentation and documentation screenshots. |
| `assets/`, `build/` | Maintained artwork/build resources and NSIS customization. `build/` includes source; do not treat the entire directory as disposable output. |
| `dist/`, `release/` | Generated application bundles and packaged releases. Do not edit bundled code as the source fix. |
| `.claude/` | Existing Claude instructions, skills and historical memory. Preserve it. |
| `.codex/` | This Codex context and focused skills. |

## Runtime path

`frontend/src/main.tsx` creates the router and query client. Pages/hooks call `frontend/src/lib/bridge.ts`, which uses the preload's `window.aniverse` bridge. `electron/ipc.ts` validates input and sender; `electron/main.ts` wires handlers to core and Electron services. Events travel back through the preload.

`electron/main.ts` is the composition root. It creates the store, AniList client, source registry, sessions, navigator, accounts/sync, casting and updater. `electron/paths.ts` resolves config/data directories. `ANIVERSE_DATA_DIR` is applied before the single-instance lock.

## Change coordination

| Change | Files to inspect together |
| --- | --- |
| RPC method | `app/shared/rpc.ts`, `electron/ipc.ts`, handlers in `electron/main.ts`, renderer caller/hooks in `frontend/src/lib/queries.ts`. |
| Event | `EventContract` in `app/shared/rpc.ts`, emitter/consumer, event allowlist in `electron/preload.ts`. |
| Settings | Shared `Settings` type; defaults and `sanitize()` in `app/core/settings.ts`; `frontend/src/lib/settingsFallback.ts`; patch schema in `electron/ipc.ts`; Settings UI; affected main-process consumers/change listeners. Explicitly rebuilt sanitizer objects must retain new fields. |
| Persisted data | `app/core/db/store.ts`: append migrations using `PRAGMA user_version`; preserve existing data and ordered migrations. |
| Source kind | `app/shared/types.ts`, `app/core/config/sitesConfig.ts`, `app/core/sources/types.ts`, registry/partition mapping, composition in `electron/main.ts`. |
| Website navigation | `electron/siteNavigator.ts`, `electron/sitePage.ts`, `app/core/sources/recipes.ts`, `WebSession.tsx`, `Watch.tsx`. |
| Theme/controls | `frontend/src/styles/app.css`, `controls.css`, `frontend/src/components/controls.tsx`. Reuse theme tokens and existing components. |

Version 1 adds local Workspace and Episode Toolkit seams. Read [workspace.md](workspace.md) for modules, data boundaries and limits.

## Important implementations

- Metadata: `app/core/metadata/anilist.ts`, `app/core/net/http.ts`. Cached/stale fallback and `RateGate(12, 28)` limit requests. Browse query variables intentionally omit unset filters.
- Persistence: `app/core/db/store.ts` uses `node:sqlite` / `DatabaseSync` and WAL. Contains local library/progress/history, sync queue, cache, site links and removal tombstones.
- Sources: the registry has `web` and `youtube` adapters. Website partitions are `persist:src-<id>`; YouTube channels share `persist:src-youtube`.
- Watch: `frontend/src/pages/Watch.tsx` selects explicit source, then last used, then first enabled. `WebSession.tsx` hosts website/YouTube pages; `player/VideoPlayer.tsx` handles native HLS/DASH/MP4 and cleanup.
- Release eligibility: `app/shared/release.ts` is shared across metadata/card/watch flows. Keep gate logic consistent; Watch also has an existing explicit override path.
- Accounts: `electron/oauth.ts`, `deepLink.ts`, `accounts.ts`; sync queue/providers/reconciliation are in `app/core/sync/`. Read [ACCOUNTS.md](../../docs/ACCOUNTS.md) before changing credential/sync behavior.
- Comments: core normalization plus `frontend/src/lib/richText.ts` and `components/RichText.tsx`; preserve safe link handling and React rendering instead of raw provider HTML.
- Playback diagnostics/recovery: `electron/mediaPage.ts` probes/controls the existing media element; `app/shared/playback.ts` derives frame/clock health; `frontend/src/components/PlaybackRescue.tsx` exposes it in Watch. Probe and control share a selected frame.
- GPU startup/diagnostics: `electron/main.ts` requests the documented discrete GPU preference before ready and adds actual GPU data to `app.info`; `app/shared/graphics.ts` normalizes/classifies adapters; `GraphicsPanel.tsx` reports the result in separate Graphics & GPU menus. UI font choice is a persisted `appearance.fontFamily` setting applied through the root CSS font token; coordinate defaults, sanitizer, fallback and IPC enum when extending it. See [PLAYBACK.md](../../docs/PLAYBACK.md).
- Drive: `app/shared/backup.ts` defines the strict version-1 portable format; `app/core/backup.ts` validates/merges without credentials, sources or local paths. `app/core/driveClient.ts` constrains Drive file operations; `electron/driveOAuth.ts` and `googleDrive.ts` own PKCE loopback auth, encrypted credentials and preview tickets. See [Drive setup](../../docs/GOOGLE-DRIVE.md).
- Anime4K: `app/shared/upscaleRuntime.ts` is browser-only WebGL code; `electron/upscaleGuest.ts` is bundled as a fixed guest script by `scripts/build.mjs`. Never import the DOM runtime into core/main directly. Guest-shader changes need a development restart to refresh the embedded script. Persisted settings use an explicit no-default partial IPC schema.
- Casting: `electron/cast/` implements CASTV2/mDNS and temporary token-protected LAN serving for local files. Website playback is not a castable extracted stream. `sender4k.ts` processes local files or selected-site capture with embedded FFmpeg/FFprobe and optional Anime4K/Vulkan/HEVC HLS output. `playerCapture.ts` brokers the sole display-media handler for TV mirroring and video-only compatibility upscaling. `windowsDisplay.ts` opens fixed system chooser/display/audio destinations for Miracast; Windows owns that screen-sharing connection. `config/ffmpeg.json` pins tools; `scripts/prepare-media.mjs` verifies/prepares them for app resources.
- Updates: `electron/updater.ts`, `updateSignature.ts`, renderer update components. Installed signed Windows NSIS builds use pinned Authenticode verification; other supported run modes report updates disabled. See [UPDATES.md](../../docs/UPDATES.md).
- Build: `scripts/build.mjs` bundles Electron to `dist/electron/{main,preload}.cjs` and Vite to `dist/renderer/`. Dev uses `127.0.0.1:5273` with a strict port. Build clears renderer output, overwrites Electron bundles in place.

### Chrome-backed transport (1.5.7)

electron/cast/chromeCast.ts owns the optional installed Chrome process, isolated cast-chrome profile, private inherited CDP pipe and secret loopback companion. cdpPipe.ts frames and bounds messages; chromePlayer.ts bundles hls.js through scripts/build.mjs. No debugging TCP port or normal Chrome profile is used. CastService accepts a device-aware CastTransport factory; Chrome devices are remembered only after trusted cast.chromeDevices. Chrome media URLs use 127.0.0.1; TVs receive Chrome's tab stream rather than fetching AniVerse HLS from the LAN. ChromeCastPicker is shared by website/native menus.

Retain explicit lifetime/ownership: user-triggered launch, companion-only target, teardown on navigation/closure/route loss, pending-client revocation and idle discovery timeout. Chrome's input decode resolution and actual TV output are different observations. test/e2e/chrome-cast.mjs tests the former; a physical receiver is needed to test the latter.

### Windows interface composition (1.5.8)

electron/uiRendering.ts owns a small device-local graphics.json startup preference. Main reads it before ready after applying ANIVERSE_DATA_DIR, defaults Windows to Stable UI, and uses disable-gpu-compositing. app.setUiRendering only writes the next-start choice; app.restart is an explicit trusted-host action. AppInfo.graphics.uiRendering reports active/preferred/restart state. Do not move this hardware-specific startup choice into portable/synced Settings without resolving early-startup availability.

Stable UI changes window composition, not all GPU work. Live WebGL/video-codec and native/captured Anime4K checks must accompany compositor changes. GraphicsPanel exposes the tradeoff. UI backdrop filters are removed; source/video filtering remains separate.

### 1.5.8 search/privacy/player extensions

Metadata discovery broadens sparse multiword results through a bounded first-word query and ranks English/romaji/native/synonym matches with small typo tolerance. It remains source-independent AniList discovery, not a live scraped source catalogue. Navigation tries up to six aliases and retains playback title/season/episode verification.

Private rules live in private_titles; incognito and metadata cache epochs are memory state. SessionManager issues UUID-based nonpersist partitions and validates their ownership. useWatchSources has no long-lived cached leases. Private storage is released on leaving; normal cookies are retained. Sync/backup/workspace safeguards run in the main process. Drive upload checks privacy again after token acquisition, immediately before transmission.

FOCUS_CSS normalizes media/ratio paths and the original video stays in place. Subframe focus is reversible and reapplied on frame load. upscaleGuest calculates overlay coordinates in the containing block, including scaling transforms. Adblocker owns session hooks, single-flight refresh, offline cache fallback and per-frame cosmetic dispatch.

The festival rollout marker is device-local KV state; the selectable festival accent is part of visual settings/presets. Its automatic lifetime ends at local January 1, 2027 without changing the chosen structural layout.

### 2.0.1 security and seasonal runtime

See [security boundaries](security.md). The embedded Rust/WebAssembly module is generated before dev/production/test runs, validates only boundary metadata and imports no OS capabilities. SourceNetworkGuard is mandatory even when ads are off. Trusted origins compare scheme/host/port explicitly, not opaque URL.origin values. Production disables Node environment/main-inspector entry points and validates ASAR integrity; use the renderer-only security harness on fused binaries. Seasonal logo/window icon/buffer are reversible and expire independently of manual palette use.

### 2.0.2 source identity, episode artwork and audio availability (2026-10-31)

seriesMarkers in app/core/sources/text.ts is self-contained and serialized as a fixed argument to sitePage's isolated-world function. It separates season and part/cour markers. Missing season information must remain unknown; do not default a named-arc candidate to Season 1 and reject it because another metadata alias says Season 2. A missing marker cannot authorize an unqualified parent using only a numbered alias; explicit conflicts remain rejected. YouTube's existing season parser/scoring is unchanged.

sitePage episodeCards reads rendered episode links, lazy images and explicit language badges only. SiteNavigator collects cards on the verified title/watch page and returns bounded metadata. EpisodeArtwork grants opaque media://episode tokens, fetches through the owned source session (mandatory Rust/DNS policy and cookies retained), bounds concurrent work/MIME/body/time, strips referrer paths/queries, disables image caching and revokes on owner destruction. It does not proxy video. Watch keys cards by media/source partition, preserving private-session separation and Spoiler Shield.

SourceAudioIndex is a bounded main-process session-only index of explicit per-episode SUB/DUB observations. sources.audio excludes disabled sources and private media. It does not persist or sync viewing records. Home LatestGrid filters the specific latest episode; Browse filters any confirmed audio for that series in loaded results and uses explicit load-more while audio filtering. Unknown titles remain in ALL; never infer dubbing from AniList popularity, country, title language or the presence of a global source server toggle. The user selected 2.0.2 for this follow-up. Historical 2.0.1 development/live reports validate the same feature implementation before the version update; final signed-package results are recorded separately.

A cached SPA revisit exposed a further artwork race: successful episode navigation could precede the episode-list hydration. SiteNavigator now retains an owner/job/page-bound successful context for read-only site.episodes refreshes. Watch reads it at 1.5/4/10 seconds after navigation, cancels on context changes and never reloads or delays the video. The integrated fixture delays watch-page cards for 6.5 seconds and verifies cached-revisit artwork recovery with Spoiler Shield active.

### 2.1.0 live source catalogues (2026-10-31)

The 2.0.2 catalogue semantics above are historical and were rejected by the user: DUB is series-wide SUB + DUB, even when the newest dubbed episode trails the newest subbed episode. SUB includes mixed and sub-only series. Per-episode filters still evaluate the individual episode's badges. Do not restore latest-episode gating for catalogue results.

Home LatestGrid and Browse use SourceCatalogueResults for DUB/SUB, independently of watched-title observations. ALL retains AniList discovery. SourceCatalogue owns one bounded, muted, hidden sandboxed BrowserWindow in sessions.ensure(source), with no preload/Node bridge, source URL policy and the normal guarded source session. cataloguePage serializes fixed rendered-DOM reads/clicks of public cards, audio controls and Next. It never reads private APIs or video URLs. Numeric counts preserve explicit zero; unknown counts can be confirmed by the selected source category. Native category pagination is bounded to 20 pages.

Public AniList IDs from card attributes/links/official cover filenames are resolved in one bounded official catalogueCards query with existing metadata filters. Alias scoring verifies the displayed identity. Unmapped cards open the public source page inside SourceBrowser with same-host validation and the authoritative main attach guard. No fabricated metadata IDs, watched hints or sync records are created.

Catalogue work is serialized with a 16-request queue, per-read deadline and idle destruction. Do not cancel every earlier request on category changes: React Query can reuse an in-flight DUB query after a DUB→SUB→DUB toggle; cancelling that shared request breaks the final selection. Privacy/cache/main-window/app teardown closes the helper and invalidates its epoch. Renderer source results use the partition/privacy/category/query key and gcTime zero.

### 2.1.1 shared hover audio and Explore selector (2026-10-31)

AudioTags.tsx mounts only with an open HoverPreview; source catalogue cards supply audioCounts/audioCategory/audioSource through MediaCard. Otherwise a delayed source-catalogue query searches up to two metadata title aliases and accepts only a matching mapped metadata ID. Queries are session/privacy scoped with gcTime zero, retries disabled; permanent private titles do not search persistent sessions. Unknown numeric counts remain unknown unless a selected source category confirms them; explicit zero stays unavailable. SourceCatalogue falls back to the website's public search controls through existing pageScript operations and never starts an episode for a lookup.

Browse's Audio Select and existing AudioFilter both update the audio route parameter; the metadata BrowseQuery intentionally excludes that parameter. Reset and reload now handle it consistently.
