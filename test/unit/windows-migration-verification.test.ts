import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/windows-migration-signatures.json';
import { verifyMigrationInstaller, verifyMigrationManifest } from '../../electron/migrationVerification';
import { certificateFingerprint, readSignature } from '../../electron/updateSignature';

vi.mock('../../electron/updateSignature', async (load) => ({
  ...await load<typeof import('../../electron/updateSignature')>(),
  readSignature: vi.fn(),
}));

const signer = Buffer.from(fixture.certificate, 'base64');
const pins = [certificateFingerprint(fixture.certificate)];
const current = '9.2.4';
const contents = Buffer.from('inert Windows installer fixture');
const verifyFixture = (key: keyof typeof fixture.manifests, source = current) => {
  const entry = fixture.manifests[key];
  return verifyMigrationManifest(Buffer.from(entry.bytes, 'base64'), Buffer.from(entry.signature, 'base64'), signer, source, pins);
};

describe('signed migration offer', () => {
  it('verifies the exact signed bytes and derives the fixed Windows installer name', () => {
    expect(verifyFixture('valid')).toMatchObject({
      version: '9.3.0', installerName: 'AniVerse-Tauri-Setup-9.3.0-x64.exe',
      installerSha256: createHash('sha256').update(contents).digest('hex'),
    });
  });

  it('rejects modification and a trusted-looking offer from an unpinned publisher', () => {
    const { bytes, signature } = fixture.manifests.valid;
    const tampered = Buffer.concat([Buffer.from(bytes, 'base64'), Buffer.from(' ')]);
    expect(() => verifyMigrationManifest(tampered, Buffer.from(signature, 'base64'), signer, current, pins)).toThrow(/signature is invalid/);
    expect(() => verifyMigrationManifest(Buffer.from(bytes, 'base64'), Buffer.from(signature, 'base64'), signer, current)).toThrow(/unknown certificate/);
  });

  it('rejects incompatible signed roles, platforms and versions', () => {
    expect(() => verifyFixture('wrongRole')).toThrow();
    expect(() => verifyFixture('wrongTarget')).toThrow();
    expect(() => verifyFixture('unknownField')).toThrow();
    expect(() => verifyFixture('valid', '9.2.3')).toThrow(/does not apply/);
    expect(() => verifyFixture('valid', '9.3.0')).toThrow(/does not apply/);
    expect(() => verifyFixture('valid', '9.4.0')).toThrow(/does not apply/);
  });
});

describe('staged migration installer', () => {
  const signature = vi.mocked(readSignature);
  const cache = path.resolve('test/cache/tauri-compat');
  let folder: string | null = null;

  afterEach(async () => {
    signature.mockReset();
    if (folder) await rm(folder, { recursive: true, force: true });
    folder = null;
  });

  async function stage(bytes: Buffer) {
    const offer = verifyFixture('valid');
    await mkdir(cache, { recursive: true });
    folder = await mkdtemp(path.join(cache, 'verify-package-'));
    const file = path.join(folder, offer.installerName);
    await writeFile(file, bytes);
    return { file, offer };
  }

  it('checks Authenticode after verifying the exact signed installer digest', async () => {
    const { file, offer } = await stage(contents);
    signature.mockResolvedValue({ status: 0, path: file, certificate: fixture.certificate });
    await expect(verifyMigrationInstaller(file, offer, pins)).resolves.toBeUndefined();
    expect(signature).toHaveBeenCalledWith(file);
  });

  it('rejects equal-size tampering before asking Windows to inspect a file', async () => {
    const tampered = Buffer.from(contents);
    tampered[0] ^= 1;
    const { file, offer } = await stage(tampered);
    await expect(verifyMigrationInstaller(file, offer, pins)).rejects.toThrow(/does not match/);
    expect(signature).not.toHaveBeenCalled();
  });

  it('rejects a file that changes while Windows inspects it', async () => {
    const { file, offer } = await stage(contents);
    signature.mockImplementationOnce(async () => {
      await writeFile(file, Buffer.concat([contents, Buffer.from(' changed')]));
      return { status: 0, path: file, certificate: fixture.certificate };
    });
    await expect(verifyMigrationInstaller(file, offer, pins)).rejects.toThrow(/changed during verification/);
  });

  it('rejects a digest match when Windows reports a signature error or a different path', async () => {
    const { file, offer } = await stage(contents);
    signature.mockResolvedValue({ status: 3, path: file, certificate: fixture.certificate });
    await expect(verifyMigrationInstaller(file, offer, pins)).rejects.toThrow(/HashMismatch/);
    signature.mockResolvedValue({ status: 0, path: file + '.other', certificate: fixture.certificate });
    await expect(verifyMigrationInstaller(file, offer, pins)).rejects.toThrow(/different file/);
  });
});
