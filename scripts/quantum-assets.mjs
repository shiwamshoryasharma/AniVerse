import { execFileSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(root, 'test/cache/quantum-audio');
const assets = new Map([
  ['quantum-audio.wasm', path.join(target, 'wasm32-unknown-unknown/release/aniverse_quantum_audio.wasm')],
  ['quantum-worklet.js', path.join(root, 'frontend/src/player/quantumWorklet.js')],
]);

export function prepareQuantumAudio() {
  execFileSync('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown',
    '--manifest-path', path.join(root, 'native/quantum-audio/Cargo.toml')], {
    cwd: root, env: { ...process.env, CARGO_TARGET_DIR: target }, stdio: 'inherit', windowsHide: true,
  });
}

export async function copyQuantumAudio(destination) {
  await mkdir(destination, { recursive: true });
  await Promise.all([...assets].map(([name, source]) => copyFile(source, path.join(destination, name))));
}
