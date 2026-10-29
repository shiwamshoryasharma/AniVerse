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
