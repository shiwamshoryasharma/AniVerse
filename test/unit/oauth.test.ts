import { describe, expect, it, vi } from 'vitest';
import { reconcile, sameEntry } from '../../app/core/sync/reconcile';
import { authorizeUrl, OAuthBroker, parseCallback, pkceVerifier, redactLink, REDIRECT_URI, SIGN_IN_TTL_MS } from '../../electron/oauth';

const ids = () => ({ anilist: '12345', mal: 'abcdef0123456789abcdef0123456789' });

function broker(now = { t: 1_000_000 }) {
  const opened: string[] = [];
  const b = new OAuthBroker(ids, async (url) => void opened.push(url), () => now.t);
  const stateOf = () => new URL(opened.at(-1)!).searchParams.get('state')!;
  return { b, opened, stateOf, now };
}

describe('OAuth URLs and callbacks', () => {
  it('builds the official authorisation URLs', () => {
    const a = new URL(authorizeUrl('anilist', '12345', 'st', null));
    expect(a.origin + a.pathname).toBe('https://anilist.co/api/v2/oauth/authorize');
    expect(Object.fromEntries(a.searchParams)).toEqual({ client_id: '12345', response_type: 'token', state: 'st' });

    const v = pkceVerifier();
    expect(v).toMatch(/^[A-Za-z0-9\-_]{43,128}$/);
    const m = new URL(authorizeUrl('mal', 'cid', 'st', v));
    expect(m.origin + m.pathname).toBe('https://myanimelist.net/v1/oauth2/authorize');
    expect(Object.fromEntries(m.searchParams)).toEqual({ response_type: 'code', client_id: 'cid', state: 'st', redirect_uri: REDIRECT_URI.mal, code_challenge: v, code_challenge_method: 'plain' });
  });

  it('parses only aniverse://oauth/<provider> links', () => {
    expect(parseCallback('aniverse://oauth/anilist#access_token=TOK&token_type=Bearer&expires_in=31536000&state=s')).toMatchObject({ provider: 'anilist', token: 'TOK', expiresIn: 31536000, state: 's' });
    expect(parseCallback('aniverse://oauth/myanimelist/?code=C&state=s')).toMatchObject({ provider: 'mal', code: 'C', state: 's' });
    expect(parseCallback('aniverse://oauth/myanimelist?error=access_denied&message=no&state=s')).toMatchObject({ error: 'access_denied', description: 'no' });
    // `auth` is accepted too (what people tend to register).
    expect(parseCallback('aniverse://auth/anilist#access_token=TOK&state=s')).toMatchObject({ provider: 'anilist', token: 'TOK' });
    for (const bad of ['https://oauth/anilist#access_token=x', 'aniverse://evil/anilist#access_token=x', 'aniverse://oauth/other?code=x', 'aniverse://user:pw@oauth/anilist', `aniverse://oauth/anilist#${'a'.repeat(20000)}`, 'not a url']) {
      expect(parseCallback(bad)).toBeNull();
    }
    expect(redactLink('aniverse://oauth/anilist#access_token=SECRET')).toBe('aniverse://oauth/anilist?…');
  });
});

