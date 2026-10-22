import type { StoredAccount, Store } from '../app/core/db/store';
import type { FetchFn } from '../app/core/net/http';
import { malToken, type SyncProvider } from '../app/core/sync/providers';
import type { TokenSource } from '../app/core/sync/syncService';
import { AppError, nowSec } from '../app/core/util';
import type { Provider } from '../app/shared/types';
import { PROVIDER_NAME, REDIRECT_URI, type OAuthBroker } from './oauth';

/** MAL access tokens are refreshed when less than this is left. */
const MAL_REFRESH_AHEAD = 24 * 3600;

/**
 * Owns the AniList / MyAnimeList sessions of this AniVerse profile: browser
 * sign-in, token exchange, MAL refresh (one at a time, so a rotated refresh
 * token is never used twice) and the "reconnect" state when a service revokes
 * or expires a session. Both services are independent: one failing never
 * touches the other.
 */
export class AccountManager implements TokenSource {
  private refreshing = new Map<Provider, Promise<string>>();

  constructor(
    private store: Store,
    private broker: OAuthBroker,
    private providers: Record<Provider, SyncProvider>,
    private fetchFn: FetchFn,
    private clientIds: () => Record<Provider, string>,
    private secureStorage: boolean,
  ) {}

  status(provider: Provider) {
    return { configured: this.broker.configured(provider), signingIn: this.broker.inProgress(provider), secureStorage: this.secureStorage };
  }

  /** Browser sign-in → tokens → profile → saved (encrypted) account. */
  async connect(provider: Provider): Promise<void> {
    const grant = await this.broker.begin(provider);
    let token: string;
    let refreshToken: string | null = null;
    let expiresAt: number | null = null;
    if (grant.provider === 'anilist') {
      token = grant.token;
      expiresAt = grant.expiresIn ? nowSec() + grant.expiresIn : null;
    } else {
      const tok = await malToken(this.fetchFn, {
        client_id: this.clientIds().mal,
        grant_type: 'authorization_code',
        code: grant.code,
        code_verifier: grant.verifier,
        redirect_uri: REDIRECT_URI.mal,
      });
      token = tok.access_token;
      refreshToken = tok.refresh_token ?? null;
      expiresAt = nowSec() + tok.expires_in;
    }
    const profile = await this.providers[provider].profile(token).catch((err: unknown) => {
      if (err instanceof AppError && err.code === 'unauthorised') throw new AppError('unauthorised', `${PROVIDER_NAME[provider]} didn’t accept the sign-in. Try connecting again.`);
      throw err;
    });
    const previous = this.store.getAccount(provider);
    const sameUser = previous?.userId === profile.userId;
    // Signing in as someone else must not push the previous user's pending changes into the new account.
    if (previous && !sameUser) this.store.clearSyncQueue(provider);
    this.store.saveAccount({
      provider,
      token,
      refreshToken,
      expiresAt,
      ...profile,
      lastSyncAt: sameUser ? (previous?.lastSyncAt ?? null) : null,
      lastError: null,
      needsReconnect: false,
    });
  }

  cancel(provider: Provider) {
    this.broker.cancel(provider);
  }

  disconnect(provider: Provider) {
    this.broker.cancel(provider);
    this.store.deleteAccount(provider);
  }

  async token(provider: Provider): Promise<string> {
    const account = this.account(provider);
    const left = account.expiresAt === null ? Infinity : account.expiresAt - nowSec();
    if (provider === 'mal' && account.refreshToken && left < MAL_REFRESH_AHEAD) {
      try {
        return await this.refresh(provider, account.refreshToken);
      } catch (err) {
        // Offline refresh while the current token still works: use it, refresh next time.
        if (left > 60 && !(err instanceof AppError && err.code === 'unauthorised')) return account.token;
        throw err;
      }
    }
    if (left <= 0) throw this.expire(provider);
    return account.token;
  }

  async rejected(provider: Provider): Promise<string | null> {
    const account = this.store.getAccount(provider);
    if (!account || account.needsReconnect) return null;
    // A 401/403 can also mean "not allowed for this item": ask the service who we are first.
    const sessionOk = await this.providers[provider]
      .profile(account.token)
      .then(() => true)
      .catch((err) => !(err instanceof AppError && err.code === 'unauthorised'));
    if (sessionOk) return null;
    if (provider === 'mal' && account.refreshToken) {
      try {
        return await this.refresh(provider, account.refreshToken);
      } catch {
        return null; // refresh() already asked for a reconnect if MAL refused it
      }
    }
    this.expire(provider);
    return null;
  }

  private account(provider: Provider): StoredAccount {
    const account = this.store.getAccount(provider);
    if (!account) throw new AppError('unauthorised', `${PROVIDER_NAME[provider]} isn’t connected.`);
    if (account.needsReconnect) throw this.reconnectError(provider);
    return account;
  }

  private refresh(provider: Provider, refreshToken: string): Promise<string> {
    const running = this.refreshing.get(provider);
    if (running) return running;
    const job = (async () => {
      try {
        const tok = await malToken(this.fetchFn, { client_id: this.clientIds().mal, grant_type: 'refresh_token', refresh_token: refreshToken });
        this.store.patchAccount(provider, {
          token: tok.access_token,
          refreshToken: tok.refresh_token ?? refreshToken,
          expiresAt: nowSec() + tok.expires_in,
          needsReconnect: false,
          lastError: null,
        });
        return tok.access_token;
      } catch (err) {
        if (err instanceof AppError && err.code === 'unauthorised') throw this.expire(provider);
        throw err;
      } finally {
        this.refreshing.delete(provider);
      }
    })();
    this.refreshing.set(provider, job);
    return job;
  }

  /** Keeps the account (and its queued changes) but asks the user to reconnect. */
  private expire(provider: Provider): AppError {
    const error = this.reconnectError(provider);
    this.store.patchAccount(provider, { needsReconnect: true, lastError: error.message });
    return error;
  }

  private reconnectError(provider: Provider): AppError {
    return new AppError('unauthorised', `Your ${PROVIDER_NAME[provider]} session expired. Reconnect in Settings → Accounts.`);
  }
}
