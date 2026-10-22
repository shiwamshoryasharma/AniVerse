# AniList & MyAnimeList accounts

Users click **Connect** → sign in on the service's own page in their browser → **Authorize** → the browser hands control back to AniVerse → their list syncs. No passwords, client IDs, redirect URLs or tokens are ever typed into AniVerse.

## How it works

| Step | AniList | MyAnimeList |
| --- | --- | --- |
| Grant | Implicit grant (`response_type=token`) | Authorization code + PKCE, `code_challenge_method=plain` (the only method MAL supports), public client — no client secret |
| Browser opens | `https://anilist.co/api/v2/oauth/authorize?client_id=…&response_type=token&state=…` | `https://myanimelist.net/v1/oauth2/authorize?response_type=code&client_id=…&state=…&redirect_uri=aniverse://oauth/myanimelist&code_challenge=…&code_challenge_method=plain` |
| Comes back as | `aniverse://oauth/anilist#access_token=…&expires_in=…&state=…` | `aniverse://oauth/myanimelist?code=…&state=…` |
| Then | Token checked with a `Viewer` query | Code exchanged at `POST https://myanimelist.net/v1/oauth2/token` with the PKCE verifier |
| Session length | 1 year, no refresh tokens → AniVerse asks to **Reconnect** when it ends | Access token per `expires_in` (≈1 month); refreshed a day before expiry or when MAL rejects it; refresh failure → **Reconnect** |

Code: `electron/oauth.ts` (sign-in transactions), `electron/deepLink.ts` (protocol registration), `electron/accounts.ts` (tokens, refresh, reconnect), `app/core/sync/` (sync and reconciliation), Settings → Accounts & sync (`frontend/src/pages/Settings.tsx`).

### Security

- **Transactions**: each Connect creates a random 256-bit `state` (and for MAL an 86-character PKCE verifier) held only in the main process. A transaction completes once, expires after 10 minutes, and is replaced by a new Connect. Links with a missing/wrong `state`, late or replayed links, and links for another provider are ignored without disturbing a sign-in in progress. (AniList: if a redirect ever arrives without `state`, the token is still only accepted while that AniList sign-in is pending.)
- **Redirect validation**: only `aniverse://oauth/anilist` and `aniverse://oauth/myanimelist` are accepted (no user/password/port, ≤16 KB). Deep links are parsed in the main process; the renderer never sees tokens (IPC returns account names and status only).
- **Storage**: tokens are encrypted with Electron `safeStorage` (Windows DPAPI, macOS Keychain, Linux Secret Service/KWallet) and bound to the AniVerse profile's random `profile.id`. A database copied to another profile or OS user can't be decrypted. Where no OS store exists (Linux `basic_text`), sessions are kept in memory for the current run only and the UI says so.
- **No secrets**: only public client IDs are compiled in. The build fails if `config/oauth.json` contains a `clientSecret`. No server is involved.
- Tokens never appear in logs (deep links are logged with query and fragment removed). Note: on Windows/Linux the OS passes the redirect link on the command line of a short-lived second AniVerse process; that is inherent to custom-scheme redirects.

### Sync behaviour

- **Auto sync** (default on): status, episodes watched, score and favourites are queued locally and sent as they change (offline-safe, exponential backoff). One queued job per title always sends the *current* entry, so changes can't arrive out of order.
- **Two-way sync** (default on, optional): on connect, at start-up and every 30 minutes (and on **Sync now**), AniVerse fetches each list and reconciles title by title (`app/core/sync/reconcile.ts`):
  - the most recent edit wins (AniList `updatedAt`, MAL `updated_at`, AniVerse's own edit time; ties keep AniVerse);
  - a service's newer edit replaces an unsent AniVerse change instead of being overwritten by it (the stale push is dropped), and the winner is pushed to the other service;
  - removals in AniVerse are remembered (tombstones) and sent; a title missing from a service is only re-added there if it changed after that service's last sync, so removals made on the service stay removed;
  - an unscored AniVerse entry never erases a service's score; MAL stores whole-number scores, AniList any precision (sent as `scoreRaw`, independent of the user's score format).
- **Push only** (two-way off): AniVerse never changes your local list from a service; Sync now sends pending changes.
- MyAnimeList needs a MAL id for the title, and has no favourites API (favourites sync to AniList only).
- Signing in as a *different* user on the same service clears that service's pending queue, so one person's changes never go to another account. Disconnect removes the tokens and that service's queue; the other service is untouched.

### Profiles

Both services are connected independently under the current AniVerse profile. A profile is one data folder (Electron `userData`, holding `aniverse.db` and `profile.id`); credentials are encrypted per OS user and bound to that folder, so separate profiles — or separate OS users — never share or read each other's sessions.

## Register the apps (once, by the developer)

### AniList

1. Sign in at <https://anilist.co/settings/developer> → **Create New Client**.
2. **Name**: AniVerse. **Redirect URL**: `aniverse://oauth/anilist` (exactly).
3. Save and copy the numeric **Client ID**. Ignore the client secret — the implicit grant doesn't use it and it must not ship in the app.

