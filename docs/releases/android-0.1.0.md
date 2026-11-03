# AniVerse Android 0.1.0 — tablet edition

A separate **Android 15+ landscape tablet** edition, built with a Kotlin native host and the existing React design system. Galaxy Tab S10+ is the primary target; compatible Tab S8/S9 and larger/other tablets qualify when Android is 15+ and smallest screen width is at least 600 dp. Phones are unsupported. Future Android/device compatibility is not guaranteed: this is a personal comfort project.

- Touch navigation rail, large actions, shared discovery/filters/library/history and familiar theme/animations.
- Sources table: paste a public HTTPS URL; add, rename, enable, open, refresh, clear or remove separately profiled websites; the header also refreshes metadata and saved sources.
- Local watch: import your video files or finish permitted direct-file downloads, attach SRT/WebVTT, play/resume offline, remove the saved app copy after travel. Selected originals stay untouched.
- Native player: double-tap ±10 seconds, left/right vertical brightness/volume swipes, touch lock, subtitle controls and picture in picture where supported.
- Downloads: queue, speed/ETA/progress, pause, validator-aware byte-range resume, restart when resume is unsupported, retry and cancel. Playlists/DRM extraction are not supported; use a direct video-file link you are permitted to save.
- Paste a valid AniList/MyAnimeList OAuth access token in the native dialog, verify account identity, encrypt with Android Keystore, then sync manually. An app/client ID alone does not grant account access. No real account was used during fixture validation.
- Origin-restricted native messages, website WebViews without a native bridge, private file storage, restricted permissions, certificate-error rejection and bounded/cancellable provider imports.

Desktop 4K enhancement is excluded. Source-backed DUB/SUB catalogue reads, Windows casting, Drive backup and Windows Workspace tools are not ported in 0.1.0; use the original website's audio/server controls. Android profiles are independent of Windows profiles.

This app is a browser, not a content provider. It cannot repair unpatched Android, firmware, codec or WebView vulnerabilities. Keep Android and Android System WebView updated. Private website profiles are disposable named profiles deleted on close/next startup, not a proven memory-only browser mode. Downloads explicitly saved remain until removed. See [Android setup, build and validation](../ANDROID.md) and [Privacy](../../PRIVACY.md).

Install the signed `AniVerse-Android-0.1.0.apk` asset and compare its SHA-256 with `SHA256SUMS.txt`. Android signing is independent of Windows; keep the same Android key for later updates. This release does not replace the Windows latest-update feed.

Validation: 16 native JVM tests, 12 native airplane-mode tests, eight transfer checks, 28 tablet-layout checks and native phone rejection passed. Actual Windows-configured sources reached the selected episode on three sites; playback decoded on two, while the third paused under browser inspection and remains unverified. No source attacks or protection bypasses were used. The signed APK loads official metadata and passes signature/manifest/asset checks. Physical Samsung hardware, real-account sync and consumer-firmware debugging behavior were not tested; the stock userdebug emulator forces WebView inspection. See the setup guide for exact limits.
