import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createServer as reservePort} from 'node:net';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';

const run = await mkdtemp(resolve('test/cache/aniverse2/rendered-catalogue-'));
const profile = join(run, 'profile');
const discovery = process.env.ANIVERSE2_CHECK_SOURCE_DISCOVERY === '1';
const cookieObservations = [];
let seeded = false;
let destinationRequests = 0;
let catalogueNavigations = 0;
const destination = createServer((_request, response) => {
  destinationRequests += 1;
  response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
  response.end(`<!doctype html><title>Fixture Redirect</title><h1>Fixture Redirect</h1>
    <main><button aria-pressed="true">SUB</button><button aria-pressed="false">DUB</button>
    <div class="episode"><button data-episode="1" aria-selected="true">Episode 1</button></div></main>
    <script>const tabs=[...document.querySelectorAll('[aria-pressed]')];
    for(const tab of tabs)tab.onclick=()=>tabs.forEach(item=>item.setAttribute('aria-pressed', item===tab));</script>`);
});
destination.listen(0, '127.0.0.1');
await once(destination, 'listening');
const redirectOrigin = 'http://127.0.0.1:' + destination.address().port;
const redirectURL = redirectOrigin + '/watch/fixture-redirect/1';
const server = createServer((request, response) => {
  if (request.url === '/discovery-seed') {
    seeded = true;
    response.writeHead(200, {'Content-Type':'text/plain','Set-Cookie':'fixture-session=normal; Path=/; HttpOnly'});
    response.end('regular source profile');
    return;
  }
  if (request.url === '/discovery') {
    cookieObservations.push(request.headers.cookie ?? null);
    response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    response.end(`<!doctype html>
      <form method="get" action="${redirectOrigin}/search"><input type="search" name="q"></form>
      <form method="post" action="/wrong"><input type="search" name="q"></form>
      <form method="get" action="/search"><input type="hidden" name="private" value="must-not-be-learned">
        <input type="search" name="q" aria-label="Search"></form>`);
    return;
  }
  if (request.url === '/discovery-rejected') {
    response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    response.end(`<!doctype html>
      <form method="get" action="/api/search"><input type="search" name="q"></form>
      <form method="get" action="/search?token=must-not-be-learned"><input type="search" name="q"></form>
      <a href="${redirectOrigin}/search?q=external">External search</a>`);
    return;
  }
  if (request.url === '/alias') {
    response.writeHead(302, {Location:redirectURL});
    response.end();
    return;
  }
  if (request.url === '/') catalogueNavigations += 1;
  response.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  response.end('<!doctype html><meta charset=utf-8><main><h2>Latest episodes</h2><section></section></main>' +
    '<script>' + renderCatalogue.toString() + ';renderCatalogue()</script>');
});

function renderCatalogue() {
  const cards = [
    [['Mixed first', 12, 11], ['Sub only', 12, 0]],
    [['Mixed second', 7, 4]],
  ];
  const section = document.querySelector('section');
  const cover = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  let number = 0, mode = 'all';
  const draw = () => {
    section.innerHTML = ['all','sub','dub'].map(audio =>
      '<button aria-pressed="' + (mode === audio) + '">' + audio.toUpperCase() + '</button>').join('') +
      cards[number].filter(([, sub, dub]) => mode === 'all' || (sub > 0 && (mode !== 'dub' || dub > 0)))
        .map(([title,sub,dub]) => '<a href="/title/' + title.toLowerCase().replace(' ','-') +
          '" data-sub-count="' + sub + '" data-dub-count="' + dub + '"><img src="' + cover + '" alt="' + title + '"></a>').join('') +
      '<button' + (number ? ' disabled' : '') + '>Next page</button>';
    for (const button of section.querySelectorAll('button')) button.onclick = () => {
      if (button.textContent === 'Next page') number += 1;
      else mode = button.textContent.toLowerCase();
      draw();
    };
  };
  draw();
}

