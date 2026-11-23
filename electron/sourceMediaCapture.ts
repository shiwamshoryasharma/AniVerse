import type {
  OnResponseStartedListenerDetails, OnSendHeadersListenerDetails, WebContents, WebFrameMain,
} from 'electron';

import type { CookieLookup } from './sourceRequestCookies';

export type SourceMediaKind = 'mp4' | 'webm' | 'hls' | 'dash';
export type MediaHeaders = { url: string; headers: Record<string, string> };
type Observation = { url: string; kind?: SourceMediaKind; headers?: Record<string, string>; at: number };
type FrameCapture = {
  url: string; pending: Map<number, Observation>; responses: Map<string, Observation>; manifests: Map<string, Observation>;
};

const responseKinds: ReadonlyMap<string, SourceMediaKind> = new Map([
  ['video/mp4', 'mp4'], ['application/mp4', 'mp4'], ['video/webm', 'webm'],
  ['application/vnd.apple.mpegurl', 'hls'], ['application/x-mpegurl', 'hls'],
  ['audio/mpegurl', 'hls'], ['audio/x-mpegurl', 'hls'], ['application/mpegurl', 'hls'],
  ['application/dash+xml', 'dash'],
]);
const replayHeaders = new Set(['accept', 'cookie', 'authorization', 'origin', 'referer']);
const captureExpiry = 10 * 60_000;
const pendingExpiry = 30_000;

function exactUrl(value: string): string | undefined {
  if (value.length > 4096) return;
  try {
    const url = new URL(value);
    if (/^https?:$/.test(url.protocol) && !url.username && !url.password && !url.hash && url.href.length <= 4096) return url.href;
  } catch { /* Ignore malformed passive observations. */ }
}

function frameKey(frame: WebFrameMain) {
  return frame.processId + ':' + frame.routingId + ':' + frame.frameTreeNodeId;
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
  map.delete(key);
  const oldest = map.keys().next();
  if (map.size >= limit && !oldest.done) map.delete(oldest.value);
  map.set(key, value);
}

function scopedHeaders(input: Record<string, string>): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  let bytes = 0;
  for (const [name, value] of Object.entries(input)) {
    const field = name.toLowerCase();
    if (!replayHeaders.has(field)) continue;
    if (Object.hasOwn(headers, field) || value.length > 4096 || !/^[\x20-\x7e]+$/.test(value)) return;
    bytes += field.length + value.length;
    if (bytes > 8192) return;
    headers[field] = value;
  }
  return Object.keys(headers).length ? headers : undefined;
}

/** Observes an existing managed guest, without issuing requests or exposing credentials to any renderer. */
export class SourceMediaCapture {
  private readonly guests = new WeakMap<WebContents, Map<string, FrameCapture>>();

  manage(guest: WebContents) {
    if (this.guests.has(guest)) return;
    const frames = new Map<string, FrameCapture>();
    this.guests.set(guest, frames);
    guest.on('did-start-navigation', details => {
      if (details.isSameDocument) return;
      if (details.isMainFrame || !details.frame) frames.clear();
      else frames.delete(frameKey(details.frame));
    });
    guest.once('destroyed', () => this.guests.delete(guest));
  }

  request(guest: WebContents, details: OnSendHeadersListenerDetails) {
    const url = exactUrl(details.url);
    const capture = this.frame(guest, details.frame, details.method, details.resourceType);
    if (!capture || !url) return;
    const headers = scopedHeaders(details.requestHeaders);
    capture.pending.delete(details.id);
    if (headers) boundedSet(capture.pending, details.id, { url, headers, at: Date.now() }, 24);
  }

  response(guest: WebContents, details: OnResponseStartedListenerDetails) {
    const url = exactUrl(details.url);
    const capture = this.frame(guest, details.frame, details.method, details.resourceType);
    if (!capture || !url) return;
    const pending = capture.pending.get(details.id);
    capture.pending.delete(details.id);
    if (details.statusCode !== 200 && details.statusCode !== 206) return;
    const contentType = Object.entries(details.responseHeaders ?? {})
      .find(([name]) => name.toLowerCase() === 'content-type')?.[1][0]?.split(';', 1)[0].trim().toLowerCase();
    const kind = contentType ? responseKinds.get(contentType) : undefined;
    if (!kind && details.resourceType !== 'media' &&
        !/^(?:video\/|audio\/|text\/vtt$|application\/(?:octet-stream|ttml\+xml|mp4)$)/.test(contentType ?? '')) return;
    const at = Date.now();
    const headers = pending?.url === url && at - pending.at <= pendingExpiry ? pending.headers : undefined;
    const observation = { url, kind, headers, at };
    if (kind === 'hls' || kind === 'dash') {
      capture.responses.delete(url);
      boundedSet(capture.manifests, url, observation, 12);
    } else {
      capture.manifests.delete(url);
      boundedSet(capture.responses, url, observation, 72);
    }
  }

  selected(guest: WebContents, frame: WebFrameMain | undefined, urls: readonly string[], cookies?: CookieLookup): Observation[] {
    if (!frame || frame.detached) return [];
    const capture = this.guests.get(guest)?.get(frameKey(frame));
    if (!capture || capture.url !== frame.url) return [];
    const cutoff = Date.now() - captureExpiry;
    return urls.flatMap(url => {
      const index = capture.manifests.has(url) ? capture.manifests : capture.responses;
      const observation = index.get(url);
      if (!observation) return [];
      if (observation.at < cutoff) {
        const retained = { url, kind: observation.kind, at: observation.at };
        index.set(url, retained);
        return [retained];
      }
      const cookie = cookies?.(url);
      return [cookie ? { ...observation, headers: { ...observation.headers, cookie } } : observation];
    });
  }

  private frame(guest: WebContents, frame: WebFrameMain | null | undefined, method: string, resourceType: string) {
    const frames = this.guests.get(guest);
    if (!frames || guest.isDestroyed() || !frame || frame.detached || method !== 'GET' ||
        !['media', 'xhr', 'other'].includes(resourceType) || !exactUrl(frame.url) ||
        frame.top?.frameTreeNodeId !== guest.mainFrame.frameTreeNodeId) return;
    const key = frameKey(frame);
    const current = frames.get(key);
    if (current?.url === frame.url) return current;
    const capture: FrameCapture = { url: frame.url, pending: new Map(), responses: new Map(), manifests: new Map() };
    boundedSet(frames, key, capture, 6);
    return capture;
  }
}
