import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadMigrationInstaller, findMigrationOffer } from '../../electron/migrationRelease';
import { certificateFingerprint, readSignature } from '../../electron/updateSignature';
import fixture from '../fixtures/windows-migration-signatures.json';

vi.mock('../../electron/updateSignature', async (load) => ({
  ...await load<typeof import('../../electron/updateSignature')>(),
  readSignature: vi.fn(),
}));

const pinned = [certificateFingerprint(fixture.certificate)];
const installer = 'AniVerse-Tauri-Setup-9.3.0-x64.exe';
const offerAsset = 'aniverse2-windows-migration.json';
const reply = { manifest: fixture.manifests.valid.bytes, signature: fixture.manifests.valid.signature, certificate: fixture.certificate };
const release = (tag_name: string, prerelease = false) =>
  ({ tag_name, draft: false, prerelease, assets: [{ name: offerAsset }, { name: installer }] });
const from = (response: (url: URL) => Response) =>
  vi.fn(async (request: URL | string | Request) => response(new URL(String(request))));
const lookup = (send: typeof fetch) => findMigrationOffer('9.2.4', send, pinned);

describe('AniVerse2 Windows release channel', () => {
  it('ignores legacy, Android, prerelease and incomplete entries', async () => {
    const send = from(() => Response.json([release('v9.3.0'), release('android-v9.3.0'), release('aniverse2-v9.3.0', true),
      { ...release('aniverse2-v9.3.0'), assets: [{ name: installer }] }]));
    await expect(lookup(send)).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('verifies the signed offer and constructs a GitHub-only installer URL', async () => {
    const send = from((url) => url.hostname === 'api.github.com'
      ? Response.json([release('aniverse2-v9.3.0')])
      : Response.json(reply));
    expect((await lookup(send))?.url).toBe('https://github.com/shiwamshoryasharma/AniVerse/releases/download/aniverse2-v9.3.0/' + installer);
  });

  it('rejects redirects outside the approved HTTPS origins', async () => {
    const send = from((url) => url.hostname === 'api.github.com'
      ? Response.json([release('aniverse2-v9.3.0')])
      : Response.redirect('https://untrusted.test/migration.json'));
    await expect(lookup(send)).rejects.toThrow(/outside GitHub/);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects a valid signed manifest that claims a different version from the tag', async () => {
    const match = release('aniverse2-v9.3.1');
    match.assets[1].name = 'AniVerse-Tauri-Setup-9.3.1-x64.exe';
    const send = from((url) => url.hostname === 'api.github.com' ? Response.json([match]) : Response.json(reply));
    await expect(lookup(send)).rejects.toThrow(/does not match its release tag/);
  });
});

describe('AniVerse2 Windows download', () => {
  let folder: string | undefined;
  afterEach(async () => {
    vi.mocked(readSignature).mockReset();
    if (folder) await rm(folder, { recursive: true, force: true });
    folder = undefined;
  });

  async function prepare() {
    const send = from((url) => url.hostname === 'api.github.com' ? Response.json([release('aniverse2-v9.3.0')]) : Response.json(reply));
    const candidate = await lookup(send);
    if (!candidate) throw new Error('Fixture offer unavailable');
    const cache = path.resolve('test/cache/tauri-compat');
    await mkdir(cache, { recursive: true });
    folder = await mkdtemp(path.join(cache, 'download-package-'));
    return { candidate, folder };
  }

  it('streams a GitHub release asset into a private directory and validates its exact bytes', async () => {
    const { candidate, folder } = await prepare();
    vi.mocked(readSignature).mockImplementation(async (file) => ({ status: 0, path: file, certificate: fixture.certificate }));
    const send = from((url) => url.hostname === 'github.com'
      ? Response.redirect('https://release-assets.githubusercontent.com/fixture/installer')
      : new Response('inert Windows installer fixture'));
    const result = await downloadMigrationInstaller(candidate, folder, send, pinned);
    expect(await readFile(result.file, 'utf8')).toBe('inert Windows installer fixture');
  });

  it('cleans up oversized and changed downloads without running Windows signature inspection', async () => {
    const { candidate, folder } = await prepare();
    await expect(downloadMigrationInstaller(candidate, folder, from(() => new Response('inert Windows installer fixture extra')), pinned)).rejects.toThrow(/exceeds its expected size/);
    await expect(downloadMigrationInstaller(candidate, folder, from(() => new Response('INERT Windows installer fixture')), pinned)).rejects.toThrow(/does not match/);
    expect(await readdir(folder)).toEqual([]);
    expect(readSignature).not.toHaveBeenCalled();
  });
});