server.listen(0,'127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
await mkdir(join(profile,'config'),{recursive:true});
const sites = [origin + '/',origin + '/alias',redirectURL];
if (discovery) sites.push(origin + '/discovery', origin + '/discovery-rejected');
await writeFile(join(profile,'config','streaming-sites.txt'),sites.join('\r\n'));
const socket = reservePort().listen(0,'127.0.0.1');
await once(socket,'listening');
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const endpoint = 'http://127.0.0.1:' + port;
const env = {...process.env,ANIVERSE2_TEST_PROFILE:profile,ANIVERSE2_TEST_SITE_ORIGIN:origin,ANIVERSE2_TEST_REDIRECT_ORIGIN:redirectOrigin,
  TEMP:run,TMP:run,TMPDIR:run,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=' + port +
  ' --remote-debugging-address=127.0.0.1'};
delete env.WEBVIEW2_USER_DATA_FOLDER;
delete env.ANIVERSE_ELECTRON_HANDOFF;
const child = spawn(resolve(process.env.ANIVERSE2_TEST_EXE ?? 'test/cache/aniverse2/aniverse2-player-test.exe'),
  [],{windowsHide:true,stdio:'ignore',env});
const exit = once(child,'exit').catch(() => undefined);
let browser, launchError;
child.on('error', error => { launchError = error; });
const report = {passed:false,checks:{}};
try {
  const deadline = Date.now() + 15000;
  while (!browser && Date.now() < deadline) {
    if (launchError || child.exitCode !== null) throw launchError ?? Error('Fixture executable exited');
    try {browser = await chromium.connectOverCDP(endpoint,{timeout:400});} catch {await delay(150);}
  }
  assert.ok(browser,'Fixture executable did not expose its local test connection');
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page');
  await page.waitForURL('https://tauri.localhost/**');
  const rpc = (method,input) => page.evaluate(data => window.__TAURI__.core.invoke('desktop_rpc',data),{method,input});
  const [source,alias,redirectSource,discoverable,rejectedDiscovery] = await rpc('sources.list');
  assert.equal(redirectSource.url,redirectURL);
  const request = (audio,page) => rpc('sources.catalogue',{sourceId:source.id,audio,page});
  const [dub,sub,duplicate] = await Promise.all([request('dub',1),request('sub',1),request('dub',1)]);
  assert.deepEqual(dub.items.map(x=>[x.title,x.sub,x.dub]),[['Mixed first',12,11]]);
  assert.deepEqual(sub.items.map(x=>[x.title,x.sub,x.dub]),[['Mixed first',12,11],['Sub only',12,0]]);
  report.checks.freshCatalogueWithOverlappingAudio = true;
  assert.deepEqual(duplicate, dub);
  assert.equal(catalogueNavigations,2,'Identical requests must share one rendered read without conflating SUB and DUB');
  assert.deepEqual(await request('dub',1),dub);
  assert.equal(catalogueNavigations,2,'A fresh snapshot should avoid a third navigation');
  report.checks.catalogueDeduplication = true;
  const second = await request('dub',2);
  assert.equal(second.page,2);
  assert.equal(second.hasNext,false);
  assert.deepEqual(second.items.map(x=>x.title),['Mixed second']);
  report.checks.sitePagination = true;

  const sourceView = target => rpc('site.surface',{action:'attach',sourceId:target.id,
    partition:target.partition,bounds:{x:0,y:0,width:900,height:600}});
  const openEpisode = (target,webContentsId) => rpc('site.openEpisode',{sourceId:target.id,webContentsId,
    mediaId:1,episode:1,titles:['Fixture Redirect'],focus:false});
  if (discovery) {
    const regular = await sourceView(discoverable);
    const navigate = url => rpc('site.surface',{action:'navigate',webContentsId:regular.webContentsId,url});
    const waitFor = async check => {
      const finish = Date.now() + 5000;
      while (!check() && Date.now() < finish) await delay(100);
      assert.ok(check());
    };
    await navigate(origin + '/discovery-seed');
    await waitFor(() => seeded);
    await navigate(discoverable.url);
    await waitFor(() => cookieObservations.some(cookie => cookie?.includes('fixture-session=normal')));
    await rpc('site.surface',{action:'detach',webContentsId:regular.webContentsId});
    const before = cookieObservations.length;
    const learned = await rpc('sources.discover',{id:discoverable.id});
    assert.equal(learned.searchTemplate,origin + '/search?q={query}');
    assert.equal(learned.searchTemplateSource,'form');
    assert.ok(learned.searchCheckedAt > 0);
    assert.deepEqual(cookieObservations.slice(before),[null]);
    const denied = await rpc('sources.discover',{id:rejectedDiscovery.id});
    assert.equal(denied.searchTemplate,null);
    assert.equal(destinationRequests,0);
    const fresh = await rpc('sources.list');
    assert.equal(fresh.find(item=>item.id===discoverable.id).searchTemplate,learned.searchTemplate);
    report.checks.publicDiscoveryWithoutSourceCookies = true;
    report.checks.rejectedCrossOriginAndPrivateActions = true;
    report.checks.persistedSameOriginTemplate = true;
  }

  const first = await sourceView(alias);
  const blocked = await openEpisode(alias,first.webContentsId);
  assert.equal(blocked.failure,'redirect',JSON.stringify(blocked));
  assert.equal(blocked.destinationSourceId,redirectSource.id);
  assert.equal(destinationRequests,0,'The redirect must not reuse the first source session');
  await rpc('site.surface',{action:'detach',webContentsId:first.webContentsId});
  const redirected = await sourceView(redirectSource);
  const opened = await openEpisode(redirectSource,redirected.webContentsId);
  assert.equal(opened.ok,true,JSON.stringify(opened));
  assert.equal(opened.url,redirectURL);
  const chosen = await rpc('site.choose',{sourceId:redirectSource.id,webContentsId:redirected.webContentsId,kind:'type',value:'dub'});
  assert.equal(chosen.options.types.find(item=>item.active)?.value,'dub',JSON.stringify(chosen));
  report.checks.configuredRedirectAndDub = true;
  await rpc('site.surface',{action:'detach',webContentsId:redirected.webContentsId});
  report.passed = true;
} catch (error) {
  report.error = String(error.message ?? error);
  throw error;
} finally {
  await writeFile(process.env.ANIVERSE2_TEST_REPORT || 'test/artifacts/aniverse2-rendered-catalogue.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  await browser?.close().catch(() => undefined);
  if (child.pid && child.exitCode === null && child.signalCode === null && child.kill()) await exit;
  server.close();
  destination.close();
}
