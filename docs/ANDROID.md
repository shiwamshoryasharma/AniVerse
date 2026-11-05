# Android tablet edition

AniVerse Android 0.4.5 uses a Kotlin host and the shared React UI. It is a browser with anime metadata and app-private offline playback, not a content provider. The Windows release remains independently versioned (2.2.1).

## Devices and support

Android 15/API 35 or newer, landscape, smallest screen width at least 600 dp. Primary target: **Galaxy Tab S10+**. Other Android tablets, including Tab S8/S9 families, qualify only when running Android 15+. Phones, iOS and other device categories are unsupported. Future OS and device compatibility is not guaranteed; this personal project is built for the author's comfort and available time. Android and WebView update warnings do not repair an unpatched device.

## Using the tablet app

- **Settings → Appearance:** choose floating bottom tabs or a vertical navigation capsule, Light glass or Dark glass, accent colour and reduced motion. Both navigation layouts retain every destination. Android appearance preferences stay separate from the Windows backup format.

- **Sources → Add source:** paste a public HTTPS website URL, optionally name it, then save. Each row has Enable, Open, Edit, Clear data and Remove. **Refresh sources** reloads saved entries, and the header **Refresh** retries current data/metadata. There is no TXT import or small fixed source-count cap. Authentication stays inside the selected source's browser profile. Original website players and audio/server controls remain in use.
- **Watch episodes** opens the original player inside the AniVerse watch screen, beside the episode list. Use the player's controls for playback, captions and quality. **Show website** reveals the source inside the same pane for sign-in, manual navigation and source controls. **Player only** restores the focused view. The browser opened from the Sources table is for full-site browsing.
- **Local watch → Import video:** use Android's file picker. AniVerse copies and validates the file in app-private storage. Add UTF-8 SRT/WebVTT from the card; SRT is normalized to WebVTT for reliable seek/resume. Play in airplane mode, resume, then Remove saved copy. Originals remain untouched. Embedded captions depend on Media3/device support. Attaching a replacement subtitle keeps the previous one if validation or import fails.
- **Player:** double-tap left/right to seek ten seconds; swipe vertically left for brightness or right for media volume. Lock touches for travel; use Unlock touches to restore controls. Mini player uses Android picture in picture where supported. Android has no desktop 4K enhancement control/pipeline.
- **Downloads:** paste a permitted direct video-file URL, or accept the source's own direct-file download action. Queue, progress/speed/ETA, pause/resume, retry/restart and cancel are native. Resume requires a valid server byte range and validator; otherwise restart safely. Completed videos appear in Local watch. Streams/playlists, DRM extraction and access-control bypass are unsupported. Source cookies/tokens are not forwarded to arbitrary file servers; authenticated links may fail. A server's own file expiry still applies.
- **Settings → AniList & MyAnimeList:** paste a valid OAuth access token into the native dialog, verify the actual account, then sync manually. A client/app ID or client secret is not an access token. The token stays outside JavaScript and source profiles, encrypted with Android Keystore. Expired tokens require reconnecting; automatic refresh/login acquisition is not included in this edition. Sync was validated with controlled fixtures, not a real user account.

## Android release updates

Open **Settings → Android updates**, choose **Check for updates**, then **Install** when a newer stable Android release is available. Updates use this project's public GitHub Android releases; Windows' latest release is ignored. Debug and fixture builds do not offer production updates.

The app downloads only after your action, verifies the APK against the release checksum and the installed app's signing identity, rejects another package or a non-increasing version code, then opens Android's installer. Android may first ask you to allow installation from AniVerse: grant that permission in the system settings, return, and choose Install again. You confirm installation in Android; the app never installs silently. App-private APK storage is exposed only through a nonexported, temporary read-grant provider scoped to the update cache.

## Feature boundaries

| Feature | Windows | Android 0.4.5 |
| --- | --- | --- |
| AniList discovery, multi-select filters, library, favourites, history Grid/List | Yes | Shared UI, touch navigation |
| User source configuration | Local TXT settings | URL table |
| Original website player, learned DOM navigation | Yes | Yes; unusual sites may need manual navigation |
| Source-backed DUB/SUB catalogue scans | Yes | Not ported; use website audio controls |
| Offline travel downloads and private saved-file section | No Android workflow | Android exclusive |
| Windows indexed local collection / Workspace / dual Subtitle Studio | Yes | Native Local watch replaces these workflows |
| 4K enhancement, desktop casting, GPU tools, Drive backups | Yes | Excluded |

## Security and privacy

Android application UID storage and the platform WebView renderer sandbox form the OS boundary. Sources get separate native browser profiles and **no native message bridge**, file grants or camera/microphone/location permissions. The packaged app main frame alone has an origin-restricted message channel with input/concurrency limits. Certificate errors are rejected; cleartext is disabled in release. File IDs/paths are native, canonical and private; Android backup/device transfer is disabled. Token verification uses official provider endpoints in release and Keystore-encrypted storage.

Provider imports use process-wide bounded workers, native inactivity/absolute deadlines, cancellation-aware query/open and nonblocking polled reads. Terminal replies release admission once. Late results cannot publish media or replace a prior subtitle. A provider that ignores cancellation can retain only the bounded provider workers; ordinary native controls remain independent.

Private website sessions use disposable **named WebView profiles**, deleted on close or next startup after interruption. They are not guaranteed memory-only; no anonymity is promised. Incognito/private-title rules suppress new library/history/progress/learned methods and sync while active. Already saved user-requested downloads/imports remain until removed. Pending edits are skipped while their title is private; existing external records are not erased.

