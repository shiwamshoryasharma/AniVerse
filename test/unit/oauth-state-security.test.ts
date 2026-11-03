import { describe, expect, it, vi } from 'vitest';
import { AccountManager } from '../../electron/accounts';
import { OAuthBroker, SIGN_IN_TTL_MS } from '../../electron/oauth';

const clientIds = () => ({ anilist: '12345', mal: '0123456789abcdef0123456789abcdef' });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
  const opened: string[] = [];
  const now = { value: 1_000_000 };
  const broker = new OAuthBroker(clientIds, async url => void opened.push(url), () => now.value);
  const previous = { provider: 'anilist', userId: 7, userName: 'Existing user', token: 'EXISTING', lastSyncAt: 42 };
  const store = { getAccount: vi.fn(() => previous), saveAccount: vi.fn(), clearSyncQueue: vi.fn() };
  const profile = vi.fn(async (token: string) => ({ userId: token === 'ATTACKER' ? 666 : 7, userName: token === 'ATTACKER' ? 'Attacker' : 'Existing user', avatar: null }));
  const providers = { anilist: { profile }, mal: { profile: vi.fn() } };
  const account = new AccountManager(store as never, broker, providers as never, vi.fn() as never, clientIds, true);
  const state = () => new URL(opened.at(-1)!).searchParams.get('state')!;
  return { broker, account, store, profile, state, now };
}

function settled<T>(promise: Promise<T>) {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
}

describe('OAuth callback transaction binding', () => {
  it.each([
    ['missing state', () => 'aniverse://oauth/anilist#access_token=ATTACKER'],
    ['wrong state', () => 'aniverse://oauth/anilist#access_token=ATTACKER&state=wrong'],
    ['empty state', () => 'aniverse://oauth/anilist#access_token=ATTACKER&state='],
    ['empty fragment state overriding query state', (state: string) => `aniverse://auth/anilist?state=${state}#access_token=ATTACKER&state=`],
  ])('ignores %s without persisting an attacker or consuming the pending login', async (_label, forged) => {
    const f = fixture();
    const connecting = settled(f.account.connect('anilist'));
    try {
      expect.soft(f.broker.handleUrl(forged(f.state()))).toBe('ignored');
      await tick();
      expect.soft(f.broker.inProgress('anilist')).toBe(true);
      expect.soft(f.profile).not.toHaveBeenCalled();
      expect.soft(f.store.saveAccount).not.toHaveBeenCalled();
      expect.soft(f.store.clearSyncQueue).not.toHaveBeenCalled();
      expect.soft(f.broker.handleUrl(`aniverse://oauth/anilist#access_token=LEGITIMATE&state=${f.state()}&expires_in=60`)).toBe('accepted');
      expect(await connecting).toMatchObject({ ok: true });
      expect(f.profile).toHaveBeenCalledExactlyOnceWith('LEGITIMATE');
      expect(f.store.saveAccount).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ token: 'LEGITIMATE', userId: 7, lastSyncAt: 42 }));
      expect(f.store.clearSyncQueue).not.toHaveBeenCalled();
    } finally {
      f.broker.cancel('anilist');
      await connecting;
    }
  });

  it.each([
    ['fragment state', (state: string) => `aniverse://oauth/anilist#access_token=LEGITIMATE&state=${state}`],
    ['query state fallback', (state: string) => `aniverse://oauth/anilist?state=${state}#access_token=LEGITIMATE`],
    ['auth host alias', (state: string) => `aniverse://auth/anilist#access_token=LEGITIMATE&state=${state}`],
  ])('preserves %s and refuses replay after account persistence', async (_label, callback) => {
    const f = fixture();
    const connecting = settled(f.account.connect('anilist'));
    try {
      const url = callback(f.state());
      expect(f.broker.handleUrl(url)).toBe('accepted');
      expect(await connecting).toMatchObject({ ok: true });
      expect(f.broker.handleUrl(url)).toBe('ignored');
      expect(f.store.saveAccount).toHaveBeenCalledTimes(1);
      expect(f.broker.inProgress('anilist')).toBe(false);
    } finally {
      f.broker.cancel('anilist');
      await connecting;
    }
  });

  it('does not persist an otherwise valid callback after transaction expiry', async () => {
    const f = fixture();
    const connecting = settled(f.account.connect('anilist'));
    f.now.value += SIGN_IN_TTL_MS + 1;
    expect(f.broker.handleUrl(`aniverse://oauth/anilist#access_token=LEGITIMATE&state=${f.state()}`)).toBe('accepted');
    expect(await connecting).toMatchObject({ ok: false, error: expect.objectContaining({ message: expect.stringMatching(/expired/i) }) });
    expect(f.store.saveAccount).not.toHaveBeenCalled();
    expect(f.profile).not.toHaveBeenCalled();
  });

  it('keeps MAL state and PKCE binding, including rejection of an AniList transaction state', async () => {
    const f = fixture();
    const anilist = settled(f.broker.begin('anilist'));
    const anilistState = f.state();
    const mal = settled(f.broker.begin('mal'));
    const malState = f.state();
    try {
      for (const state of ['', 'wrong', anilistState]) {
        expect(f.broker.handleUrl(`aniverse://oauth/myanimelist?code=ATTACKER&state=${state}`)).toBe('ignored');
        expect(f.broker.inProgress('mal')).toBe(true);
      }
      expect(f.broker.handleUrl('aniverse://oauth/myanimelist?code=ATTACKER')).toBe('ignored');
      expect(f.broker.handleUrl(`aniverse://oauth/myanimelist?code=GOOD&state=${malState}`)).toBe('accepted');
      expect(await mal).toMatchObject({ ok: true, value: { provider: 'mal', code: 'GOOD', verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43,128}$/) } });
      expect(f.broker.handleUrl(`aniverse://oauth/myanimelist?code=GOOD&state=${malState}`)).toBe('ignored');
      expect(f.broker.inProgress('anilist')).toBe(true);
    } finally {
      f.broker.cancel('anilist');
      f.broker.cancel('mal');
      await Promise.all([anilist, mal]);
    }
  });
});
