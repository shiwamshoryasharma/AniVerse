import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const run = await mkdtemp(resolve('test/cache/anime4k-surface-'));
const clip = await readFile(new URL('../fixtures/aniverse2-anime4k-neutral.mp4', import.meta.url));
const source = [
  "import { attachAnime4K } from './app/shared/upscaleRuntime';",
  "import { apply as applyGuest, stop as stopGuest } from './electron/upscaleGuest';",
  "const stage=document.querySelector('main'), video=document.querySelector('video');",
  "let status=null, dispose=()=>{}, reads=0, local, maxTexturePixels=0;",
  "const texImage2D=WebGLRenderingContext.prototype.texImage2D;",
  "WebGLRenderingContext.prototype.texImage2D=function(...args){",
  "  if(args.length===9 && typeof args[3]==='number') maxTexturePixels=Math.max(maxTexturePixels,args[3]*args[4]);",
  "  return Reflect.apply(texImage2D,this,args);",
  "};",

  "await video.play();",
  "window.fixture={video, resize:(w,h)=>{stage.style.width=w+'px';stage.style.height=h+'px';},",
  "  start(path){status=null; maxTexturePixels=0; if(path==='site'){const poll=()=>{status=applyGuest({enabled:true,mode:'A',thin:false,darken:false},true);};",
  "      const timer=window.setInterval(poll,500); poll(); dispose=()=>{clearInterval(timer);stopGuest();};return;}",
  "    local=document.createElement('canvas'); local.className='local'; stage.append(local);",
  "    const read=local.getBoundingClientRect.bind(local); local.getBoundingClientRect=()=>{reads++;return read();};",
  "    dispose=attachAnime4K(video,local,{enabled:true,mode:'A',thin:false,darken:false},value=>{status=value;},true);",
  "  }, stop:()=>{dispose();local?.remove();local=null;}, read(){const canvas=stage.querySelector('canvas');",
  "    return { status, width:canvas?.width,height:canvas?.height,",
  "      visible:canvas&&getComputedStyle(canvas).visibility==='visible',time:video.currentTime,reads,maxTexturePixels };}",
  "};",
].join('\n');
const result = await build({ stdin: { contents: source, resolveDir: process.cwd() }, bundle: true, format: 'esm', minify: true, write: false });
const app = result.outputFiles[0].text;
const html = '<!doctype html><style>main { position:relative;width:72px;height:48px }' +
  'main>video,main>.local { position:absolute;inset:0;width:100%;height:100%;object-fit:contain }</style>' +
  '<main><video src="/neutral.mp4" playsinline autoplay muted loop></video></main><script type="module" src="/fixture.js"></script>';

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--disable-background-networking'], env: { ...process.env, TEMP: run, TMP: run, TMPDIR: run },
});
const report = { passed: false };
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1.25 });
  await page.route('http://anime4k.aniverse.test/**', route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/fixture.js') return route.fulfill({ contentType: 'application/javascript', body: app });
    if (pathname === '/neutral.mp4') return route.fulfill({ contentType: 'video/mp4', body: clip });
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.goto('http://anime4k.aniverse.test/');
  await page.waitForFunction(() => window.fixture?.video.readyState >= 2);

  const resized = async (path, width, height) => {
    await page.waitForFunction(({ path, width, height }) => {
      const output = window.fixture.read();
      if (output.status?.state === 'unavailable') throw new Error(path + " " + width + "px: " + output.status.message);
      return output.status?.state === 'active' && output.width === width && output.height === height && output.visible;
    }, { path, width, height }, { polling: 100 });
    return page.evaluate(() => window.fixture.read());
  };
  for (const path of ['local', 'site']) {
    await page.evaluate(path => { window.fixture.resize(72, 48); window.fixture.start(path); }, path);
    const small = await resized(path, 90, 51);
    await page.waitForFunction(time => window.fixture.video.currentTime > time + .24, small.time);
    if (path === 'local') {
      const after = await page.evaluate(() => window.fixture.read());
      assert.equal(after.reads, small.reads, 'Steady playback must not read canvas layout on every frame');
    }
    await page.evaluate(() => window.fixture.resize(180, 110));
    const large = await resized(path, 225, 127);
    assert.equal(small.maxTexturePixels, 96 * 54, 'Preserve native-size shader intermediates without an enlargement pass');
    assert.equal(large.maxTexturePixels, 192 * 108, 'Retain the original 2× enlargement stage when a real display can use it');
    assert.ok(large.time > small.time);
    await page.evaluate(() => window.fixture.stop());
    assert.equal(await page.locator('main canvas').count(), 0);
    report[path] = { small: [small.width, small.height], large: [large.width, large.height], intermediatePixels: [small.maxTexturePixels, large.maxTexturePixels], clockAdvanced: true };
  }
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await browser.close();
  await writeFile(resolve('test/artifacts/aniverse2-anime4k-surface.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}