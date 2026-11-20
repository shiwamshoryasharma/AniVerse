import { createHash, verify, X509Certificate } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import signing from '../config/signing.json';
import { checkUpdateSignature, isPinnedUpdateCertificate, readSignature } from './updateSignature';

const version = z.string().regex(/^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const manifest = z.strictObject({
  schema: z.literal(1),
  role: z.literal('aniverse-tauri-migration'),
  target: z.literal('windows-x64'),
  version,
  minimumElectron: version,
  installerSha256: sha256,
  installerBytes: z.number().int().positive().max(2_000_000_000),
  applicationSha256: sha256,
});

type MigrationOffer = z.infer<typeof manifest> & { installerName: string };

export function compareMigrationVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  return (left[0] - right[0]) || (left[1] - right[1]) || (left[2] - right[2]);
}

/** Verify the exact detached manifest bytes with a pinned Windows publisher certificate. */
export function verifyMigrationManifest(
  bytes: Buffer, signature: Buffer, certificateDer: Buffer, current: string, pins: readonly string[] = signing.updateSigners,
): Readonly<MigrationOffer> {
  if (bytes.length === 0 || bytes.length > 4096 || signature.length === 0 || signature.length > 1024 ||
      certificateDer.length === 0 || certificateDer.length > 16_384) {
    throw new Error('Invalid migration signature data size.');
  }
  if (!isPinnedUpdateCertificate(certificateDer.toString('base64'), pins)) {
    throw new Error('The migration manifest is signed by an unknown certificate.');
  }
  const certificate = new X509Certificate(certificateDer);
  if (!verify('sha256', bytes, certificate.publicKey, signature)) {
    throw new Error('The migration manifest signature is invalid.');
  }
  const offer = manifest.parse(JSON.parse(bytes.toString('utf8')));
  version.parse(current);
  if (compareMigrationVersions(offer.minimumElectron, current) > 0 || compareMigrationVersions(offer.version, current) <= 0) {
    throw new Error('The migration manifest does not apply to this version of AniVerse.');
  }
  return Object.freeze({ ...offer, installerName: `AniVerse-Tauri-Setup-${offer.version}-x64.exe` });
}

/** Verify a completed download in an app-owned directory before handing it to an installer runner. */
export async function verifyMigrationInstaller(
  file: string, offer: Readonly<MigrationOffer>, pins: readonly string[] = signing.updateSigners,
): Promise<void> {
  if (path.basename(file) !== offer.installerName) throw new Error('Unexpected migration installer filename.');
  const downloaded = await open(file, 'r');
  try {
    const info = await downloaded.stat({ bigint: true });
    if (!info.isFile() || info.size !== BigInt(offer.installerBytes)) throw new Error('Unexpected migration installer size.');
    const hash = createHash('sha256');
    for await (const chunk of downloaded.createReadStream({ autoClose: false, end: offer.installerBytes - 1 })) hash.update(chunk);
    if (hash.digest('hex') !== offer.installerSha256) {
      throw new Error('The migration installer does not match the signed manifest.');
    }
    const signature = await readSignature(file);
    if (!signature.path) throw new Error('Windows did not identify the migration installer.');
    const error = checkUpdateSignature(signature, file, pins);
    if (error) throw new Error(error);
    const current = await lstat(file, { bigint: true });
    if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino ||
        current.size !== info.size || current.mtimeNs !== info.mtimeNs || current.ctimeNs !== info.ctimeNs) {
      throw new Error('The migration installer changed during verification.');
    }
  } finally {
    await downloaded.close();
  }
}
