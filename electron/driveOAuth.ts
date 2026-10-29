import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { FetchFn } from '../app/core/net/http';
import { DRIVE_SCOPE, DRIVE_SHARED_SCOPE, type DriveCredentials } from '../app/shared/drive';
import { boundedText } from '../app/core/driveClient';

export interface GoogleTokens { accessToken: string; refreshToken: string; expiresAt: number }
const tokenSchema = z.object({ access_token: z.string().min(1).max(16000), refresh_token: z.string().max(16000).optional(), expires_in: z.number().positive().max(86400) });
export async function googleTokens(fetchFn: FetchFn, form: Record<string, string>, previousRefresh = ''): Promise<GoogleTokens> {
  const response = await fetchFn('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(),
    redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Google sign-in or refresh was rejected. Check the OAuth app configuration and reconnect.'); }
  const data = tokenSchema.parse(JSON.parse(await boundedText(response, 64000)));
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? previousRefresh, expiresAt: Date.now() + data.expires_in * 1000 };
}
export async function authorizeGoogle(credentials: DriveCredentials, shared: boolean, fetchFn: FetchFn, open: (url: string) => Promise<void>, signal: AbortSignal): Promise<GoogleTokens> {
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const server = createServer();
  let finish!: (code: string) => void, fail!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  // Mark rejection handled while awaiting browser launch.
  void result.catch(() => undefined);
  const abort = () => fail(new Error('Google sign-in cancelled.'));
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => fail(new Error('Google sign-in timed out. Try again.')), 180000);
  let consumed = false;
  try {
    if (signal.aborted) throw new Error('Google sign-in cancelled.');
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as AddressInfo).port;
    const redirect = 'http://127.0.0.1:' + port + '/oauth2callback';
    server.on('request', (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      const url = new URL(req.url ?? '/', redirect);
      const incoming = url.searchParams.get('state') ?? '';
      const incomingBytes = Buffer.from(incoming), expectedBytes = Buffer.from(state);
      const matches = incomingBytes.length === expectedBytes.length && timingSafeEqual(incomingBytes, expectedBytes);
      if (req.method !== 'GET' || req.headers.host !== '127.0.0.1:' + port || url.pathname !== '/oauth2callback' || consumed || !matches) { res.writeHead(400).end('Invalid sign-in response.'); return; }
      consumed = true;
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.has('error')) { res.end('Sign-in was not completed. Return to AniVerse.'); fail(new Error('Google sign-in was declined.')); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><title>AniVerse</title><p>Google Drive connected. You can return to AniVerse.</p>');
      finish(code);
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: credentials.clientId, redirect_uri: redirect, response_type: 'code',
      scope: shared ? DRIVE_SHARED_SCOPE : DRIVE_SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256',
      access_type: 'offline', prompt: 'consent select_account' }).toString();
    await open(url.href);
    const code = await result;
    return await googleTokens(fetchFn, { client_id: credentials.clientId, client_secret: credentials.clientSecret,
      redirect_uri: redirect, grant_type: 'authorization_code', code, code_verifier: verifier });
  } finally {
    clearTimeout(timeout); signal.removeEventListener('abort', abort);
    server.close(); server.closeAllConnections();
  }
}
