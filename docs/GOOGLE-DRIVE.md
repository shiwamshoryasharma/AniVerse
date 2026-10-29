# Google Drive app-data sync

AniVerse 1.5.2 adds manual import/export in **Settings → Google Drive sync**. Video files are not uploaded.

## Set up your own Google OAuth client

1. Create or select your Google Cloud project and enable the Google Drive API.
2. Configure the OAuth consent screen. Add your Google account as a test user if the app is in Testing.
3. Create **OAuth client ID → Desktop app**, download its JSON and choose **Upload OAuth JSON** in AniVerse.
4. Choose **Connect Google**, select your account and approve the requested access.

A plain API key cannot authorize private Drive data. Service-account private-key JSON is not accepted. Sign-in runs in the system browser with PKCE, a random single-use state and a short-lived listener bound only to 127.0.0.1.

Client credentials and tokens remain in the main process, encrypted with the existing profile-bound OS credential store. Without secure storage, the connection is session-only. Tokens and JSON contents are never returned through the renderer bridge or included in backups.

## Stable shared format

~~~text
AniVerse Sync/
  aniverse-backup.v1.json
~~~

The folder and file names are fixed. The backup envelope uses `format: "aniverse.backup"` and `version: 1`. `appVersion` records the exporting AniVerse version without changing the portable protocol.

- **EXPORT** creates your folder if needed and replaces only the fixed backup file. Existing content is validated before replacement; unrelated or incompatible files are rejected.
- **IMPORT · preview** downloads and validates a bounded backup, then shows record counts. **Confirm import** merges that exact preview. Preview tickets expire after ten minutes.
- Import preserves unrelated records and newer local library/progress/history. Repeated imports do not duplicate unchanged scenes or favourites. Local removal tombstones protect against resurrecting an older list entry.
- Appearance/player settings apply only when explicitly selected. Imported skip maps start disabled because device/source editions can differ.
- A saved local weekly plan is retained; the imported plan fills an empty planner. Theme presets merge up to the existing 30-preset limit.
- No automatic AniList/MyAnimeList pushes are queued by importing a Drive backup.

Backups include library status/progress/scores, playback positions, history, favourites, scene notes/tags, skip ranges, appearance/player preferences, visual themes and weekly plans. They exclude account/API credentials, source lists/identities, cookies, profile images, local media indexes/paths, video files and watch-insight sessions. A backup can contain private viewing interests and notes; share it deliberately.

## Shared folders and different OAuth clients

Google Drive allows duplicate folder names; a name alone is not a unique identity. Share the existing **AniVerse Sync** folder in Google Drive, then paste its folder link/ID into AniVerse and choose **Use folder**. Keep its name and file structure unchanged. Import needs read access; export needs edit access.

Default sign-in requests `drive.file`, limited to files your OAuth app creates or can access. Files created with another OAuth client are not automatically authorized by that scope.

For a folder shared across different clients, enable **Shared-folder access** before connecting/reconnecting. Google then requests the broader `drive` scope. This permission can manage all Drive files; AniVerse constrains its operations to the selected fixed-name folder and backup file. It neither changes sharing permissions nor renames folders. Google Cloud verification/testing rules still apply to your own OAuth project.

Ambiguous duplicate folders/files are rejected rather than guessed. Select the intended folder by ID to resolve duplicate folder names. If Google returns a revision tag, export uses it to reject concurrent changes; this is manual backup, not automatic conflict-free multi-device sync.

Disconnect clears the local token and attempts Google revocation. Delete the backup separately in Drive if you want cloud data removed.

Sources: [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).
