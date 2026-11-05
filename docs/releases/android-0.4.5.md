# AniVerse Android 0.4.5 — floating glass and reliable navigation

Android-only update for landscape tablets running Android 15/API 35 or newer, with a smallest screen width of at least 600 dp. Windows remains independently versioned.

## Changes

- Floating glossy glass navigation, horizontally along the bottom or vertically beside your content. Choose Light glass or Dark glass in Settings; both layouts retain the same destinations.
- Clear, high-contrast typography, animated selection and menus, touch feedback and motion preferences. Appearance settings come first, with advanced security details tucked away.
- Use source cards with clearer touch targets, search retry/empty states and sign-out confirmation before browser-data clearing.
- Read rendered website episode cards instead of treating metadata episode counts as source availability; recover source navigation through bounded title aliases and ordinary search forms.
- Faster startup requests and correct cancellation deadlines. Concurrent requests to one host share a DNS lookup; temporary resolver failures no longer block a source for a minute.
- Check stable Android GitHub releases from Settings and explicitly download a verified APK. The release checksum, package identity, newer version code and retained signing certificate must match before Android's installer is opened. Installation requires your confirmation; debug/fixture builds cannot use production updates.

The app and controlled regression checks below pass. Third-party source compatibility remains qualified by the source-by-source results.

Website sources retain their own players, audio, quality and server controls. AniVerse reads rendered page navigation; it does not extract streams, bypass website challenges or guarantee that every third-party site is available. Local watch and permitted direct-file downloads remain separate native workflows.

## Installation

Install the signed `AniVerse-Android-0.4.5.apk` and compare its SHA-256 with `SHA256SUMS.txt`. Android version code is 405. Older APKs without an Android updater need this one-time installation; later stable Android releases can be checked and installed from Settings. The retained Android signing identity permits updates over earlier production APKs while preserving the app profile. 

The Android release does not change the Windows latest-update feed or remove earlier releases and assets. See [Android setup and limits](../ANDROID.md) and [Privacy](../../PRIVACY.md).

## Validation

Validated on the owned Android emulator:
- 332 shared unit tests and 31 native JVM tests.
- 13 native instrumented checks, including real local frames, seeking/captions, imports and download races.
- 18 integrated tablet/source checks, 13 neutral DOM navigation checks, and eight native transfer checks.
- 28 layout checks across four representative tablet screens, plus native phone rejection.
- Five checks on the signed production APK: exact installed bytes/version, official AniList metadata, bottom-glass layout, Android release checks/downgrade rejection, and trusted bridge rejection.
- Typecheck, lint, signing/manifest/provider checks and exact packaged web assets pass. Android release lint has zero errors and 43 warnings.

All 14 configured source websites were visited in bounded functional runs. This is not a claim that all 14 passed: website verification, unavailable catalogue matches, inspection-sensitive players and incomplete decoded/episode evidence remain documented. Search control, result-card and semantic watch-link defects were fixed with reproduced neutral regressions; the previously stuck source now reaches its site's verification page. No challenge or debugger protection was bypassed. Website players retain their original controls.

Consumer Samsung hardware/firmware, real-account synchronization and a future newer-version self-update installation transaction were not certified by these checks. Older APKs without the updater need one manual bootstrap installation of 0.4.5; subsequent stable Android releases use the in-app updater.
