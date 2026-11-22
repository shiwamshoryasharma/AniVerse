# AniVerse2 features in AniVerse 1 for Windows

The reference for this list is AniVerse2 3.0.10. AniVerse 2.3.0 upgrades the existing Electron installation and uses the installed profile. Both Windows editions can be installed side by side.

| Feature | AniVerse 2.3.0 on Electron |
| --- | --- |
| Appearance | Ten palette colours plus custom colours for the header, navigation, sidebar, pages, cards, buttons, icons and floating menus. Live preview, saved preferences, reset, dark and light themes, GitHub Dimmed and VS Code palettes. |
| Layouts and display | Classic, Studio, Cinema, Atlas and Dock. Responsive layouts and display scale. Floating rounded vertical rail starts icon-only and expands to show labels. |
| Search and discovery | Search titles in the same search field. Opening it shows local history-based and genre-based suggestions. Recommendations exclude completed titles. Matching completed titles stay searchable with a completion label. Incognito skips personalization. |
| Home efficiency | Bound the number of full-size hero images and animated placeholders. Suspend the carousel while it is out of view or the app is in the background. Keep navigation and transitions. Retry a temporarily locked local profile during startup without blocking the window thread. |
| Source navigation | Reuse configured site recipes, retained series matches and confirmed episode observations. Maintain source redirect handoffs, timeout fallback, source isolation and SUB/DUB server selection. |
| Episode cards and player | Use source artwork when supplied, keep episode card labels legible at reduced widths, and keep the original media player in the app. Preserve player-only focus and site controls. |
| Quantum Audio | Rust DSP in an AudioWorklet for supported local video and website players. Includes intensity and clean bypass when audio cannot be processed. The audio stays on the original media clock. |
| Save MP4 | Visible player button, user-selected destination, progress and Rust-backed remuxing of compatible finite clear HLS. Direct MP4 is saved byte-for-byte. Protected and authenticated transfers require the source’s own download facility. |
| Graphics | Windows GPU preference, compatibility video guidance, existing Stable and Accelerated UI modes, and viewport-aware Anime4K on compatible streams. Adapter choice depends on the Windows driver and display wiring. |
| Blocking report | Standard time-series chart with source, activity and time filters. Detailed blocked-request breakdown stays in the local session. |
| Casting and local media | Existing device and Windows display casting, website mirroring, compatible sender-side 4K, media collection and playback remain available. |
| Library, sync and privacy | Existing AniList, MyAnimeList and Google Drive flows, watching history, collections, toolkit and private sessions use the existing Electron profile. |
| Windows installer and updates | AniVerse retains its branded NSIS setup, app identity, Authenticode verification and signed Electron updater. AniVerse2 uses its own setup and updater. The optional migration keeps AniVerse installed. |
| Browser sandbox | Electron isolates websites in sandboxed Chromium webviews without Node access. AniVerse2 uses the WebView2 sandbox. The Chromium runtime ships with Electron. |

Source capabilities depend on the website's available player, episode metadata and audio tracks. Downloading and Quantum Audio require compatible media.
