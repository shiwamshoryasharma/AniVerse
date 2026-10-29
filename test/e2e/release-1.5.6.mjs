// Real Electron renderer/main integration using neutral metadata and a public test clip.
// Every profile, cache, chosen file, export and screenshot stays under test/.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const cache = path.join(root, 'test/cache/release-' + version + '-ui');
const artifacts = path.join(root, 'test/artifacts');
mkdirSync(cache, { recursive: true });
mkdirSync(artifacts, { recursive: true });
const run = mkdtempSync(path.join(cache, 'run-'));
const profile = path.join(run, 'profile'),
  config = path.join(run, 'config'),
  videos = path.join(run, 'videos'),
  temporary = path.join(run, 'temp');
for (const folder of [profile, config, videos, temporary]) mkdirSync(folder, { recursive: true });
writeFileSync(path.join(config, 'streaming-sites.txt'), 'https://mirror-fixture.test\n');
writeFileSync(path.join(config, 'filters.txt'), '! Test filters\n');
const clip = path.join(root, 'test/cache/release-1.5.2-ui/sintel-trailer.mp4');
if (!existsSync(clip)) {
  const response = await fetch('https://media.w3.org/2010/05/sintel/trailer.mp4');
  assert.ok(response.ok, 'Public test clip is available');
  writeFileSync(clip, Buffer.from(await response.arrayBuffer()));
}
const videoFile = path.join(videos, 'Fixture Series - 01.mp4');
writeFileSync(videoFile, readFileSync(clip));
await build({
  stdin: {
    contents:
      "export { Store } from './app/core/db/store';export { WorkspaceService } from './app/core/workspace';export { AniListClient } from './app/core/metadata/anilist';",
    resolveDir: root,
  },
  outfile: path.join(run, 'seed.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['node:sqlite'],
  logLevel: 'warning',
});
const { Store, WorkspaceService, AniListClient } = createRequire(import.meta.url)(path.join(run, 'seed.cjs'));
const store = new Store(path.join(profile, 'aniverse.db'));
const media = { id: 7, idMal: null, title: 'Fixture Series', cover: '', banner: null, format: 'TV', episodes: 3 };
const raw = {
  id: 7,
  idMal: null,
  type: 'ANIME',
  title: { romaji: 'Fixture Series', english: 'Fixture Series', native: null, userPreferred: 'Fixture Series' },
  coverImage: { extraLarge: '', large: '', color: null },
  bannerImage: null,
  format: 'TV',
  status: 'FINISHED',
  episodes: 3,
  duration: 24,
  averageScore: 80,
  season: 'FALL',
  seasonYear: 2020,
  genres: ['Adventure'],
  isAdult: false,
  nextAiringEpisode: null,
  startDate: { year: 2020, month: 1, day: 1 },
  description: 'A hidden fixture synopsis.',
  streamingEpisodes: [
    { title: 'Episode 3 - Secret ending', thumbnail: 'https://image.example.test/spoiler.jpg', url: 'https://video.example.test', site: 'Fixture' },
  ],
  externalLinks: [],
};
const data = {
  Media: raw,
  Page: { media: [raw] },
  spotlight: { media: [] },
  trending: { media: [raw] },
  popularSeason: { media: [raw] },
  upcoming: { media: [] },
  topRated: { media: [raw] },
  recent: { airingSchedules: [] },
};
const client = new AniListClient(async () => new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } }), store, {
  showAdult: () => false,
  token: () => null,
});
await client.details(7);
await client.search('Fixture Series');
await client.home();
store.setLibraryEntry(media, 'CURRENT', 0);
store.setKv('settings', { privacy: { adblock: false, watchInsights: false }, updates: { autoCheck: false, autoDownload: false }, player: { autoplay: false } });
store.setKv('collection:roots', [videos]);
store.db
  .prepare('INSERT INTO local_media(path,name,bytes,query,episode,media_id,missing) VALUES(?,?,?,?,?,?,0)')
  .run(videoFile, path.basename(videoFile), readFileSync(videoFile).length, 'Fixture Series', 1, 7);
const workspace = new WorkspaceService(store);
workspace.saveBookmark({ media, episode: 1, position: 12, duration: 52, sourceId: null, note: 'A fixture scene', tags: ['test'] });
store.setSiteLink('mirror-fixture-test',7,1,'https://mirror-fixture.test/episode-1');
store.close();

