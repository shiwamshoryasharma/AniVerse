import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createServer as createSocket} from 'node:net';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';

const cache = path.resolve('test/cache/aniverse2');
const run = await mkdtemp(path.join(cache, 'rendered-player-'));
const profile = path.join(run, 'profile');
const sourceURL = process.env.ANIVERSE2_LIVE_SOURCE;
if (!sourceURL || new URL(sourceURL).protocol !== 'https:') throw new Error('Set a configured HTTPS source for the live check.');
await mkdir(path.join(profile, 'config'), {recursive: true});
await writeFile(path.join(profile,'config','streaming-sites.txt'), sourceURL + '\r\n');
const origin = new URL(sourceURL).origin;
const redirect = process.env.ANIVERSE2_LIVE_DESTINATION;
if (redirect) await writeFile(path.join(profile,'config','streaming-sites.txt'), [sourceURL, redirect].join('\r\n')+'\r\n');
const temporary = createSocket().listen(0, '127.0.0.1');
await once(temporary, 'listening');
const port = temporary.address().port;
await new Promise(resolve => temporary.close(resolve));
const endpoint = 'http://127.0.0.1:' + port;
const executable = path.resolve(process.env.ANIVERSE2_TEST_EXE ?? 'test/cache/aniverse2/aniverse2-player-test.exe');
const env = {...process.env, ANIVERSE2_TEST_PROFILE: profile,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-address=127.0.0.1 --remote-debugging-port=' + port +
    ' --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --autoplay-policy=no-user-gesture-required',
  TEMP:run,TMP:run,TMPDIR:run};
