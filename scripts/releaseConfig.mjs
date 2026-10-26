// The electron-builder configuration for signed release builds, shared by
// scripts/dist-signed.mjs and the update end-to-end test (test/e2e/updater.mjs).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const windowsSecurityModule = "Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; ";

/** config/signing.json (thumbprint, publisher, pinned update signers), with ANIVERSE_SIGN_SHA1 overriding the thumbprint. */
export function signingInfo() {
  const file = path.join(root, 'config', 'signing.json');
  const json = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const sha1 = String(process.env.ANIVERSE_SIGN_SHA1 ?? json.certificateSha1 ?? '')
    .replace(/[\s:]/g, '')
    .toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(sha1)) throw new Error('Set the signing certificate thumbprint in config/signing.json or ANIVERSE_SIGN_SHA1.');
  const certificatePath = ['Cert:', 'CurrentUser', 'My', sha1].join(path.win32.sep);
  const found = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsSecurityModule + `if (Test-Path -LiteralPath '${certificatePath}') { 'yes' }`], { encoding: 'utf8', windowsHide: true });
  if (found.error || found.status !== 0) throw new Error('Could not query the signing certificate: ' + (found.stderr?.trim() || found.error?.message || 'PowerShell failed.'));
  if (found.stdout.trim() !== 'yes') {
    throw new Error(`Code-signing certificate ${sha1} is not in this user's certificate store (CurrentUser\\My). Import its .pfx backup first.`);
  }
  return { sha1, publisherName: String(json.publisherName ?? '') };
}

/**
 * Writes a complete release copy of electron-builder.yml and returns its path.
 * (electron-builder merges lists from extra config into the file instead of replacing
 * them, so overrides can't be passed directly.)
 *  - signed with the certificate from the Windows store; the publisher name goes into
 *    app-update.yml, which makes electron-updater check every update's signature;
 *  - ships only filters.txt (no streaming-site list);
 *  - `overrides` replace top-level keys (the update test sets version, output and feed).
 */
export function writeReleaseConfig(overrides = {}) {
  const { sha1, publisherName } = signingInfo();
  const yaml = createRequire(createRequire(import.meta.url).resolve('app-builder-lib'))('js-yaml');
  const config = yaml.load(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
  config.extraResources = [{ from: 'config', to: 'config', filter: ['filters.txt'] }];
  config.win = {
    ...config.win,
    signtoolOptions: { certificateSha1: sha1, signingHashAlgorithms: ['sha256'], ...(publisherName ? { publisherName: [publisherName] } : {}) },
  };
  Object.assign(config, overrides);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'aniverse-release-')), 'electron-builder.release.yml');
  writeFileSync(file, yaml.dump(config));
  return { file, sha1 };
}
