import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
await mkdir('test/cache', { recursive: true });
const temp = await mkdtemp(path.resolve('test/cache/electron-media-capture-'));
const profile = path.join(temp, 'profile');
await mkdir(profile);

let authenticated = false;
const server = createServer((request, response) => {
  if (request.url === '/watch') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'fixture-session=owned; Path=/; HttpOnly; SameSite=Lax',
    }).end('<script>window.play=()=>fetch("/asset?ticket=fixture",{headers:{Authorization:"Bearer fixture"}}).then(response=>response.status)</script>');
  } else if (request.url === '/asset?ticket=fixture') {
    authenticated = request.headers.authorization === 'Bearer fixture' &&
      request.headers.cookie === 'fixture-session=owned';
    response.writeHead(authenticated ? 200 : 403, {
      'Content-Type': 'application/dash+xml',
      'Cache-Control': 'no-store',
    }).end('<MPD/>');
  } else {
    response.writeHead(404).end();
  }
});

await writeFile(path.join(temp, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
let child;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const asset = base + '/asset?ticket=fixture';
  const source = [
    'import { app, BrowserWindow, session } from "electron";',
    'import { once } from "node:events";',
    'import assert from "node:assert/strict";',
    'import { SourceMediaCapture } from "./electron/sourceMediaCapture";',
    'import { observeSourceNetwork, cookiesForTopPlayer } from "./electron/ownedPlayerFrame";',
    'app.setPath("userData", process.env.ANIVERSE_CAPTURE_TEST_PROFILE);',
    '(async () => {',
    '  await app.whenReady();',
    '  const capture = new SourceMediaCapture();',
    '  const partition = "fixture-media-capture";',
    '  const browserSession = session.fromPartition(partition, { cache:false });',
    '  const window = new BrowserWindow({ show:false, webPreferences:{ webviewTag:true, sandbox:true, contextIsolation:true } });',
    '  let guest;',
    '  window.webContents.on("did-attach-webview", (_event, attached) => { guest=attached; capture.manage(attached); observeSourceNetwork(attached); });',
    '  browserSession.webRequest.onSendHeaders(details => { if(guest && details.webContentsId===guest.id) capture.request(guest, details); });',
    '  browserSession.webRequest.onResponseStarted(details => { if(guest && details.webContentsId===guest.id) capture.response(guest, details); });',
    '  await window.loadURL("data:text/html,<!doctype html><body></body>");',
    '  const attached=once(window.webContents,"did-attach-webview");',
    '  await window.webContents.executeJavaScript(' +
      JSON.stringify('const guest=document.createElement("webview");guest.partition="' + 'fixture-media-capture' +
        '";guest.src=' + JSON.stringify(base + '/watch') + ';document.body.append(guest);true') + ');',
    '  await attached;',
    '  await guest.debugger.sendCommand("Network.enable");',
    '  const ready = Date.now()+10000;',
    '  while(Date.now()<ready && !(await guest.executeJavaScript("Boolean(window.play)").catch(()=>false))) await new Promise(resolve=>setTimeout(resolve,50));',
    '  assert.equal(await guest.executeJavaScript("window.play()"),200);',
    '  const asset = ' + JSON.stringify(asset) + ';',
    '  const deadline = Date.now()+15000;',
    '  let found;',
    '  while(!found && Date.now()<deadline) {',
    '    const observation=capture.selected(guest,guest.mainFrame,[asset],await cookiesForTopPlayer(guest))[0]; found=observation?.headers?.cookie ? observation : undefined;',
    '    if(!found) await new Promise(resolve=>setTimeout(resolve,100));',
    '  }',
    '  assert.equal(found?.kind,"dash");',
    '  assert.equal(found?.headers?.authorization,"Bearer fixture");',
    '  assert.equal(found?.headers?.cookie,"fixture-session=owned");',
    '  assert.deepEqual(capture.selected(guest,guest.mainFrame,[asset+"&other=1"]),[]);',
    '  window.destroy();',
    '  app.exit(0);',
    '})().catch(error=>{console.error(error);app.exit(1);});',
  ].join('\n');
  await build({
    stdin: { contents: source, sourcefile: 'capture-main.ts', resolveDir: process.cwd(), loader: 'ts' },
    outfile: path.join(temp, 'main.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
  });
  child = spawn(require('electron'), [temp], {
    windowsHide: true,
    env: { ...process.env, TEMP: temp, TMP: temp, ANIVERSE_CAPTURE_TEST_PROFILE: profile },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const deadline = setTimeout(() => child.kill(), 30000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, 'Chromium did not report expected exact media context.');
    assert.equal(authenticated, true, 'The source did not receive playback credentials.');
  } finally {
    clearTimeout(deadline);
  }
} finally {
  if (child?.exitCode === null) child.kill();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log('Verified Chromium extensionless media MIME and exact-request Cookie/Authorization capture.');
