# Status and provenance

Snapshot: 2026-10-31, Asia/Calcutta. Scoped source/runtime validation is recorded below; it is not certification of every external service or device.

## Version 2.1.0 (2026-10-31)

The user rejected 2.0.2's observed-session filter and requested a 2.1.0 release. Actual public source UI inspection confirms that DUB lists mixed series even when dubbing lags, and SUB includes mixed plus sub-only. Source identities remain only in ignored configuration/evidence.

Home/Browse now use selected-source public catalogue cards, the website's audio controls and actual pagination, with public AniList ID matching and raw-page fallback. The new catalogue is independent of SourceAudioIndex/watch history. A reproduced rapid-toggle race was fixed by serializing bounded reads without cancelling shared in-flight category queries. Per-episode availability stays individual. Source/session/security boundaries and normal/4K playback remain.

Verified: typecheck, clean lint, 250 unit tests in 50 files, 14 integrated catalogue/series UI checks, 8 source/privacy checks and 14 checks on the final signed application. Package verification confirms exact bundle/WASM bytes, pinned signer, selected fuses, embedded vendor hashes and update feed. The installer SHA256 is c24e959877472df739b88914d7ed07c089fdd60caa64bbd9bd59476d1751fdf5. The existing self-signed signer remains UntrustedRoot on this host. Full results are recorded in test/artifacts/release-2.1.0-validation.json and release-2.1.0-package.json. The fresh native live Home run returned 12 DUB and 12 SUB cards with no watched-title hints; it included a SUB 12 / DUB 11 series and sub-only entries. The source/card/layout checks do not establish universal provider compatibility. No physical TV/audio, model/image-quality or installer/update installation check is claimed.

[2.1.0 release notes](../../docs/releases/2.1.0.md).

## Version 2.0.2 (2026-10-31)

The user reported similarly named series failing to load, then requested actual episode stills and ALL/DUB/SUB in both episode and home/browse UI. The user selected 2.0.2 for this follow-up. Initial development/live validation used the 2.0.1 package label; final 2.0.2 signed-package verification is recorded separately.

Root cause reproduced in real isolated-world DOM execution: the navigator inferred Season 2 from a metadata alias, but defaulted a matching named-arc candidate without a season marker to Season 1 and rejected it. Three exact/Japanese arc checks failed before the fix. seriesMarkers now treats an omitted marker as unknown, normalizes explicit numeric aliases and keeps season and part/cour separate. Numbered aliases alone cannot authorize an unqualified parent. Explicit conflicts remain rejected. YouTube matching was preserved.

Episode artwork and explicit SUB/DUB badges now come from verified rendered episode cards, including lazy images, opaque links and separate badge nodes without whitespace. The bounded EpisodeArtwork broker fetches images in the owned source session through its mandatory guards and grants only opaque read-only media URLs to the app. It does not extract/proxy video. Source cookies never reach the app renderer, referrers omit paths/queries, grants revoke on owner destruction and future artwork stays hidden by Spoiler Shield. Audio hints are bounded, session-local and excluded from sync/private viewing; unknown availability remains in ALL.

Verified: typecheck, clean lint, 246 unit tests in 49 files, production-mode build, 8 real DOM checks, 9 integrated series/artwork/audio UI checks, 11 retained security/playback checks and 8 source/privacy checks. Those initial runtime suites used development Electron. The final signed 2.0.2 binary additionally passes 13 production checks through renderer-only CDP, including source image grants/audio filtering, security restrictions, normal/4K playback and local media. Package verification confirms exact bundle/WASM bytes, selected fuses, dependency notices, vendor hashes, feed and the existing pinned signer. UI checks cover original video advancement, three distinct fixture stills, all filter locations, latest-episode-specific audio, future-image hiding, narrower-window controls and private-title exclusion.

Live testing of the exact reported ordinary title (AniList 204650, episode 1) resolved the series and played at 1920 × 1080 with an advancing clock, zero security denials and navigator.webdriver false. Five source episode cards, five artwork grants and both explicit audio badges were observed. A separate native app-UI run decoded all five source images through opaque grants while the original 1080p video clock advanced. Source identities remain in ignored config/artifacts. This confirms that specific live case, not universal website availability or physical audio/TV output.

Evidence under test/artifacts: series-matching.json, series-ui.json, series-live-after.json, series-live-ui.json, series-live-ui.png and series-fix-validation.json. Updated public follow-up notes are [2.0.2 release notes](../../docs/releases/2.0.2.md). No model/image-generation check or real installer/update installation was performed.

