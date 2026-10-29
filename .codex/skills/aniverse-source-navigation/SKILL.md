---
name: aniverse-source-navigation
description: Extend or debug AniVerse source adapters, rendered website navigation, YouTube matching and isolated source sessions. Use for source behavior in this repository, not unrelated browsing.
---

# AniVerse source navigation

Read [architecture](../../memory/architecture.md), [decisions](../../memory/decisions.md), and the affected source. Preserve the existing adapter/navigation split.

## Select the seam

- Configured source: `app/core/config/sitesConfig.ts` parses local `config/streaming-sites.txt`; do not add real site URLs to tracked code/docs/tests. Use neutral `.test` fixtures.
- Adapter: `app/core/sources/types.ts` defines `SourceAdapter` with `kind`, `capabilities`, `match` and `streams`. One instance serves a kind; per-source state stays in registry/store.
- Website browsing: `WebSiteAdapter` in `registry.ts` returns page URLs. `electron/siteNavigator.ts` drives search/title/episode navigation; `sitePage.ts` holds isolated-world DOM scripts. Preserve the site's own player instead of extracting streams.
- Site-specific layout: inspect recipe support in `app/core/sources/recipes.ts` and local `config/site-recipes.json`. Use supported recipes for local layout differences; change generic heuristics only when the problem is shared.
- YouTube: `app/core/sources/youtube.ts` and `sources/text.ts` handle matching; preserve season-aware scoring and `SxEy` precedence.
- Session/security: `electron/sessions.ts`, `adblock.ts`, `cloudflare.ts`. Source page requests should use the injected `SiteFetcher` to retain source cookies/clearance. Official APIs use their intended transport.

## Preserve contracts

When adding a kind, coordinate `SourceKind`, URL classification, adapter registration in `electron/main.ts`, capabilities, partition routing and renderer behavior. Existing website partitions are `persist:src-<id>`; YouTube shares `persist:src-youtube`.

Preserve navigation allowlists, source ownership, download/popup guards and adblock hook ownership. Do not add private API access, stream extraction, access-control bypass or automated CAPTCHA solving.

Keep pinned/learned links, season checks, SUB/DUB/server preferences and the loader before guest attachment. Website streams are not extracted for direct casting. Since 1.5.3, user-initiated casting can mirror the selected owned site view and only its audio through `WebsiteMirror` and embedded FFmpeg; never broaden this to desktop, system audio, camera or microphone capture. Do not assume development recipes are present in a fresh signed release.

## Verify the cause

Use fixtures/unit tests for pure matching/navigation decisions. Use the existing native in-process survey for live website behavior; use Playwright for AniVerse UI. Historical remote-debugging/anti-bot failures must be confirmed outside the Playwright harness before changing product behavior.

Follow [validation guidance](../aniverse-validation/SKILL.md). Put fixtures/scripts/configs and evidence under `test/`; redact configured site identities from shared reports. Do not change Claude's completed layers based only on stale notes or historical screenshots.
