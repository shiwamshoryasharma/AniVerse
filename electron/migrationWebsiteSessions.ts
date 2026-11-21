import { BrowserWindow, safeStorage, session } from 'electron';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { SourceInfo } from '../app/shared/types';

const archiveName = 'website-sessions.json';
const mayPersistFor = 400 * 86400;
const token = /^[!#$%&'*+.^_\x60|~0-9A-Za-z-]{1,256}$/;
const valueChars = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{0,4096}$/;
const sourceId = /^[a-z0-9][a-z0-9-]{0,127}$/;

function portableCookie(cookie: Record<string, unknown>, hostname: string, now: number) {
  const { name, value, domain, path, secure, httpOnly, expires, sameSite, sourceScheme } = cookie;
  // Browser cookie APIs must establish that the cookie never had a partition key.
  if (cookie.partitionKey !== undefined || cookie.partitionKeyOpaque !== undefined || cookie.sameParty === true ||
      domain !== hostname || secure !== true || sourceScheme !== 'Secure' || cookie.session !== false ||
      typeof httpOnly !== 'boolean' || typeof expires !== 'number' || !Number.isFinite(expires) ||
      expires <= now || expires > now + mayPersistFor || !['Strict', 'Lax', 'None'].includes(String(sameSite)) ||
      typeof name !== 'string' || !token.test(name) || typeof value !== 'string' || !valueChars.test(value) ||
      typeof path !== 'string' || !/^\/[\x20-\x3a\x3c-\x7e]{0,1023}$/.test(path)) return null;
  return { name, value, path, httpOnly, expires, sameSite };
}

async function ownedCookies(source: SourceInfo, hostname: string, remaining: number) {
  const own = session.fromPartition(source.partition);
  const storage = own.storagePath;
  if (!storage || !await stat(storage).then(stat => stat.isDirectory(), () => false)) return [];
  // Network.getAllCookies is attached to this one isolated WebContents. The
  // browser-level Storage domain and Electron's Cookie type lack this combination
  // of source-session scope and partition provenance.
  const view = new BrowserWindow({ show: false, webPreferences: { session: own, sandbox: true, contextIsolation: true } });
  try {
    async function read() {
      await view.loadURL('about:blank');
      if (view.webContents.session !== own) return [];
      const debuggerApi = view.webContents.debugger;
      debuggerApi.attach('1.3');
      const { cookies } = await debuggerApi.sendCommand('Network.getAllCookies') as { cookies: Record<string, unknown>[] };
      const now = Date.now() / 1000;
      return cookies.flatMap(cookie => portableCookie(cookie, hostname, now) ?? []).slice(0, 64);
    }
    return await Promise.race([read(), delay(remaining, [], { ref: false })]);
  } finally {
    if (!view.isDestroyed()) view.destroy();
  }
}

/** Keep only encrypted, nonce-bound records. Incognito and foreign sessions never reach this exporter. */
export async function exportWebsiteSessions(data: string, staging: string, nonce: string, sources: readonly SourceInfo[]) {
  if (!safeStorage.isEncryptionAvailable() || !sources.length) return;
  const file = await open(path.join(data, 'profile.id'), 'r').catch(() => null);
  if (!file) return;
  const buffer = Buffer.alloc(100);
  let profileId: string;
  try {
    const { bytesRead } = await file.read(buffer);
    profileId = buffer.subarray(0, bytesRead).toString('utf8').trim();
  } finally {
    await file.close();
  }
  if (!/^[a-f0-9]{32}$/.test(profileId)) return;
  const packets: Record<string, string> = Object.create(null);
  const deadline = Date.now() + 8000;
  let bytes = 0;
  for (const source of sources) {
    if (Date.now() >= deadline || bytes > 120_000) break;
    if (!source.enabled || source.kind !== 'web' || !sourceId.test(source.id) || source.partition !== 'persist:src-' + source.id) continue;
    const address = URL.parse(source.url);
    if (!address || address.protocol !== 'https:' || address.port || address.username || address.password) continue;
    const cookies = await ownedCookies(source, address.hostname, Math.max(1, deadline - Date.now())).catch(() => []);
    if (!cookies.length) continue;
    const payload = JSON.stringify({ schema: 1, nonce, source: source.id, origin: address.origin, cookies });
    if (Buffer.byteLength(payload) > 32_000) continue;
    const sealed = safeStorage.encryptString(profileId + '\n' + payload);
    const packet = 'enc2:' + sealed.toString('base64');
    bytes += packet.length;
    if (bytes <= 120_000) packets[source.id] = packet;
  }
  if (!Object.keys(packets).length) return;
  const archive = await open(path.join(staging, archiveName), 'wx', 0o600);
  try {
    await archive.writeFile(JSON.stringify(packets), 'utf8');
    await archive.sync();
  } finally {
    await archive.close();
  }
}
