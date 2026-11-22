import { once } from 'node:events';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const cache = path.resolve('test/cache/aniverse2');
await mkdir(cache, { recursive: true });
const run = await mkdtemp(path.join(cache, 'electron-session-export-'));
const app = path.join(run, 'fixture.cjs');
const body = String.raw`
import { BrowserWindow, app, safeStorage, session } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { exportWebsiteSessions } from './electron/migrationWebsiteSessions';

const root = process.env.ANIVERSE2_COOKIE_FIXTURE;
const legacy = path.join(root, 'legacy');
const staging = path.join(root, 'staging');
const profile = 'f'.repeat(32);
const nonce = 'b65dd52b-81cb-48a8-a1bc-268c997cdf7d';
await mkdir(legacy, { recursive: true });
await mkdir(staging, { recursive: true });
await writeFile(path.join(legacy, 'profile.id'), profile);
app.setPath('userData', legacy);
await app.whenReady();
const own = session.fromPartition('persist:src-source-test');
const view = new BrowserWindow({ show: false, webPreferences: { session: own, sandbox: true } });
await view.loadURL('about:blank');
view.webContents.debugger.attach('1.3');
const expires = Date.now() / 1000 + 86400;
const origin = 'https://source.test';
const cookie = { url: origin, expires, secure: true, httpOnly: true, sameSite: 'Lax' };
await view.webContents.debugger.sendCommand('Network.setCookies', {cookies:[
  {...cookie, name:'fixture', value:'fixture-valid-secret', path:'/scope'},
  {...cookie, name:'domain', value:'fixture-domain-secret', domain:'.source.test'},
  {...cookie, name:'one_session', value:'fixture-temporary-secret', expires:-1},
  {...cookie, name:'other_site', value:'fixture-other-site', url:'https://other.test'},
  {...cookie, name:'chips', value:'fixture-chips-secret', sameSite:'None',
    partitionKey:{topLevelSite:'https://context.test', hasCrossSiteAncestor:true}},
]});
await own.cookies.flushStore();
const foreign = session.fromPartition('persist:src-foreign-test');
await foreign.cookies.set({ name:'foreign', value:'fixture-foreign-secret', url:origin, expirationDate:expires, httpOnly:true, secure:true, sameSite:'lax' });
await exportWebsiteSessions(legacy, staging, nonce, [
  { id:'source-test', partition:'persist:src-source-test', kind:'web', enabled:true, url:origin + '/browse' },
  { id:'foreign-test', partition:'persist:src-foreign-test', kind:'web', enabled:false, url:origin },
]);
const packed = await readFile(path.join(staging, 'website-sessions.json'), 'utf8');
assert.doesNotMatch(packed,/fixture-valid-secret|source\.test|fixture-chips-secret/);
const sealed = JSON.parse(packed);
assert.deepEqual(Object.keys(sealed), ['source-test']);
const decoded = safeStorage.decryptString(Buffer.from(sealed['source-test'].slice(5),'base64'));
const [boundProfile, body] = decoded.split('\n');
const data = JSON.parse(body);
assert.equal(boundProfile, profile);
assert.equal(data.nonce, nonce);
assert.equal(data.origin, origin);
assert.equal(data.cookies.length, 1);
assert.ok(Math.abs(data.cookies[0].expires - expires) < 0.01);
assert.deepEqual(data.cookies[0], {
  name:'fixture', value:'fixture-valid-secret', path:'/scope', httpOnly:true, expires:data.cookies[0].expires, sameSite:'Lax',
});
view.destroy();
await writeFile(path.join(root, 'result.json'), JSON.stringify({ passed:true, explicitSameHostOnly:true, encryptedAndNonceBound:true, noPrivateOrForeignJar:true, partitionedAndTransientCookiesExcluded:true }));
app.exit(0);
`;
const importsDone = body.indexOf('const root');
await build({
  stdin:{ contents: body.slice(0,importsDone) + '(async () => {' + body.slice(importsDone) +
    '})().catch(error => { console.error(error.message); app.exit(1); });', resolveDir:process.cwd() },
  external:['electron'], format:'cjs', bundle:true, platform:'node', outfile:app,
});
const exe = createRequire(import.meta.url)('electron');
const child = spawn(exe, [app], { env:{ ...process.env, ANIVERSE2_COOKIE_FIXTURE:run, TEMP:run, TMP:run }, stdio:'inherit', windowsHide:true });
const [exit] = await once(child,'exit');
assert.equal(exit,0);
const result = JSON.parse(await readFile(path.join(run,'result.json'),'utf8'));
await mkdir('test/artifacts',{recursive:true});
await writeFile('test/artifacts/aniverse2-electron-session-export-windows.json', JSON.stringify(result,null,2) + '\n');
console.log(result);
