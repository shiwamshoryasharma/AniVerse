import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { authorizeGoogle, googleTokens } from '../../electron/driveOAuth';
const credentials = { clientId: '123-fixture.apps.googleusercontent.com', clientSecret: 'fixture-secret' };
describe('Google desktop OAuth', () => {
  it('rejects mismatched state, then exchanges a valid one using PKCE and a loopback redirect', async () => {
    let challenge = '';
    const tokens = await authorizeGoogle(credentials, false, async (url, init) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const body = new URLSearchParams(String(init?.body));
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(challenge);
      expect(body.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
      return new Response(JSON.stringify({ access_token: 'access-fixture', refresh_token: 'refresh-fixture', expires_in: 3600 }));
    }, async (url) => {
      const auth = new URL(url); challenge = auth.searchParams.get('code_challenge')!;
      expect(auth.hostname).toBe('accounts.google.com');
      expect(auth.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
      const redirect = auth.searchParams.get('redirect_uri')!;
      const bad = new URL(redirect); bad.search = new URLSearchParams({ code: 'bad', state: 'é'.repeat(auth.searchParams.get('state')!.length) }).toString();
      expect((await fetch(bad)).status).toBe(400);
      const good = new URL(redirect); good.search = new URLSearchParams({ code: 'fixture-code', state: auth.searchParams.get('state')! }).toString();
      expect((await fetch(good)).ok).toBe(true);
    }, new AbortController().signal);
    expect(tokens.refreshToken).toBe('refresh-fixture');
  });
  it('retains the refresh token when Google only returns a new access token', async () => {
    const result = await googleTokens(async () => new Response(JSON.stringify({ access_token: 'new-fixture', expires_in: 3600 })), {}, 'old-refresh');
    expect(result.refreshToken).toBe('old-refresh');
  });
  it('cancels a pending sign-in and closes its loopback listener', async () => {
    const controller = new AbortController();
    await expect(authorizeGoogle(credentials, false, async () => { throw new Error('No token request expected'); }, async () => { controller.abort(); }, controller.signal)).rejects.toThrow(/cancelled/);
  });
});
