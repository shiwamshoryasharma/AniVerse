# Version 1 workspace

Inspected 2026-10-26. Read current files before treating this map as runtime evidence.

## Product boundaries

AniVerse remains a browser for user-configured websites plus a player for user-provided files/direct URLs. Official signed releases omit source lists and private recipes. Website automation uses rendered DOM/navigation and the original player; do not add stream extraction or access-control bypass.

The user explicitly removed Watch Together after initially approving it. There is no room-networking feature/dependency in 1.0. Do not recreate it from the earlier request.

Do not claim novel-in-the-world functionality or guaranteed GPU/AI enhancement. The distinguishing workflow is the integrated Episode Toolkit.

## Modules

- app/shared/workspace.ts: bookmarks, skip maps, plan/local media/insight types; filename parsing, budget planning, spoiler and edition checks.
- app/core/workspace.ts: private records and visual themes over Store. Main guards insight recording behind the opt-in setting.
- Store migration v4: scene_bookmarks, skip_ranges, local_media, watch_sessions. Preserve migrations 1–3 and existing data.
- electron/collection.ts: user-chosen roots, bounded asynchronous scans, confirmed matching, realpath/root checks and local-file token grants.
- app/shared/theme.ts: strict portable visual schema. Unknown fields, accounts, arbitrary fonts/CSS and credentials are rejected.
- app/shared/subtitles.ts and player/SubtitleStudio.tsx: text conversion, clock/offset selection, safe React text overlay, primary/secondary captions and imported Blob tracks.
- Workspace.tsx: scene bookmarks, weekly planner, local collection and insights in separate menus.
- EpisodeToolkit.tsx: current-time capture, B shortcut, markers/ranges, edition checks, opt-in observation. Website samples come from Watch's existing loop; native samples use PlayerControls.
- SpoilerGuard.tsx and EpisodePanel/Details/HoverCard: explicit reveal and future-episode hiding. Website content is outside the shield.
- ThemePresets.tsx: own Settings menu, file-dialog import/export in main.

## Invariants and limits

Real file paths remain in main/SQLite. UI/RPC DTOs use filenames and capability URLs. A collection match is user confirmation, not license verification. Deleting an index entry never deletes its video.

Watch insights default false and stay local. They estimate observable playing intervals; skips, seeks, pauses and unobservable/hidden playback do not prove viewing. Do not describe frame drops as lip-sync measurements.

Skip ranges require explicit automatic enabling, identical source and similar recorded duration. Website timing is sampled every three seconds. Cross-edition reuse needs user review.

Subtitle Studio applies inside the native AniVerse player. Custom dual captions do not carry to website players, operating-system PiP or cast receivers. Imported subtitle files must be UTF-8 SRT/VTT, bounded in main, displayed as text and cleaned up on unmount.

Planner uses up to 20 relevant library titles and available airing data; fallback runtime is 24 minutes. Saved plans are snapshots. Theme exports include only visual preferences, theater mode and quality preference.

All testing files/caches/temp/evidence stay under test/. No model-generation pipeline is present; test/images remains the required input location if one is introduced.

## Validation entry points

Unit suites: workspace.test.ts, workspace-settings.test.ts, collection.test.ts, subtitles.test.ts.
Renderer/main integration: node test/e2e/workspace.mjs after building. It uses neutral seeded metadata, a public Sintel test clip, main file-dialog stubs restricted to its test cache, real native playback, and isolated profiles/config.

Set E2E_EXE to the packaged executable to run the same checks against packaging. Read test/artifacts/workspace-ui.json for the most recent result and whether it was packaged. Previous reports do not certify a later build.
