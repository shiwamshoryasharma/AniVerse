import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** What `Get-AuthenticodeSignature` reports for a file (see readSignature). */
export interface SignatureInfo {
  /** System.Management.Automation.SignatureStatus: 0 Valid, 1 UnknownError, 2 NotSigned, 3 HashMismatch, 4 NotTrusted, … */
  status: number;
  path: string | null;
  /** DER bytes of the signer certificate, base64; null when the file isn't signed. */
  certificate: string | null;
}

const STATUS = ['Valid', 'UnknownError', 'NotSigned', 'HashMismatch', 'NotTrusted', 'NotSupportedFileFormat', 'Incompatible'];

export const certificateFingerprint = (derBase64: string) => createHash('sha256').update(Buffer.from(derBase64, 'base64')).digest('hex').toUpperCase();

/**
 * Decides whether a downloaded update may be installed: it must carry an intact Authenticode
 * signature from one of the pinned certificates (SHA-256 fingerprints).
 *
 * AniVerse's own certificate is self-signed, so Windows can't chain it to a trusted root and
 * reports UnknownError instead of Valid. That alone proves nothing, so the signer is pinned
 * instead. Tampering is still caught by Windows first: a modified file reports HashMismatch
 * even when it carries the right certificate.
 *
 * Returns null when the update is acceptable, otherwise the reason it was rejected.
 */
export function checkUpdateSignature(info: SignatureInfo, file: string, pinned: readonly string[]): string | null {
  const status = STATUS[info.status] ?? `status ${info.status}`;
  if (!info.certificate) return `The update isn't signed (${status}).`;
  if (info.status !== 0 && info.status !== 1) return `The update's signature is not intact (${status}).`;
  if (info.path && path.normalize(info.path).toLowerCase() !== path.normalize(file).toLowerCase()) {
    return 'The signature check looked at a different file.';
  }
  const fingerprint = certificateFingerprint(info.certificate);
  const pins = pinned.map((p) => p.replace(/[\s:]/g, '').toUpperCase());
  if (!pins.includes(fingerprint)) return `The update is signed by an unknown certificate (SHA-256 ${fingerprint}).`;
  return null;
}

/** Runs `Get-AuthenticodeSignature` on a file (Windows PowerShell, no profile, no user input). */
export function readSignature(file: string): Promise<SignatureInfo> {
  // The path came from the updater's own download folder; quote it for PowerShell anyway
  // (single quotes are literal, doubled to escape) so it can never run as a command.
  const literal = file.replace(/'/g, "''");
  const command =
    `$s = Get-AuthenticodeSignature -LiteralPath '${literal}'; ` +
    `[pscustomobject]@{ status = [int]$s.Status; path = $s.Path; certificate = $(if ($s.SignerCertificate) { [Convert]::ToBase64String($s.SignerCertificate.RawData) } else { $null }) } | ConvertTo-Json -Compress`;
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeout: 30_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`Signature check failed: ${stderr.trim() || err.message}`));
        try {
          const data = JSON.parse(stdout.trim()) as Partial<SignatureInfo>;
          resolve({ status: Number(data.status), path: data.path ?? null, certificate: data.certificate ?? null });
        } catch {
          reject(new Error('Signature check returned no result.'));
        }
      },
    );
  });
}