## Version 2.0.1 (2026-10-30)

User-selected release version: 2.0.1, replacing the unpublished 1.5.9 development label. Adds the import-free, bounded Rust/WASM policy and software/package controls documented in [security.md](security.md). Source requests use metadata checks, not a stream proxy or replacement. Mandatory protection remains active with ad blocking off. A disposed-frame focus race found during live navigation was repaired.

Seasonal vector branding, running-window icon, semantic icon accents and lamp/pumpkin buffering follow the festive palette. They restore the standard mark and preserved original cat on January 1, 2027, including when the palette is manually retained. Early palette opt-out and reduced motion work. Static installer/shortcut branding remains standard.

Final 2.0.1 verification: typecheck and lint pass; 233 unit tests in 48 files pass. The signed production binary passes 11 runtime checks: actual Rust engine, disabled production Node environment/RunAsNode/inspection entry points, app CSP, source sandbox, blocked unrelated loopback request while decoded video advances with ads off, quality changes, original video identity, 4K filtering, allowed navigation and blocked takeover, clean invalid RPC handling, local file decoding and January restoration. Package verification confirms main-bundle equality, embedded WASM hash/no imports, notices, selected fuses, feed digest, vendor tool/shader hashes and the existing pinned signer. Its Windows trust status remains UntrustedRoot for the project's existing self-signed certificate; no public publisher trust is claimed.

Development runtime checks completed before the version-only update: 10 casting/upscaling checks including six presets and timing fallback, 10 Workspace checks, and 8 source/privacy checks. These are development results, not packaged checks. The 11 production checks were rerun on the final 2.0.1 executable.

Live ordinary-title testing used all 14 configured website sources in isolated muted native sessions, without extraction or remote debugging. Twelve navigated; seven showed actual decoded video-clock advancement across the initial run and retry. The seven unconfirmed cases were compared against the hash-verified 1.5.8 installer in an isolated extracted baseline: all seven remained unconfirmed there, including the same two navigation timeouts. No new playback failure was observed in this comparison. This does not certify all websites, episodes, source availability, speaker quality or physical TV output.

Evidence: test/artifacts/release-2.0.1-package.json, security-ui.json, release-2.0.1-validation.json, security-live-playback.json, security-live-playback-retry.json and security-live-baseline.json. The live reports retain their actual development/baseline versions; do not relabel them. The previous installer was SHA256 d05baaa27fe64a90eb87f066d42de3272a312b6861395c725080e8e891ed5814. The final 2.0.1 installer is SHA256 e76c6a519a60f54b97f39c517010a98a15c8b2ce7895fcd559e8185839222f42. Physical installation/update installation, image/model quality and exhaustive vulnerability scanning were not performed.

## Version 1.5.8 (2026-10-30)

The user reported intermittent blur across the whole interface, including text/buttons, and confirmed that hovering or resizing clears it. This is consistent with a compositor redraw problem; it is not limited to video scaling. A fresh Electron probe reproduced remaining whole-window CSS backdrop blur but did not reproduce/certify the user's intermittent desktop driver symptom.

Windows now defaults to Stable UI through disable-gpu-compositing, applied before ready/GPU initialization after the test data-directory override. UiRenderingPreferences reads/writes only a strict stable/accelerated choice in device-local graphics.json. It is separate from synced Settings because it must be read before database bootstrap and is hardware-specific. GraphicsPanel exposes current/preferred/restart state with an explicit restart action. Renderer sandboxing, WebGL, video codecs and embedded encoders remain enabled; this is not disableHardwareAcceleration.

Removed backdrop filters from release highlights, shared dialogs, context/menu surfaces and navigation overlays. Opaque context menus replace translucent blurred menus; decorative image filters and Anime4K remain independent.

Source validation: typecheck, lint, 192 unit tests/33 files; 22 runtime checks at each of 125% and 150% scale, including three actual launches per scale, repeated resizes, no active UI backdrop blur, live NVIDIA WebGL pixels and hardware codec flags; native/captured-video Anime4K all-six-mode/timing regressions; actual stable-compositor H.264/HEVC/AAC sender capture with aligned sustained timestamps. Dedicated/system GPU diagnostics also passed.

Compatibility/performance limit: software window composition can increase CPU and GPU readback work. Accelerated UI remains available for unaffected systems. The tests do not prove every driver/monitor combination is repaired. Keep that distinction in future fixes/releases.

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

