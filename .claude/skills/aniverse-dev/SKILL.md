---
name: aniverse-dev
description: Build, run, test and visually verify the AniVerse Electron app in this repository. Use for any change to app/, electron/ or frontend/, for debugging the running app, and to resume work (see RESUME.md in this folder).
---

# AniVerse development

## Commands (run from the project root)
| Goal | Command |
| --- | --- |
| Install | `npm install` (npm 11 blocks install scripts: `allowScripts` in package.json approves electron/esbuild; if `node_modules/electron/dist` is missing run `node node_modules/electron/install.js`) |
| Dev with HMR | `npm run dev` (Vite on 127.0.0.1:5273 + esbuild watch + Electron restart) |
| Typecheck | `npm run typecheck` (root tsconfig = app + electron + unit tests; `frontend/tsconfig.json` = renderer) |
| Lint | `npm run lint` (oxlint, config `.oxlintrc.json`; must be 0 warnings) |
| Unit tests | `npm test` (Vitest, `test/unit`) |
| Build | `npm run build` → `dist/electron/{main,preload}.cjs`, `dist/renderer` |
| E2E (hidden window) | `node test/e2e/smoke.mjs [steps…]` → screenshots in `test/artifacts/`; steps: home details browse schedule sources watch library player settings-sources settings-accounts settings-privacy player-hls player-dash player-mp4 |
| Live sources | `node test/e2e/sources.mjs` (AniList filter combos, YouTube RSS; optional FORM_SOURCE / SPA_SOURCE / CF_SOURCE site checks) |
| Site survey | `npm run test:sites [-- <source-id…>]` → `test/artifacts/site-survey.json` + `survey-<id>.png`. Runs **in-process** (`ANIVERSE_TEST_DRIVER`, `test/e2e/drivers/site-survey.cjs`, launcher `test/e2e/native.mjs`) — never through Playwright (see gotcha) |
| Release/leak/cat gates | `node test/e2e/watch-gates.mjs [unreleasedId] [releasedId]` |
| Site debugging | `node test/e2e/site-debug.mjs <id> <url> [--no-adblock]` (navigation initiators via CDP; Playwright, so webdriver=true) and `PROBE_URL=<url> npx electron test/e2e/guard-probe.cjs [w h]` (plain webview, no automation) |
| Packaged check | `npx electron-builder --win --dir --config electron-builder.yml` then `E2E_EXE=release/win-unpacked/AniVerse.exe node test/e2e/smoke.mjs home sources` |
| Windows installer | `npm run dist:installer` → `release/AniVerse-Setup-<v>.exe` (art from `assets/installer/` rendered by `scripts/make-installer-art.cjs`; NSIS customisation in `build/installer.nsh`; see docs/INSTALLER.md). NSIS-only rebuild: `npx electron-builder --win nsis --prepackaged release/win-unpacked --config electron-builder.yml` |
| Installer tests | `pwsh -NoProfile -NonInteractive -File test/e2e/installer-silent.ps1` (install/reinstall/uninstall, data untouched) and `… test/e2e/installer-ui.ps1` (drives every page off-screen → `test/artifacts/installer-1..8-*.png`) |
| Icon | `npx electron scripts/make-icon.cjs` (renders `frontend/public/favicon.svg` → `build/icon.png`) |

## Verifying UI
The built-in browser pane cannot host the app (renderer needs the preload bridge). Verify with the E2E script and **Read the PNGs** in `test/artifacts/`. Wait for real content selectors (e.g. `.mcard img`, `.state h3`), not loading placeholders (`.state` also matches spinners).

