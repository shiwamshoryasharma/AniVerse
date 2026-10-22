# AniVerse — project instructions

Electron 44 + React 19 + TypeScript 6 desktop anime hub. Read `docs/ARCHITECTURE.md` for the module map.

## Non-negotiable constraints (from the product brief)
- Sources come only from `config/streaming-sites.txt` — never hardcode site URLs in code.
- No media hosting, no DRM bypass, no unauthorised/private API access. Website sources are opened in isolated sessions with the site's own player; **do not write scrapers that extract episode lists or stream URLs from those sites**. Native streams come only from authorised sources (official YouTube embeds, user-supplied URLs/files, future licensed adapters).
- Cloudflare: verification runs in a real browser window in the source's session. Never auto-click Turnstile, spoof fingerprints, or add solver services.
- Preserve browser security boundaries: renderer sandboxed + contextIsolation; every IPC method validated with zod in `electron/ipc.ts`; webviews only for configured partitions (`persist:src-<id>`).
- One visible app profile; each website keeps its own isolated login session.
- Keep the UI compact, dark, premium; no placeholder buttons — every control must work.

## Workflow
- Skills: `.claude/skills/aniverse-dev` (build/run/test/verify, gotchas, current status in `RESUME.md`) and `.claude/skills/aniverse-source-adapter` (adding adapters).
- Project memory: `.claude/memory/MEMORY.md`.
- Test caches, scripts and configs go under `test/` (cache in `test/cache/`, screenshots in `test/artifacts/`, images in `test/images/`).
- Validate each change: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, then `node test/e2e/smoke.mjs <steps>` and look at the screenshots.
- E2E runs must use `ANIVERSE_HEADLESS=1` (already set in the scripts) so windows never appear on the user's desktop.
