// Publishes the signed release in release/ as a GitHub release, the feed AniVerse updates from.
//   npm run dist:signed
//   npm run release -- --notes path/to/notes.md
// Checks first: clean working tree on main and pushed, no existing tag, the installer signed
// with AniVerse's certificate, and latest.yml / .blockmap built for this version. Then tags
// v<version>, pushes the tag and uploads installer, blockmap, latest.yml and a SHA-256 file
// (GitHub CLI `gh`, signed in with push access).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { root, signingInfo } from './releaseConfig.mjs';

const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();

const notesArg = process.argv.indexOf('--notes');
const notes = notesArg > 0 ? path.resolve(process.argv[notesArg + 1] ?? '') : '';
if (!notes || !existsSync(notes)) fail('pass the release notes: npm run release -- --notes <file.md>');

const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = `v${version}`;
const installer = path.join(root, 'release', `AniVerse-Setup-${version}.exe`);
const blockmap = `${installer}.blockmap`;
const latest = path.join(root, 'release', 'latest.yml');
const checksum = `${installer}.sha256`;

if (run('git', ['status', '--porcelain'])) fail('commit or stash your changes first.');
if (run('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail('release from the main branch.');
run('git', ['fetch', 'origin', 'main', '--tags']);
if (run('git', ['rev-parse', 'HEAD']) !== run('git', ['rev-parse', 'origin/main'])) fail('push main first (HEAD differs from origin/main).');
if (run('git', ['tag', '-l', tag])) fail(`tag ${tag} already exists.`);

for (const f of [installer, blockmap, latest]) if (!existsSync(f)) fail(`missing ${path.relative(root, f)} — run npm run dist:signed.`);
const feed = readFileSync(latest, 'utf8');
if (!new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm').test(feed)) fail(`release/latest.yml is not for ${version} — run npm run dist:signed.`);

const { sha1 } = signingInfo();
const sig = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', `$s = Get-AuthenticodeSignature -LiteralPath '${installer.replace(/'/g, "''")}'; "$([int]$s.Status) $($s.SignerCertificate.Thumbprint)"`],
  { encoding: 'utf8' },
);
const [status, thumbprint] = sig.stdout.trim().split(' ');
if (!['0', '1'].includes(status) || thumbprint !== sha1) fail(`${path.basename(installer)} is not signed with certificate ${sha1} (status ${status}, signer ${thumbprint || 'none'}).`);

const hash = createHash('sha256').update(readFileSync(installer)).digest('hex');
writeFileSync(checksum, `${hash}  ${path.basename(installer)}\n`, 'ascii');
console.log(`AniVerse ${version}: signed by ${sha1}, SHA-256 ${hash}`);

run('git', ['tag', '-a', tag, '-m', `AniVerse ${version}`]);
run('git', ['push', 'origin', tag]);
const gh = spawnSync('gh', ['release', 'create', tag, '--verify-tag', '--latest', '--title', `AniVerse ${version}`, '--notes-file', notes, installer, blockmap, latest, checksum], {
  cwd: root,
  stdio: 'inherit',
});
if (gh.status !== 0) fail('gh release create failed (the tag was pushed; fix the problem and run `gh release create` by hand).');
console.log(`Published ${tag}. Installed copies will offer the update on their next check.`);
