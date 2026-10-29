# AniVerse project guidance

This is an existing Electron/React desktop anime application. Preserve the layers already implemented by Claude; inspect the affected source before changing architecture.

## Load project context

- Read [.codex/memory/MEMORY.md](.codex/memory/MEMORY.md) at the start of work in this repository.
- For implementation work, read [.codex/skills/aniverse-development/SKILL.md](.codex/skills/aniverse-development/SKILL.md).
- For source adapters, website navigation, or isolated sessions, read [.codex/skills/aniverse-source-navigation/SKILL.md](.codex/skills/aniverse-source-navigation/SKILL.md).
- For local Workspace, Episode Toolkit, collection, theme, insight or subtitle changes, read [.codex/skills/aniverse-workspace/SKILL.md](.codex/skills/aniverse-workspace/SKILL.md).
- For testing or generation/validation experiments, read [.codex/skills/aniverse-validation/SKILL.md](.codex/skills/aniverse-validation/SKILL.md).
- These skills intentionally live under the user's requested `.codex/skills/`. This entrypoint routes to them; do not assume that this custom location appears in the native skill selector.
- Existing Claude context remains in [.claude/CLAUDE.md](.claude/CLAUDE.md), [.claude/memory/MEMORY.md](.claude/memory/MEMORY.md), and `.claude/skills/`. Keep it intact. Resolve dated contradictions using current code and the provenance notes in [.codex/memory/status.md](.codex/memory/status.md).

## User requirements

- Use `E:\14-OCT-2026\aniverse\test\images` for image inputs to model generation or validation. It contained only `.gitkeep` at the 2026-10-29 inspection; inspect it again before image-dependent work. Do not substitute unrelated images or generate images without an explicit request.
- All testing scripts, configurations, profiles, caches, temporary files, and outputs belong under `E:\14-OCT-2026\aniverse\test`. Use `test/cache/` for scratch/profile data, `test/artifacts/` for evidence, and existing `test/unit/`, `test/e2e/`, and `test/fixtures/` for maintained tests.
- FFmpeg and FFprobe must ship inside the app and update with AniVerse; do not depend on a system installation or PATH. Sender-side 4K casting performs filtering/encoding on the casting device.
- Keep Google Drive folder/file names and the versioned backup schema stable across application releases. User-authorized sync covers app data only, not video files.
- Preserve working functionality, existing utilities, styles, and adapters. Make the smallest practical change.

## Project boundaries

- Sources come from the editable local `config/streaming-sites.txt`; do not hardcode or publish configured site names/URLs. Use neutral `.test` hosts in fixtures and public documentation.
- Website playback uses rendered source pages and their own players. Existing search/series/episode navigation and focus CSS are intentional. Preserve the boundary against stream extraction, media hosting, private API access, and access-control bypass.
- Keep renderer sandboxing, context isolation, validated trusted-frame IPC, isolated source sessions, and main-process-only credentials.
- For application changes, follow [CONTRIBUTING.md](CONTRIBUTING.md). Select additional runtime checks using the validation skill. Documentation-only context updates need skill/link validation, not installers, network tests, or release commands.
