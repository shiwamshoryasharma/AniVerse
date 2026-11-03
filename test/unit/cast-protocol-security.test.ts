import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const tlsMock = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('node:tls', () => ({ default: tlsMock }));
import { CastClient, decodeMessage, encodeMessage } from '../../electron/cast/castv2';

const MAX_FRAME = 1024 * 1024;
const MEDIA_NS = 'urn:x-cast:com.google.cast.media';
const clients: CastClient[] = [];
const decoderFixture = path.resolve('test/cache/release-2.2.0/castv2-security.fixture.cjs');

class Socket extends EventEmitter {
  destroyed = false;
  write = vi.fn(() => true);
  destroy = vi.fn(() => {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('close');
    }
    return this;
  });
}

async function connected() {
  const socket = new Socket();
  let ready!: () => void;
  tlsMock.connect.mockImplementationOnce((_options, callback) => { ready = callback; return socket; });
  const client = new CastClient();
  clients.push(client);
  const connecting = client.connect('receiver.test');
  ready();
  await connecting;
  return { client, socket };
}

function mediaFrame(id = 1, extra: Record<string, unknown> = {}) {
  return encodeMessage({ sourceId: 'receiver-0', destinationId: 'sender-aniverse', namespace: MEDIA_NS, payload: JSON.stringify({ type: 'MEDIA_STATUS', status: [{ mediaSessionId: id, playerState: 'PLAYING', currentTime: id, ...extra }] }) });
}

function announce(length: number) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(length);
  return header;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
  tlsMock.connect.mockReset();
});

beforeAll(() => {
  mkdirSync(path.dirname(decoderFixture), { recursive: true });
  // Compile only the production module into the test cache; never run an app build.
  buildSync({ entryPoints: ['electron/cast/castv2.ts'], outfile: decoderFixture, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
});

describe('bounded Cast protobuf decoding', () => {
  it.each([
    ['truncated field key', [0x80]],
    ['truncated scalar varint', [0x08, 0x80]],
    ['truncated string length', [0x12, 0x80]],
    ['string outside frame', [0x12, 0x02, 0x61]],
    ['overlong varint', [0x08, ...Array<number>(11).fill(0x80), 0]],
    ['invalid zero field', [0]],
    ['unsupported group wire type', [0x13]],
  ])('rejects %s within an external process deadline', (_label, bytes) => {
    // A Vitest testTimeout cannot interrupt a synchronous parser loop. The OS child timeout can.
    // Allow process startup under the full parallel suite; malformed decoding must still terminate.
    const script = `const {decodeMessage}=require(${JSON.stringify(decoderFixture)});let rejected=false;try{decodeMessage(Buffer.from(${JSON.stringify(bytes)}))}catch{rejected=true}process.stdout.write(JSON.stringify({rejected}));`;
    const child = spawnSync(process.execPath, ['-e', script], { timeout: 5000, encoding: 'utf8', windowsHide: true });
    expect(child.error, `decoder must terminate; stderr: ${child.stderr}`).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ rejected: true });
  });

  it('preserves Unicode and skips supported unknown protobuf fields', () => {
    const message = { sourceId: '受信機', destinationId: 'sender-aniverse', namespace: MEDIA_NS, payload: JSON.stringify({ title: '日本語 🌙 café' }) };
    const body = encodeMessage(message).subarray(4);
    // Unknown varint, length-delimited, fixed64, and fixed32 fields can precede Cast fields.
    const unknown = Buffer.from([0x78, 0x01, 0x72, 0x01, 0x61, 0x69, ...Array<number>(8).fill(0), 0x65, ...Array<number>(4).fill(0)]);
    expect(decodeMessage(Buffer.concat([unknown, body]))).toEqual(message);
  });

  it('closes a transport receiving malformed protobuf without hanging its caller', () => {
    const script = `const {EventEmitter}=require('node:events');const tls=require('node:tls');let socket;tls.connect=(_opts,ready)=>{socket=new EventEmitter();socket.write=()=>true;socket.destroy=()=>{socket.destroyed=true};queueMicrotask(ready);return socket};const {CastClient}=require(${JSON.stringify(decoderFixture)});(async()=>{const client=new CastClient();await client.connect('receiver.test');let threw=false;try{socket.emit('data',Buffer.from([0,0,0,1,128]))}catch{threw=true}const destroyed=!!socket.destroyed;client.close();process.stdout.write(JSON.stringify({destroyed,threw}))})().catch(e=>{console.error(e);process.exitCode=1});`;
    const child = spawnSync(process.execPath, ['-e', script], { timeout: 5000, encoding: 'utf8', windowsHide: true });
    expect(child.error, `transport must terminate; stderr: ${child.stderr}`).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ destroyed: true, threw: false });
  });
});

