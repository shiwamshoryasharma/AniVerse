import { app, BrowserWindow, dialog, session, type WebContents } from 'electron';
import { createWriteStream } from 'node:fs';
import { link, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { RustPolicy } from '../app/core/security/rustPolicy';
import { SourceNetworkGuard } from './sourceNetwork';

const maxBytes = 8 * 1024 ** 3;
const headerBytes = 16 * 1024;

// The app transfers direct files. Guest sessions retain their unconditional download block.
export class SourceMp4Download {
  private busy = false;
  constructor(private policy: RustPolicy, private folder: () => string | null) {}

  async save(guest: WebContents, url: string): Promise<boolean> {
    if (this.busy) throw Error('An MP4 download is already in progress.');
    this.busy = true;
    let scratch: string | undefined;
    const controller = new AbortController();
    const stop = () => controller.abort();
    guest.once('destroyed', stop);
    try {
      const host = guest.hostWebContents;
      const parent = host && BrowserWindow.fromWebContents(host);
      if (!parent) return false;
      const filename = path.posix.basename(new URL(url).pathname).slice(0, 96).replace(/[^a-zA-Z0-9 ._-]/g, '_').replace(/\.mp4$/i, '');
      const options = {
        title: 'Save source MP4',
        defaultPath: path.join(this.folder() ?? app.getPath('downloads'), 'AniVerse - ' + filename + '.mp4'),
        filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
      };
      const { canceled, filePath } = await dialog.showSaveDialog(parent, options);
      if (canceled || !filePath || controller.signal.aborted) return false;
      if (path.extname(filePath).toLowerCase() !== '.mp4') throw Error('Choose a filename ending in .mp4.');

      const transport = session.fromPartition('aniverse-direct-mp4', { cache: false });
      const guard = new SourceNetworkGuard(this.policy, transport, () => '');
      if (!await guard.check({ url, resourceType: 'media' })) throw Error('The MP4 host is unavailable.');
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45 * 60_000)]);
      const response = await transport.fetch(url, { credentials: 'omit', redirect: 'error', signal });
      if (response.status !== 200 || !response.body ||
          response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'video/mp4') {
        throw Error('The source did not return a public MP4 file.');
      }
      const length = Number(response.headers.get('content-length'));
      if (length > maxBytes) throw Error('The MP4 exceeds the 8 GB download limit.');
      scratch = await mkdtemp(path.join(path.dirname(filePath), '.aniverse-download-'));
      const staging = path.join(scratch, 'video.part');
      const expected = response.headers.has('content-encoding') ? 0 : length;
      await pipeline(this.verifiedBytes(response.body, expected), createWriteStream(staging, { flags: 'wx' }), { signal });
      signal.throwIfAborted();
      await link(staging, filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') throw Error('That file already exists. Choose a new filename.');
        throw Error('Could not save the MP4. Choose a different destination.');
      });
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      if (error instanceof Error && !/^(?:net::|fetch failed|failed to fetch|abort)/i.test(error.message)) throw error;
      throw Error('The MP4 transfer failed.');
    } finally {
      controller.abort();
      guest.removeListener('destroyed', stop);
      try { if (scratch) await rm(scratch, { recursive: true, force: true }); }
      finally { this.busy = false; }
    }
  }

  private async *verifiedBytes(body: ReadableStream<Uint8Array>, expected: number) {
    const reader = body.getReader();
    const prefix = Buffer.alloc(headerBytes);
    let total = 0;
    let verified = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) throw Error('The MP4 exceeds the 8 GB download limit.');
        if (verified) { yield value; continue; }
        const offset = total - value.length;
        const used = Math.min(value.length, headerBytes - offset);
        prefix.set(value.subarray(0, used), offset);
        if (total < headerBytes) continue;
        if (!this.policy.isMp4Header(prefix)) throw Error('The response is not an MP4 file.');
        verified = true;
        yield prefix;
        if (used < value.length) yield value.subarray(used);
      }
      if (expected && total !== expected) throw Error('The source ended the transfer early.');
      if (!verified) {
        const header = prefix.subarray(0, total);
        if (!this.policy.isMp4Header(header)) throw Error('The response is not an MP4 file.');
        yield header;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
