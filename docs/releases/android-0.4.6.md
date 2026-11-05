# AniVerse Android 0.4.6

Android-only update. Windows remains 2.2.1 with its installer and update feed preserved.

- Smaller floating navigation and search capsules over a full-width canvas, with a show/hide control for the vertical rail. The hero uses a smooth poster-card strip.
- Select source-confirmed SUB/DUB options beside the player. Downloads retain confirmed audio and include audio filters; older saved items remain unknown.
- Download the playing direct video or supported non-DRM HLS VOD without copying a link. Native downloads preserve observed request context across a verified source/CDN chain.
- Adaptive compact, portrait and resizable windows; the old tablet-size launch gate is removed and touchscreen hardware is optional.
- Localized glass blur, Android/custom accent colours, pull-to-refresh, touch-sized context menus and source ad filtering.

On a working 0.4.5 tablet, use Settings → Android updates. If the old tablet-size notice blocks BlueStacks/DeX startup, manually install the new APK over the existing app; keep the app installed to retain its data. Android asks you to approve installation.

Two focused emulator flows verified the source audio/download path and the floating navigation/hero behavior. Signed-package and publication identity are recorded separately in the release verification artifacts.

Audio options depend on what the source exposes. DRM, live-stream offline saving and access-control bypass are unsupported. Website challenges, expired links and unconfirmed sources remain limits; universal source compatibility is not claimed. Physical Samsung/DeX, BlueStacks and real-account sync remain untested.
