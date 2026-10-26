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
