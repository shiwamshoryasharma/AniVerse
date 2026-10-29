---
name: aniverse-workspace
description: Maintain AniVerse scene bookmarks, skip maps, weekly planning, local collection, themes, watch insights and native subtitles. Use for its local Workspace and Episode Toolkit features.
---

# AniVerse Workspace

Read [the workspace map](../../memory/workspace.md), then the affected source. Use [development guidance](../aniverse-development/SKILL.md) for shared RPC, settings and migration changes.

## Pick the existing implementation

| Behavior | Inspect together |
| --- | --- |
| Bookmarks, skip ranges, watch observations | `app/shared/workspace.ts`, `app/core/workspace.ts`, `app/core/db/store.ts`, `EpisodeToolkit.tsx`, `Watch.tsx` |
| Weekly plan | `buildWatchPlan()` in `app/shared/workspace.ts`, `planner.*` handlers in `electron/main.ts`, `Workspace.tsx` |
| Local collection | `electron/collection.ts`, file grants in `electron/media.ts`, `collection.*` contracts/handlers, Watch/Player routes |
| Visual themes | `app/shared/theme.ts`, `WorkspaceService` theme methods, `themes.*` handlers, `ThemePresets.tsx` |
| Dual/imported captions | `app/shared/subtitles.ts`, `player.openSubtitles` handler, `VideoPlayer.tsx`, `SubtitleStudio.tsx` |
| Spoiler hiding | `hideEpisode()`, `SpoilerGuard.tsx`, `EpisodePanel.tsx`, `Details.tsx`, `HoverCard.tsx` |

Component/page names above are under `frontend/src/components/`, `pages/`, or `player/` as appropriate. Exact paths are in the [folder map](../../memory/project-structure.md).

## Preserve the meaningful boundaries

- Keep scene notes, skip maps, collection paths, plans and watch insights local; do not add them to account-list sync or public comments.
- Coordinate the typed RPC contract, zod validation and main handlers. Append migrations instead of rewriting the existing v1–v4 schema history.
- Auto skip requires explicit enabling. Reuse `canAutoSkip()` for source identity and edition-duration compatibility; the current tolerance is the greater of five seconds or two percent. Keep range validation and the enabled check at their existing call sites.
- Use the existing playback observer and player controls. Website timing is sampled every three seconds; do not claim frame-accurate skipping or measured lip sync.
- Collection scanning stays asynchronous, skips symbolic links, and retains bounded traversal. Opening rechecks the real path against user-chosen roots and grants a capability URL. Do not send filesystem paths to the renderer or delete videos when removing an index entry.
- Preserve filename guesses as suggestions until the user confirms a match. An extension match does not guarantee Chromium codec support.
- Watch insight recording remains gated in main by `privacy.watchInsights`, disabled by default. Count observed playback intervals rather than seeks; dropped-frame ratios do not measure lip sync.
- Theme import/export uses the strict visual schema. Do not export accounts, private paths, notes, arbitrary CSS or credentials.
- Caption overlays stay tied to the native video clock; positive offsets delay captions. Render subtitle text safely and release Blob URLs/listeners on replacement or unmount. Website players, system PiP and cast receivers do not inherit this overlay.

The existing context records Watch Together as removed scope. Do not infer that a local Workspace task calls for a room service.

## Validate only the affected behavior

Follow [validation guidance](../aniverse-validation/SKILL.md). Existing focused suites are `test/unit/workspace.test.ts`, `workspace-settings.test.ts`, `collection.test.ts` and `subtitles.test.ts`.

After application changes and a build, `node test/e2e/workspace.mjs` exercises the integrated UI using isolated profiles/configuration and reports to `test/artifacts/`. Inspect it before running: it downloads a public video fixture to `test/cache/` if absent. Historical reports do not verify a changed build.

All testing helpers, configuration, temporary files, caches and outputs stay under `test/`. Image-based generation/validation inputs come from `test/images/`; inspect availability before use.
