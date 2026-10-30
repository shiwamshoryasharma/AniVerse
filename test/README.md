# Tests

| Path | Contents |
| --- | --- |
| `unit/` | Vitest suites for the core (config parser, SQLite store, settings, sync queue, AniList mapping/queries, source discovery, YouTube matching, comment helpers). `npm test` |
| `fixtures/` | Saved responses: AniList home query, a site with a search form, a site with schema.org SearchAction, a Cloudflare block page |
| `e2e/smoke.mjs` | Launches the built app **hidden** (`ANIVERSE_HEADLESS=1`: invisible, click-through, unfocused), visits every screen, plays public HLS/DASH/MP4 test streams and writes screenshots to `artifacts/`. Args select steps: `node test/e2e/smoke.mjs home watch`. `E2E_EXE=release/win-unpacked/AniVerse.exe` tests the packaged app. `E2E_FRESH=1` resets the profile |
| `e2e/sources.mjs` | Live checks against `config/streaming-sites.txt`: AniList filter combinations, YouTube RSS episodes, site search discovery, Cloudflare flow. Needs network |
| `cache/` | Test profile (`e2e-profile/`) and scratch data — git-ignored |
| `artifacts/` | Screenshots from E2E runs — git-ignored |
| `images/` | Image assets for tests (currently unused by the suites) |

`node test/e2e/workspace.mjs` validates version 1 menus, bookmark editing, planning, collection refresh, theme import/export, spoiler hiding, real local playback, dual captions/SRT import, skip maps and opt-in insights. It seeds neutral metadata and downloads a public Sintel test clip once under `cache/workspace-ui/`. Profiles, mocked dialog selections, exports and temp files stay under `cache/`; reports/screenshots go to `artifacts/workspace-*`. Set `E2E_EXE` for a packaged run.

Run `npm run build` before the application E2E scripts — they launch `dist/`.

`node test/e2e/player-focus.mjs` independently bundles the real focus/media DOM scripts into `test/cache/` and runs neutral fixtures in hidden Electron. It covers overlays, hidden/challenge frames, original player controls/captions, probe/control selection and recovery without stream-URL access. Reports and screenshots go to `test/artifacts/`. `node test/e2e/gpu.mjs` checks the actual high-performance/system startup flags and GPU Settings UI using separate hidden profiles. `node test/e2e/fonts.mjs` verifies UI font switching and persistence across app restarts. Unit suites also cover GPU adapter classification, playback-health counters and font defaults/persistence/sanitization; the Vitest cache stays in `test/cache/vite/`.

`node test/e2e/release-1.5.3.mjs` checks automatic/acknowledged release highlights, coloured history, actual navigation geometry for Classic/Studio/Cinema, native and website TV actions, controlled Drive backup and all Anime4K modes. `E2E_EXE` selects a packaged app.

`node test/e2e/website-mirror.mjs` captures a real isolated neutral webview with audio, passes chunks through production IPC validation, and verifies embedded H.264 1080p / HEVC 4K plus AAC output, HLS serving and navigation cleanup. Receiver transport is controlled; no physical TV is used. `E2E_MEDIA_RESOURCES` selects packaged tools/shaders. Its Electron fixture is under `test/e2e/fixtures/`; profiles, temp files and outputs remain under `test/`.

`node test/e2e/release-1.5.6.mjs` reproduces blocked WebGL pixel access using a neutral cross-origin iframe/video fixture. It verifies all six compatibility presets, visible processed output, original audio/playback, lifecycle cleanup, release highlights, and both Windows casting menus through validated IPC. Windows URI actions are controlled in this UI suite; it does not pair a TV. `E2E_EXE` selects a packaged run.

The 1.5.6 harness also checks Darken/Thin on native and captured video, and injects a 130 ms render delay to verify that late filtered output is hidden while source playback/audio continue. Unit suites test the actual vendor shader fragments and frame-deadline policy. These checks do not measure physical audio/video lip sync.

`node test/e2e/chrome-cast.mjs` verifies installed Chrome's actual Cast API and the production companion with local MP4 and embedded 3840 × 2160 HEVC HLS. Profiles/temp data stay under cache/chrome-cast; evidence goes to artifacts/chrome-cast*. It does not certify a TV route. E2E_MEDIA_RESOURCES selects packaged tools. The existing release-1.5.6 UI harness now uses the current package version for artifact names and checks Chrome discovery plus unchanged zoom/viewport/DPR and a non-blurred cast backdrop.

`node test/e2e/ui-rendering.mjs` checks non-blurred UI surfaces, repeated resizes, real GPU WebGL pixels, hardware codec availability, and Stable/Accelerated mode changes across three isolated Electron launches. Set E2E_DEVICE_SCALE_FACTOR to 1.25 or 1.5 for fractional-scale checks and E2E_EXE for the packaged build. The test requires a working hardware GPU and keeps everything under cache/ui-rendering and artifacts/ui-rendering-*. E2E_STABLE_UI=1 makes the website-mirror fixture use the same software window compositor as Windows production.

### 1.5.8 source/privacy and layout checks

- `node test/e2e/player-focus.mjs`: neutral cropped/offset video and wrapper regressions, layout restoration, original element identity/controls/subtitles, and real 4K overlay alignment under a transformed wrapper. Requires the existing public Sintel fixture clip in `test/cache/release-1.5.2-ui/`.
- `node test/e2e/sources-privacy.mjs`: real app IPC, missing-page fallback, bounded exhaustion/retry, popup denial, normal/private cookie isolation, leave/revisit cleanup, restart persistence and seasonal episode/settings UI. Controlled metadata and `.test` protocols only.
- `node test/e2e/release-1.5.6.mjs`: maintained current-version casting/Anime4K suite, now also checks cropped cross-origin iframe geometry before compatibility filtering.

Serialize GPU-heavy harnesses. `E2E_EXE=release/win-unpacked/AniVerse.exe` selects the signed unpacked app for supported launchers. Evidence remains under `test/artifacts/`; source catalogues, provider account syncing, TV output and installer installation are not validated by these fixtures.

### 2.0.1 security and seasonal checks

Rust developers need Cargo/rustc and the wasm32-unknown-unknown target (`rustup target add wasm32-unknown-unknown`). `npm test` prepares the locked module; Cargo downloads/targets stay under test/cache. Production/dev builds prepare it too.

`node test/e2e/security.mjs` checks the real Rust module, app CSP, source sandbox, private-network blocking with ads off while video keeps advancing, quality changes, normal navigation, 4K output and January loader/logo reversion. `E2E_EXE=release/win-unpacked/AniVerse.exe` tests the production fuse restrictions through renderer-only CDP. Older Playwright Electron main-inspector launchers intentionally cannot drive the fused release; run them on the development bundle for regression coverage.

`node test/e2e/live-playback.mjs` surveys configured website sources against ordinary catalogue metadata. It uses a new isolated profile, muted output and no browser debugging; reports advancing decoded media separately from navigation. SURVEY_INDICES, SURVEY_ID, SURVEY_TIMEOUT and SURVEY_REPORT can select/retry cases. Source configuration is not published; evidence stays ignored under test/artifacts. A failed or unconfirmed live player is not a playback pass.
