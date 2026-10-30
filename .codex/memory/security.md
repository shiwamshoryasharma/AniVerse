# Security and source compatibility

Snapshot: 2026-10-30; implementation target 2.0.1, baseline 1.5.8. This is a scoped implementation and validation record, not an exhaustive vulnerability scan or an attack-proof claim.

## Owners

- native/security/src/lib.rs: import-free Rust/WASM policy; canonical URLs/IPs, source navigation identity, app asset paths, explicit local-origin exception. Input 16 KiB; memory 8 MiB. Cargo.lock pins dependencies.
- scripts/prepare-security.mjs: locked Cargo build, generated hash/ABI manifest and bundled dependency notices. Cargo caches/targets live under test/cache; users do not install a Rust runtime.
- app/core/security/rustPolicy.ts: manifest/hash/ABI validation, bounded decision calls, fail-closed traps.
- electron/sourceNetwork.ts and sessions.ts: source request metadata, bounded cached DNS checks and source ownership. They do not proxy, rewrite, extract or replace media. Blob/MSE and embedded data players retain Chromium's local-object rules.
- electron/adblock.ts: one request-hook owner; mandatory source guard runs independently of optional ads/cosmetics. Cosmetic IPC input work is bounded.
- trustedOrigin.ts, rpcBudget.ts, ipc.ts: exact app identity, own-property method dispatch, input/call/concurrency limits. URL.origin alone is unsafe for opaque app/file/data schemes.
- electron/media.ts: app CSP/nosniff/referrer policy, guarded app assets and local capability host/read methods.
- electron-builder.yml: production Node environment/inspector/RunAsNode fuses disabled; ASAR integrity/ASAR-only loading enabled; extra file privileges disabled. Preserve existing cookie/profile format; no untested cookie-encryption migration is claimed.

Source security must not disturb valid playback or navigation. Keep source permissions, context isolation, disabled Node/worker/subframe integration, original player controls and sender grants intact. Explicit local sources do not authorize other LAN ports/hosts. Investigate a denial before changing policy; do not add a broad allowlist to make a test pass.

## Seasonal branding

seasonalVisuals(date,accent) is separate from the palette rollout. Before January 1, 2027 and while the festive accent is selected, the app uses the vector festival mark, running-window icon, lamp/pumpkin buffer and icon accents. After December, the normal logo/icon and original cat return even if a user manually retains the palette. Early palette opt-out restores standard visuals. Reduced motion is respected. Static signed installer/shortcut branding remains standard. Original cat assets are preserved.

## Verification seams

Real Rust module tests cover schemes, private/reserved/canonicalized addresses, explicit source origins, opaque-origin rejection, input/memory limits and fail-closed integrity. RPC tests reproduce inherited method and input-work failures before their fixes.

test/e2e/security.mjs uses renderer-only loopback CDP, so it can test production with Node inspection disabled. It verifies the actual fused binary under hostile Node environment/RunAsNode/inspector flags, app CSP, source sandbox, forbidden LAN request cancellation while media advances, quality switches, original video identity, 4K output, normal navigation and January restoration.

Older _electron launchers require a Node inspector and must use the development bundle after this release; do not weaken production fuses for them. Development runtime regressions still exercise source/privacy, Workspace and all-mode casting/upscaling paths. Packaged integrity checks compare the exact main bundle, WASM/hash, notices, selected fuse states, signatures, feed, vendor tools and shaders.

Live survey evidence records decoded clocks/dimensions separately from page navigation. Source identities and URLs remain in ignored configuration/artifacts. Failure to confirm a live player is not a playback pass. Compare uncertain cases against the previous release before labeling them new security regressions. Main-frame/subframe disposal is routine and must be caught during focus reapplication.

## Limits

DNS resolution and the eventual network connection are separate; a cached preflight does not prove elimination of DNS rebinding. Private split-DNS hosts can require an explicitly local source URL. RPC work is bounded after Electron cloning. Chromium/codec/driver/OS/dependency bugs, compromised local administration and all website-content risks are not eliminated. No OS firewall, AV service or telemetry scanner was added. Physical TV output, speaker quality and installer/update installation remain separate checks.

See [public architecture and limits](../../docs/SECURITY-ARCHITECTURE.md).

Release evidence: final 2.0.1 typecheck/lint and 233 unit tests passed; 11 fused production runtime checks passed. Live survey/retry confirmed decoded playback on seven of fourteen configured websites. All seven unconfirmed cases were also unconfirmed on the isolated hash-verified 1.5.8 baseline, including the same two navigation timeouts. Preserve the actual 1.5.9 development version in those historical reports. No newly observed security-induced playback failure was identified; not all external playback is certified. See [status](status.md) for evidence and installer hashes.
