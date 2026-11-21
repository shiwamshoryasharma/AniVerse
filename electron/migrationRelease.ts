import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { compareMigrationVersions, verifyMigrationInstaller, verifyMigrationManifest } from './migrationVerification';

const repo = 'shiwamshoryasharma/AniVerse';
const releases = `https://github.com/${repo}/releases`;
const migrationIndex = `https://raw.githubusercontent.com/${repo}/codex/aniverse2-windows-updates/aniverse2-windows-migration.json`;
const release = z.object({ draft: z.literal(false), prerelease: z.literal(false), tag_name: z.string(), assets: z.array(z.object({ name: z.string() })) });
const tag = /^aniverse2-v((?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2})$/;
const offerName = 'aniverse2-windows-migration.json';
const envelope = z.strictObject({ manifest: z.string(), signature: z.string(), certificate: z.string() });
const assetOrigins = new Set(['https://github.com', 'https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com']);

class GitHubReleaseError extends Error {
  constructor(readonly status: number) {
    super(`GitHub returned HTTP ${status} while checking AniVerse2.`);
  }
}

async function request(url: string, signal: AbortSignal, send: typeof fetch, kind: 'api' | 'asset' | 'index' = 'api'): Promise<Response> {
  let target = new URL(url);
  for (let count = 0; count <= 4; count++) {
    const allowed = kind === 'asset' ? assetOrigins.has(target.origin)
      : target.origin === (kind === 'api' ? 'https://api.github.com' : 'https://raw.githubusercontent.com');
    if (target.username || target.password || !allowed) {
      throw new Error('The AniVerse2 download redirected outside GitHub.');
    }
    const reply = await send(target, { signal, redirect: 'manual' });
    const location = reply.headers.get('location');
    if (kind !== 'asset' || !location || ![301, 302, 303, 307, 308].includes(reply.status)) {
      if (reply.status === 200 && reply.body) return reply;
      await reply.body?.cancel();
      throw new GitHubReleaseError(reply.status);
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

async function latestTag(current: string, signal: AbortSignal, send: typeof fetch) {
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
  return selected;
}

export async function findMigrationOffer(current: string, send: typeof fetch = fetch, pins?: readonly string[]) {
  const signal = AbortSignal.timeout(25_000);
  let selected: Awaited<ReturnType<typeof latestTag>>;
  let signed: z.infer<typeof envelope> | undefined;
  try {
    selected = await latestTag(current, signal, send);
  } catch (error) {
    if (!(error instanceof GitHubReleaseError) || ![403, 429].includes(error.status)) throw error;
    const index = await request(migrationIndex, signal, send, 'index').catch((failure: unknown) => {
      if (failure instanceof GitHubReleaseError && failure.status === 404) return null;
      throw failure;
    });
    if (!index) return null;
    signed = envelope.parse(await json(index, 32 * 1024));
  }
  if (selected) {
    const url = `${releases}/download/${selected.tag}/${offerName}`;
    signed = envelope.parse(await json(await request(url, signal, send, 'asset'), 32 * 1024));
  }
  if (!signed) return null;
  const offer = verifyMigrationManifest(Buffer.from(signed.manifest, 'base64'), Buffer.from(signed.signature, 'base64'), Buffer.from(signed.certificate, 'base64'), current, pins);
  if (selected && offer.version !== selected.version) throw new Error('The signed AniVerse2 version does not match its release tag.');
  return { offer, signed, url: `${releases}/download/aniverse2-v${offer.version}/${offer.installerName}` };
}

export async function downloadMigrationInstaller(candidate: NonNullable<Awaited<ReturnType<typeof findMigrationOffer>>>, directory: string, send: typeof fetch = fetch, pins?: readonly string[]) {
  const signal = AbortSignal.timeout(15 * 60_000);
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(path.join(directory, 'attempt-'));
  try {
    const file = path.join(staging, candidate.offer.installerName);
    const reply = await request(candidate.url, signal, send, 'asset');
    await pipeline(bounded(reply, candidate.offer.installerBytes), createWriteStream(file, { flags: 'wx' }), { signal });
    await verifyMigrationInstaller(file, candidate.offer, pins);
    return { staging, file };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
