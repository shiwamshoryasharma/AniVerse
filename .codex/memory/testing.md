# Testing and image-input policy

Rechecked 2026-10-29; initially inspected 2026-10-26. See [test/README.md](../../test/README.md), [package.json](../../package.json), and [.claude/memory/testing-practice.md](../../.claude/memory/testing-practice.md).

## Required locations

All test scripts/configurations/caches/profiles/temp files/evidence belong under `E:\14-OCT-2026\aniverse\test`.

| Purpose | Location |
| --- | --- |
| Image input for model generation or validation | `test/images/` |
| Unit suites / fixtures | `test/unit/` / `test/fixtures/` |
| Electron integration harnesses / native drivers | `test/e2e/` / `test/e2e/drivers/` |
| Test configuration | `test/` (existing `vitest.config.ts`) |
| Disposable cache, profiles, task-specific temporary files | `test/cache/` |
| Screenshots, reports and generated validation outputs | `test/artifacts/` |

`test/images/` contained only `.gitkeep` at inspection. Recheck before image-dependent work. Do not silently use documentation screenshots, production cat assets, unrelated directories or generated replacement images. No model-generation subsystem was identified in the inspected application.

`test/cache/*` and `test/artifacts/*` are ignored except `.gitkeep`. Keep reusable tests in maintained test directories; scratch validators may stay under `test/cache/`.

## Existing commands

Run from the project root in PowerShell:

~~~powershell
Set-Location -LiteralPath 'E:\14-OCT-2026\aniverse'
npm run typecheck
npm run lint
npm test
~~~

A targeted unit invocation is `npm test -- test/unit/site-navigator.test.ts`. The current Vitest config uses Node, fork workers, a 15-second timeout and `test/unit/**/*.test.ts`. Store tests use in-memory SQLite. The runtime must support `node:sqlite`; verify the actual Node version rather than historical machine notes.

For application code, [CONTRIBUTING.md](../../CONTRIBUTING.md) also requires `npm run build`. E2E launches the existing `dist/` build:

~~~powershell
npm run build
node test/e2e/smoke.mjs home
node test/e2e/smoke.mjs watch player-hls
node test/e2e/watch-gates.mjs
~~~

Choose only relevant E2E steps; the smoke harness still has network-dependent startup. Builds write normal application output to `dist/`; that directory is not a destination for test caches or scripts.

For source/website checks:

~~~powershell
npm run test:live
npm run test:sites
node test/e2e/native.mjs test/e2e/drivers/watch-audio.cjs
~~~

These contact live services/sites; historical artifacts cannot establish present availability.

## Harness invariants

- Use existing hidden launchers: `ANIVERSE_HEADLESS=1`, with `ANIVERSE_DATA_DIR` under `test/cache/`. A custom launcher must also set `ANIVERSE_CONFIG_DIR` under `test/cache/` if it writes test-only configuration.
- Main applies the data directory before the single-instance lock. Test mode also avoids taking over the OS deep-link handler and initial account auto-sync.
- Smoke, live sources and watch-gates share `test/cache/e2e-profile`; do not run them concurrently. Native drivers use `native-profile`; survey uses `survey-profile` unless configured otherwise.
- `E2E_FRESH=1` deletes the smoke test profile. Native/survey launchers can reset their test profiles. Verify the exact resolved target and ownership before deleting or moving anything.
- Record spawned PIDs and exit/cleanup only owned test processes. Profiles are often passed through environment variables, so a command-line substring alone may not identify ownership. Never blanket-kill Electron or the user's development app.
- Use Playwright for AniVerse's own UI. Prefer the native in-process driver for third-party site behavior: Claude observed that remote debugging exposed automation and triggered false site failures. Recheck this tooling-dependent behavior when relevant; do not spoof browser properties in the product.
- A browser-only renderer preview lacks the Electron preload and cannot validate actual app flows.
- Wait for real content and inspect the resulting `test/artifacts/` PNGs after UI changes. A loading selector or old screenshot is not verification.

## Known containment gaps: inspect before running

The current harnesses are not all fully contained:

