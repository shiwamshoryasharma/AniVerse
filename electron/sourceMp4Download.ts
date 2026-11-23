import { app, BrowserWindow, dialog, session, type WebContents, type WebFrameMain } from 'electron';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { link, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { episodeDownloadFilename, type EpisodeDownloadContext } from '../app/shared/download-filename';
import { downloadableVideoPath } from '../app/shared/downloadFormats';
import type { RustPolicy } from '../app/core/security/rustPolicy';
import { SourceNetworkGuard } from './sourceNetwork';
import { readOwnedPlayer } from './ownedPlayerFrame';
import { SourceMediaCapture, type SourceMediaKind, type MediaHeaders } from './sourceMediaCapture';

declare const __ANIVERSE_DOWNLOAD_SCRIPT__: string;
type SubtitleChoice = { url?: string; language?: string; label?: string };
type MediaCandidate = {
  identity?: string; media: string; url: string; owned?: boolean; kind?: SourceMediaKind;
  playlists?: string[]; observations?: string[]; subtitle?: SubtitleChoice; expectedDuration?: number;
  headersByUrl?: MediaHeaders[]; maxHeight?: number;
};
type Mp4Progress = { received: number; total: number | null };

const maxBytes = 8 * 1024 ** 3;
const headerBytes = 16 * 1024;

// The app transfers direct files. Guest sessions retain their unconditional download block.
export class SourceMp4Download {
  readonly capture = new SourceMediaCapture();
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


  saveDirect(owner: WebContents, url: string, source?: string, filenameContext?: EpisodeDownloadContext): Promise<boolean> {
    const target = this.publicUrl(url, downloadableVideoPath);
    const scoped = !source || (target && (new URL(source).origin === target.origin ||
      this.policy.decide({ context: 'mp4', url: target.href, source }).allowed));
    if (!target || !scoped) {
      throw Error('Choose a supported public HTTPS video to save as MP4.');
    }
    return this.saveMedia(owner, { media: target.href, url: target.href }, () => !owner.isDestroyed(), undefined, filenameContext);
  }

  async saveActive(guest: WebContents, current: () => boolean, filenameContext?: EpisodeDownloadContext,
    maxHeight?: number): Promise<boolean> {
    if (!current()) return false;
    const selected = await this.inspect(guest);
    if (!selected || !current()) throw Error('Play a supported video before saving. Some sources restrict downloads.');
    return this.saveMedia(guest, { ...selected, maxHeight }, async () => {
      if (!current()) return false;
      const refreshed = await this.inspect(guest);
      return !!refreshed && refreshed.identity === selected.identity && refreshed.media === selected.media &&
        (selected.expectedDuration === undefined ? refreshed.expectedDuration === undefined :
          typeof refreshed.expectedDuration === 'number' && Math.abs(refreshed.expectedDuration - selected.expectedDuration) <= 0.5) && current();
    }, current, filenameContext);
  }

  private async inspect(guest: WebContents): Promise<MediaCandidate | null> {
    let frame: WebFrameMain | undefined;
    let cookies: import('./sourceRequestCookies').CookieLookup | undefined;
    const observed = await readOwnedPlayer(guest, __ANIVERSE_DOWNLOAD_SCRIPT__, (selected, lookup) => { frame = selected; cookies = lookup; });
    if (!observed || typeof observed !== 'object') return null;
    const raw = observed as Record<string, unknown>;
    if (typeof raw.identity !== 'string' || !/^[a-zA-Z0-9:-]{1,96}$/.test(raw.identity)) return null;
    const identity = raw.identity;
    if (typeof raw.media !== 'string' || raw.media.length > 4096) return null;
    const values = (value: unknown, limit: number) => {
      if (!Array.isArray(value) || value.length > limit) return [];
      return [...new Set(value.map(item => this.publicUrl(item, undefined, true)?.href).filter((item): item is string => !!item))];
    };
    const direct = this.publicUrl(raw.media, undefined, true)?.href;
    const blob = raw.media.startsWith('blob:');
    if (!direct && !blob) return null;
    if (direct && this.publicUrl(raw.url, undefined, true)?.href !== direct) return null;
    const names = values(raw.resources, 192);
    const reported = values(raw.playlists ?? (raw.url ? [raw.url] : []), 8);
    const fragments = values(raw.observations ?? (raw.observed ? [raw.observed] : []), 32);
    let subtitle: SubtitleChoice | undefined;
    if (raw.subtitle && typeof raw.subtitle === 'object') {
      const track = raw.subtitle as Record<string, unknown>;
      const trackUrl = this.publicUrl(track.url, undefined, true)?.href;
      const language = typeof track.language === 'string' && track.language.length <= 64 ? track.language : undefined;
      const label = typeof track.label === 'string' && track.label.length <= 128 ? track.label : undefined;
      subtitle = { ...(trackUrl ? { url: trackUrl } : {}), ...(language ? { language } : {}), ...(label ? { label } : {}) };
    }
    const captured = this.capture.selected(guest, frame, [...new Set([
      ...(direct ? [direct] : []), ...names, ...reported, ...fragments, ...(subtitle?.url ? [subtitle.url] : []),
    ])], cookies);
    const hints = new Map(captured.map(record => [record.url, record.kind]));
    const kindOf = (url: string) => {
      const observed = hints.get(url);
      if (observed) return observed;
      const pathname = new URL(url).pathname;
      if (/\.m3u8$/i.test(pathname)) return 'hls';
      if (/\.mpd$/i.test(pathname)) return 'dash';
      if (/\.webm$/i.test(pathname)) return 'webm';
      if (/\.mp4$/i.test(pathname)) return 'mp4';
      return undefined;
    };
    const selectedKind = direct ? kindOf(direct) : undefined;
    const directFile = direct && selectedKind !== 'hls' && selectedKind !== 'dash';
    if (directFile) {
      return { identity, media: direct, url: direct, owned: true, kind: selectedKind,
        headersByUrl: this.replayHeaders(captured, [direct]) };
    }
    const playlists = [...new Set([...(direct ? [direct] : []),
      ...reported, ...captured.map(record => record.url)])]
      .filter(url => kindOf(url) === 'hls' || kindOf(url) === 'dash');
    const kinds = new Set(playlists.map(kindOf));
    const kind = selectedKind ?? (kinds.size === 1 ? kindOf(playlists[0]) : undefined);
    if (kind !== 'hls' && kind !== 'dash') return null;
    const compatible = playlists.filter(url => kindOf(url) === kind).slice(0, 8);
    const observations = [...new Set([...fragments, ...names])]
      .filter(url => kindOf(url) !== 'hls' && kindOf(url) !== 'dash').slice(0, 32);
    const expectedDuration = raw.expectedDuration;
    if (typeof expectedDuration !== 'number' || !Number.isFinite(expectedDuration) || expectedDuration <= 0 ||
        expectedDuration > 21600 || !compatible.length || (blob && !observations.length)) return null;
    const headersByUrl = this.replayHeaders(captured, [...compatible, ...observations, ...(subtitle?.url ? [subtitle.url] : [])]);
    return { identity, media: direct ?? raw.media, url: compatible[0], owned: true, kind, playlists: compatible, observations,
      expectedDuration, subtitle, headersByUrl };
  }

  private replayHeaders(captured: readonly { url: string; headers?: Record<string, string> }[], admitted: string[]) {
    const exact = new Map(captured.map(record => [record.url, record.headers]));
    const entries: MediaHeaders[] = [];
    let bytes = 0;
    for (const url of admitted) {
      const headers = exact.get(url);
      if (!headers || entries.some(entry => entry.url === url)) continue;
      const entry = { url, headers };
      const length = Buffer.byteLength(JSON.stringify(entry));
      if (bytes + length > 32 * 1024 || entries.length >= 16) break;
      bytes += length;
      entries.push(entry);
    }
    return entries.length ? entries : undefined;
  }

  private publicUrl(value: unknown, extension?: RegExp, owned = false): URL | null {
    if (typeof value !== 'string' || value.length > 4096) return null;
    try {
      const url = new URL(value);
      const fixture = process.env.ANIVERSE_TEST_PROFILE === '1'
        && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
        && url.origin === process.env.ANIVERSE_TEST_MEDIA_ORIGIN;
      if (url.href.length > 4096 || (extension && !extension.test(url.pathname)) ||
          (!owned && url.search) || url.hash || url.username || url.password) return null;
      if (fixture || (url.protocol === 'https:' && !url.port
        && this.policy.decide({ context: 'handoff', url: url.href, source: url.href }).allowed)) return url;
    } catch { /* Invalid source URL. */ }
    return null;
  }
  private async saveMedia(
    owner: WebContents,
    selected: MediaCandidate,
    validate: () => boolean | Promise<boolean>,
    current: () => boolean = () => !owner.isDestroyed(),
    filenameContext?: EpisodeDownloadContext,
  ): Promise<boolean> {
    if (process.platform !== 'win32') throw Error('MP4 saving is available on Windows.');
    if (this.busy) throw Error('An MP4 download is already in progress.');
    const parent = BrowserWindow.fromWebContents(owner.hostWebContents ?? owner);
    if (!parent) return false;
    this.busy = true;
    try {
      const episodeName = filenameContext === undefined ? undefined : episodeDownloadFilename(filenameContext);
      if (episodeName === null) throw Error('The episode filename context is invalid.');
      const basename = path.posix.basename(new URL(selected.url).pathname).slice(0, 96)
        .replace(/[^a-zA-Z0-9 ._-]/g, '_').replace(/\.[a-z0-9]+$/i, '') || 'episode';
      const { canceled, filePath } = await dialog.showSaveDialog(parent, {
        title: 'Save MP4 as',
        defaultPath: path.join(this.folder() ?? app.getPath('downloads'), episodeName ?? 'AniVerse - ' + basename + '.mp4'),
        filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
      });
      if (canceled || !filePath || owner.isDestroyed()) return false;
      if (path.extname(filePath).toLowerCase() !== '.mp4') throw Error('Choose a filename ending in .mp4.');
      if (!await validate()) throw Error('The active video changed before the download started.');
      return await this.transfer(owner, { ...selected, destination: filePath }, current);
    } finally {
      this.busy = false;
    }
  }

  private async transfer(owner: WebContents, request: MediaCandidate & { destination: string }, current: () => boolean) {
    const resources = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'build/vendor');
    const worker = spawn(path.join(resources, 'ffmpeg/aniverse-media-transfer.exe'), [], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    const result = new Promise<number | null>(resolve => {
      worker.once('error', () => resolve(null));
      worker.once('close', code => resolve(code));
    });
    let cancelled = false;
    const stop = () => { cancelled = true; worker.stdin.end(); };
    const monitor = setInterval(() => { if (!current()) stop(); }, 250);
    owner.once('destroyed', stop);
    worker.stdin.on('error', () => { /* Worker startup and transfer failure are reported below. */ });
    const lines = createInterface({ input: worker.stdout });
    let completed = false;
    let message = 'The bundled MP4 download helper could not complete the transfer.';
    try {
      const { identity: _identity, ...transfer } = request;
      worker.stdin.write(JSON.stringify(transfer) + '\n');
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
      if (cancelled || owner.isDestroyed() || !current()) return false;
      if (code === -1073741515 || code === 3221225781) throw Error('Windows could not load the bundled video download helper. Update or reinstall AniVerse.');
      if (code !== 0 || !completed) throw Error(message);
      return true;
    } finally {
      clearInterval(monitor);
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
