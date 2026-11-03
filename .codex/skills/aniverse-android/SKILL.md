---
name: aniverse-android
description: Build, change or validate AniVerse's Android 15+ landscape tablet edition, including shared React seams, native source isolation, local watch, transfers and signed APKs. Use for Android work rather than desktop Electron-only changes.
---

# AniVerse Android

Read [Android memory](../../memory/android.md) and the relevant part of [Android operation/build](../../../docs/ANDROID.md). This edition uses Kotlin plus the existing React UI, not Capacitor or React Native. Preserve Windows through the shared contracts; keep native Android code under `android/`, tablet adaptation under `frontend/src/android/`.

## Boundaries that change implementation choices

- Android 15/API35+, landscape, >=600dp smallest width; Galaxy Tab S10+ target. Eligible other tablets are allowed; phones are rejected. Emulator profile tests do not certify Samsung hardware/One UI. Future OS/device compatibility is not promised.
- Keep the app-origin message listener on the packaged main frame only. Source WebViews receive no native listener, file grants, device permissions or account tokens. Use real native profiles; `SourceInfo.partition` is descriptive, not the enforcing profile.
- Shared DOM operations run in the source page's JavaScript world on Android. Treat returned observations as untrusted. Preserve original website players, TLS rejection and per-source method fallback; no stream extraction or access-control bypass.
- Native credentials are verified OAuth access tokens, encrypted using Keystore. A client ID/secret is not a token. Normal debug uses official APIs. Only the explicit `android:fixture` / `-PaniverseFixture=true` build redirects to a local fixture and disables account entry; never use real credentials in fixture tests. Release API requests must use official hosts without redirects.
- Local watch copies selected files. Keep opaque canonical private paths, selected originals, UTF-8/size validation, SRT-to-WebVTT normalization and correct descriptor offset/length handling. Keep imports on process-wide bounded workers with native deadlines/exactly-once replies and cancellation-gated publication. Cancellation must cover late metadata/open results and retain the old subtitle on failure.
- Downloads accept permitted direct video-file links, queue sequentially, validate ranges/validators before append, and finalize state/files atomically. Do not weaken pause/cancel state predicates or make download completion depend on an import deadline.
- Incognito/private titles suppress new progress/methods/sync. Disposable named WebView profiles are deleted on close/startup; do not call them proved memory-only. Explicitly saved offline files remain. Android cannot fix unpatched OS/WebView/firmware/codec vulnerabilities.
- Desktop 4K enhancement/casting/GPU/Drive/Workspace and source-backed audio-catalogue scans are not ported. Do not expose unimplemented controls as working features.

## Build and validate

Use `npm run android:debug` / `npm run android:release`; they rebuild web assets before Gradle. Release signing material stays in ignored private config or environment, with the same Android identity retained for future updates. Keep Android version independent from the root Windows package.

Read [validation](../aniverse-validation/SKILL.md). All test source/config/cache/profiles/evidence belong under repository `test/`, including Android source sets. Use owned emulators only, always `adb -s <owned serial>`; never run unscoped connected-device tests. The user-facing emulator is emulator-5580; preserve its saved sources/profile. Use the separate emulator-5584 for tests and explicit fixture app ID. Never test/reset a user-active emulator or touch physical devices.

Use `test/e2e/android-live.mjs` and `android-layouts-live.mjs` with actual Windows-configured source URLs for functional checks, plus `android-downloads.mjs`, native JVM tests and instrumented local provider/media cases as relevant. Keep private URLs/screenshots under ignored test/cache; redact public reports. Do not bypass challenges or debugger detection. Preserve failures and separate host-emulator crashes from product failures. Consult memory for the current stable emulator backend before video tests. Test fixture APK/debugging must never be published or left as the user's release testing app.

A release must pass shared required checks, native tests/lint, APK signature/manifest/content gates and relevant runtime/UI checks. Signed release has no fixture provider/cleartext exception/WebView debugging. Keep Windows latest feed and older releases/tags/assets intact. Publication requires an authorized release request, not routine validation. Update Android memory with actual evidence and limits.
