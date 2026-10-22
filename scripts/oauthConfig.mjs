// Reads AniVerse's OAuth client IDs for the build (config/oauth.json, overridable
// with ANIVERSE_ANILIST_CLIENT_ID / ANIVERSE_MAL_CLIENT_ID) and exposes them to
// the main process as the compile-time constant __ANIVERSE_OAUTH__.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function oauthClientIds() {
  const file = path.join(root, 'config', 'oauth.json');
  const json = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const anilistClientId = String(process.env.ANIVERSE_ANILIST_CLIENT_ID ?? json.anilist?.clientId ?? '').trim();
  const malClientId = String(process.env.ANIVERSE_MAL_CLIENT_ID ?? json.myanimelist?.clientId ?? '').trim();
  if (anilistClientId && !/^\d{1,12}$/.test(anilistClientId)) throw new Error(`AniList client ID must be numeric (got "${anilistClientId}")`);
  if (malClientId && !/^[a-f0-9]{16,64}$/i.test(malClientId)) throw new Error('MyAnimeList client ID must be the hexadecimal Client ID from myanimelist.net/apiconfig');
  if (json.myanimelist?.clientSecret || json.anilist?.clientSecret) throw new Error('config/oauth.json must not contain client secrets');
  return { anilistClientId, malClientId };
}

export function oauthDefine() {
  return { __ANIVERSE_OAUTH__: JSON.stringify(oauthClientIds()) };
}
