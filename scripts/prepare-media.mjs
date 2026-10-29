// Prepare version-pinned tools for embedding. Never use a system FFmpeg at runtime.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(path.join(root, 'config/ffmpeg.json'), 'utf8'));
const sha256 = async (file) => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
export async function prepareMediaRuntime() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Embedded 4K casting currently targets Windows x64.');
  const output = path.join(root, 'build/vendor/ffmpeg');
  const manifest = path.join(output, 'manifest.json');
  if (existsSync(manifest)) {
    const data = JSON.parse(readFileSync(manifest, 'utf8'));
    if (data.version === config.version && data.archiveSha256 === config.sha256 &&
      await sha256(path.join(output, 'ffmpeg.exe')) === data.files['ffmpeg.exe'] &&
      await sha256(path.join(output, 'ffprobe.exe')) === data.files['ffprobe.exe']) return;
  }
  const cache = path.join(root, 'test/cache/vendor', 'ffmpeg-' + config.version);
  await mkdir(cache, { recursive: true }); await mkdir(output, { recursive: true });
  const archive = path.join(cache, 'ffmpeg.7z');
  if (!existsSync(archive) || await sha256(archive) !== config.sha256) {
    console.log('Downloading embedded FFmpeg ' + config.version + '…');
    const offset = await stat(archive).then((s) => s.size).catch(() => 0);
    const response = await fetch(config.archive, { headers: offset ? { Range: 'bytes=' + offset + '-' } : {}, signal: AbortSignal.timeout(900000) });
    if (!response.ok || !response.body) throw new Error('FFmpeg download failed: ' + response.status);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: response.status === 206 && offset ? 'a' : 'w' }));
    if (await sha256(archive) !== config.sha256) throw new Error('FFmpeg checksum mismatch; refusing to embed this archive.');
  }
  await new Promise((resolve, reject) => {
    const child = spawn('tar.exe', ['-xf', archive, '-C', cache], { windowsHide: true, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('FFmpeg extraction failed.')));
  });
  const directory = (await readdir(cache, { withFileTypes: true })).find((entry) => entry.isDirectory() && entry.name.includes(config.version));
  if (!directory) throw new Error('Unexpected FFmpeg archive layout.');
  const extracted = path.join(cache, directory.name);
  for (const file of ['ffmpeg.exe', 'ffprobe.exe']) await copyFile(path.join(extracted, 'bin', file), path.join(output, file));
  for (const file of ['LICENSE', 'README.txt']) if (existsSync(path.join(extracted, file))) await copyFile(path.join(extracted, file), path.join(output, file));
  await writeFile(manifest, JSON.stringify({ ...config, archiveSha256: config.sha256, files: {
    'ffmpeg.exe': await sha256(path.join(output, 'ffmpeg.exe')), 'ffprobe.exe': await sha256(path.join(output, 'ffprobe.exe')),
  } }, null, 2) + '\n');
  console.log('Embedded FFmpeg ' + config.version + ' verified.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareMediaRuntime();