- `test/vitest.config.ts` now explicitly sets Vite's `cacheDir` to `test/cache/vite/`. Keep task-specific tool/npm/temp caches under `test/cache/` as well.
- When `ELECTRON_BUILDER_CACHE` is inside this ESM repository, put a `package.json` with `type: commonjs` at that test-cache root. Builder's downloaded CommonJS icon helper otherwise inherits the app's `type: module` and fails. Keep the fence in `test/cache/`, not in application source.
- A custom check may need task-scoped `TEMP`, `TMP`, and `TMPDIR` redirected under `test/cache/`; restore prior values afterward.
- `test/e2e/guard-probe.cjs` does not set `ANIVERSE_DATA_DIR` itself. Do not use its unmodified default invocation as an isolated test.
- Installer tests modify real Windows installation, HKCU records and shortcuts. Updater E2E also temporarily moves the shared `%LOCALAPPDATA%\aniverse-updater` cache.
- `scripts/releaseConfig.mjs` uses `os.tmpdir()` for generated release configuration. Installer/uninstaller tools may write outside `test/` too.

Do not run installer/updater/release workflows for routine validation or documentation checks. If specifically requested later, first adapt/verify their test isolation and identify unavoidable OS effects against the user's scope.

## Playback/GPU/font checks added in 0.3.0

`node test/e2e/player-focus.mjs` runs neutral rendered focus/media fixtures (no application build needed). `node test/e2e/gpu.mjs` checks actual startup preferences, separate graphics menus, illustrations, icon layout and path removal. It accepts `E2E_EXE` for a packaged app. `node test/e2e/fonts.mjs` checks UI font changes and persistence across restarts. The release summary is `test/artifacts/release-0.3.0-validation.json`.

## Release 1.5.2 checks

`node test/e2e/release-1.5.2.mjs` checks three styles, controlled Drive OAuth/import/export through real IPC, all six native GPU modes, compact menu controls and embedded cast availability. Google transport is controlled; no real account is used. `node test/e2e/cast-4k.mjs` runs real embedded FFmpeg/Anime4K/HEVC/AAC encoding and HLS token/range checks with a receiver transport fixture; no physical TV is controlled. `E2E_EXE` selects a packaged app for the UI harness; `E2E_MEDIA_RESOURCES` selects packaged tool/shader resources for the encoding harness. Evidence is `test/artifacts/release-1.5.2-*`.

## Context refresh (2026-10-29)

For the current context-only validation, use `test/cache/codex-context-2026-10-29/validate_context.py`; its report is `test/artifacts/codex-context-2026-10-29.json`. The older context validator has a fixed three-skill list and an October 26 baseline; it does not validate the expanded skill set or establish preservation across this refresh. The new validator discovers project skills and compares against a fresh baseline.

The image directory was rechecked and still contains only `.gitkeep`. No image/model check ran. Application build/runtime checks are unnecessary for these context-only changes.

## Original context-only update

No application tests, builds, live website checks, image/model checks, installers or releases were required. Validate the skills and local links, record evidence under `test/artifacts/`, and verify existing source/Claude files remain unchanged.

## Release 1.5.3 checks

release-1.5.3.mjs adds first-launch highlights/receipt persistence, coloured history, structural layout geometry and visible native/website Cast controls. website-mirror.mjs uses actual webContents video/audio capture, production RPC schemas, embedded H.264/HEVC/AAC encoding and a controlled receiver. E2E_MEDIA_RESOURCES can select packaged tools. No physical TV is used. Evidence is test/artifacts/release-1.5.3-*; unit count is 161 at this change.

## Release 1.5.6 checks

release-1.5.6.mjs uses a real cross-origin iframe plus a third-origin video without CORS to reproduce direct GPU SecurityError and exercise all six compatibility presets, source audio/playback and stop/navigation cleanup. Windows chooser/display/audio RPC actions are controlled in the UI suite. A separate contained native-launch probe checks the real registered system URI without selecting a TV. Current unit count is 177; physical TV pairing and universal website compatibility are not certified.

## Chrome casting checks (1.5.7)

test/e2e/chrome-cast.mjs launches installed Chrome with a fresh profile under test/cache/chrome-cast and private inherited pipes. It uses the production companion and CastService media server to verify MP4 plus embedded 4K HEVC HLS playback, advancing media/frame counters, screenshots and shutdown. The receiver is a local-player test double; physical TV output is not tested. E2E_MEDIA_RESOURCES selects packaged embedded tools.

release-1.5.6.mjs now derives artifact/version names from package.json, retains earlier upscaling/timing regressions and adds real Chrome discovery through trusted IPC plus app zoom, viewport, DPR and non-blurred backdrop checks. Its Windows URI actions remain controlled. On 2026-10-29, the host had no receiver announcements; do not infer receiver support or physical connection from these checks.

