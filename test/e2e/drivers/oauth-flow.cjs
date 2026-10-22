// OAuth deep-link flow, end to end inside the app (no real accounts needed).
// Build with placeholder client IDs first, e.g.
//   ANIVERSE_ANILIST_CLIENT_ID=12345 ANIVERSE_MAL_CLIENT_ID=0123456789abcdef0123456789abcdef npm run build
//   node test/e2e/native.mjs test/e2e/drivers/oauth-flow.cjs
// The system browser is stubbed: the driver reads the authorisation URL AniVerse
// would open, then hands aniverse:// links to the app the way the OS does (a second
// instance's command line). Real providers then reject the placeholder token/code,
// which exercises the token exchange and error paths.
// Output: test/artifacts/oauth-flow.json + accounts-*.png
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const artifacts = path.join(root, 'test', 'artifacts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function oauthFlow({ window }) {
  const { app, shell } = require('electron');
  const opened = [];
  shell.openExternal = async (url) => void opened.push(url); // never open the user's browser from a test

  const ui = (code) => window.webContents.executeJavaScript(code, true);
  const rpc = (method, input) => ui(`window.aniverse.invoke(${JSON.stringify(method)}, ${input === undefined ? 'undefined' : JSON.stringify(input)}).catch((e) => ({ error: e.message }))`);
  const until = async (check, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
      const v = await check();
      if (v) return v;
    }
    return null;
  };
  const deliver = (link) => app.emit('second-instance', {}, [process.execPath, '.', link], root);
  const shot = async (name) => writeFileSync(path.join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  const account = async (p) => (await rpc('accounts.list')).find((a) => a.provider === p);
  const params = (url) => Object.fromEntries(new URL(url).searchParams);
  const out = {};

  await until(() => ui(`!!document.querySelector('.app')`), 30000);
  await ui(`location.hash = '#/settings/accounts'`);
  await until(() => ui(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Connect')`));
  out.initial = await rpc('accounts.list');
  await sleep(600);
  await shot('accounts-settings');

  // AniList through the UI: Connect → browser (stubbed) → deep link back.
  await ui(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Connect').click()`);
  await until(() => opened.length >= 1);
  const ani = opened[0];
  out.anilistAuthorize = { url: ani.split('?')[0], params: { ...params(ani), state: params(ani).state ? '(random)' : null } };
  await sleep(500);
  out.waitingShown = await ui(`/Waiting for AniList/.test(document.body.innerText)`);
  await shot('accounts-waiting');
  deliver('aniverse://oauth/anilist#access_token=FORGED&state=not-the-state');
  await sleep(400);
  out.forgedIgnored = (await account('anilist')).signingIn === true;
  deliver(`aniverse://oauth/anilist#access_token=PLACEHOLDER&token_type=Bearer&expires_in=31536000&state=${params(ani).state}`);
  await until(async () => !(await account('anilist')).signingIn);
  await sleep(1500);
  out.anilistAfter = await account('anilist');
  out.anilistToast = await ui(`[...document.querySelectorAll('.toast, [role="status"]')].map((t) => t.innerText).filter(Boolean).join(' | ')`);
  await shot('accounts-anilist-rejected');

  // MyAnimeList through RPC: PKCE code exchange against the real token endpoint.
  const mal = rpc('accounts.connect', { provider: 'mal' });
  await until(() => opened.length >= 2);
  const m = params(opened[1]);
  out.malAuthorize = { url: opened[1].split('?')[0], params: { ...m, state: '(random)', code_challenge: `(${m.code_challenge?.length} chars)` } };
  deliver(`aniverse://oauth/myanimelist?code=PLACEHOLDER&state=${m.state}`);
  out.malResult = await mal;

  // Cancel, and a link arriving after the sign-in ended.
  const cancelled = rpc('accounts.connect', { provider: 'anilist' });
  await until(() => opened.length >= 3);
  await rpc('accounts.cancel', { provider: 'anilist' });
  out.cancelResult = await cancelled;
  deliver(`aniverse://oauth/anilist#access_token=LATE&state=${params(opened[2]).state}`);
  await sleep(300);
  out.lateLinkConnected = (await account('anilist')).connected;
  out.protocolRegisteredByTest = false; // TEST runs skip registerDeepLinks(); see main.ts TEST_RUN

  writeFileSync(path.join(artifacts, 'oauth-flow.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
};