const reports = [], errors = [];
async function until(fn){const deadline=Date.now()+45000;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,200));}throw new Error('Runtime state timed out');}
const app = await _electron.launch({
  executablePath: process.env.E2E_EXE ? path.resolve(root, process.env.E2E_EXE) : createRequire(import.meta.url)('electron'),
  args: process.env.E2E_EXE ? [] : [root], cwd: root,
  env: { ...process.env, ANIVERSE_HEADLESS: '1', ANIVERSE_DATA_DIR: profile, ANIVERSE_CONFIG_DIR: config, TEMP: temporary, TMP: temporary, TMPDIR: temporary },
  timeout: 60000,
});
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console',message=>{if(['warning','error'].includes(message.type()))console.log('[renderer] '+message.text().slice(0,500));});
  await page.waitForSelector('.app');
  const go = async (hash, selector) => { await page.evaluate((h) => location.hash = h, hash); await page.waitForSelector(selector); };
  const capture = async (name) => page.screenshot({ path: path.join(artifacts, 'release-' + version + '-' + name + '.png') });
  const check = (name, detail = {}) => { reports.push({ name, passed: true, ...detail }); console.log('[PASS] ' + name); };
  await page.waitForSelector('.release-dialog[open]');
  await capture('release-highlights');
  await page.getByRole('button',{name:'Got it',exact:true}).click();
  await go('#/settings/changelog','.changelog-history');
  assert.ok(await page.locator('.release-entry').count() >= 4);
  check(version + ' highlights and offline changelog');
  await app.evaluate(({shell})=>{
    globalThis.testDisplayUris=[];
    shell.openExternal=async uri=>{globalThis.testDisplayUris.push(uri);};
  });
  await go('#/watch/7/1?local=1','video');
  await page.waitForFunction(()=>document.querySelector('video')?.duration>0);
  const nativeMetrics=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,zoom:getComputedStyle(document.body).zoom}));
  await page.getByRole('button',{name:'Cast to TV',exact:true}).click();
  await page.getByRole('button',{name:'Find TVs with Chrome',exact:true}).waitFor();
  assert.equal(await page.locator('.cast-windows-option[open]').count(),0);
  assert.deepEqual(await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,zoom:getComputedStyle(document.body).zoom})),nativeMetrics);
  assert.ok(await page.locator('.cast-menu').evaluate(element=>element.getBoundingClientRect().top>=element.closest('[aria-label="Video player"]').getBoundingClientRect().top));
  await capture('native-chrome-chooser');
  await page.locator('.cast-windows-option summary:visible').click();
  await page.getByRole('button',{name:'Find wireless displays',exact:true}).click();
  await page.getByRole('button',{name:'Display settings',exact:true}).click();
  await page.getByRole('button',{name:'TV audio',exact:true}).click();
  assert.deepEqual(await app.evaluate(()=>globalThis.testDisplayUris),['ms-settings-connectabledevices:devicediscovery','ms-settings:display','ms-settings:sound']);
  await capture('native-wireless');
  check('Native cast picker opens fixed Windows chooser, display and audio actions through real IPC');
  await page.getByRole('button',{name:'Play',exact:true}).first().click();
  await page.getByRole('button',{name:'Anime4K Upscale',exact:true}).click();
  await page.getByRole('switch',{name:'Enable Anime4K Upscale',exact:true}).click();
  await page.waitForSelector('.anime4k-status.active',{timeout:45000});
  await page.getByRole('switch',{name:'Darken lines',exact:true}).click();
  await page.getByRole('switch',{name:'Thin lines',exact:true}).click();
  await page.waitForFunction(()=>{const canvas=document.querySelector('.anime4k-canvas');return document.querySelector('.anime4k-status.active')&&canvas.width===3840&&getComputedStyle(canvas).visibility==='visible';});
  await capture('native-line-effects');
  check('Native upscaling compiles and renders with Darken and Thin enabled');
  await page.getByRole('switch',{name:'Enable Anime4K Upscale',exact:true}).click();
  await page.getByRole('switch',{name:'Darken lines',exact:true}).click();
  await page.getByRole('switch',{name:'Thin lines',exact:true}).click();
  await app.evaluate(({session},encodedClip)=>{
    const bytes=Buffer.from(encodedClip,'base64');
    session.fromPartition('persist:src-mirror-fixture-test').protocol.handle('https',request=>{
      if(new URL(request.url).hostname==='media-fixture.test')return new Response(bytes,{headers:{'Content-Type':'video/mp4'}});
      if(new URL(request.url).hostname!=='player-fixture.test')return new Response('<!doctype html><html><body style="margin:0;background:black"><iframe src="https://player-fixture.test/frame" style="border:0;width:100vw;height:100vh" allow="autoplay"></iframe></body></html>',{headers:{'Content-Type':'text/html'}});
      return new Response('<!doctype html><html><head><title>Fixture Series Episode 1</title></head><body style="margin:0;background:black"><video style="width:100vw;height:100vh;object-fit:contain" controls loop autoplay src="https://media-fixture.test/video.mp4"></video></body></html>',{headers:{'Content-Type':'text/html'}});
    });
  },readFileSync(clip).toString('base64'));
  await page.evaluate(()=>window.aniverse.invoke('sources.pin',{sourceId:'mirror-fixture-test',mediaId:7,url:'https://mirror-fixture.test/episode-1'}));
  await go('#/watch/7/1?source=mirror-fixture-test','webview');
  await page.waitForFunction(()=>!!document.querySelector('webview')?.getWebContentsId());
  const guest=await page.locator('webview').evaluate(view=>view.getWebContentsId());
  await page.waitForSelector('.screen .cat-loader',{state:'detached',timeout:45000});
  await until(async()=>app.evaluate(async({webContents},id)=>!!(await webContents.fromId(id).mainFrame.framesInSubtree.find(frame=>frame.url.includes('player-fixture.test'))?.executeJavaScript("document.querySelector('video')?.readyState>=2")),guest));
  await app.evaluate(async({webContents},id)=>webContents.fromId(id).mainFrame.framesInSubtree.find(frame=>frame.url.includes('player-fixture.test')).executeJavaScript("document.querySelector('video').play()",true),guest);
  const websiteMetrics=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,zoom:getComputedStyle(document.body).zoom}));
  const zoomBefore=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
  await page.getByRole('button',{name:'Cast to TV',exact:true}).click();
  await page.getByRole('button',{name:'Find TVs with Chrome',exact:true}).waitFor();
  assert.equal(await page.locator('.episode-cast-dialog').evaluate(element=>getComputedStyle(element,'::backdrop').backdropFilter),'none');
  assert.deepEqual(await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,zoom:getComputedStyle(document.body).zoom})),websiteMetrics);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()),zoomBefore);
  await capture('website-crisp-cast-dialog');
  await page.getByRole('button',{name:'Find TVs with Chrome',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.chrome-cast-picker')?.textContent.includes('Chrome found no TVs')||document.querySelector('.chrome-cast-picker .cast-device-card')||document.querySelector('.chrome-cast-picker [role="alert"]'),{},{timeout:60000});
  assert.equal(await page.locator('.chrome-cast-picker [role="alert"]').count(),0);
  await capture('website-chrome-discovery');
  await page.locator('.cast-windows-option summary:visible').click();
  await page.getByRole('button',{name:'Find wireless displays',exact:true}).click();
  assert.equal((await app.evaluate(()=>globalThis.testDisplayUris)).length,4);
  await capture('website-wireless');
  await page.getByRole('button',{name:'Close TV chooser',exact:true}).click();
  await page.evaluate(()=>window.aniverse.invoke('cast.chromeClose'));
  assert.deepEqual(await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,zoom:getComputedStyle(document.body).zoom})),websiteMetrics);
  await capture('website-after-cast-close');
  check('Chrome discovery through trusted IPC; cast dialog never blurs or changes app zoom, viewport or DPR');
  check('Website cast picker supports Miracast separately from Google Cast');
  const reason=await app.evaluate(async({webContents},id)=>webContents.fromId(id).mainFrame.framesInSubtree.find(frame=>frame.url.includes('player-fixture.test')).executeJavaScript("(()=>{const gl=document.createElement('canvas').getContext('webgl');try{gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,document.querySelector('video'));return 'no exception';}catch(e){return e.name+': '+e.message;}})()"),guest);
  assert.match(reason,/SecurityError|cross.origin|taint/i,'Fixture reproduces origin-blocked GPU pixel access');
  await page.locator('.site-anime4k summary').click();
  await page.getByRole('switch',{name:'Enable Anime4K Upscale',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.site-anime4k')?.textContent.includes('Original playback continues'),{},{timeout:30000});
  await capture('direct-upscale-failure');
  check('Cross-origin website reproduces the direct Anime4K failure',{reason});
  await page.getByRole('button',{name:'Use compatibility upscaling',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.site-anime4k')?.textContent.includes('Compatibility · Anime4K A ·'),{},{timeout:45000});
  const output=await page.locator('.compatibility-upscale-surface').evaluate(surface=>{
    const video=surface.querySelector('video'),canvas=surface.querySelector('canvas');
    window.testCaptureTrack=video.srcObject.getVideoTracks()[0];
    return {width:canvas.width,height:canvas.height,visibility:getComputedStyle(canvas).visibility,audioTracks:video.srcObject.getAudioTracks().length};
  });
  assert.ok(output.width<=3840&&output.width>=3000&&output.height<=2160);assert.equal(output.visibility,'visible');assert.equal(output.audioTracks,0);
  for(const [index,mode] of ['A','B','C','A+A','B+B','C+A'].entries()){
    await page.locator('.site-anime4k .anime4k-modes button').nth(index).click();
    await page.waitForFunction(m=>document.querySelector('.site-anime4k')?.textContent.includes('Compatibility · Anime4K '+m+' ·'),mode,{timeout:20000});
  }
  for(const name of ['Darken lines','Thin lines']){
    const previous=await page.locator('.compatibility-upscale-surface canvas').elementHandle();
    await page.getByRole('switch',{name,exact:true}).click();
    await until(()=>previous.evaluate(canvas=>!canvas.isConnected));
    await previous.dispose();
    await page.waitForTimeout(800);
    console.log('[effect] '+name+' '+JSON.stringify(await page.evaluate(()=>({status:document.querySelector('.site-anime4k summary')?.textContent,canvas:[...document.querySelectorAll('.compatibility-upscale-surface canvas')].map(c=>({w:c.width,h:c.height,visibility:getComputedStyle(c).visibility})),video:document.querySelector('.compatibility-upscale-surface video')?.readyState}))));
    await page.waitForFunction(()=>{const canvas=document.querySelector('.compatibility-upscale-surface canvas');return canvas?.width>=3000&&getComputedStyle(canvas).visibility==='visible';});
  }
  await page.waitForTimeout(800);
  await page.locator('.site-anime4k summary').click();
  await page.locator('.screen').scrollIntoViewIfNeeded();
  await capture('compatibility-upscale');
  const original=await page.evaluate(id=>window.aniverse.invoke('player.probe',{webContentsId:id}),guest);
  assert.ok(original&&!original.paused&&original.currentTime>0);
  assert.equal(await app.evaluate(({webContents},id)=>webContents.fromId(id).isAudioMuted(),guest),false);
  check('All six presets filter a real origin-blocked source through video-only compositor capture',{...output,originalPlaybackContinues:true,lineEffects:true});
  await page.evaluate(()=>{
    const original=WebGLRenderingContext.prototype.finish;
    window.restoreGpuFinish=()=>{WebGLRenderingContext.prototype.finish=original;};
    WebGLRenderingContext.prototype.finish=function(){original.call(this);const until=performance.now()+130;while(performance.now()<until){}};
  });
  await page.waitForFunction(()=>document.querySelector('.site-anime4k')?.textContent.includes('Upscaling paused because rendering is too slow'),{},{timeout:20000});
  await page.evaluate(()=>window.restoreGpuFinish());
  assert.equal(await page.locator('.compatibility-upscale-surface canvas').evaluate(canvas=>getComputedStyle(canvas).visibility),'hidden');
  const continued=await page.evaluate(id=>window.aniverse.invoke('player.probe',{webContentsId:id}),guest);
  assert.ok(continued&&!continued.paused&&continued.currentTime>=original.currentTime);
  assert.equal(await app.evaluate(({webContents},id)=>webContents.fromId(id).isAudioMuted(),guest),false);
  check('A slow GPU drops delayed filtered pictures and preserves the original playing media clock',{simulatedRenderMs:130,sourceAudioContinues:true});
  await page.getByRole('button',{name:'Stop compatibility upscaling',exact:true}).click();
  await page.waitForSelector('.compatibility-upscale-surface',{state:'detached'});
  assert.equal(await page.evaluate(()=>window.testCaptureTrack.readyState),'ended');
  await page.getByRole('button',{name:'Use compatibility upscaling',exact:true}).click();
  await page.waitForSelector('.compatibility-upscale-surface canvas');
  await app.evaluate(async({webContents},id)=>webContents.fromId(id).loadURL('https://mirror-fixture.test/next'),guest);
  await page.waitForSelector('.compatibility-upscale-surface',{state:'detached'});
  check('Stopping and source navigation release compatibility capture and overlay');
  assert.deepEqual(errors, [], 'No renderer crashes');
} catch (error) {
  errors.push(String(error));
  const failedPage=await app.firstWindow();
  console.log(JSON.stringify(await failedPage.evaluate(async()=>({upscale:(await window.aniverse.invoke('settings.get')).player.upscale,status:document.querySelector('.site-anime4k')?.innerText,canvases:[...document.querySelectorAll('.compatibility-upscale-surface canvas')].map(canvas=>({width:canvas.width,height:canvas.height,visibility:getComputedStyle(canvas).visibility})),capture:document.querySelector('.compatibility-upscale-surface video')?.readyState}))));
  await failedPage.screenshot({path:path.join(artifacts,'release-'+version+'-failure.png')});
  throw error;
} finally {
  await app.close();
  writeFileSync(path.join(artifacts, 'release-'+version+'-ui.json'), JSON.stringify({ packaged: !!process.env.E2E_EXE, reports, errors }, null, 2) + '\n');
}