delete env.ANIVERSE_ELECTRON_HANDOFF;
delete env.WEBVIEW2_USER_DATA_FOLDER;
const child = spawn(executable, [], {windowsHide: true, stdio:['ignore','pipe','pipe'], env});
let stderr = '', browser, page, launchError;
child.on('error', error => { launchError = error; });
child.stderr.on('data', bytes => {stderr += bytes;});
const exit = once(child, 'exit').catch(() => undefined);
const report = {passed: false, checks: {}, frames: [], executableSha256:createHash('sha256').update(await readFile(executable)).digest('hex')};
const poll = async (fn, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(150);
  }
  return null;
};
try {
  browser = await poll(async () => {
    if (launchError || child.exitCode !== null) throw launchError ?? Error(stderr);
    try {
      if ((await fetch(endpoint + '/json/version', {signal: AbortSignal.timeout(400)})).ok) {
        return await chromium.connectOverCDP(endpoint, {timeout: 1500});
      }
    } catch { /* wait for owned test window */ }
    return null;
  });
  assert.ok(browser, 'The test window did not attach');
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? await context.waitForEvent('page');
  await page.waitForURL('https://tauri.localhost/**', {timeout: 15000});
  await page.locator('.app').waitFor();
  const rpc = (method, input) => page.evaluate(({method,input}) =>
    window.__TAURI__.core.invoke('desktop_rpc',{method,input}), {method,input});
  const sources = await rpc('sources.list');
  let [source] = sources;
  assert.ok(source?.id);
  const requested = process.env.ANIVERSE2_LIVE_TITLE;
  const titles = requested ? [requested] : ['Tougen Anki: Nikko Kegon Falls Arc', 'Tougen Anki: Nikko Kegon Falls-hen'];
  const found = await rpc('meta.search', {q:requested ?? 'Tougen Anki'});
  const exact = found.find(media => Object.values(media.title).some(title => requested ? title?.toLowerCase() === requested.toLowerCase() : /nikko|kegon/i.test(title ?? '')));
  assert.ok(exact?.id, 'Could not verify the exact arc in the metadata catalog');
  for (const title of Object.values(exact.title)) if (title && !titles.includes(title)) titles.push(title);
  await page.evaluate(async ({id}) => {
    const ids = new Map();
    window.ownPlaybackFixtureIds = ids;
    await window.__TAURI__.event.listen('aniverse:site/surface', ({payload}) => {
      if (payload?.finished && payload.webContentsId && typeof payload.url === 'string') ids.set(payload.webContentsId, payload.url);
    });
    location.hash = '#/anime/' + id;
  }, {id:exact.id});
  await page.locator('.details-title').waitFor({timeout:25000});
  report.checks.reactTitleDetailsLoaded = true;
  const sourceButton = page.locator('button.source-btn').filter({hasText:source.name}).first();
  await sourceButton.click({timeout:15000});
  await page.locator('.watch-heading h1').waitFor({timeout:25000});
  report.checks.watchOpenedFromDetails = true;
  for (const audio of ['sub','dub','sub']) {
    const name = new RegExp('^\\s*' + audio + '\\s*$', 'i');
    await page.locator('.source-bar button.opt-btn').filter({hasText:name}).first().click({timeout:30000});
    await page.locator('.screen').scrollIntoViewIfNeeded();
    const baseline = new Map();
    const sample = await poll(async () => {
      const views = await page.evaluate(() => Array.from(window.ownPlaybackFixtureIds.entries()));
      for (const [webContentsId,url] of views) {
        if (!url.startsWith('https:') || new URL(url).pathname === '/') continue;
        if (redirect && new URL(url).origin !== new URL(redirect).origin) continue;
        const choices = await rpc('site.options',{webContentsId}).catch(() => null);
        const active = choices?.types?.find(row=>row.active)?.value;
        const metrics = await rpc('player.probe',{webContentsId}).catch(() => null);
        if (active !== audio || !(metrics?.video?.totalFrames>4 && metrics.currentTime>0.2)) continue;
        assert.ok(Number.isFinite(metrics.video.bufferedAhead) && metrics.video.bufferedAhead>=0, 'Missing native buffered-ahead value.');
        assert.ok(Number.isFinite(metrics.video.playbackRate), 'Missing native playback rate.');
        const previous = baseline.get(webContentsId);
        const count = metrics.video.totalFrames;
        if (previous && count > previous.count && metrics.currentTime>previous.time) return {frames:count-previous.count};
        if (!previous || count < previous.count) baseline.set(webContentsId,{count,time:metrics.currentTime});
      }
      return null;
    }, 28000);
    assert.ok(sample, 'Watch did not confirm advancing frames with ' + audio.toUpperCase() + ' audio.');
    report.frames.push({audio,frames:sample.frames});
  }
  report.checks.configuredRedirect = Boolean(redirect);
  report.checks.reactWatchDecodedVideo = true;
  report.checks.subDubSubDecoded = report.frames.length === 3;
  await page.locator('.playback-rescue').filter({hasText:/s buffered/}).waitFor({timeout:8000});
  assert.equal(await page.getByText('This screen crashed.',{exact:false}).count(),0);
  report.checks.playbackMetricContractRenders = true;

  if (process.env.ANIVERSE2_CHECK_DISPLAY === '1') {
    const cdp = await context.newCDPSession(page);
    report.display = [];
    for (const [width,height] of [[640,480],[800,600],[1024,600],[1280,720]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      assert.ok(await poll(async()=>await page.evaluate(width=>innerWidth===width,width),3000),'Viewport resize failed.');
      const result = await page.evaluate(() => {
        const bounds = selector => document.querySelector(selector).getBoundingClientRect();
        const close = document.querySelector('.tauri-window-controls button:last-child');
        const view = bounds('.watch');
        const sources = bounds('.source-bar');
        return {
          width:innerWidth,height:innerHeight,
          closeVisible:!!close && close.getBoundingClientRect().right<=innerWidth+1,
          watchFits:view.left>=-1&&view.right<=innerWidth+1,
          sourceControlsFit:sources.left>=-1&&sources.right<=innerWidth+1,
        };
      });
      assert.ok(result.closeVisible && result.watchFits && result.sourceControlsFit,JSON.stringify(result));
      report.display.push(result);
    }
    await page.evaluate(()=>{location.hash='#/settings/graphics';});
    await page.getByRole('region',{name:'Display and window'}).waitFor({timeout:12000});
    await page.getByRole('combobox',{name:'Interface scale'}).click();
    await page.getByText('115% interface scale',{exact:true}).click();
    assert.equal(await page.evaluate(()=>localStorage.getItem('aniverse2.display-scale')),'115');
    await page.reload();
    await page.getByRole('region',{name:'Display and window'}).waitFor({timeout:12000});
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.displayScale),'115');
    await cdp.detach();
    report.checks.compactDisplayAndScalePersistence = true;
  }
  report.passed = true;
} catch (error) {
  report.error = String(error?.message ?? error);
  if (page) {
    report.sourceState = await page.evaluate(() => ({
      watch: document.querySelector('.watch-heading')?.innerText?.slice(0, 300),
      player: document.querySelector('.screen')?.innerText?.slice(0, 300),
      sources: document.querySelector('.source-bar')?.innerText?.slice(0, 450),
      urls: Array.from(window.ownPlaybackFixtureIds?.values() ?? [], value => new URL(value).origin + new URL(value).pathname),
    })).catch(() => null);
  }
  throw error;
} finally {
  await mkdir('test/artifacts',{recursive:true});
  await writeFile(process.env.ANIVERSE2_LIVE_REPORT ?? 'test/artifacts/aniverse2-live-source.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  await browser?.close().catch(() => undefined);
  if (child.pid && child.exitCode === null && child.signalCode === null && child.kill()) await exit;

}