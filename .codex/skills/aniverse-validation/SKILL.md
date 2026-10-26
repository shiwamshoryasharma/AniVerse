---
name: aniverse-validation
description: Run scoped AniVerse checks with isolated test data, review Electron UI evidence, or prepare image-based generation/validation using test/images. Use for testing in this repository.
---

# AniVerse validation

Read [testing policy and harness details](../../memory/testing.md) before choosing commands. It records known containment gaps; do not assume every existing harness already obeys the user's test-directory requirement.

## Contain test work

Use the repository's `test/` for every testing script, config, profile, cache, temporary file and generated result. Use `test/cache/` for disposable data and `test/artifacts/` for reports/screenshots. Do not put testing helpers inside this skill or modify production config for a test.

Image-based model generation or validation must take inputs from `test/images/`. Inspect the directory first: at the 2026-10-26 snapshot it held only `.gitkeep`. If the requested check requires images and none are available, report the missing input and continue only independent work; do not substitute unrelated images or claim success. No model-generation pipeline was identified in the inspected app.

## Match the check to the change

- Documentation/skill/memory edits: validate skill manifests and local references; check factual claims and preservation of existing files. Application builds, live site tests and installers add no evidence for a Markdown-only change.
- Application logic: follow `CONTRIBUTING.md` checks and use relevant maintained unit suites. Check actual runtime support for `node:sqlite`.
- Electron UI/player: build first, run targeted hidden smoke steps, then inspect the generated PNGs for real content and layout. The standalone renderer browser lacks the preload bridge.
- Website navigation: use existing native in-process drivers/survey before attributing anti-bot behavior to product code. The Playwright harness may change site behavior.
- Image/model checks, when requested and supported: record input filenames from `test/images/`, exact generation/validation parameters, output paths and observed results under `test/`. Do not infer such a pipeline exists just from the user's input-path rule.

## Protect the running app

Use hidden Electron test runs and profiles/config under `test/cache/`. Preserve data-dir setup before the single-instance lock. Serialize harnesses that share a profile; record owned process IDs and clean up only those processes. Never kill all Electron instances or interfere with the user's development session.

Inspect tool cache/temp behavior too. Vitest explicitly caches under test/cache/vite; guard-probe still does not set its own app data directory. Installer/updater harnesses modify real Windows state and caches outside the project; release commands tag/push/publish. Do not use those as routine validation. A specifically requested installer/updater task first needs isolation work and scope review.

Report exact checks run, failures, skipped or blocked checks and evidence paths. Old artifacts and Claude's historical passes do not establish a current result.
