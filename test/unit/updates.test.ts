import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, sanitize } from '../../app/core/settings';
import type { Settings } from '../../app/shared/types';
import { certificateFingerprint, checkUpdateSignature } from '../../electron/updateSignature';

const ours = randomBytes(900).toString('base64');
const theirs = randomBytes(900).toString('base64');
const pin = createHash('sha256').update(Buffer.from(ours, 'base64')).digest('hex').toUpperCase();
const file = 'C:\\Users\\me\\AppData\\Local\\aniverse-updater\\pending\\AniVerse-Setup-0.2.1.exe';

describe('update signature check', () => {
  it('fingerprints the certificate like Windows does (SHA-256 of its DER bytes)', () => {
    expect(certificateFingerprint(ours)).toBe(pin);
  });

  it('accepts the pinned certificate, trusted (Valid) or self-signed (UnknownError)', () => {
    expect(checkUpdateSignature({ status: 1, path: file, certificate: ours }, file, [pin])).toBeNull();
    expect(checkUpdateSignature({ status: 0, path: file, certificate: ours }, file, [pin])).toBeNull();
    // fingerprints as printed in the README (colons, any case) work too
    expect(checkUpdateSignature({ status: 1, path: file, certificate: ours }, file, [pin.toLowerCase().match(/../g)!.join(':')])).toBeNull();
  });

  it('rejects a tampered file even when it carries the right certificate', () => {
    expect(checkUpdateSignature({ status: 3, path: file, certificate: ours }, file, [pin])).toMatch(/not intact \(HashMismatch\)/);
  });

  it('rejects other signers, even with a Windows-trusted certificate', () => {
    expect(checkUpdateSignature({ status: 0, path: file, certificate: theirs }, file, [pin])).toMatch(/unknown certificate/);
  });

  it('rejects unsigned files and results for another path', () => {
    expect(checkUpdateSignature({ status: 2, path: file, certificate: null }, file, [pin])).toMatch(/isn't signed \(NotSigned\)/);
    expect(checkUpdateSignature({ status: 1, path: 'C:\\other.exe', certificate: ours }, file, [pin])).toMatch(/different file/);
  });
});

describe('update settings', () => {
  it('defaults to automatic checks and downloads, also for settings saved before updates existed', () => {
    const old = { ...DEFAULT_SETTINGS } as Partial<Settings>;
    delete old.updates;
    expect(sanitize(old as Settings).updates).toEqual({ autoCheck: true, autoDownload: true });
    expect(sanitize({ ...DEFAULT_SETTINGS, updates: { autoCheck: false, autoDownload: false } }).updates).toEqual({ autoCheck: false, autoDownload: false });
  });
});
