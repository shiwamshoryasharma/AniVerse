# Status and provenance

Snapshot: 2026-10-26, Asia/Calcutta. This is a source/documentation inspection, not a runtime certification.

## Version 1.0.0 update (2026-10-26)

Adds the eight local workspace features and integrated Episode Toolkit; Watch Together was explicitly removed. See [workspace.md](workspace.md). README, DISCLAIMER, PRIVACY and the About notice now describe the actual browser/player model, local data, rights and limitations.

131 unit tests, typecheck/lint, production/signed build, 10 packaged Workspace checks, 25 original-player assertions, both GPU preference/UI modes and packaged HLS/DASH/MP4 playback passed. The pinned signer, SHA-512 feed and public-only packaged resources were verified. Evidence: test/artifacts/release-1.0.0-validation.json. The self-signed certificate has an untrusted root; this is not a publicly trusted publisher. Real installer/uninstaller/updater installation and image/model-generation tests were not run. Source-specific live playback was not rerun for 1.0; frame counters do not certify lip sync.

## Playback/GPU update (2026-10-26)

Version 0.3.0 adds focus isolation fixes, hidden/challenge-frame rejection, Playback Rescue, same-element recovery, position preservation on source option changes, and dedicated-GPU preference with actual adapter reporting, separate illustrated GPU settings menus, and persisted UI fonts. See [PLAYBACK.md](../../docs/PLAYBACK.md). Current validation/release evidence belongs under `test/artifacts/`; historical context-only hashes below describe the earlier documentation task, not the application patch.

## Existing implementation

`package.json` reports AniVerse 1.0.0, Electron 44, React 19, TypeScript 6 and Vite 8. These are repository declarations, not claims about globally installed runtimes.

The inspected source contains these implemented layers:

| Layer | Evidence |
| --- | --- |
| Core metadata, SQLite, settings, comments, library/progress | `app/core/` |
| IPC/preload and isolated browser sessions | `electron/ipc.ts`, `preload.ts`, `sessions.ts` |
| Website search/episode navigation and player focus | `electron/siteNavigator.ts`, `sitePage.ts` |
| Website/YouTube/native playback and release gates | `frontend/src/pages/Watch.tsx`, `components/WebSession.tsx`, `player/VideoPlayer.tsx`, `app/shared/release.ts` |
| Accounts and local-first/two-way sync | `electron/accounts.ts`, `oauth.ts`, `app/core/sync/` |
| Casting | `electron/cast/` |
| Windows installer, signing and self-update | `build/installer.nsh`, `scripts/dist-signed.mjs`, `electron/updater.ts`, `updateSignature.ts` |
| React pages, custom controls/theme, original cat loader | `frontend/src/` |
| Unit/Electron harnesses | `test/unit/`, `test/e2e/` |

Preserve and extend these layers. Their presence does not establish that every path currently passes. No AI model-generation component was found in the inspected application; the user's image-testing rule is retained for future relevant work.

## Stale or narrower historical notes

- [.claude/skills/aniverse-dev/RESUME.md](../../.claude/skills/aniverse-dev/RESUME.md) includes older “unsigned installer / signing next” limits alongside later signing/updater work. Current source and [INSTALLER.md](../../docs/INSTALLER.md)/[UPDATES.md](../../docs/UPDATES.md) show those implementations exist. Do not recreate them as unfinished tasks.
- Initial “no episode scraping” wording predates rendered-page episode navigation. Keep the distinction between the website adapter's page result, the navigator's DOM interaction, and prohibited stream extraction.
- Older OAuth-window descriptions are superseded by the implemented system-browser/deep-link flow.
- `scripts/build.mjs` says OAuth client-ID changes require a dev restart. `electron/main.ts` reads config/environment live in development; packaged builds use compiled IDs.
- Base `electron-builder.yml` lists site configuration resources, while signed release configuration deliberately includes only filters. `electron/paths.ts` seeds site-list/filter defaults, not recipes. Do not assume a fresh packaged profile has development recipes.
- Claude's tool versions, regional/network failures and prior test successes are dated October 22–23 observations. Verify current conditions instead of copying them as facts.
- macOS/Linux packaging entries do not prove those platforms were tested. Historical notes also leave nearly-full-drive installer handling unverified.

## Evidence for the 0.3.0 application update

111 unit tests, 25 rendered-player assertions, typecheck/lint/build, live SUB/DUB playback, GPU settings and font restart persistence checks passed. The signed packaged app passed home/HLS smoke and GPU-menu checks. The installer/update feed hash was verified. Local evidence is in `test/artifacts/release-0.3.0-validation.json`. Real installer/uninstaller/update-install E2E was not run. Frame counters do not certify lip-sync; NVIDIA AI enhancement remains driver controlled.

## Evidence for the original context-only update

The requested work adds Codex guidance and memory, plus validation evidence under `test/`. The skill validator, local-link checks and existing-file hash comparison are recorded by `test/cache/validate-codex-context.py` in `test/artifacts/codex-context-validation.json`.

Application typechecks, lint, unit/E2E tests, builds, account actions, live websites, image/model generation and Windows installers/updaters were not run for this documentation-only task. Existing artifacts and Claude's past pass claims are not current results.
