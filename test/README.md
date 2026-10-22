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

Run `npm run build` before the E2E scripts — they launch `dist/`.
