import { EventEmitter } from 'node:events';
import tls from 'node:tls';

/**
 * Minimal Google Cast (CASTV2) sender. Messages are length-prefixed protobuf
 * `CastMessage`s over TLS (port 8009). Only what AniVerse needs is implemented:
 * connect, heartbeat, launch the Default Media Receiver, load and control media.
 */

export const DEFAULT_MEDIA_RECEIVER = 'CC1AD845';
const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
};
const SENDER = 'sender-aniverse';
const RECEIVER = 'receiver-0';

interface CastMessage {
  sourceId: string;
  destinationId: string;
  namespace: string;
  payload: string;
}

// ---------------------------------------------------------------- protobuf (just CastMessage)

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

function stringField(field: number, value: string): Buffer {
  const data = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from([(field << 3) | 2, ...varint(data.length)]), data]);
}

export function encodeMessage(m: CastMessage): Buffer {
  const body = Buffer.concat([
    Buffer.from([(1 << 3) | 0, 0]), // protocol_version = CASTV2_1_0
    stringField(2, m.sourceId),
    stringField(3, m.destinationId),
    stringField(4, m.namespace),
    Buffer.from([(5 << 3) | 0, 0]), // payload_type = STRING
    stringField(6, m.payload),
  ]);
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export function decodeMessage(buf: Buffer): CastMessage {
  const msg: CastMessage = { sourceId: '', destinationId: '', namespace: '', payload: '' };
  let i = 0;
  const readVarint = (): bigint => {
    let result = 0n;
    for (let byte = 0; byte < 10; byte++) {
      if (i >= buf.length) throw new Error('Truncated Cast varint.');
      const value = buf[i++];
      if (byte === 9 && value > 1) throw new Error('Oversized Cast varint.');
      result |= BigInt(value & 0x7f) << BigInt(byte * 7);
      if (value < 0x80) return result;
    }
    throw new Error('Unterminated Cast varint.');
  };
  const skip = (length: number) => {
    if (length > buf.length - i) throw new Error('Truncated Cast field.');
    i += length;
  };
  while (i < buf.length) {
    const tag = readVarint();
    if (tag > 0xffffffffn || tag < 8n) throw new Error('Invalid Cast field key.');
    const key = Number(tag), field = key >>> 3, wire = key & 7;
    if (wire === 0) readVarint(); // Unknown uint64 values can be skipped without losing precision.
    else if (wire === 1) skip(8);
    else if (wire === 5) skip(4);
    else if (wire === 2) {
      const length = readVarint();
      if (length > BigInt(buf.length - i)) throw new Error('Truncated Cast string.');
      const len = Number(length);
      if (field === 2) msg.sourceId = buf.toString('utf8', i, i + len);
      else if (field === 3) msg.destinationId = buf.toString('utf8', i, i + len);
      else if (field === 4) msg.namespace = buf.toString('utf8', i, i + len);
      else if (field === 6) msg.payload = buf.toString('utf8', i, i + len);
      i += len;
    } else throw new Error('Unsupported Cast wire type.');
  }
  return msg;
}

// ---------------------------------------------------------------- client

export interface ReceiverApp {
  appId: string;
  sessionId: string;
  transportId: string;
}

export interface MediaStatus {
  mediaSessionId: number;
  playerState: 'IDLE' | 'PLAYING' | 'PAUSED' | 'BUFFERING';
  currentTime: number;
  idleReason?: string;
  media?: { duration?: number };
  volume?: { level: number; muted: boolean };
}

export class CastClient extends EventEmitter {
  private socket: tls.TLSSocket | null = null;
  private buffer = Buffer.alloc(4);
  private received = 0;
  private readingHeader = true;
  private frameTimer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private heartbeat: NodeJS.Timeout | null = null;
  private lastSeen = 0;
  private connected = new Set<string>();
  app: ReceiverApp | null = null;
  mediaSessionId: number | null = null;

  connect(host: string, port = 8009): Promise<void> {
    return new Promise((resolve, reject) => {
      let ready = false;
      // Cast devices present self-signed certificates on the local network.
      const socket = tls.connect({ host, port, rejectUnauthorized: false, timeout: 8000 }, () => {
        ready = true;
        this.lastSeen = Date.now();
        this.open(RECEIVER);
        this.heartbeat = setInterval(() => {
          if (Date.now() - this.lastSeen > 20000) return this.close(new Error('The Cast device stopped responding.'));
          this.send(NS.heartbeat, RECEIVER, { type: 'PING' });
        }, 5000);
        resolve();
      });
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('timeout', () => socket.destroy(new Error('Timed out connecting to the Cast device.')));
      socket.on('error', (err) => {
        reject(err);
        this.close(err);
      });
      socket.on('close', () => { if (!ready) reject(new Error('Cast connection closed before it was ready.')); this.close(); });
      this.socket = socket;
    });
  }

  private open(destination: string) {
    if (this.connected.has(destination)) return;
    this.connected.add(destination);
    this.send(NS.connection, destination, { type: 'CONNECT', origin: {}, userAgent: 'AniVerse' });
  }

  private onData(chunk: Buffer) {
    this.lastSeen = Date.now();
    let offset = 0;
    try {
      // Fill at most one bounded frame at a time, including when TLS coalesces many messages.
      while (offset < chunk.length && this.socket) {
        if (!this.frameTimer) {
          this.frameTimer = setTimeout(() => this.close(new Error('The Cast device sent an incomplete message.')), 10000);
          this.frameTimer.unref();
        }
        const count = Math.min(this.buffer.length - this.received, chunk.length - offset);
        chunk.copy(this.buffer, this.received, offset, offset + count);
        offset += count;
        this.received += count;
        if (this.received < this.buffer.length) return;
        if (this.readingHeader) {
          const length = this.buffer.readUInt32BE(0);
          // Application budget, not a claimed CASTV2 protocol maximum.
          if (length === 0 || length > 1024 * 1024) throw new Error('The Cast message exceeds the allowed size.');
          this.buffer = Buffer.allocUnsafe(length);
          this.received = 0;
          this.readingHeader = false;
        } else {
          const message = decodeMessage(this.buffer);
          this.buffer = Buffer.alloc(4);
          this.received = 0;
          this.readingHeader = true;
          clearTimeout(this.frameTimer);
          this.frameTimer = null;
          this.onMessage(message);
        }
      }
    } catch (error) {
      this.close(error instanceof Error ? error : new Error('Invalid Cast message.'));
    }
  }

  private onMessage(msg: CastMessage) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(msg.payload);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    if (msg.namespace === NS.heartbeat && payload.type === 'PING') this.send(NS.heartbeat, msg.sourceId, { type: 'PONG' });
    if (msg.namespace === NS.connection && payload.type === 'CLOSE' && msg.sourceId === this.app?.transportId) {
      this.app = null;
      this.mediaSessionId = null;
      this.emit('closed');
    }
    const requestId = Number(payload.requestId);
    const waiter = requestId ? this.pending.get(requestId) : undefined;
    if (waiter) {
      clearTimeout(waiter.timer);
      this.pending.delete(requestId);
      if (/^(LOAD_FAILED|LOAD_CANCELLED|INVALID_REQUEST|LAUNCH_ERROR|INVALID_PLAYER_STATE)$/.test(String(payload.type))) {
        waiter.reject(new Error(`Cast device: ${String(payload.type).toLowerCase().replace(/_/g, ' ')}${payload.reason ? ` (${payload.reason})` : ''}`));
      } else waiter.resolve(payload);
    }
    if (payload.type === 'MEDIA_STATUS') {
      const status = (payload.status as MediaStatus[] | undefined)?.[0];
      if (status) {
        this.mediaSessionId = status.mediaSessionId;
        this.emit('media', status);
      } else this.emit('media', null);
    }
    if (payload.type === 'RECEIVER_STATUS') {
      const apps = ((payload.status as { applications?: ReceiverApp[] })?.applications ?? []) as ReceiverApp[];
      if (this.app && !apps.some((a) => a.sessionId === this.app!.sessionId)) {
        this.app = null;
        this.emit('closed');
      }
    }
  }

  private send(namespace: string, destinationId: string, payload: Record<string, unknown>) {
    this.socket?.write(encodeMessage({ sourceId: SENDER, destinationId, namespace, payload: JSON.stringify(payload) }));
  }

  private request(namespace: string, destinationId: string, payload: Record<string, unknown>, timeoutMs = 15000): Promise<Record<string, unknown>> {
    const requestId = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('The Cast device did not answer in time.'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send(namespace, destinationId, { ...payload, requestId });
    });
  }

  async launch(appId = DEFAULT_MEDIA_RECEIVER): Promise<ReceiverApp> {
    const status = await this.request(NS.receiver, RECEIVER, { type: 'LAUNCH', appId }, 25000);
    const app = ((status.status as { applications?: ReceiverApp[] })?.applications ?? []).find((a) => a.appId === appId);
    if (!app) throw new Error('The Cast device could not start its media player.');
    this.app = app;
    this.open(app.transportId);
    return app;
  }

  async load(media: Record<string, unknown>, currentTime = 0): Promise<MediaStatus | null> {
    if (!this.app) throw new Error('No media player running on the Cast device.');
    const r = await this.request(NS.media, this.app.transportId, { type: 'LOAD', media, autoplay: true, currentTime }, 30000);
    return (r.status as MediaStatus[] | undefined)?.[0] ?? null;
  }

  async media(type: 'PLAY' | 'PAUSE' | 'STOP' | 'SEEK' | 'GET_STATUS', extra: Record<string, unknown> = {}) {
    if (!this.app || (this.mediaSessionId === null && type !== 'GET_STATUS')) return;
    await this.request(NS.media, this.app.transportId, { type, mediaSessionId: this.mediaSessionId ?? undefined, ...extra }).catch(() => undefined);
  }

  async volume(level: number) {
    await this.request(NS.receiver, RECEIVER, { type: 'SET_VOLUME', volume: { level: Math.max(0, Math.min(1, level)) } }).catch(() => undefined);
  }

  async stopApp() {
    if (!this.app) return;
    await this.request(NS.receiver, RECEIVER, { type: 'STOP', sessionId: this.app.sessionId }).catch(() => undefined);
    this.app = null;
  }

  close(err?: Error) {
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = null;
    this.buffer = Buffer.alloc(4);
    this.received = 0;
    this.readingHeader = true;
    this.connected.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const w of this.pending.values()) {
      clearTimeout(w.timer);
      w.reject(err ?? new Error('Cast connection closed.'));
    }
    this.pending.clear();
    if (this.socket) {
      const s = this.socket;
      this.socket = null;
      s.destroy();
      this.emit('disconnected', err ?? null);
    }
  }
}
