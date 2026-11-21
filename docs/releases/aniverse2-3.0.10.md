# AniVerse2 3.0.10 for Windows x64

- Download MP4 supports compatible clear on-demand HLS streams alongside direct MP4 files. Save As uses your configured folder and combines the existing video and audio tracks without re-encoding. Availability depends on the selected player and source.
- Home stops animating and releases outgoing spotlight artwork after the visible transition. Carousel rotation pauses when Home is out of view or the window loses focus.
- Windows startup loads profile data away from the window thread. The app remains responsive when its SQLite profile is temporarily locked.
- The installer bundles the FFmpeg remuxer. AniVerse2 starts it only for compatible stream downloads.

Verified with Windows WebView2 playback and Save As fixtures, a reproducible SQLite lock, and a controlled Home rendering comparison.
