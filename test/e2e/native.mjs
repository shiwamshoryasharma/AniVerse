// Runs a test driver (test/e2e/drivers/*.cjs) inside the built AniVerse app,
// hidden, with a throwaway profile and WITHOUT remote debugging, so websites
// see a normal browser (navigator.webdriver = false). Run `npm run build` first.
//
//   node test/e2e/native.mjs <driver.cjs> [--keep-profile]
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function runDriver(driver, { env = {}, keepProfile = false, profile = 'native-profile' } = {}) {
  const dataDir = path.join(root, 'test', 'cache', profile);
  if (!keepProfile) rmSync(dataDir, { recursive: true, force: true });
  return new Promise((resolve) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [root], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, ...env, ANIVERSE_HEADLESS: '1', ANIVERSE_DATA_DIR: dataDir, ANIVERSE_TEST_DRIVER: path.resolve(root, driver) },
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [driver, ...rest] = process.argv.slice(2);
  if (!driver) {
    console.error('usage: node test/e2e/native.mjs <driver.cjs> [--keep-profile]');
    process.exit(2);
  }
  process.exit(await runDriver(driver, { keepProfile: rest.includes('--keep-profile') }));
}
