import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../app/core/util';
import type { Provider } from '../app/shared/types';

/**
 * Sign-in through the user's own browser. AniVerse opens the provider's official
 * authorisation page, the provider redirects to an `aniverse://oauth/…` deep link,
 * the OS hands that link to the running app, and the main process matches it to
 * the transaction it started. AniVerse never sees the password and needs no server.
 *
 * - AniList: implicit grant (token in the URL fragment, valid for a year).
 * - MyAnimeList: authorisation code + PKCE, `plain` method (the only one MAL supports), public client.
 */

export const DEEP_LINK_SCHEME = 'aniverse';
export const REDIRECT_URI: Record<Provider, string> = {
  anilist: `${DEEP_LINK_SCHEME}://oauth/anilist`,
  mal: `${DEEP_LINK_SCHEME}://oauth/myanimelist`,
};
export const PROVIDER_NAME: Record<Provider, string> = { anilist: 'AniList', mal: 'MyAnimeList' };
/** How long a started sign-in stays valid. */
export const SIGN_IN_TTL_MS = 10 * 60 * 1000;
const MAX_CALLBACK_LENGTH = 16 * 1024;

export type OAuthGrant = { provider: 'anilist'; token: string; expiresIn: number | null } | { provider: 'mal'; code: string; verifier: string };

export interface OAuthCallback {
  provider: Provider;
  state: string | null;
  code: string | null;
  token: string | null;
  expiresIn: number | null;
  error: string | null;
  description: string | null;
}

/** 43–128 characters from the unreserved set (RFC 7636). */
export function pkceVerifier(): string {
  return randomBytes(64).toString('base64url'); // 86 characters
}

export function authorizeUrl(provider: Provider, clientId: string, state: string, verifier: string | null): string {
  if (provider === 'anilist') {
    // The redirect is the one registered for the client; AniList's implicit grant returns `state` in the fragment.
    const q = new URLSearchParams({ client_id: clientId, response_type: 'token', state });
    return `https://anilist.co/api/v2/oauth/authorize?${q}`;
  }
  if (!verifier) throw new AppError('internal', 'PKCE verifier missing');
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    state,
    redirect_uri: REDIRECT_URI.mal,
    code_challenge: verifier,
    code_challenge_method: 'plain',
  });
  return `https://myanimelist.net/v1/oauth2/authorize?${q}`;
}

/**
 * Callback hosts AniVerse answers to: `oauth` (documented) and `auth`, which is
 * what people naturally type when registering the app's Redirect URL.
 */
const CALLBACK_HOSTS = ['oauth', 'auth'];

