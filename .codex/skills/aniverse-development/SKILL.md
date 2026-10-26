---
name: aniverse-development
description: Change or review AniVerse application code using its existing Electron/core/React seams and project conventions. Use for features, fixes, refactors and resuming development in this repository.
---

# AniVerse development

Read [the memory index](../../memory/MEMORY.md), then [architecture](../../memory/architecture.md) for affected modules. Consult [status](../../memory/status.md) before interpreting Claude's resume as a task list.

## Work in the existing layers

- Keep Electron/platform work in `electron/`, plain domain services in `app/core/`, shared contracts in `app/shared/`, and React UI in `frontend/src/`.
- Inspect `electron/main.ts` composition before adding services. Existing playback, navigation, sync, casting, installer/signing and updater are implemented; extend the relevant path instead of rebuilding it.
- For RPC changes, coordinate the contract, zod schema, main handler and renderer caller. For new events, update the preload allowlist too.
- For settings, coordinate shared types, core defaults and `sanitize()`, renderer fallback, patch validation, UI, and main-process consumers/change listeners. The sanitizer explicitly rebuilds profile/accounts/updates; adding a field only to defaults and types can silently discard it.
- For persistence, append compatible SQLite migrations; retain existing progress, queues, accounts and removal tombstones.
- Reuse theme tokens and custom controls. Preserve the original cat-frame loader, release gates and website-loader/focus behavior.
- Preserve renderer/guest security boundaries, credential handling and sync semantics. The concrete invariants are in [decisions](../../memory/decisions.md).
- Read current source when old notes conflict. In particular, development OAuth IDs are read live even though an older build-script comment says otherwise.

## Workspace changes

For bookmarks, ranges, plans, collection files, portable themes, local insights or native captions, read [the workspace map](../../memory/workspace.md). Retain the browser-only website workflow, opt-in statistics, main-process file grants and strict visual-theme schema. Watch Together was explicitly removed by the user; do not infer its inclusion from older notes.

## Choose relevant validation

Use [the validation skill](../aniverse-validation/SKILL.md). Application changes follow the repository's typecheck/lint/test/build requirements and relevant runtime checks; documentation-only edits need focused context validation.

For source adapters or website behavior, load [source navigation](../aniverse-source-navigation/SKILL.md). For accounts, signing or updater work, read the relevant existing `docs/ACCOUNTS.md`, `docs/INSTALLER.md`, or `docs/UPDATES.md` instead of copying their manuals into memory.

Keep all new test scripts/configs/cache/output under `test/`. Preserve `.claude/`. Update Codex memory with dated, evidence-backed changes; do not record an implementation or old screenshot as a current test pass.
