import { app, BrowserWindow, dialog, session, type WebContents } from 'electron';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { link, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { RustPolicy } from '../app/core/security/rustPolicy';
import { SourceNetworkGuard } from './sourceNetwork';
import { readOwnedPlayer } from './ownedPlayerFrame';

declare const __ANIVERSE_DOWNLOAD_SCRIPT__: string;
type MediaCandidate = { media: string; url: string; observed?: string };
type Mp4Progress = { received: number; total: number | null };

const maxBytes = 8 * 1024 ** 3;
const headerBytes = 16 * 1024;

// The app transfers direct files. Guest sessions retain their unconditional download block.
export class SourceMp4Download {
  private busy = false;
  constructor(private policy: RustPolicy, private folder: () => string | null,
    private progress: (event: Mp4Progress) => void = () => {}) {}

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


  saveDirect(owner: WebContents, url: string, source?: string): Promise<boolean> {
    const target = this.publicUrl(url, /\.mp4$/i);
    if (!target || (source && !this.policy.decide({ context: 'mp4', url: target.href, source }).allowed)) {
      throw Error('Choose a public HTTPS MP4 file.');
    }
    return this.saveMedia(owner, { media: target.href, url: target.href }, () => !owner.isDestroyed());
  }

  async saveActive(guest: WebContents, current: () => boolean): Promise<boolean> {
    if (!current()) return false;
    const selected = await this.inspect(guest);
    if (!selected || !current()) throw Error('Play a clear MP4 or supported HLS episode before saving.');
    return this.saveMedia(guest, selected, async () => {
      if (!current()) return false;
      const refreshed = await this.inspect(guest);
      return !!refreshed && refreshed.media === selected.media && refreshed.url === selected.url && current();
    });
  }

  private async inspect(guest: WebContents): Promise<MediaCandidate | null> {
    const observed = await readOwnedPlayer(guest, __ANIVERSE_DOWNLOAD_SCRIPT__);
    if (!observed || typeof observed !== 'object') return null;
    const raw = observed as Record<string, unknown>;
    if (typeof raw.media !== 'string' || raw.media.length > 4096) return null;
    const url = this.publicUrl(raw.url, /\.(?:mp4|m3u8)$/i);
    if (!url) return null;
    if (!raw.media.startsWith('blob:')) {
      return this.publicUrl(raw.media, /\.(?:mp4|m3u8)$/i)?.href === url.href
        ? { media: raw.media, url: url.href } : null;
    }
    const segment = this.publicUrl(raw.observed, /\.(?:ts|m4s|cmfv)$/i);
    return segment && /\.m3u8$/i.test(url.pathname) && segment.origin === url.origin
      ? { media: raw.media, url: url.href, observed: segment.href } : null;
  }

  private publicUrl(value: unknown, extension: RegExp): URL | null {
    if (typeof value !== 'string' || value.length > 4096) return null;
    try {
      const url = new URL(value);
      const fixture = process.env.ANIVERSE_TEST_PROFILE === '1'
        && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
        && url.origin === process.env.ANIVERSE_TEST_MEDIA_ORIGIN;
      if (!extension.test(url.pathname) || url.search || url.hash || url.username || url.password) return null;
      if (fixture || (url.protocol === 'https:' && !url.port
        && this.policy.decide({ context: 'handoff', url: url.href, source: url.href }).allowed)) {
        return url;
      }
    } catch { /* Invalid source URL. */ }
    return null;
  }

  private async saveMedia(
    owner: WebContents,
    selected: MediaCandidate,
    validate: () => boolean | Promise<boolean>,
  ): Promise<boolean> {
    if (process.platform !== 'win32') throw Error('MP4 saving is available on Windows.');
    if (this.busy) throw Error('An MP4 download is already in progress.');
    const parent = BrowserWindow.fromWebContents(owner.hostWebContents ?? owner);
    if (!parent) return false;
    this.busy = true;
    try {
      const basename = path.posix.basename(new URL(selected.url).pathname).slice(0, 96)
        .replace(/[^a-zA-Z0-9 ._-]/g, '_').replace(/\.(?:mp4|m3u8)$/i, '') || 'episode';
      const { canceled, filePath } = await dialog.showSaveDialog(parent, {
        title: 'Save MP4 as',
        defaultPath: path.join(this.folder() ?? app.getPath('downloads'), 'AniVerse - ' + basename + '.mp4'),
        filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
      });
      if (canceled || !filePath || owner.isDestroyed()) return false;
      if (path.extname(filePath).toLowerCase() !== '.mp4') throw Error('Choose a filename ending in .mp4.');
      if (!await validate()) throw Error('The active video changed before the download started.');
      return await this.transfer(owner, { url: selected.url, observed: selected.observed, destination: filePath });
    } finally {
      this.busy = false;
    }
  }

  private async transfer(owner: WebContents, request: { url: string; observed?: string; destination: string }) {
    const resources = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'build/vendor');
    const worker = spawn(path.join(resources, 'ffmpeg/aniverse-media-transfer.exe'), [], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    const result = new Promise<number | null>(resolve => {
      worker.once('error', () => resolve(null));
      worker.once('close', code => resolve(code));
    });
    const stop = () => worker.stdin.end();
    owner.once('destroyed', stop);
    worker.stdin.on('error', () => { /* Worker startup and transfer failure are reported below. */ });
    const lines = createInterface({ input: worker.stdout });
    let completed = false;
    let message = 'The bundled MP4 download helper could not complete the transfer.';
    try {
      worker.stdin.write(JSON.stringify(request) + '\n');
      for await (const line of lines) {
        if (line.length > 4096) continue;
        let event: { done?: boolean; error?: string; received?: number; total?: number | null };
        try { event = JSON.parse(line); } catch { continue; }
        if (!event || typeof event !== 'object') continue;
        if (event.done === true) completed = true;
        if (typeof event.error === 'string') message = event.error;
        if (Number.isSafeInteger(event.received) && event.received! >= 0
          && (event.total === null || (Number.isSafeInteger(event.total) && event.total! >= event.received!))) {
          this.progress({ received: event.received!, total: event.total! });
        }
      }
      const code = await result;
      if (owner.isDestroyed()) return false;
      if (code !== 0 || !completed) throw Error(message);
      return true;
    } finally {
      owner.removeListener('destroyed', stop);
      lines.close();
      stop();
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
