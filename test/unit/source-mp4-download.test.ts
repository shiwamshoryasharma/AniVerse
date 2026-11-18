import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RustPolicy } from '../../app/core/security/rustPolicy';
import { SourceMp4Download } from '../../electron/sourceMp4Download';

const mocks = vi.hoisted(() => ({ showSaveDialog: vi.fn(), fetch: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => 'windows-downloads' },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showSaveDialog: mocks.showSaveDialog },
  session: { fromPartition: () => ({ fetch: mocks.fetch, protocol: { isProtocolHandled: async () => true } }) },
}));
const policy = new RustPolicy(readFileSync('dist/electron/security.wasm'));
const mp4 = Buffer.from('000000146674797069736f6d000000006d703432', 'hex');
const url = 'https://media.test/clip.mp4';
let folder: string;
let output: string;
beforeEach(() => {
  folder = mkdtempSync(path.join('test/cache/', 'windows-mp4-'));
  output = path.join(folder, 'saved.mp4');
  mocks.showSaveDialog.mockReset().mockResolvedValue({ canceled: false, filePath: output });
  mocks.fetch.mockReset();
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

function save(bytes: Buffer, length = bytes.length) {
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(bytes.subarray(0, 5)));
    controller.enqueue(new Uint8Array(bytes.subarray(5)));
    controller.close();
  } });
  mocks.fetch.mockResolvedValueOnce(new Response(body, { headers: { 'content-type': 'video/mp4', 'content-length': String(length) } }));
  const guest = Object.assign(new EventEmitter(), { hostWebContents: {} });
  return new SourceMp4Download(policy, () => folder).save(guest as never, url);
}
it('starts the save dialog in the configured folder and publishes the exact bytes', async () => {
  await expect(save(mp4)).resolves.toBe(true);
  expect(mocks.showSaveDialog).toHaveBeenCalledWith(expect.anything(),
    expect.objectContaining({ defaultPath: path.join(folder, 'AniVerse - clip.mp4') }));
  expect(readFileSync(output)).toEqual(mp4);
  expect(mocks.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
});
it('rejects mislabeled and truncated responses without leaving a final file', async () => {
  await expect(save(Buffer.from('<html>not an MP4</html>'))).rejects.toThrow('not an MP4');
  await expect(save(mp4, mp4.length + 100)).rejects.toThrow('ended the transfer early');
  expect(existsSync(output)).toBe(false);
});
it('preserves an existing destination even when the save dialog returns its name', async () => {
  writeFileSync(output, 'existing');
  await expect(save(mp4)).rejects.toThrow('already exists');
  expect(readFileSync(output, 'utf8')).toBe('existing');
});