describe('OAuthBroker', () => {
  it('completes a MyAnimeList sign-in once, with the verifier it generated', async () => {
    const { b, opened, stateOf } = broker();
    const grant = b.begin('mal');
    expect(b.inProgress('mal')).toBe(true);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    const verifier = new URL(opened[0]).searchParams.get('code_challenge');
    // A forged/stale link with another state is ignored and the real sign-in keeps waiting.
    expect(b.handleUrl('aniverse://oauth/myanimelist?code=EVIL&state=wrong')).toBe('ignored');
    expect(b.inProgress('mal')).toBe(true);
    expect(b.handleUrl(`aniverse://oauth/myanimelist?code=GOOD&state=${stateOf()}`)).toBe('accepted');
    await expect(grant).resolves.toEqual({ provider: 'mal', code: 'GOOD', verifier });
    // Replaying the same link does nothing.
    expect(b.handleUrl(`aniverse://oauth/myanimelist?code=GOOD&state=${stateOf()}`)).toBe('ignored');
  });

  it('accepts the AniList token from the fragment and checks an echoed state', async () => {
    const { b, opened, stateOf } = broker();
    const grant = b.begin('anilist');
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(b.handleUrl('aniverse://oauth/anilist#access_token=X&state=other')).toBe('ignored');
    expect(b.handleUrl(`aniverse://oauth/anilist#access_token=TOKEN&expires_in=60&state=${stateOf()}`)).toBe('accepted');
    await expect(grant).resolves.toEqual({ provider: 'anilist', token: 'TOKEN', expiresIn: 60 });
    expect(b.handleUrl('aniverse://oauth/anilist#access_token=LATE')).toBe('ignored');
    expect(b.handleUrl('aniverse://something/else')).toBe('unknown');
  });

  it('ends a sign-in that comes back to a mistyped redirect with the fix', async () => {
    const { b, opened } = broker();
    const grant = b.begin('anilist');
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(b.handleUrl('aniverse://oath/anilist#access_token=T&state=s')).toBe('accepted');
    await expect(grant).rejects.toThrow('sent you back to aniverse://oath/anilist, but AniVerse expects aniverse://oauth/anilist');
    // Nothing pending: the same link is just unknown.
    expect(b.handleUrl('aniverse://oath/anilist#access_token=T')).toBe('unknown');
  });

  it('reports a declined authorisation, expiry, restarts and missing client IDs', async () => {
    const { b, opened, stateOf, now } = broker();
    const declined = b.begin('mal');
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    b.handleUrl(`aniverse://oauth/myanimelist?error=access_denied&state=${stateOf()}`);
    await expect(declined).rejects.toThrow(/declined/);

    const expired = b.begin('anilist');
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    now.t += SIGN_IN_TTL_MS + 1;
    b.handleUrl(`aniverse://oauth/anilist#access_token=T&state=${stateOf()}`);
    await expect(expired).rejects.toThrow(/expired/);

    const first = b.begin('anilist');
    const second = b.begin('anilist');
    await expect(first).rejects.toThrow(/restarted/);
    b.cancel('anilist');
    await expect(second).rejects.toThrow(/cancelled/);

    const none = new OAuthBroker(() => ({ anilist: '', mal: '' }), async () => undefined);
    await expect(none.begin('anilist')).rejects.toThrow(/no client ID/);
    expect(none.configured('mal')).toBe(false);
  });
});

describe('reconcile', () => {
  const s = (status: 'CURRENT' | 'COMPLETED', progress: number, score: number | null = null) => ({ status, progress, score });

  it('compares entries at each service’s precision and never erases a remote score', () => {
    expect(sameEntry(s('CURRENT', 3, 7.6), s('CURRENT', 3, 8), 'mal')).toBe(true);
    expect(sameEntry(s('CURRENT', 3, 7.6), s('CURRENT', 3, 8), 'anilist')).toBe(false);
    expect(sameEntry(s('CURRENT', 3, null), s('CURRENT', 3, 9), 'anilist')).toBe(true);
    expect(sameEntry(s('CURRENT', 3, 9), s('CURRENT', 3, null), 'anilist')).toBe(false);
  });

  it('newest edit wins and propagates to the other service; ties keep AniVerse', () => {
    const r = reconcile({
      local: { state: s('CURRENT', 2), updatedAt: 100 },
      remotes: { anilist: { state: s('CURRENT', 5, 8), updatedAt: 200 }, mal: { state: s('CURRENT', 2), updatedAt: 90 } },
      targets: ['anilist', 'mal'],
      lastSyncAt: { anilist: 50, mal: 50 },
      pendingLocal: true,
    });
    expect(r).toEqual({ apply: { from: 'anilist', state: s('CURRENT', 5, 8), updatedAt: 200 }, push: ['mal'], drop: ['anilist'], conflict: true });

    const tie = reconcile({ local: { state: s('CURRENT', 2), updatedAt: 100 }, remotes: { anilist: { state: s('CURRENT', 3), updatedAt: 100 } }, targets: ['anilist'], lastSyncAt: {}, pendingLocal: false });
    expect(tie.apply).toBeNull();
    expect(tie.push).toEqual(['anilist']);
  });

  it('pushes a title missing on a service only if it changed since that service’s last sync', () => {
    const base = { local: { state: s('COMPLETED', 12), updatedAt: 100 }, remotes: {}, targets: ['mal' as const], pendingLocal: false };
    expect(reconcile({ ...base, lastSyncAt: { mal: 150 } }).push).toEqual([]); // removed on MAL: don't resurrect
    expect(reconcile({ ...base, lastSyncAt: { mal: 50 } }).push).toEqual(['mal']);
    expect(reconcile({ ...base, lastSyncAt: { mal: null } }).push).toEqual(['mal']); // first sync
  });

  it('keeps AniVerse’s score when the newer service entry has none', () => {
    const r = reconcile({ local: { state: s('CURRENT', 1, 7), updatedAt: 10 }, remotes: { mal: { state: s('CURRENT', 4), updatedAt: 20 } }, targets: ['mal'], lastSyncAt: {}, pendingLocal: false });
    expect(r.apply?.state).toEqual(s('CURRENT', 4, 7));
  });
});
