# AniVerse Android 0.4.7

Android-only player and download fixes. Windows remains 2.2.1.

- Player-only mode isolates the actual video and its original controls through nested website frames, removing source headers, chat and navigation from the player area.
- Website view restores the original page without restarting playback. Player isolation recovers when the website replaces or moves its player.
- Download preparation uses the remaining bounded network budget instead of a fixed 1.5-second socket limit. Slow source responses no longer surface a raw “timeout” message.

Install through Settings → Android updates, or install the APK over the existing app without uninstalling. The existing signing identity, saved data and earlier releases are retained.

Two focused runtime cases passed: nested player isolation with visible restored playback, and delayed authenticated HLS DUB download with native offline decoding. The final signed APK package/update/launch validation is recorded separately in the release artifacts. Website challenges, unavailable content, unsupported/protected streams and unverified providers remain limits; physical Samsung/DeX and BlueStacks are not certified by the emulator checks.
