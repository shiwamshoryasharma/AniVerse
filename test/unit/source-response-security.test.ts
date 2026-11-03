import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({ fromPartition: vi.fn() }));
vi.mock('electron', () => ({ app: { userAgentFallback: 'Chrome/150 Electron/44 AniVerse/2' }, session: electronMock, webContents: {}, shell: {} }));
import { DEFAULT_SETTINGS } from '../../app/core/settings';
import { SessionManager } from '../../electron/sessions';

const LIMIT = 8 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const SOURCE_URL = 'https://source.test/catalogue';

function fixture(responses: Response[], kind: 'web' | 'youtube' = 'web') {
  const source = { id: 'fixture', name: 'Fixture source', host: 'source.test', url: 'https://source.test', partition: 'persist:src-fixture', kind, enabled: true, adblock: true, autoCloudflare: true };
  const fetch = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected extra request');
    return response;
  });
  const ses = Object.assign(new EventEmitter(), { fetch, setUserAgent: vi.fn(), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn() });
  electronMock.fromPartition.mockReturnValue(ses);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.privacy.autoCloudflare = true;
  const solve = vi.fn(async () => undefined);
  const manager = new SessionManager({ get: () => source } as never, { attach: vi.fn() } as never, { solve } as never, () => settings, vi.fn(), vi.fn(), { decide: () => ({ allowed: true }) } as never);
  return { manager, fetch, solve };
}

function streamResponse(chunks: Uint8Array[], headers: Record<string, string> = {}, status = 200) {
  let index = 0;
  let bytesRead = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) { controller.close(); return; }
      const chunk = chunks[index++];
      bytesRead += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel,
  }, { highWaterMark: 0 });
  return { response: new Response(stream, { headers, status }), cancel, bytesRead: () => bytesRead };
}

async function outcome(manager: SessionManager, url = SOURCE_URL, accept?: string) {
  return manager.get('fixture', url, { accept }).then(response => ({ ok: true as const, bytes: Buffer.byteLength(response.text), response }), error => ({ ok: false as const, error }));
}

function expectNetworkFailure(result: Awaited<ReturnType<typeof outcome>>) {
  // Inspect only the compact result so a RED run never prints an oversized response body.
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatchObject({ code: 'network', message: expect.stringMatching(/large|limit|size|exceed/i) });
}

describe('source metadata response byte budget', () => {
  it('rejects an announced oversized body before reading it and cancels the stream', async () => {
    const body = streamResponse([Buffer.from('do not read')], { 'content-length': String(LIMIT + 1) });
    const { manager } = fixture([body.response]);
    const result = await outcome(manager);
    expect.soft(body.bytesRead()).toBe(0);
    expect.soft(body.cancel).toHaveBeenCalledTimes(1);
    expectNetworkFailure(result);
  });

  it.each([
    ['undeclared', {}],
    ['understated', { 'content-length': '1' }],
    ['malformed', { 'content-length': 'unknown' }],
    ['negative', { 'content-length': '-1' }],
  ])('counts streamed bytes for %s lengths and cancels on overflow', async (_label, headers) => {
    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(CHUNK, 0x61));
    const body = streamResponse(chunks, headers);
    const { manager } = fixture([body.response]);
    const result = await outcome(manager);
    expect.soft(body.cancel).toHaveBeenCalledTimes(1);
    expect.soft(body.bytesRead()).toBeLessThanOrEqual(LIMIT + CHUNK);
    expectNetworkFailure(result);
  });

  it.each([false, true])('accepts exactly 8 MiB with declared length=%s', async declared => {
    const body = streamResponse(Array.from({ length: 8 }, () => Buffer.alloc(CHUNK, 0x61)), declared ? { 'content-length': String(LIMIT) } : {});
    const { manager } = fixture([body.response]);
    const result = await outcome(manager);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes).toBe(LIMIT);
      expect(result.response.text.startsWith('aaaa')).toBe(true);
      expect(result.response.text.endsWith('aaaa')).toBe(true);
    }
    expect(body.cancel).not.toHaveBeenCalled();
  });

  it('counts UTF-8 bytes, including a multibyte character crossing the byte limit', async () => {
    const body = streamResponse([Buffer.alloc(LIMIT - 1, 0x61), Buffer.from('€'), Buffer.from('unread tail')]);
    const { manager } = fixture([body.response]);
    const result = await outcome(manager);
    expect.soft(body.cancel).toHaveBeenCalledTimes(1);
    expectNetworkFailure(result);
  });

  it.each([
    ['HTML', 'text/html', '<html><title>日本語 🌙</title><body>café €</body></html>', 'web', SOURCE_URL],
    ['OpenSearch XML', 'application/opensearchdescription+xml', '<?xml version="1.0"?><OpenSearchDescription><ShortName>検索 €</ShortName></OpenSearchDescription>', 'web', 'https://source.test/opensearch.xml'],
    ['YouTube RSS', 'application/atom+xml', '<?xml version="1.0"?><feed><entry><title>日本語 🌙</title></entry></feed>', 'youtube', 'https://www.youtube.com/feeds/videos.xml?channel_id=fixture'],
  ] as const)('preserves split UTF-8 in %s metadata and request Accept headers', async (_label, contentType, text, kind, url) => {
    const body = streamResponse([...Buffer.from(text)].map(byte => Uint8Array.of(byte)), { 'content-type': contentType });
    const { manager, fetch } = fixture([body.response], kind);
    const response = await manager.get('fixture', url, { accept: contentType });
    expect(response).toMatchObject({ status: 200, text, url, headers: { 'content-type': contentType } });
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ headers: expect.objectContaining({ Accept: contentType }), signal: expect.any(AbortSignal), redirect: 'follow' }));
    expect(body.cancel).not.toHaveBeenCalled();
  });

  it('preserves an empty body including a response without a readable body', async () => {
    const { manager } = fixture([new Response(null), streamResponse([]).response]);
    expect(await manager.get('fixture', SOURCE_URL)).toMatchObject({ status: 200, text: '' });
    expect(await manager.get('fixture', SOURCE_URL)).toMatchObject({ status: 200, text: '' });
  });

  it('reports a local response stream error as a network failure', async () => {
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) controller.enqueue(Buffer.from('<html>'));
      else controller.error(new Error('fixture stream failure'));
    } });
    const { manager } = fixture([new Response(stream)]);
    await expect(manager.get('fixture', SOURCE_URL)).rejects.toMatchObject({ code: 'network', message: expect.stringContaining('fixture stream failure') });
  });

  it('enforces the same body limit on the second read after Cloudflare verification', async () => {
    const challenge = new Response('<title>Just a moment</title>', { status: 503, headers: { 'cf-mitigated': 'challenge' } });
    const oversized = streamResponse(Array.from({ length: 10 }, () => Buffer.alloc(CHUNK, 0x61)), { 'content-length': '1' });
    const { manager, fetch, solve } = fixture([challenge, oversized.response]);
    const result = await outcome(manager);
    expect(solve).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect.soft(oversized.cancel).toHaveBeenCalledTimes(1);
    expect.soft(oversized.bytesRead()).toBeLessThanOrEqual(LIMIT + CHUNK);
    expectNetworkFailure(result);
  });

  it('retains ordinary metadata retrieval after a verified Cloudflare challenge', async () => {
    const challenge = new Response('<title>Just a moment</title>', { status: 503, headers: { 'cf-mitigated': 'challenge' } });
    const { manager, fetch, solve } = fixture([challenge, new Response('<html>verified metadata</html>')]);
    expect(await manager.get('fixture', SOURCE_URL)).toMatchObject({ text: '<html>verified metadata</html>' });
    expect(solve).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