/** Parses an `aniverse://oauth/<provider>` (or `aniverse://auth/<provider>`) link; null for anything else. */
export function parseCallback(raw: string): OAuthCallback | null {
  if (typeof raw !== 'string' || raw.length > MAX_CALLBACK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:` || !CALLBACK_HOSTS.includes(url.hostname) || url.username || url.password || url.port) return null;
  const route = url.pathname.replace(/\/+$/, '');
  const provider: Provider | null = route === '/anilist' ? 'anilist' : route === '/myanimelist' ? 'mal' : null;
  if (!provider) return null;
  const query = url.searchParams;
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  const pick = (key: string) => fragment.get(key) ?? query.get(key);
  const expires = Number(fragment.get('expires_in'));
  return {
    provider,
    state: pick('state'),
    code: query.get('code'),
    token: fragment.get('access_token'),
    expiresIn: Number.isFinite(expires) && expires > 0 ? expires : null,
    error: pick('error'),
    description: pick('error_description') ?? pick('message') ?? pick('hint'),
  };
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Drops query and fragment so tokens never reach logs. */
export function redactLink(raw: string): string {
  return raw.replace(/[?#].*$/s, '?…');
}

interface Transaction {
  state: string;
  verifier: string | null;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (grant: OAuthGrant) => void;
  reject: (err: Error) => void;
}

/**
 * Tracks sign-ins in progress. Each has a random `state`, expires after ten
 * minutes and can complete only once; links that match no transaction (stale,
 * replayed or forged) are ignored without disturbing a sign-in in progress.
 */
export class OAuthBroker {
  private pending = new Map<Provider, Transaction>();

  constructor(
    private clientIds: () => Record<Provider, string>,
    private openExternal: (url: string) => Promise<void>,
    private now: () => number = Date.now,
  ) {}

  configured(provider: Provider): boolean {
    return !!this.clientIds()[provider];
  }

  inProgress(provider: Provider): boolean {
    return this.pending.has(provider);
  }

  /** Opens the provider's sign-in page in the system browser; resolves when the deep link comes back. */
  begin(provider: Provider): Promise<OAuthGrant> {
    const clientId = this.clientIds()[provider];
    if (!clientId) return Promise.reject(new AppError('config', `${PROVIDER_NAME[provider]} sign-in isn’t available in this build (no client ID configured).`));
    this.fail(provider, new AppError('unauthorised', 'Sign-in restarted.'));
    const state = randomBytes(32).toString('base64url');
    const verifier = provider === 'mal' ? pkceVerifier() : null;
    const url = authorizeUrl(provider, clientId, state, verifier);
    return new Promise<OAuthGrant>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(provider, new AppError('unauthorised', 'Sign-in timed out. Click Connect to try again.')), SIGN_IN_TTL_MS);
      timer.unref?.();
      this.pending.set(provider, { state, verifier, startedAt: this.now(), timer, resolve, reject });
      this.openExternal(url).catch((err: unknown) => this.fail(provider, new AppError('internal', `Couldn’t open your browser: ${err instanceof Error ? err.message : String(err)}`)));
    });
  }

  cancel(provider: Provider) {
    this.fail(provider, new AppError('unauthorised', 'Sign-in was cancelled.'));
  }

  /**
   * Handles an `aniverse://` link from the OS. Returns 'accepted' when it completed
   * (or ended) a sign-in, 'ignored' for an OAuth link that matched nothing, and
   * 'unknown' for links that aren't OAuth callbacks.
   */
  handleUrl(raw: string): 'accepted' | 'ignored' | 'unknown' {
    const cb = parseCallback(raw);
    if (!cb) return this.misdirected(raw) ? 'accepted' : 'unknown';
    const tx = this.pending.get(cb.provider);
    if (!tx) return 'ignored';
    if (this.now() - tx.startedAt > SIGN_IN_TTL_MS) {
      this.fail(cb.provider, new AppError('unauthorised', 'Sign-in expired. Click Connect to try again.'));
      return 'accepted';
    }
    // A link whose state doesn't match is not ours: leave the real sign-in running.
    const stateOk = cb.state !== null && sameSecret(cb.state, tx.state);
    if (cb.error) {
      if (!stateOk) return 'ignored';
      const declined = cb.error === 'access_denied';
      this.fail(cb.provider, new AppError('unauthorised', declined ? `You declined access on ${PROVIDER_NAME[cb.provider]}.` : `${PROVIDER_NAME[cb.provider]}: ${cb.description ?? cb.error}`));
      return 'accepted';
    }
    if (cb.provider === 'mal') {
      if (!stateOk || !cb.code || !tx.verifier) return 'ignored';
      this.complete(cb.provider, { provider: 'mal', code: cb.code, verifier: tx.verifier });
      return 'accepted';
    }
    // AniList echoes `state` in the fragment; a link carrying a different state is rejected.
    // (Should it ever be dropped, the token is still only accepted while this sign-in is pending.)
    if (!cb.token || (cb.state !== null && !stateOk)) return 'ignored';
    this.complete(cb.provider, { provider: 'anilist', token: cb.token, expiresIn: cb.expiresIn });
    return 'accepted';
  }

  /**
   * A service sent the user back to some other aniverse:// address while its sign-in
   * was waiting — almost always a Redirect URL registered with a typo. End that
   * sign-in with the fix instead of waiting until it times out.
   */
  private misdirected(raw: string): boolean {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return false;
    const where = `${url.hostname}${url.pathname}`.toLowerCase();
    const provider: Provider | null = /anilist/.test(where) ? 'anilist' : /myanimelist|\bmal\b/.test(where) ? 'mal' : null;
    if (!provider || !this.pending.has(provider)) return false;
    this.fail(
      provider,
      new AppError(
        'config',
        `${PROVIDER_NAME[provider]} sent you back to ${redactLink(raw).replace(/\?…$/, '')}, but AniVerse expects ${REDIRECT_URI[provider]}. Set that exact Redirect URL in your ${PROVIDER_NAME[provider]} developer settings, save, then connect again.`,
      ),
    );
    return true;
  }

  private complete(provider: Provider, grant: OAuthGrant) {
    const tx = this.pending.get(provider);
    if (!tx) return;
    this.pending.delete(provider);
    clearTimeout(tx.timer);
    tx.resolve(grant);
  }

  private fail(provider: Provider, err: Error) {
    const tx = this.pending.get(provider);
    if (!tx) return;
    this.pending.delete(provider);
    clearTimeout(tx.timer);
    tx.reject(err);
  }
}
