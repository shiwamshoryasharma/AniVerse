# AniVerse memory index

Last inspected: 2026-10-26, Asia/Calcutta. Repository: `E:\14-OCT-2026\aniverse`.

AniVerse is an implemented desktop anime hub, not a model-generation project. Package metadata currently says 1.0.0; read the current package file before relying on versions.

Read the relevant reference only:

- [Architecture and extension seams](architecture.md): directory map, entrypoints, coordinated changes.
- [Product decisions and invariants](decisions.md): existing behavior, source boundaries, security, UI.
- [Testing and image-input policy](testing.md): commands, isolation, outputs, known harness limitations.
- [Version 1 local workspace](workspace.md): scene/skip/subtitle/planner/collection/theme/insight seams and the removed Watch Together scope.
- [Status and provenance](status.md): inspected implementation, stale Claude notes, what was actually validated.

The user's durable requirements are recorded in [the root guidance](../../AGENTS.md): retain Claude's completed work, use `test/images/` for image-based generation/validation, and contain all test machinery and generated evidence under `test/`.

At inspection, `test/images/` contained only `.gitkeep`. Do not claim an image-based check ran without real input files. No AI model-generation implementation was identified in the inspected application source.

Memory records observations, not proof of current runtime health. Prefer current source and a fresh targeted check over historical pass claims. When updating this memory, record the date, source or command, outcome, and any unverified part. Keep credentials, configured site identities, browser profile contents, and copied private notes out of these files.

Skills: [development](../skills/aniverse-development/SKILL.md), [source navigation](../skills/aniverse-source-navigation/SKILL.md), [validation](../skills/aniverse-validation/SKILL.md).
