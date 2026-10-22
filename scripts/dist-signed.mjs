// Release build: the Windows installer, signed with AniVerse's code-signing certificate and
// shipped without any streaming-site list (public builds start with an empty source list;
// only filters.txt is bundled). Run through `npm run dist:signed`, which bundles first.
//
// The certificate is taken from the Windows certificate store (CurrentUser\My) by the SHA-1
// thumbprint in config/signing.json, or ANIVERSE_SIGN_SHA1. Its private key never leaves the
// store. The fingerprints are published in README.md so users can check a download.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import builder from 'electron-builder';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'config', 'signing.json');
const sha1 = String(process.env.ANIVERSE_SIGN_SHA1 ?? (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).certificateSha1 : '') ?? '')
  .replace(/[\s:]/g, '')
  .toUpperCase();
if (!/^[0-9A-F]{40}$/.test(sha1)) throw new Error('Set the signing certificate thumbprint in config/signing.json or ANIVERSE_SIGN_SHA1.');

const found = spawnSync('powershell.exe', ['-NoProfile', '-Command', `if (Test-Path Cert:\\CurrentUser\\My\\${sha1}) { 'yes' }`], { encoding: 'utf8' });
if (found.stdout.trim() !== 'yes') {
  throw new Error(`Code-signing certificate ${sha1} is not in this user's certificate store (CurrentUser\\My). Import its .pfx backup first.`);
}

// electron-builder merges lists from extra config into electron-builder.yml instead of replacing
// them, so write a complete release copy of the config rather than passing overrides.
const yaml = createRequire(createRequire(import.meta.url).resolve('app-builder-lib'))('js-yaml');
const config = yaml.load(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
config.extraResources = [{ from: 'config', to: 'config', filter: ['filters.txt'] }];
config.win = { ...config.win, signtoolOptions: { certificateSha1: sha1, signingHashAlgorithms: ['sha256'] } };
const releaseConfig = path.join(mkdtempSync(path.join(tmpdir(), 'aniverse-release-')), 'electron-builder.release.yml');
writeFileSync(releaseConfig, yaml.dump(config));

await builder.build({
  projectDir: root,
  targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64),
  config: releaseConfig,
});
console.log(`Signed installer in release/ (certificate ${sha1}).`);