describe('bounded Cast transport framing', () => {
  it('rejects a frame larger than 1 MiB from its header and cleans up only that client', async () => {
    vi.useFakeTimers();
    const bad = await connected();
    const good = await connected();
    const disconnected = vi.fn();
    bad.client.on('disconnected', disconnected);
    const pendingResult: unknown[] = [];
    const pending = bad.client.launch().then(value => pendingResult.push(value), error => pendingResult.push(error));
    try {
      bad.socket.emit('data', announce(MAX_FRAME + 1));
      await vi.advanceTimersByTimeAsync(0);
      expect.soft(bad.socket.destroyed).toBe(true);
      expect.soft(disconnected).toHaveBeenCalledTimes(1);
      expect.soft(pendingResult[0]).toBeInstanceOf(Error);
      expect(good.socket.destroyed).toBe(false);
      const media = vi.fn();
      good.client.on('media', media);
      good.socket.emit('data', mediaFrame(4));
      expect(media).toHaveBeenCalledWith(expect.objectContaining({ mediaSessionId: 4 }));
    } finally {
      bad.client.close();
      await pending;
    }
  });

  it('bounds an incomplete frame even if the peer drips bytes to remain active', async () => {
    vi.useFakeTimers();
    const { socket } = await connected();
    socket.emit('data', Buffer.concat([announce(65536), Buffer.from([0x12])]));
    for (let second = 0; second < 20 && !socket.destroyed; second++) {
      await vi.advanceTimersByTimeAsync(1000);
      socket.emit('data', Buffer.from([0]));
    }
    expect(socket.destroyed).toBe(true);
  });

  it('handles fragmented headers/bodies and coalesced ordinary messages', async () => {
    const { client, socket } = await connected();
    const media = vi.fn();
    client.on('media', media);
    const first = mediaFrame(1, { title: '日本語 🌙' });
    let start = 0;
    for (const end of [1, 2, 4, 9, first.length - 1]) {
      socket.emit('data', first.subarray(start, end));
      expect(media).not.toHaveBeenCalled();
      start = end;
    }
    socket.emit('data', Buffer.concat([first.subarray(first.length - 1), mediaFrame(2), mediaFrame(3)]));
    expect(media.mock.calls.map(call => call[0].mediaSessionId)).toEqual([1, 2, 3]);
    expect(media.mock.calls[0][0].title).toBe('日本語 🌙');
    expect(socket.destroyed).toBe(false);
  });

  it('accepts the 1 MiB boundary and coalesced frames whose aggregate exceeds it', async () => {
    const { client, socket } = await connected();
    const media = vi.fn();
    client.on('media', media);
    const base = mediaFrame(1, { padding: '' });
    const exact = mediaFrame(1, { padding: 'x'.repeat(MAX_FRAME - (base.length - 4)) });
    // A larger protobuf string length varint changes its overhead; calculate once more.
    const adjusted = mediaFrame(1, { padding: 'x'.repeat(MAX_FRAME - (exact.length - 4) + MAX_FRAME - (base.length - 4)) });
    expect(adjusted.readUInt32BE(0)).toBe(MAX_FRAME);
    socket.emit('data', adjusted);
    socket.emit('data', Buffer.concat([mediaFrame(2, { padding: 'x'.repeat(350000) }), mediaFrame(3, { padding: 'x'.repeat(350000) }), mediaFrame(4, { padding: 'x'.repeat(350000) })]));
    expect(media.mock.calls.map(call => call[0].mediaSessionId)).toEqual([1, 2, 3, 4]);
    expect(socket.destroyed).toBe(false);
  });

  it('clears the incomplete-frame deadline after completion and on close', async () => {
    vi.useFakeTimers();
    const { client, socket } = await connected();
    const frame = mediaFrame();
    socket.emit('data', frame.subarray(0, 7));
    await vi.advanceTimersByTimeAsync(3000);
    socket.emit('data', frame.subarray(7));
    await vi.advanceTimersByTimeAsync(15000);
    expect(socket.destroyed).toBe(false);
    client.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
