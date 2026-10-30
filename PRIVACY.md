# Privacy and local data

_Last updated: 30 October 2026 · AniVerse 1.5.8_

AniVerse has no account system or developer-operated usage-analytics endpoint of its own. Most personal records stay on the device. Websites and external services receive requests when their features are used.

## Local records

| Data | Handling |
| --- | --- |
| Library, history, progress, favourites, scores, settings and profile | Local SQLite database and profile files |
| Scene bookmarks, notes/tags and skip ranges | Local; excluded from AniList/MyAnimeList list sync |
| Weekly plan and visual themes | Local; explicit theme export writes a JSON file you choose |
| Collection roots, filenames, sizes and confirmed matches | Local database; real paths stay in the main process/database and are hidden from collection menus |
| Imported subtitles | Selected file is read locally, converted to WebVTT and held for the native player session; original file unchanged |
| Optional watch insights | Disabled by default; local session timestamps, media/episode/source identifiers, playing-time estimates and available frame counters |
| Website cookies, logins, cache and local storage | Separate Chromium session per configured website |
| Google Drive backups | Explicit export uploads library, progress, history, favourites, notes, skip maps, themes and plans; import previews and merges. No video files, source lists, credentials or local paths are uploaded. |
| Embedded 4K casting | Selected local video is processed on the sender; bounded temporary HLS segments are served over a token-protected LAN URL and removed when stopped. |
| OAuth tokens | Main process, using Electron's operating-system secure storage when available |
| Source and OAuth configuration | Local files; do not commit or share them |

The database is not an encrypted vault. Operating-system account security, backups and disk protection matter. A collection index can reveal interests and paths even when menus hide paths.

Theme import/export accepts only a strict visual/player schema. It excludes credentials, sources, private notes and arbitrary CSS. Importing a preset does not execute a script or import media.

## Network destinations

| Destination | Trigger and request content |
| --- | --- |
| AniList and image hosts | Discovery, searches, details, schedule; authenticated list changes/comments when enabled |
| MyAnimeList | Supported metadata/forum lookups and authenticated list sync |
| YouTube / Google APIs | Official channel requests, embeds, trailers and comments; configured API key where required |
| Websites and their third parties | Normal browser requests, cookies, scripts, media and addresses loaded by the page; blocking is best effort |
| Filter-list distributors | Downloads when blocker lists need updating |
| GitHub Releases and asset hosts | Update checks/downloads; automatic unless disabled in Settings → About |
| Google Drive / Google OAuth | Only after user setup/sign-in and explicit import/export; fixed app-data backup and OAuth credentials sent only to Google's official endpoints |
| Selected cast device | Media address/playback information; local files can be served temporarily over a token-protected LAN URL |

Services ordinarily see request metadata such as IP address, time and user agent. Their own privacy policies apply. Local scene notes and watch-insight records are not copied to an AniVerse analytics service.

Collection filename parsing is local. Matching uses the search text shown in the AniList search field; edit it if an inferred title contains private information. Full filesystem paths are not required by the metadata API.

Account sign-in uses the provider's official OAuth page in the system browser. AniVerse does not ask for that password. A temporary local callback can receive the authorization response. See [Accounts](docs/ACCOUNTS.md).

## Retention and controls

- **Insights:** enable/disable in Workspace → Watch insights or Settings → Privacy & blocking. Disabling stops new samples; **Clear insights** deletes existing samples while keeping progress and bookmarks.
- **Bookmarks and skip maps:** delete individual records in Workspace or Episode Toolkit.
- **Collection:** removing an entry deletes its index record, not the file. Refreshing a remembered folder can index it again.
- **Google Drive:** disconnect clears local tokens and attempts revocation. Cloud backups persist until separately deleted in Drive; folder sharing is managed there. Notes leave the device only when you explicitly export/share a backup. [Setup and data scope](docs/GOOGLE-DRIVE.md).
- **Themes:** delete presets in Settings → Theme presets. Exported files remain where you saved them until separately deleted.
- **Website sessions:** use the source-session clearing controls. Disconnecting AniList/MyAnimeList removes that integration's local token.
- **Metadata:** clear cached metadata in Privacy & blocking; library records and logins remain.
- **Updates:** disable automatic checks/downloads in About if unwanted.

Uninstallation normally retains the user-data folder for reinstalling. For complete local removal, quit the app and remove its user-data folder, including database, configuration and browser sessions. Backups and exported files require separate deletion. Local deletion does not delete records already held by external services.

## Reports

Use [GitHub issues](https://github.com/shiwamshoryasharma/AniVerse/issues) for product questions and [SECURITY.md](SECURITY.md) for security concerns. Share the minimum reproduction details. Do not upload full databases, cookies, private source lists, OAuth files, personal paths or watch records.

## Optional website casting

When you select a TV for a website episode, AniVerse can capture the selected source view and optionally its audio. Encoded video/audio is served temporarily to the Cast receiver over your local network with an unguessable per-session URL. The desktop, camera, microphone and unrelated application audio are not captured. Stop casting or leave the episode to revoke capture and delete the owned rolling media cache. Mirroring is optional; normal website playback does not activate it.

## Windows wireless displays and compatibility upscaling (1.5.6)

Windows wireless display is a separate, optional system projection route. Its menu explains that Windows can share your screen and audio, including other visible apps. Windows controls discovery, pairing, display/audio modes and disconnection. AniVerse opens fixed Windows system destinations; it does not read or export the Windows device list.

Compatibility upscaling requests video-only capture of the selected owned source view, including rendered player frames. It captures no desktop or audio and records no file. Original source audio continues independently. Capture is stopped on disable, explicit Stop, navigation or episode exit. This recovery path does not extract stream URLs or remove protected-media restrictions.

## Incognito and private titles

The header's **Incognito** control starts a temporary app session. **Keep private** on a title stores a persistent, device-local rule. Both prevent new playback progress, history, watched updates, watch-insight samples, learned watch links and AniList/MyAnimeList sync jobs. Existing queued jobs for a newly private title are removed; provider imports skip it. A request already sent before privacy was enabled cannot be undone.

Private website players use fresh memory-only sessions, without normal cookies or logins. Ending incognito clears those sessions. Leaving a permanently private title clears its leased session; revisiting starts another. Incognito is off after restarting; private-title rules persist locally and are not exported. During global incognito, metadata response caches and snapshots stay in memory, manual library/favourite saves and app-data import/export are disabled, and account sync is suspended.

Permanent private titles can retain manually saved local library entries, but future provider sync and newly created app-data backups exclude their title records. Imports respect this device's private-title rules. Existing local progress is preserved without new updates and hidden from history/continue lists while private. Existing external records, previously exported files and remote backups are not deleted automatically.

This is app privacy, not anonymous networking. Websites, metadata providers, the network and a selected cast receiver can still receive requests or playback information. Chrome casting uses its own app-owned profile; its browser/receiver records are outside AniVerse's watch-history database. Use of casting and external-browser actions remains explicit.

## Seasonal appearance

The 2026 festive palette is an automatic local rollout through December 31, 2026. Its device-local marker remembers the prior accent for restoration on January 1, 2027 and records an early opt-out. The palette remains selectable after the automatic period. It changes appearance rather than sending activity to any service.

Portable v1 app-data backups use the prior standard accent (or Ember) while the festive palette is active. Saved festive presets use Ember in the backup. This keeps established portable colour values compatible; the automatic seasonal rollout marker is not exported. Standalone theme JSON can retain the festive palette for current AniVerse versions.