## Whole-interface rendering checks (1.5.8)

test/e2e/ui-rendering.mjs validates 22 checks per run through Stable → Accelerated → Stable restarts: fresh release overlays, actual compiled CSS, repeated native resizes, zoom/DPR invariants, live GPU WebGL pixels/renderer, video codec flags, preference persistence and restart status. E2E_DEVICE_SCALE_FACTOR=1.25/1.5 covers fractional scaling; E2E_EXE selects the packaged app. All profiles/config/temp/evidence stay under test/.

E2E_STABLE_UI=1 makes website-mirror.mjs assert disabled_software composition in its Electron fixture, so capture/encoding checks exercise the same path as production. GPU-heavy tests should run sequentially: concurrent sender/GPU startup once produced a zero-pixel accelerated readback, while isolated serial reruns at both scales passed. Do not convert a resource-contention failure into a driver diagnosis or silently retry it away.

gpu.mjs now acknowledges the current release dialog and uses its own neutral config directory. The native desktop user's intermittent hover-to-clear symptom was not directly reproduced by the hidden harness; report the tested compositor workaround and CSS fix without universal driver claims.

The 1.5.8 sources-privacy harness uses real Electron/IPC with neutral protocol handlers, temporary profiles and controlled metadata. It covers bounded fallback/retry, popup prevention, normal/private cookie separation, release/revisit cleanup and restart persistence. player-focus additionally decodes the public test clip for a real 4K overlay under a transformed containing block. New unit suites cover search ranking/aliases, blocker hot refresh/offline fallback, popup policy, seasonal expiry/opt-out and privacy races. These do not certify live external site availability or anonymous browsing.

From 2.0.1, npm test prepares the locked Rust/WASM module and dependency notices; the target toolchain is wasm32-unknown-unknown. All Cargo download/target caches remain under test/cache. test/e2e/security.mjs supports fused production binaries through renderer-only CDP and verifies actual video advancement during blocked unrelated requests. Legacy _electron main-inspector harnesses are development-only after the fuse change. Native live surveys have no remote debugging and keep player-source URLs out of tracked reports. The 1.5.8 baseline comparison uses an isolated extracted, hash-verified installer with only a test bootstrap around its unchanged app bundle; it does not run an installer or alter the user's installed app.

Unreleased 2026-10-31 checks: test/e2e/series-matching.mjs runs real isolated-world DOM matching and episode-card operations without external sites. test/e2e/series-ui.mjs drives complete search/title/episode navigation, source-session image grants using extracted public fixture frames, all audio filter locations, original playback, Spoiler Shield, responsive controls and private-title exclusion. Both contain all profiles/temp/evidence under test. The UI launcher targets development Electron; it does not weaken packaged fuses. Live playback surveys now report episode card/artwork counts and explicit audio observations without source URLs in maintained code.

Version 2.0.2 extends security.mjs with two compiled-app thumbnail/audio checks. Its renderer-only CDP launcher can exercise the signed fused app without enabling the Node inspector. The existing cross-origin/GPU/security and local media checks remain. Package verification still compares exact bundle/WASM bytes, signatures, feed, selected fuses and embedded tool/shader hashes.

## 2.1.0 catalogue regression checks (2026-10-31)

test/unit/catalogue-audio.test.ts reproduces lagging-dub exclusion and inclusive SUB, explicit zero/unknown category rules, plus bounded official metadata ID resolution. test/e2e/series-ui.mjs starts with no observed titles, reads rendered neutral source catalogue cards, checks native paging, rapid DUB→SUB→DUB changes, Home/Browse, per-episode filters and private helper cleanup. It retains arc/still/late-cache/spoiler/normal video checks. test/e2e/security.mjs adds a fresh-catalogue check to the production-compatible renderer-CDP suite; its homepage fixture retains its original video as well as catalogue cards.

Live catalogue inspection and native Home verification are in ignored test/cache/catalogue-*.cjs and test/artifacts/catalogue-*.json/png. The fresh native UI result has navigator.webdriver false, 12 DUB cards including SUB 12 / DUB 11, 12 SUB cards including zero-DUB series, and zero watched-title hints before and after. These prove the inspected provider, not every possible TXT-source DOM. They do not certify physical TV/audio or install/update installation.
