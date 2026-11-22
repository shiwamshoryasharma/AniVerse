import { execFileSync } from 'node:child_process';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function prepareMediaTransfer() {
  if (process.platform !== 'win32') return;
  const out = path.join(root, 'test/cache/media-transfer/target');
  const target = 'x86_64-pc-windows-msvc';
  execFileSync('cargo', ['build', '--locked', '--release', '--target', target,
    '--manifest-path', path.join(root, 'native/media-transfer/Cargo.toml')], {
    cwd: root, env: { ...process.env, CARGO_TARGET_DIR: out,
      CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS: '-C target-feature=+crt-static' }, stdio: 'inherit', windowsHide: true,
  });
  const resources = path.join(root, 'build/vendor/ffmpeg');
  await mkdir(resources, { recursive: true });
  await copyFile(path.join(out, target, 'release/aniverse-media-transfer.exe'),
    path.join(resources, 'aniverse-media-transfer.exe'));
}
