# Privacy

_Last updated: 23 October 2026_

AniVerse has **no accounts of its own, no telemetry, no analytics and no servers**. The developer receives nothing about you or how you use the app.

## What stays on your computer

Everything AniVerse keeps is stored locally in `%APPDATA%\AniVerse` (Windows):

| Data | Where |
| --- | --- |
| Library, watch history, progress, favourites, settings, profile name/bio/images | `aniverse.db` (SQLite) and the profile folder |
| AniList / MyAnimeList sign-in tokens | Encrypted with the operating system's secure storage (Windows DPAPI, macOS Keychain, Linux Secret Service) and tied to your local profile |
| Each website's cookies, logins and cache | A separate, isolated browser session per site |
| Your source list and extra filter rules | `config/streaming-sites.txt`, `config/filters.txt` |

Uninstalling AniVerse removes the program but keeps this folder, so a reinstall picks up where you left off. Delete the folder to remove all data.

## What leaves your computer, and to whom

AniVerse only talks to a service when you use the feature that needs it:

| Service | When | What is sent |
| --- | --- | --- |
| **AniList** (`graphql.anilist.co`, image CDN) | Browsing, schedule, details, comments; list sync if connected | Search/filter queries; with sign-in, your list changes and comments you post |
| **MyAnimeList** (`api.myanimelist.net`) | Forum comments; list sync if connected | Topic lookups; with sign-in, your list changes |
| **YouTube** (`youtube.com`, `googleapis.com`) | Official-channel sources, trailers, YouTube comments | Channel/video requests; your own YouTube Data API key if you set one |
| **Ad-block filter lists** (Ghostery's list CDN) | Start-up, when the cached lists are out of date | A plain download request |
| **GitHub** (this repository's releases) | Update checks: start-up and every 6 hours, unless turned off in Settings → About | Plain requests for the latest release's `latest.yml` and, when there's an update, its installer files |
| **Websites you add** | When you open them | Whatever any browser sends to a website you visit |
| **Cast devices** on your local network | When you use casting | The stream address, to the TV you chose |

Sign-in uses each service's official OAuth page in your normal web browser. AniVerse never sees your AniList or MyAnimeList password.

These services have their own privacy policies. AniVerse has no control over them, or over the websites you add.

## Questions

Open an issue on [GitHub](https://github.com/shiwamshoryasharma/AniVerse/issues). Don't include personal data.