## Gotchas learned the hard way
- **Single-instance lock** lives in the userData folder: `ANIVERSE_DATA_DIR` is applied at the top of `electron/main.ts` *before* `requestSingleInstanceLock()`, so test runs never collide with (or focus) the user's own `npm run dev` instance. A hung *test* instance still blocks the next test launch ("Target page … has been closed") — stop only processes whose command line uses `test/cache/e2e-profile`, never the user's.
- `scripts/build.mjs` overwrites `dist/electron` in place (no `rm -rf dist`) so building while the user runs `npm run dev` is safe.
- **Never edit regex-heavy TS through bash heredoc + Python**: `\\b` collapses and Python writes a backspace char. Use the Write/Edit tools for files with backslashes.
- **AniList nulls**: `id_not_in: null` / `format_in: null` → HTTP 500, `countryOfOrigin: null` → empty. `browseQuery()` declares only set filters. AniList `pageInfo.total` is a 5000 placeholder for broad filters.
- **AniList rate limit** ~30/min → `RateGate(12, 28)` + SQLite cache + stale fallback.
- **Ghostery**: `enableBlockingInSession` registers global IPC per session (breaks with >1 partition) — `electron/adblock.ts` wires `onBeforeRequest/onHeadersReceived` per partition and registers cosmetic IPC once; custom `config/filters.txt` is applied with `updateFromDiff` (merging engines fails on resource checksum).
- **webRequest is single-listener per session**: the adblocker owns `onBeforeRequest`/`onHeadersReceived` in source sessions — detect Cloudflare in webviews via page titles, not headers.
- **YouTube Error 153**: embeds need a referrer; `WebSession` sets `httpreferrer` and passes `{ httpReferrer }` on every `loadURL`; never reload the initial src on `dom-ready`.
- **Hidden E2E windows** must still be shown (opacity 0 + ignore mouse + showInactive) — a never-shown window doesn't paint and screenshots time out.
- `node:sqlite` works in Electron 44 (Node 24) and in Node 22.17 for Vitest (prints an ExperimentalWarning — harmless).
- **Bash tool + heredoc containing `''`** fails with "unexpected EOF": write patch scripts with the Write tool to `test/cache/patch.py`, run with `python`, delete after.
- **The user's `npm run dev` (Vite on 127.0.0.1:5273) can cache a half-written file**: rewriting a module with `cat > file` once left Vite serving an *empty* `CatLoader.tsx` (broken cat in the user's window). Patch scripts must write to a temp file and `os.replace` it; after edits, spot-check `curl -s http://127.0.0.1:5273/src/<path> | wc -c`. Re-saving the file fixes a stale module.
- **AniList release status is unreliable**: films stay `RELEASING` while in cinemas and shows flip to `RELEASING` before their start date. Gate playback with `app/shared/release.ts` (`pendingRelease`), used by the core home partition, cards, Details and the Watch gate.
- **Site navigator debugging**: `node test/e2e/site-survey.mjs <source-id…>` drives each site in the real app and writes `test/artifacts/site-survey.json` (statuses, navigations incl. redirects, final page) + `survey-<id>.png`. Per-site hints go in `config/site-recipes.json`; prefer generic fixes in `electron/sitePage.ts`.
- **Playwright makes sites see a bot**: `_electron.launch` adds `--remote-debugging-port`, which sets `navigator.webdriver = true` in every page, webviews included. One site's guard (webdriver / chromedriver keys / disable-devtool → blank page + `location.replace('/')`) then bounced every search to its splash page, and Cloudflare scores it as automation. Users never run with that flag. Anything that judges *site* behaviour must run in-process via `ANIVERSE_TEST_DRIVER` (dev builds only) — Playwright is fine for AniVerse's own UI. Never "fix" this by spoofing `navigator.webdriver` in the product.
- npx's Windows shim fails (exit 127) on arguments containing `?` — pass URLs to `npx electron <script>` through env vars. Data URLs with inline HTML need `encodeURIComponent` (a `#` in CSS truncates them).
- **Webview leak**: the Watch loader must be keyed on the site key, not on the webview id — otherwise the site is visible until the guest attaches. `node test/e2e/watch-gates.mjs` checks it.
- Muse Asia titles look like `Show - Episode 15 (S2E03) [English Sub]`: `parseEpisodeNumber` prefers `SxEy`; `videoScore` requires matching seasons.
- **NSIS installer (`build/installer.nsh`)**: electron-builder compiles with warnings as errors, so installer-only and uninstaller-only functions/variables sit behind `!ifndef/!ifdef BUILD_UNINSTALLER`. `SetBrandingImage` and `$mui.*` page variables only exist after MUI inserts the page: define such functions inside the page hook macro *after* the page, or in `customHeader` (inserted after all pages). MUI re-shows separator controls 1035/1036/1045 on every page change — hide them in each show function. A leftover installer process locks `release/*.exe` ("waiting for unlock") and blocks the next run (one-instance rule): stop `AniVerse-Setup*` first.
- **Driving Win32 dialogs from PowerShell**: don't name helpers after aliases (`Cls` = Clear-Host → "Exception setting CursorPosition"); keep window enumeration in C#; press buttons with a posted `WM_COMMAND` to the dialog (BM_CLICK fails when the dialog isn't active, and SendMessage blocks on modal boxes); read edit boxes with `WM_GETTEXT`. Run such scripts with `pwsh -NoProfile -NonInteractive -File` — and note Git Bash kills child processes when its command ends.

## Where things live
- RPC contract: `app/shared/rpc.ts` (+ zod schemas in `electron/ipc.ts`, handlers in `electron/main.ts`, hooks in `frontend/src/lib/queries.ts`). Adding a method = all four.
- Styles: single design system `frontend/src/styles/app.css` (tokens on `:root`, accents via `[data-accent]`, density via `[data-density]`).
- Watch logic: `frontend/src/pages/Watch.tsx`; site sessions: `frontend/src/components/WebSession.tsx`; player: `frontend/src/player/VideoPlayer.tsx`.
