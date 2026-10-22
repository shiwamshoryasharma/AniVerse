import { AppError, sleep } from '../util';

/** Fetch implementation injected by the host (Electron net / Node fetch / test fake). */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface JsonRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  form?: Record<string, string>;
  retries?: number;
  timeoutMs?: number;
}

/**
 * JSON request with timeout, 429 Retry-After handling and bounded retries on
 * transient failures. Throws AppError with a stable code.
 */
export async function requestJson<T>(fetchFn: FetchFn, req: JsonRequest): Promise<T> {
  const retries = req.retries ?? 2;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 20000);
    try {
      const headers: Record<string, string> = { Accept: 'application/json', ...req.headers };
      let body: string | undefined;
      if (req.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(req.form).toString();
      } else if (req.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(req.body);
      }
      const res = await fetchFn(req.url, { method: req.method ?? (body ? 'POST' : 'GET'), headers, body, signal: controller.signal });
      if (res.status === 429 && attempt < retries) {
        const wait = Number(res.headers.get('retry-after')) || 2 ** attempt * 2;
        await sleep(Math.min(wait, 65) * 1000);
        continue;
      }
      const text = await res.text();
      if (res.status === 401 || res.status === 403) throw new AppError('unauthorised', `${new URL(req.url).host} rejected the request (${res.status}).`);
      if (res.status === 404) throw new AppError('not-found', `Not found: ${new URL(req.url).pathname}`);
      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) {
          await sleep(800 * (attempt + 1));
          continue;
        }
        throw new AppError('network', `${new URL(req.url).host} responded ${res.status}: ${text.slice(0, 200)}`);
      }
      return (text ? JSON.parse(text) : null) as T;
    } catch (err) {
      lastError = err;
      if (err instanceof AppError) throw err;
      if (attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new AppError('network', `Request to ${new URL(req.url).host} failed: ${message}`);
}

/**
 * Token bucket: allows short bursts (`capacity`) while keeping the long-run rate
 * at `perMinute`. AniList currently allows ~30 requests/minute.
 */
export class RateGate {
  private tokens: number;
  private updated = Date.now();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private capacity: number,
    private perMinute: number,
  ) {
    this.tokens = capacity;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const turn = this.chain.then(() => this.take());
    this.chain = turn.catch(() => undefined);
    return turn.then(fn);
  }

  private async take() {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.updated) / 60000) * this.perMinute);
      this.updated = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.perMinute) * 60000));
    }
  }
}
