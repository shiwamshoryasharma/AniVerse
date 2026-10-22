import { randomBytes } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import makeMdns from 'multicast-dns';
import { AppError } from '../../app/core/util';
import type { CastDevice, CastMedia, CastState } from '../../app/shared/types';
import { CastClient, type MediaStatus } from './castv2';

const CONTENT_TYPES: Record<CastMedia['kind'], string> = { hls: 'application/x-mpegurl', dash: 'application/dash+xml', mp4: 'video/mp4' };
const FILE_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/mp4', '.vtt': 'text/vtt' };

/** Finds Google Cast devices on the local network (mDNS `_googlecast._tcp.local`). */
export function discoverCastDevices(timeoutMs = 3000): Promise<CastDevice[]> {
  return new Promise((resolve) => {
    const mdns = makeMdns();
    const found = new Map<string, CastDevice>();
    const hosts = new Map<string, string>();
    mdns.on('response', (res) => {
      const records = [...res.answers, ...res.additionals] as unknown as { name: string; type: string; data?: unknown }[];
      for (const r of records) if (r.type === 'A') hosts.set(r.name, r.data as string);
      for (const r of records) {
        if (r.type !== 'SRV' || !r.name.includes('_googlecast')) continue;
        const srv = r.data as { port: number; target: string };
        const txt = records.find((t) => t.type === 'TXT' && t.name === r.name);
        const fields: Record<string, string> = {};
        for (const b of ((txt?.data as Buffer[] | undefined) ?? [])) {
          const [k, ...v] = b.toString().split('=');
          fields[k] = v.join('=');
        }
        const host = hosts.get(srv.target) ?? records.find((a) => a.type === 'A')?.data;
        if (!host || typeof host !== 'string') continue;
        const id = fields.id || r.name;
        found.set(id, { id, name: fields.fn || r.name.split('._googlecast')[0], model: fields.md || 'Chromecast', host, port: srv.port });
      }
    });
    const ask = () => mdns.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] });
    ask();
    const again = setTimeout(ask, 1000);
    setTimeout(() => {
      clearTimeout(again);
      mdns.destroy();
      resolve([...found.values()].sort((a, b) => a.name.localeCompare(b.name)));
    }, timeoutMs);
  });
}

/** Local IPv4 address on the same network as the Cast device (for serving local files). */
function lanAddressFor(deviceHost: string): string | null {
  const target = deviceHost.split('.').map(Number);
  let fallback: string | null = null;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      fallback ??= ni.address;
      const mask = ni.netmask.split('.').map(Number);
      const addr = ni.address.split('.').map(Number);
      if (mask.every((m, i) => (addr[i] & m) === (target[i] & m))) return ni.address;
    }
  }
  return fallback;
}

/**
 * Casts *media only* to a Cast device: the device's Default Media Receiver
 * streams the URL itself; AniVerse acts as the remote. Local files are served
 * to the device from a short-lived, token-protected LAN server.
 */
export class CastService {
  private devices = new Map<string, CastDevice>();
  private client: CastClient | null = null;
  private server: http.Server | null = null;
  private served = new Map<string, string>();
  private poll: NodeJS.Timeout | null = null;
  private state: CastState = { device: null, status: 'idle', currentTime: 0, duration: 0, title: null, volume: 1, error: null };

  constructor(
    private emit: (s: CastState) => void,
    private localFile: (mediaUrl: string) => string | null,
  ) {}

  snapshot(): CastState {
    return { ...this.state };
  }

  private set(patch: Partial<CastState>) {
    this.state = { ...this.state, ...patch };
    this.emit(this.snapshot());
  }

  async scan(): Promise<CastDevice[]> {
    const list = await discoverCastDevices();
    for (const d of list) this.devices.set(d.id, d);
    return list;
  }

