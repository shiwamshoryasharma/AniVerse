# Status and provenance

Snapshot: 2026-10-29, Asia/Calcutta. Scoped source/runtime validation is recorded below; it is not certification of every external service or device.

## Version 1.5.7 (2026-10-29)

New user evidence shows Chrome actively tab-casting to a TV that AniVerse could not discover. Windows + K visibility alone did not establish the TV's complete protocol support; the earlier Miracast-only diagnosis was insufficient. AniVerse's direct CASTV2/Default Media Receiver HLS path is not Chrome tab mirroring.

ChromeCast now uses installed Chrome's Media Router via inherited CDP pipes, a dedicated app-owned profile and a token-protected loopback companion. The shared CastService transport seam retains direct casting and embedded sender processing. Chrome gets selected-player media, not source pages/cookies or the Windows desktop. Unique names start tab mirroring; duplicate friendly names require a native Chrome-menu choice after player load. An unused discovery window expires after two minutes. CDP Cast is experimental; physical output quality remains receiver/Chrome-dependent.

Removed the cast backdrop blur, bounded the native chooser to its player, made cast/upscale/quality/speed menus mutually exclusive, kept failures visible and restored previous playback after failed native starts. Native startup is invalidated during URL preparation/previous-sender teardown; route end and polling failure close the transport. Pending Chrome clients are revoked immediately on closure.

Verified source checks: typecheck, clean lint, 188 tests/32 files; nine Electron UI checks including real Chrome discovery through trusted IPC, unchanged zoom/viewport/DPR and no backdrop blur; real Chrome MP4 and embedded HEVC 3840 × 2160 HLS decoding with advancing frame counters; six real owned-webview capture/encoding checks. The signed package additionally passed nine feature checks, ten Workspace regressions, package/signature/feed verification and embedded tool/shader hash checks. The latest mirror run had <=22 ms complete-segment audio/video timestamp gaps across its sustained sample. These are presentation timestamps, not measured TV lip sync.

The test host received no mDNS/SSDP TV announcements and Chrome reported no receivers; the user confirmed the TV was off/unavailable during verification. Physical TV pairing/playback, final TV resolution and lip sync remain unverified. Evidence stays under test/artifacts/chrome-cast*, release-1.5.7-*, and test/cache/cast-diagnosis. Do not describe a mocked Cast driver or successful companion playback as a successful TV connection.

## Version 1.5.6 (2026-10-29)

The requested release addresses three reported paths: Windows + K TVs use Miracast rather than Google Cast; origin-blocked video needs compositor-capture compatibility filtering; and the pinned Darken/Thin GLSL fragments do not compile in WebGL 1. WindowsDisplay opens fixed system chooser/display/audio destinations. PlayerCapture brokers the sole display-media handler for owned source views. lineEffects.ts specializes vendor Gaussian loops locally; node_modules and global WebGL APIs are unchanged.

Rendering completes one GPU frame at a time, rejects output beyond an 80 ms render/media-clock deadline, tries smaller shader models after sustained lateness and returns to the original picture if necessary. Source audio, seeks and playback rate remain authoritative. This controls filter-induced lag; it is not a physical lip-sync measurement or a repair for mistimed source tracks.

Verified: 177 unit tests, typecheck/lint, signed production build, eight packaged casting/upscaling/timing checks and ten packaged Workspace checks. The real neutral fixture covers a cross-origin iframe and third-origin video without CORS, all six presets, Darken/Thin, original audio/playback, a forced 130 ms render delay, and navigation/stop cleanup. Native system URI launching returned success without TV selection; desktop tooling did not establish a physical TV connection. Physical pairing, DRM, every live source and actual installer/update installation remain unverified. Evidence is test/artifacts/release-1.5.6-* and test/cache/release-1.5.6/verify-release.py.

An existing time-dependent metadata-cache key was exposed during the final unit run. The since/now variables now share a time bucket, with a deterministic second-boundary regression.

## Version 1.5.3 (2026-10-29)