## Final 1.5.8 scope (2026-10-30)

The user extended the same pending release with generic TXT-source playback support, cross-source fallback, broader search (including English/romaji/native aliases), both private-session modes, responsibility documentation, popup/filter updates, corrected normal/4K player geometry, thumbnail episode cards and an automatic temporary Diwali × Halloween dark palette. No user-mentioned live source identities were added to tracked files.

SourceFallback bounds each title/episode selection to one enabled-source pass. SiteNavigator classifies missing title/episode/rendered error pages separately from security challenges and cancellation. Private source partitions are issued in-memory leases; release on leaving and rebuild on revisit. Main-process Store, sync, workspace and backup guards suppress private writes; metadata cache epochs and the last-moment Drive upload guard reject late responses/privacy changes. Existing remote data is not removed, and external networking is not anonymous.

Focus CSS now marks the actual media and intermediate ratio wrappers. Nested player documents receive reversible per-frame styles, and delayed iframe loads are restyled. Direct Anime4K overlays use the actual containing block rather than viewport coordinates under transforms. Existing video/audio/control identity is retained.

Popup protection denies every new window while enabled, including same-site windows that previously replaced the player. Main-frame redirect events are guarded; embedded navigation remains available. Adblock refresh checks hourly, updates stale rules after 24 hours, preserves last-known-good rules offline and exposes a manual update RPC. Cosmetic IPC is owned-session/frame-URL validated and targets the requesting frame.

The festive accent is separate from the three structural layouts. SettingsService applies its local rollout once, remembers the previous accent, honours opt-out and restores it on January 1, 2027 (including while open). Manual selection remains available after the promotion. Episode cards preserve spoiler protection and use placeholders when metadata has no thumbnail; no SUB/DUB/date information is invented.

Final checks: typecheck/lint, 216 unit tests in 40 files, 31 focused-player checks including real transformed-wrapper 4K alignment, eight packaged source/privacy/seasonal checks, ten packaged casting/Anime4K checks including cropped cross-origin iframe geometry, ten packaged Workspace regressions, 22 packaged rendering checks at each of 125% and 150%, and six embedded sender/capture checks. Sustained complete-segment AV timestamp gaps stayed below 22 ms; this is not physical TV lip-sync measurement. Final installer SHA-256: d05baaa27fe64a90eb87f066d42de3272a312b6861395c725080e8e891ed5814. App/installer match the pinned signer (self-signed untrusted-root status 1), exact packaged main bundle, update feed and vendor/shader hashes. Only filters.txt ships as configuration. Four skills and 108 local references validated. Evidence: test/artifacts/release-1.5.8-validation.json. Publication is recorded separately after GitHub asset/revision verification.

Backup compatibility regression: the festive accent must not be written to the established v1 appearance enum. Export the previous standard accent (or Ember), and normalize festive preset colours in app-data backups. Standalone theme exports support the current festive value. The fixed Drive folder/file/schema version remain unchanged.

2026-10-31 follow-up verification note: a second live UI run with the same test profile timed out waiting for cached-revisit artwork. This was not discarded as a flaky pass. The delayed SPA-list race was reproduced/fixed using bounded owner/page-context metadata refreshes, and the 6.5-second delayed-list fixture now passes after cached reload. Live revisit retest results are recorded in series-live-ui.json. The verifier rejects a failed live UI report; the driver now writes failures instead of leaving stale successful evidence.

The live screenshot also exposed an inherited thumbnail display bug: onError set display:none, and a successful replacement retained that inline style. A deterministic missing-image → valid delayed-image fixture failed on actual visibility, despite positive naturalWidth. EpisodePanel now keys images by URL and clears the hidden style on load. Live UI verification requires positive decoded size and visible layout, including after metadata refresh and dialog dismissal; decoded-but-hidden images are not accepted as success.

Final 2.0.2 release evidence: test/artifacts/release-2.0.2-package.json, release-2.0.2-ui.json and release-2.0.2-validation.json. The installer SHA256 is 051a9034f28ca3296bcd84ef82da0d1e07765671f41b262c0933a0a40323db88. It retains the existing pinned self-signed signer (UntrustedRoot on this host); no new public publisher trust is claimed. The live visible-artwork check now asserts actual rendered visibility after the metadata refresh and dialog dismissal, not merely successful image decoding.