  async start(deviceId: string, media: CastMedia): Promise<CastState> {
    const device = this.devices.get(deviceId);
    if (!device) throw new AppError('not-found', 'That Cast device is no longer available — scan again.');
    await this.stop();
    this.set({ device: { id: device.id, name: device.name }, status: 'connecting', currentTime: media.startAt ?? 0, duration: 0, title: media.title, error: null });

    try {
      const url = await this.castableUrl(media.url, device.host);
      const client = new CastClient();
      this.client = client;
      client.on('media', (s: MediaStatus | null) => this.onMedia(s));
      client.on('closed', () => this.finish('ended'));
      client.on('disconnected', (err: Error | null) => this.finish(err ? 'error' : 'idle', err?.message ?? null));
      await client.connect(device.host, device.port);
      await client.launch();
      const tracks = await Promise.all(
        (media.subtitles ?? []).map(async (s, i) => ({
          trackId: i + 1,
          type: 'TEXT',
          trackContentId: await this.castableUrl(s.url, device.host),
          trackContentType: 'text/vtt',
          subtype: 'SUBTITLES',
          name: s.label,
          language: s.lang,
        })),
      );
      const contentType = media.kind === 'mp4' ? (FILE_TYPES[path.extname(new URL(media.url).pathname).toLowerCase()] ?? 'video/mp4') : CONTENT_TYPES[media.kind];
      await client.load(
        {
          contentId: url,
          contentType,
          streamType: 'BUFFERED',
          metadata: { metadataType: 0, title: media.title, subtitle: media.subtitle ?? '', images: media.image ? [{ url: media.image }] : [] },
          ...(tracks.length ? { tracks } : {}),
        },
        media.startAt ?? 0,
      );
      // The receiver only reports changes; poll so the remote's progress bar keeps moving.
      this.poll = setInterval(() => void this.client?.media('GET_STATUS'), 2000);
      return this.snapshot();
    } catch (err) {
      const message = (err as Error).message;
      await this.stop();
      this.set({ status: 'error', error: message });
      throw new AppError('network', `Casting failed: ${message}`);
    }
  }

  private onMedia(s: MediaStatus | null) {
    if (!s) return;
    const status: CastState['status'] =
      s.playerState === 'PLAYING' ? 'playing' : s.playerState === 'PAUSED' ? 'paused' : s.playerState === 'BUFFERING' ? 'buffering' : s.idleReason === 'FINISHED' ? 'ended' : s.idleReason === 'ERROR' ? 'error' : this.state.status;
    this.set({
      status,
      currentTime: s.currentTime ?? this.state.currentTime,
      duration: s.media?.duration ?? this.state.duration,
      volume: s.volume?.level ?? this.state.volume,
      error: s.idleReason === 'ERROR' ? 'The Cast device could not play this stream.' : null,
    });
  }

  async control(action: 'play' | 'pause' | 'seek' | 'volume', value?: number): Promise<CastState> {
    const c = this.client;
    if (!c) throw new AppError('invalid-input', 'Nothing is casting.');
    if (action === 'play') await c.media('PLAY');
    else if (action === 'pause') await c.media('PAUSE');
    else if (action === 'seek') await c.media('SEEK', { currentTime: Math.max(0, value ?? 0) });
    else if (action === 'volume') {
      await c.volume(value ?? 1);
      this.set({ volume: Math.max(0, Math.min(1, value ?? 1)) });
    }
    return this.snapshot();
  }

  /** Stops playback on the device and tears down the session and file server. */
  async stop(): Promise<CastState> {
    const c = this.client;
    this.client = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    if (c) {
      await c.stopApp().catch(() => undefined);
      c.removeAllListeners();
      c.close();
    }
    this.closeServer();
    if (this.state.status !== 'idle') this.set({ status: 'idle', device: null });
    return this.snapshot();
  }

  private finish(status: CastState['status'], error: string | null = null) {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.client = null;
    this.closeServer();
    this.set({ status, error, device: status === 'ended' ? this.state.device : null });
  }

  /** http(s) URLs are fetched by the device directly; local files go through the LAN server. */
  private async castableUrl(url: string, deviceHost: string): Promise<string> {
    if (/^https?:\/\//i.test(url)) return url;
    const file = this.localFile(url);
    if (!file) throw new AppError('invalid-input', 'This media cannot be cast.');
    const ip = lanAddressFor(deviceHost);
    if (!ip) throw new AppError('network', 'No local network connection found for casting.');
    const port = await this.ensureServer();
    const token = `${randomBytes(16).toString('hex')}${path.extname(file).toLowerCase()}`;
    this.served.set(token, file);
    return `http://${ip}:${port}/cast/${token}`;
  }

  private ensureServer(): Promise<number> {
    if (this.server) return Promise.resolve((this.server.address() as AddressInfo).port);
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const token = (req.url ?? '').replace(/^\/cast\//, '').split('?')[0];
        const file = this.served.get(token);
        if (!file || req.method !== 'GET') {
          res.writeHead(404).end();
          return;
        }
        const size = statSync(file).size;
        const type = FILE_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
        const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
        const m = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
        if (m) {
          const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
          const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
          res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
          createReadStream(file, { start, end }).pipe(res);
        } else {
          res.writeHead(200, { ...headers, 'Content-Length': size });
          createReadStream(file).pipe(res);
        }
      });
      server.on('error', reject);
      server.listen(0, '0.0.0.0', () => {
        this.server = server;
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  private closeServer() {
    this.served.clear();
    this.server?.close();
    this.server = null;
  }
}
