import { dialog, net, protocol, webContents, type BrowserWindow, type WebContents } from 'electron';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { ProbeResult } from '../app/shared/types';

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
    const token = `${randomBytes(16).toString('hex')}${path.extname(result.filePaths[0]).toLowerCase()}`;
    this.files.set(token, result.filePaths[0]);
    return { url: `media://local/${token}`, name: path.basename(result.filePaths[0]) };
  }
}

const PROBE_SCRIPT = `(() => {
  const videos = Array.from(document.querySelectorAll('video')).filter((v) => isFinite(v.duration) && v.duration > 0);
  if (!videos.length) return null;
  videos.sort((a, b) => (Number(!b.paused) - Number(!a.paused)) || (b.duration - a.duration));
  const v = videos[0];
  return { currentTime: v.currentTime, duration: v.duration, paused: v.paused, ended: v.ended };
})()`;

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

  async probe(id: number): Promise<ProbeResult | null> {
    const wc = this.guest(id);
    if (!wc) return null;
    let best: Omit<ProbeResult, 'url'> | null = null;
    for (const frame of wc.mainFrame.framesInSubtree) {
      try {
        const r = (await frame.executeJavaScript(PROBE_SCRIPT)) as Omit<ProbeResult, 'url'> | null;
        if (r && (!best || (!r.paused && best.paused) || r.duration > best.duration)) best = r;
      } catch {
        // detached or restricted frame
      }
    }
    return best ? { ...best, url: wc.getURL() } : null;
  }

  async control(id: number, action: 'play' | 'pause' | 'seek', value?: number): Promise<boolean> {
    const wc = this.guest(id);
    if (!wc) return false;
    const op =
      action === 'seek'
        ? `v.currentTime = Math.max(0, Math.min(v.duration, ${Number(value) || 0}));`
        : action === 'play'
          ? 'void v.play();'
          : 'v.pause();';
    const script = `(() => { const v = Array.from(document.querySelectorAll('video')).find((x) => isFinite(x.duration) && x.duration > 0); if (!v) return false; ${op} return true; })()`;
    for (const frame of wc.mainFrame.framesInSubtree) {
      try {
        if (await frame.executeJavaScript(script)) return true;
      } catch {
        // ignore
      }
    }
    return false;
  }
}