The user clarified themes as structural layouts. Classic/Studio/Cinema now select different navigation and episode placement while retaining old persisted style IDs. Watch has an explicit Cast to TV button for native media and scoped website-view/audio mirroring. ChangelogService and bundled release data provide automatic per-version highlights, coloured/icon history and feature links.

Verified: typecheck/lint, 161 unit tests, production build, eight packaged feature checks, ten packaged Workspace regressions, real owned-webview H.264 1080p / HEVC 3840 × 2160 with AAC, and local-file HEVC/HLS token/range serving using packaged embedded tools. The receiver transport is controlled; no physical TV or real Google account was used. Installer/feed/vendor-hash/skill-link evidence is recorded by test/cache/release-1.5.3/verify-release.py into test/artifacts/release-1.5.3-validation.json.

Regression lessons: bundled Electron 44 reports display capture as a media permission request with an empty device list. Only allow that shape for a fresh owned-player grant and trusted top frame; never grant audio/video device types. Return the capture grant before encoder probing consumes user activation. Observe encoder readiness rejection even when TV validation fails, and guard asynchronous receiver/server startup against stop. Release-dialog header/footer stay visible while its body scrolls.

## Version 1.5.2 (2026-10-29)

Implemented Classic/Aurora/Paper interface styles, six-mode Anime4K WebGL filtering, personal-OAuth Google Drive app-data backup, and embedded sender-side Anime4K/Vulkan/HEVC 4K casting for opened local videos. FFmpeg/FFprobe 9.0.2 ship inside app resources and never resolve from PATH. The fixed Drive protocol is `AniVerse Sync/aniverse-backup.v1.json`; credentials, site identities, local media paths and watch insights are excluded.

Current checks passed: typecheck/lint, 151 unit tests, production/signed Windows build, six packaged feature checks (including all six GPU modes), ten packaged Workspace regressions, and real embedded 3840 × 2160 HEVC/AAC encoding plus HLS token/range serving. The existing signer was retained; embedded vendor tool hashes and public-only packaged config are checked by `test/cache/release-1.5.2/verify-release.py`. Evidence: `test/artifacts/release-1.5.2-validation.json` and related UI/cast reports/screenshots.

The Drive UI uses controlled Google responses and a real PKCE loopback callback in tests. A real Google account, physical TV, live website playback, actual install/uninstall/update-install and image-quality validation were not tested. Distinguish receiver-transport fixtures from physical-TV compatibility. The code respects website pixel-access restrictions instead of extracting streams.

Regression lessons: partial IPC schemas must not insert default upscale values; changing only mode must retain enabled state. Scope menu button styles to direct children so embedded switches keep their geometry. Builder helper caches inside this ESM repository need their own CommonJS package fence. Keep third-party FFmpeg tools unmodified when signing the application so their published manifest hashes remain valid.

## Context refresh (2026-10-29)

Re-read root guidance, existing Codex/Claude context, package/build configuration, source/test inventory, runtime entrypoints, RPC/preload, Workspace helpers/services, collection path handling and test launchers. The initial read-only Git status was clean; HEAD was `359fd8c` (2026-10-26, README footer styling).

Retained the existing development, source-navigation and validation skills; added a focused [Workspace skill](../skills/aniverse-workspace/SKILL.md) and [folder map](project-structure.md). The root guidance routes to the custom skill directory. Do not assume these project-local files are installed globally or appear in the native selector.

User requirements reconfirmed: image-based generation/validation uses `test/images/`; every testing helper, config, profile, cache, temporary file and output stays under `test/`. Image inventory still contains only `.gitkeep`, and no model-generation subsystem was identified in the inspected application source.

Current validation evidence is `test/artifacts/codex-context-2026-10-29.json`, generated by `test/cache/codex-context-2026-10-29/validate_context.py`. The baseline is in the same cache folder. The report records official skill-validator results, metadata/link checks and file-hash preservation. It covers documentation/context work only; no application, live-site, account, image/model, installer, updater or release check was run in this refresh. The older pass counts below are historical reports and were not rerun.

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