AniList's docs require the redirect to match the registered URL exactly and allow custom-scheme redirects. AniVerse also accepts `aniverse://auth/anilist` (a common way to type it); any other `aniverse://` address ends the sign-in with an error naming the address it expected.

### MyAnimeList

1. Sign in at <https://myanimelist.net/apiconfig> → **Create ID**.
2. **App Type**: `other` (a public client: no secret is needed for PKCE). **App Redirect URL**: `aniverse://oauth/myanimelist` (exactly). Fill in name, description, homepage and company/purpose as MAL asks.
3. Copy the 32-character hexadecimal **Client ID**. If MAL also shows a client secret, don't use it.

MAL accepts custom-scheme redirects (other native public clients, e.g. Mihon's `mihon://myanimelist-auth`, use the same approach). AniVerse sends `redirect_uri` explicitly in both the authorize and token requests, so it must match exactly.

## Configure the client IDs (build time)

Copy `config/oauth.example.json` to `config/oauth.json` and put them in. The file is untracked (`.gitignore`), so each fork or build uses its own IDs:

```json
{ "anilist": { "clientId": "12345" }, "myanimelist": { "clientId": "0123456789abcdef0123456789abcdef" } }
```

or set environment variables when building (they override the file — handy for CI):

```bash
ANIVERSE_ANILIST_CLIENT_ID=12345 ANIVERSE_MAL_CLIENT_ID=0123456789abcdef0123456789abcdef npm run build
```

`scripts/oauthConfig.mjs` validates the values and compiles them into the main process (`__ANIVERSE_OAUTH__`) for builds. Development runs (`npm run dev`) read `config/oauth.json` live, so new IDs work without a restart. A build without an ID shows that service's **Connect** button disabled ("isn't available in this build").

## Development setup

- `npm run dev` registers `aniverse://` for the development Electron on start-up (Windows: `HKCU\Software\Classes\aniverse` pointing at `node_modules/electron/dist/electron.exe "<project>"`). The browser's "Open AniVerse?" prompt then reaches the running dev instance through the single-instance lock.
- Browsers name the handler with Windows' "friendly app name", which for the development Electron would be "Electron". AniVerse sets `FriendlyAppName = AniVerse` on its own key (`HKCU\Software\Classes\aniverse\shell\open`), so the prompt reads **"Open AniVerse?"**; other Electron apps are unaffected.
- Sign-in diagnostics go to `<data folder>/logs/accounts.log` (sign-in started, link received with which parts present, result). It never contains tokens, codes or `state` values.
- Test runs (`ANIVERSE_HEADLESS`, `ANIVERSE_DATA_DIR`, `ANIVERSE_TEST_DRIVER`) never register the scheme, so tests can't take over the handler.
- macOS and Linux only route custom schemes to *packaged* apps (Info.plist / `.desktop` file), so test the full browser round trip there with a packaged build.
- Check the handler on Windows: `start aniverse://oauth/anilist` should focus AniVerse and log `[deep-link] no matching sign-in for aniverse://oauth/anilist?…` (nothing in progress — harmless).

## Packaged apps

`electron-builder.yml` declares the scheme (`protocols: aniverse`):

- **Windows NSIS installer**: registers `aniverse://` for the user at install; the app also re-registers itself on start. The **portable** build registers on first start.
- **macOS**: `CFBundleURLTypes` in Info.plist; links arrive through `open-url`.
- **Linux AppImage**: the scheme lives in the `.desktop` file (`x-scheme-handler/aniverse`), so the AppImage must be integrated (e.g. AppImageLauncher or `--appimage-extract` + desktop entry).

## Testing

- Unit: `npm test` — `test/unit/oauth.test.ts` (authorize URLs, PKCE, callback parsing, forged/replayed/expired links, cancel/restart, missing IDs, reconcile rules) and `test/unit/store-sync.test.ts` (queue coalescing, token-refresh retry, legacy queue rows, two-way import / conflict / removal, push-only).
- End-to-end without accounts: build with placeholder IDs and run the in-app driver. It stubs the browser, delivers `aniverse://` links through the real second-instance path and lets AniList/MAL reject the placeholder token and code:

  ```bash
  ANIVERSE_ANILIST_CLIENT_ID=12345 ANIVERSE_MAL_CLIENT_ID=0123456789abcdef0123456789abcdef npm run build
  node test/e2e/native.mjs test/e2e/drivers/oauth-flow.cjs
  ```

  Expected (`test/artifacts/oauth-flow.json`): official authorize URLs, "Waiting for AniList…" in Settings, the forged link ignored, "AniList didn't accept the sign-in", "MyAnimeList rejected the sign-in", "Sign-in was cancelled", late link ignored. Rebuild without the placeholders afterwards.
- With real IDs (manual): `npm run dev` → Settings → Accounts & sync → **Connect** AniList → sign in → **Authorize** → allow the browser to open AniVerse → the row shows your name and the list imports (two-way). Repeat for MyAnimeList. Then: mark an episode watched (both services update within seconds), change a status/score on the website and press **Sync now** (AniVerse follows the newer edit), go offline and back (queued changes send later), **Disconnect** (row resets, the other service keeps working).