Public-address checks run before native requests and source callbacks; TLS checks remain active. DNS resolution races, every WebView request/redirect/WebSocket class, OS/firmware/codec bugs and browser vulnerabilities are not ruled out. Treat these checks as app safeguards, not a VPN/firewall or a guarantee that arbitrary sources are safe. See [Privacy](../PRIVACY.md), [Security policy](../SECURITY.md) and [security architecture](SECURITY-ARCHITECTURE.md).

## Build and signing

Install Node 22+, Android Studio, Java 17+ compatible with Gradle 9.6, Android SDK platform 37 and build tools. The wrapper pins Gradle 9.6.0 SHA-256; AGP is 9.5.0. This checkout uses Android Studio's JBR. Set JAVA_HOME and ANDROID_HOME if installed elsewhere.

Run `npm ci`, then `npm run android:debug` or `npm run android:release` from the repository root. Both rebuild `dist/android` before packaging. Gradle build/user/project caches, Android user configuration and temp output are contained under `test/cache/android-0.1.0`. The release task also runs Android lint. Opening the Gradle project alone does not rebuild web assets; run `npm run android:ui` after UI changes.

Release signing uses `ANIVERSE_ANDROID_KEYSTORE`, `ANIVERSE_ANDROID_STORE_PASSWORD` and `ANIVERSE_ANDROID_KEY_PASSWORD`, alias `aniverse-tablet`. The build script can instead read ignored `config/android-signing.json` with keystore/storePassword/keyPassword fields. Never commit the key/passwords. Securely back up the existing Android signing key: later APK updates need that identity. The APK is copied to `release/android-0.4.5/AniVerse-Android-0.4.5.apk`; the build derives the output version from `android/app/build.gradle.kts`. The shared `test/cache/android-0.1.0` cache path remains stable across releases.

Normal `android:debug` uses official metadata networking and package `app.aniverse.tablet.debug`. It contains no fixture provider or local API redirection. The explicit `npm run android:fixture` / Gradle `-PaniverseFixture=true` test build instead uses package `app.aniverse.tablet.fixture`, local fixture networking and a nonexported test provider; its account-entry UI is disabled and its header identifies it. Test instrumented source sets are enabled only by that explicit flag. Release remains `app.aniverse.tablet`, signed, with app debugging disabled and no fixture endpoint/provider. Publish the release APK, and keep functional testing on official metadata and the actual privately configured Windows sources.

## Validation scope

Use owned Android Studio emulators only; a physical tablet connection is unnecessary. The user-facing emulator is emulator-5580; isolated validation now uses emulator-5584 so tests cannot overwrite an actively used profile. Every ADB command must name the owned emulator serial. Maintained harnesses are under `test/e2e/android-live.mjs`, `test/e2e/android-layouts-live.mjs`, `test/e2e/android-downloads.mjs`, and `test/android/`; reports live under `test/artifacts`. Emulator screen profiles approximate tablet layouts and do not certify Samsung One UI, device codecs, DRM or physical hardware. The initial API35 system image has an old patch/WebView and triggers the app's warning. Initial software-rendered host emulator runs crashed in qemu (0xc0000005), including with HardwareDecoder disabled. Switching to the actual host NVIDIA OpenGL renderer, with emulator Vulkan/HardwareDecoder disabled, completed native video and source playback checks. This changes only emulator configuration, not product security or the tablet decoder.


### Version 0.4.5

Validation is pending for the Android-only tablet navigation, page-reading, loading and source-recovery changes. Fresh reports must be generated under `test/artifacts/` before publication. An opened pane, discovered page, or displayed player control is not proof that the selected episode decoded video. Configured sources must be reported individually; third-party availability and device compatibility cannot be inferred from fixture results.

### Historical version 0.1.0

Final validation for 0.1.0: 16 native JVM tests; 12 native instrumented checks in airplane mode, including actual decoded frames, sidecar captions after forward/backward and paused seeks, caption off/on preservation, touch lock/resume, bounded provider imports and credential/download races; eight transfer checks including exact Range/If-Range and final-file SHA-256; 28 layout checks across representative S10+, S8/S9, Ultra and generic tablet screens plus fresh phone rejection. Actual privately configured Windows sources were added through the URL UI: series/episode navigation succeeded on three, decoded playback on two, and visible native video pixels were inspected on one. The third provider paused its CDP-inspected page; playback there remains unverified. A later buffering sample on the first source is preserved, not converted into a pass. No challenge/debugger protections were bypassed and no vulnerability probes were sent to those websites.

The signed APK's manifest, signature and 19 web assets were checked against the isolated source build; its first-run notice and official metadata load were verified. Lint passes with 41 warnings. The stock test OS is a **userdebug** build (`ro.debuggable=1`), which forces WebView inspection despite the app disabling it; absence of inspection on consumer firmware was not tested. This platform behavior is documented in [Chromium SharedStatics](https://chromium.googlesource.com/chromium/src/+/9963b4a7d5d60e3c270bb880a7350447c570656e/android_webview/glue/java/src/com/android/webview/chromium/SharedStatics.java). Do not enter real account credentials in the test emulator. Consumer hardware and real-account sync are outside these checks.


## Android 0.4.5 validation

The current Android release adds floating bottom/vertical glass navigation, persistent light/dark surfaces, animation preferences, corrected rendered-page navigation, actual source episode labels and verified GitHub release updates. Fresh checks pass: 332 shared unit, 31 native JVM, 13 native instrumented, 18 tablet/source runtime, 13 neutral DOM, eight transfer and 28 representative tablet layout checks plus phone rejection. The signed production APK passes five startup/network/UI/updater checks. Release lint has zero errors and 43 warnings. All 14 configured sources were tested, but verification pages, missing catalogue matches and unconfirmed media remain explicit limits; this is not universal source compatibility. Earlier 0.1.0 results above remain historical.
