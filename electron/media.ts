import { dialog, net, protocol, webContents, type BrowserWindow, type WebContents } from 'electron';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { ProbeResult } from '../app/shared/types';
import { mediaPageScript, type MediaAction } from './mediaPage';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.vtt': 'text/vtt',
};

/** Must run before app `ready`. */
export function registerSchemes() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
    { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

/**
 * `app://aniverse/…` serves the built renderer; `media://local/<token>` streams a
 * file the user picked in the open dialog (tokens are unguessable and only
 * issued by the dialog, so the renderer cannot read arbitrary files).
 */
export class MediaProtocols {
  private files = new Map<string, string>();

  constructor(
    private rendererDir: string,
    private profileDir: string,
  ) {}

  install() {
    protocol.handle('app', async (request) => {
      const { pathname } = new URL(request.url);
      const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      const file = path.normalize(path.join(this.rendererDir, rel));
      const relative = path.relative(this.rendererDir, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Forbidden', { status: 403 });
      const target = await stat(file).then((s) => (s.isFile() ? file : null)).catch(() => null);
      return net.fetch(pathToFileURL(target ?? path.join(this.rendererDir, 'index.html')).toString());
    });

    protocol.handle('media', async (request) => {
      const { host, pathname } = new URL(request.url);
      if (host === 'profile') {
        // media://profile/avatar.webp — only the two profile images, nothing else in the folder.
        const name = pathname.replace(/^\//, '');
        if (!/^(avatar|banner)\.(png|jpe?g|webp)$/.test(name)) return new Response('Not found', { status: 404 });
        return net.fetch(pathToFileURL(path.join(this.profileDir, name)).toString()).catch(() => new Response('Not found', { status: 404 }));
      }
      const token = pathname.replace(/^\//, '');
      const file = this.files.get(token);
      if (!file) return new Response('Not found', { status: 404 });
      const { size } = await stat(file);
      const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      const range = request.headers.get('range')?.match(/bytes=(\d*)-(\d*)/);
      if (range) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, {
          status: 206,
          headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' },
        });
      }
      return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
        status: 200,
        headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
      });
    });
  }

  /** File path behind a `media://local/<token>` URL issued by the open dialog (for casting). */
  localPath(url: string): string | null {
    const m = url.match(/^media:\/\/local\/([a-f0-9]{32}\.[a-z0-9]+)$/i);
    return m ? (this.files.get(m[1]) ?? null) : null;
  }

  async pick(parent: BrowserWindow | null): Promise<{ url: string; name: string } | null> {
    const options = {
      title: 'Open video',
      properties: ['openFile' as const],
      filters: [{ name: 'Video', extensions: ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'm3u8', 'mpd'] }],
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return { url: this.grantFile(result.filePaths[0]), name: path.basename(result.filePaths[0]) };
  }

  /** Main-process callers must first validate that the user selected this file/folder. */
  grantFile(file:string):string {
    const token = `${randomBytes(16).toString('hex')}${path.extname(file).toLowerCase()}`;
    this.files.set(token,file);
    return `media://local/${token}`;
  }
}

const PROBE_SCRIPT = mediaPageScript();

/**
 * Reads (and optionally controls) the <video> element inside a source webview,
 * including cross-origin player frames, so progress tracking and skip work for
 * site players. Only webviews hosted by the main window are accepted.
 */
export class MediaProbe {
  constructor(
    private host: () => WebContents | null,
    private isSourceGuest: (wc: WebContents) => boolean,
  ) {}

  private guest(id: number): WebContents | null {
    const wc = webContents.fromId(id);
    if (!wc || wc.isDestroyed() || wc.getType() !== 'webview') return null;
    if (wc.hostWebContents !== this.host() || !this.isSourceGuest(wc)) return null;
    return wc;
  }

  private async selected(wc: WebContents) {
    let best: { value: Omit<ProbeResult, 'url'>; frame: WebContents['mainFrame'] } | null = null;
    for (const frame of wc.mainFrame.framesInSubtree) {
      try {
        const r = (await frame.executeJavaScript(PROBE_SCRIPT)) as Omit<ProbeResult, 'url'> | null;
        if (r && (!best || (r.duration >= 60 && best.value.duration < 60) ||
          ((r.duration >= 60) === (best.value.duration >= 60) && ((!r.paused && best.value.paused) ||
          (r.paused === best.value.paused && r.duration > best.value.duration))))) best = { value: r, frame };
      } catch {
        // detached or restricted frame
      }
    }
    return best;
  }

  async probe(id: number): Promise<ProbeResult | null> {
    const wc = this.guest(id);
    if (!wc) return null;
    const selected = await this.selected(wc);
    return selected ? { ...selected.value, url: wc.getURL() } : null;
  }

  async control(id: number, action: Exclude<MediaAction, 'probe'>, value?: number): Promise<boolean> {
    const wc = this.guest(id);
    if (!wc) return false;
    const selected = await this.selected(wc);
    if (!selected) return false;
    try {
      return (await selected.frame.executeJavaScript(mediaPageScript(action, value))) === true;
    } catch {
      return false;
    }
  }
}
