import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { compareMigrationVersions, verifyMigrationInstaller, verifyMigrationManifest } from './migrationVerification';

const repo = 'shiwamshoryasharma/AniVerse';
const releases = `https://github.com/${repo}/releases`;
const release = z.object({ draft: z.literal(false), prerelease: z.literal(false), tag_name: z.string(), assets: z.array(z.object({ name: z.string() })) });
const tag = /^aniverse2-v((?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2})$/;
const offerName = 'aniverse2-windows-migration.json';
const envelope = z.strictObject({ manifest: z.string(), signature: z.string(), certificate: z.string() });
const assetOrigins = new Set(['https://github.com', 'https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com']);

async function request(url: string, signal: AbortSignal, send: typeof fetch, githubAsset = false): Promise<Response> {
  let target = new URL(url);
  for (let count = 0; count <= 4; count++) {
    if (target.username || target.password || (githubAsset ? !assetOrigins.has(target.origin) : target.origin !== 'https://api.github.com')) {
      throw new Error('The AniVerse2 download redirected outside GitHub.');
    }
    const reply = await send(target, { signal, redirect: 'manual' });
    const location = reply.headers.get('location');
    if (!githubAsset || !location || ![301, 302, 303, 307, 308].includes(reply.status)) {
      if (reply.status === 200 && reply.body) return reply;
      await reply.body?.cancel();
      throw new Error(`GitHub returned HTTP ${reply.status} while checking AniVerse2.`);
    }
    await reply.body?.cancel();
    target = new URL(location, target);
  }
  throw new Error('Too many AniVerse2 download redirects.');
}

async function* bounded(response: Response, max: number) {
  let bytes = 0;
  const reader = response.body!.getReader();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return;
      bytes += part.value.byteLength;
      if (bytes > max) throw new Error('The AniVerse2 download exceeds its expected size.');
      yield Buffer.from(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function json(response: Response, max: number): Promise<unknown> {
  const parts: Buffer[] = [];
  for await (const part of bounded(response, max)) parts.push(part);
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
}

export async function findMigrationOffer(current: string, send: typeof fetch = fetch, pins?: readonly string[]) {
  const signal = AbortSignal.timeout(25_000);
  let selected: { tag: string; version: string } | undefined;
  for (const page of [1, 2]) {
    const items = z.array(z.unknown()).parse(await json(await request(`https://api.github.com/repos/${repo}/releases?per_page=50&page=${page}`, signal, send), 4 * 1024 * 1024));
    for (const raw of items) {
      const parsed = release.safeParse(raw);
      if (!parsed.success) continue;
      const item = parsed.data;
      const version = tag.exec(item.tag_name)?.[1];
      if (!version || compareMigrationVersions(version, current) <= 0 || (selected && compareMigrationVersions(version, selected.version) <= 0)) continue;
      if (!item.assets.some((asset) => asset.name === offerName) || !item.assets.some((asset) => asset.name === `AniVerse-Tauri-Setup-${version}-x64.exe`)) continue;
      selected = { tag: item.tag_name, version };
    }
    if (items.length < 50) break;
  }
  if (!selected) return null;
  const prefix = `${releases}/download/${selected.tag}/`;
  const signed = envelope.parse(await json(await request(prefix + offerName, signal, send, true), 32 * 1024));
  const offer = verifyMigrationManifest(Buffer.from(signed.manifest, 'base64'), Buffer.from(signed.signature, 'base64'), Buffer.from(signed.certificate, 'base64'), current, pins);
  if (offer.version !== selected.version) throw new Error('The signed AniVerse2 version does not match its release tag.');
  return { offer, signed, url: prefix + offer.installerName };
}

export async function downloadMigrationInstaller(candidate: NonNullable<Awaited<ReturnType<typeof findMigrationOffer>>>, directory: string, send: typeof fetch = fetch, pins?: readonly string[]) {
  const signal = AbortSignal.timeout(15 * 60_000);
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(path.join(directory, 'attempt-'));
  try {
    const file = path.join(staging, candidate.offer.installerName);
    const reply = await request(candidate.url, signal, send, true);
    await pipeline(bounded(reply, candidate.offer.installerBytes), createWriteStream(file, { flags: 'wx' }), { signal });
    await verifyMigrationInstaller(file, candidate.offer, pins);
    return { staging, file };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
