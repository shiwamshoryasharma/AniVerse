import type { WebContents } from 'electron';

export type CookieLookup = (url: string) => string | undefined;
type Scope = { frame: string; loader: string; sessionId?: string };
type Pending = { request?: Scope & { url: string }; cookie?: string; response?: string; blocked?: boolean };
type Saved = { cookie: string; at: number };

/** Chromium emits ExtraInfo before or after the corresponding request. Never pair redirect hops. */
export class SourceRequestCookies {
  private readonly pending = new Map<string, Pending>();
  private readonly saved = new Map<string, Saved>();

  clear() {
    this.pending.clear();
    this.saved.clear();
  }

  message(method: string, params: Record<string, unknown>, sessionId?: string) {
    if (!['Network.requestWillBeSent', 'Network.requestWillBeSentExtraInfo', 'Network.responseReceived',
      'Network.loadingFailed'].includes(method) || typeof params.requestId !== 'string') return;
    const id = (sessionId ?? '') + ' ' + params.requestId;
    const row = this.pending.get(id) ?? {};
    if (row.blocked) return;
    if (method === 'Network.requestWillBeSent') {
      const request = params.request as { url?: string; method?: string } | undefined;
      if (params.redirectResponse || !['Media', 'XHR', 'Fetch', 'Other'].includes(String(params.type)) ||
          request?.method !== 'GET' || typeof params.frameId !== 'string' ||
          typeof params.loaderId !== 'string' || !params.loaderId || !request.url || request.url.length > 4096 ||
          !/^https?:\/\//.test(request.url)) {
        row.blocked = true;
        delete row.cookie;
      } else {
        row.request = { url: request.url, frame: params.frameId, loader: params.loaderId, sessionId };
      }
    } else if (method === 'Network.requestWillBeSentExtraInfo') {
      const headers = params.headers as Record<string, unknown> | undefined;
      const entry = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'cookie');
      const value = entry?.[1];
      row.cookie = typeof value === 'string' && value.length <= 4096 && /^[\x20-\x7e]+$/.test(value) ? value : '';
    } else {
      const response = params.response as { status?: number; url?: string } | undefined;
      if (method === 'Network.responseReceived' && params.hasExtraInfo === true &&
          (response?.status === 200 || response?.status === 206)) row.response = response.url;
      if (!row.response) {
        row.blocked = true;
        delete row.cookie;
      }
    }
    this.insert(this.pending, id, row, 160);
    if (!row.blocked && row.request && row.cookie !== undefined && row.request.url === row.response) {
      const key = this.key(row.request, row.request.url);
      if (row.cookie) this.insert(this.saved, key, { cookie: row.cookie, at: Date.now() }, 192);
      else this.saved.delete(key);
      this.pending.delete(id);
    }
  }

  lookup(guest: WebContents, scope: Scope): CookieLookup {
    return url => {
      if (guest.isDestroyed() || !guest.debugger.isAttached()) return;
      const match = this.saved.get(this.key(scope, url));
      if (match && Date.now() - match.at <= 10 * 60_000) return match.cookie;
    };
  }

  private key(scope: Scope, url: string) {
    return JSON.stringify([scope.sessionId ?? "", scope.frame, scope.loader, url]);
  }

  private insert<T>(map: Map<string, T>, key: string, value: T, limit: number) {
    map.delete(key);
    const first = map.keys().next();
    if (map.size >= limit && !first.done) map.delete(first.value);
    map.set(key, value);
  }
}
