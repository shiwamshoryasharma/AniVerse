# Architecture and extension seams

Inspected 2026-10-26. Start with [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for the maintained architecture narrative and [package.json](../../package.json) for current scripts/dependencies.

## Directory map

| Path | Responsibility |
| --- | --- |
| `app/core/` | Plain TypeScript domain services: metadata, config parsing, SQLite, sources, settings, comments, sync. No Electron imports found in this layer. |
| `app/shared/` | Shared data types, typed RPC/events, release gating. |
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
- Casting: `electron/cast/` implements CASTV2/mDNS and temporary token-protected LAN serving for local files. Website playback is not a castable extracted stream.
- Updates: `electron/updater.ts`, `updateSignature.ts`, renderer update components. Installed signed Windows NSIS builds use pinned Authenticode verification; other supported run modes report updates disabled. See [UPDATES.md](../../docs/UPDATES.md).
- Build: `scripts/build.mjs` bundles Electron to `dist/electron/{main,preload}.cjs` and Vite to `dist/renderer/`. Dev uses `127.0.0.1:5273` with a strict port. Build clears renderer output, overwrites Electron bundles in place.
