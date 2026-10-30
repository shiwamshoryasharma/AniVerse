// Neutral rendered-page fixtures; no configured website identities or stream extraction.
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const path = require('node:path');

const root = process.env.ANIVERSE_FOCUS_ROOT;
if (!root || !process.env.ANIVERSE_DATA_DIR) throw new Error('Launch with node test/e2e/player-focus.mjs');
app.setPath('userData', process.env.ANIVERSE_DATA_DIR);
const { pageScript, FOCUS_CSS } = require(path.join(root, 'test/cache/player-focus/site-page.cjs'));
const { mediaPageScript } = require(path.join(root, 'test/cache/player-focus/media-page.cjs'));
const artifacts = path.join(root, 'test/artifacts');
const ISOLATED_WORLD = 1017;
const results = [];
const captureErrors = [];
const check = (name, condition, actual) => {
  results.push({ name, passed: !!condition, actual });
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}: ${JSON.stringify(actual)}`);
};

const fixture = (extra = '') => `<!doctype html><html><head><meta charset="utf-8">
<style>
html,body { margin:0; background:#101010; color:white; font:18px sans-serif; }
main { width:800px; height:600px; padding:36px; }
.player-shell { position:relative; width:640px; height:360px; background:#12364b; }
video { display:block; width:100%; height:100%; background:#12364b; object-fit:contain; }
.subtitles { position:absolute; bottom:58px; left:20%; color:white; background:#000; z-index:2; }
.controls { position:absolute; bottom:0; left:0; right:0; height:40px; background:#18262f; z-index:3; }
</style></head><body><main><div class="player-shell" id="player-shell">
<video id="actual-video" controls></video><div class="subtitles" id="subtitles">Fixture subtitles</div>
<div class="controls" id="controls"><button id="play">Play</button> SUB / DUB</div></div></main>${extra}
<script>window.originalVideo=document.querySelector('#actual-video');</script></body></html>`;

async function inspect(win) {
  return win.webContents.executeJavaScript(`(() => {
    const target=document.querySelector('[data-aniverse-player]');
    const video=document.querySelector('#actual-video');
    const rect=target?.getBoundingClientRect();
    const center=document.elementFromPoint(innerWidth/2,innerHeight/2);
    const visible=(id)=>{
      const e=document.getElementById(id), r=e.getBoundingClientRect(), s=getComputedStyle(e);
      return s.visibility!=='hidden' && s.display!=='none' && Number(s.opacity)!==0 &&
        r.width>0 && r.height>0 && r.left>=0 && r.top>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1;
    };
    return {
      target:target?.id ?? null,
      targetContainsVideo:!!target && (target===video || target.contains(video)),
      center: center?.id ?? center?.tagName ?? null,
      centerIsPlayer:!!target && !!center && (target===center || target.contains(center)),
      videoIdentity:video===window.originalVideo,
      subtitlesVisible:visible('subtitles'),
      controlsVisible:visible('controls'),
      targetBounds:rect ? {x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null
    };
  })()`);
}

async function runFixture(win, name, extra, assertions) {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fixture(extra)));
  const marked = await win.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: pageScript({ op:'markPlayer', keep:true }) }]);
  const key = await win.webContents.insertCSS(FOCUS_CSS);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const state = await inspect(win);
  check(`${name}: finds player`, marked?.found, marked);
  for (const [label, test] of assertions) check(`${name}: ${label}`, test(state), state);
  try { writeFileSync(path.join(artifacts, `player-focus-${name}.png`), (await win.webContents.capturePage()).toPNG()); } catch (error) { captureErrors.push({ fixture:name, message:error.message }); console.warn(`[capture] ${name}: ${error.message}`); }
  await win.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code:pageScript({op:'releasePlayer'}) }]);
  await win.webContents.removeInsertedCSS(key);
  const restored = await win.webContents.executeJavaScript(`document.querySelectorAll('[data-aniverse-player],[data-aniverse-chain]').length`);
  check(`${name}: releases markers`, restored===0, restored);
}


async function installMediaState(win) {
  await win.webContents.executeJavaScript(`(() => {
    window.mediaState = {};
    const original = document.querySelector('#actual-video');
    const hidden = document.createElement('video');
    hidden.id = 'hidden-video';
    hidden.style.cssText = 'visibility:hidden;width:900px;height:506px;position:absolute;inset:0';
    document.body.prepend(hidden);
    const decoy = document.createElement('video');
    decoy.id = 'decoy-video';
    decoy.style.cssText = 'width:300px;height:170px;position:absolute;left:650px;top:0';
    document.body.appendChild(decoy);
    for (const [element, duration, position] of [[original,1200,42],[hidden,7200,311],[decoy,3600,93]]) {
      const state = { duration, position, paused:false, sourceReads:0, sourceWrites:0 };
      window.mediaState[element.id] = state;
      Object.defineProperties(element, {
        duration:{ configurable:true, get:()=>state.duration },
        currentTime:{ configurable:true, get:()=>state.position, set:(value)=>{state.position=value;} },
        paused:{ configurable:true, get:()=>state.paused },
        ended:{ configurable:true, get:()=>false },
        videoWidth:{ configurable:true, get:()=>1280 },
        videoHeight:{ configurable:true, get:()=>720 },
        readyState:{ configurable:true, get:()=>4 },
        buffered:{ configurable:true, get:()=>({length:1,start:()=>35,end:()=>65}) },
        src:{ configurable:true, get:()=>{state.sourceReads++;throw Error('Media source must not be read');}, set:()=>{state.sourceWrites++;throw Error('Media source must not be replaced');} },
        currentSrc:{ configurable:true, get:()=>{state.sourceReads++;throw Error('Current media source must not be read');} }
      });
      const attribute = element.getAttribute.bind(element);
      element.getAttribute = (name) => {
        if (name.toLowerCase()==='src') { state.sourceReads++; throw Error('Source attribute must not be read'); }
        return attribute(name);
      };
      const setAttribute = element.setAttribute.bind(element);
      element.setAttribute = (name,value) => {
        if (name.toLowerCase()==='src') { state.sourceWrites++; throw Error('Source attribute must not be replaced'); }
        return setAttribute(name,value);
      };
      element.play = () => { state.paused=false; return Promise.resolve(); };
      element.pause = () => { state.paused=true; };
      element.getVideoPlaybackQuality = () => ({totalVideoFrames:900,droppedVideoFrames:12});
    }
  })()`);
}

async function mediaState(win) {
  return win.webContents.executeJavaScript(`({
    states:window.mediaState,
    originalIdentity:document.querySelector('#actual-video')===window.originalVideo
  })`);
}

async function runMediaFixture(win) {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fixture()));
  await installMediaState(win);
  await win.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{code:pageScript({op:'markPlayer',selector:'#player-shell'})}]);
  const probe = await win.webContents.executeJavaScript(mediaPageScript());
  check('media: probe chooses marked original rather than hidden or unmarked videos', probe?.duration===1200 && probe.currentTime===42, probe);
  check('media: reports playback metrics and buffer ahead', probe?.video?.width===1280 && probe.video.height===720 &&
    probe.video.readyState===4 && probe.video.bufferedAhead===23 && probe.video.totalFrames===900 &&
    probe.video.droppedFrames===12 && probe.video.playbackRate===1, probe?.video);
  const pause = await win.webContents.executeJavaScript(mediaPageScript('pause'));
  let state = await mediaState(win);
  check('media: control uses the same video as probe', pause===true && state.states['actual-video'].paused &&
    !state.states['hidden-video'].paused && !state.states['decoy-video'].paused, state);
  const pausedResync = await win.webContents.executeJavaScript(mediaPageScript('resync'));
  state = await mediaState(win);
  check('media: paused resync retains time, pause state and video identity', pausedResync===true &&
    state.states['actual-video'].position===42 && state.states['actual-video'].paused && state.originalIdentity, state);
  await win.webContents.executeJavaScript(mediaPageScript('play'));
  const playingResync = await win.webContents.executeJavaScript(mediaPageScript('resync'));
  state = await mediaState(win);
  check('media: playing resync retains time, play state and video identity', playingResync===true &&
    state.states['actual-video'].position===42 && !state.states['actual-video'].paused && state.originalIdentity, state);
  await win.webContents.executeJavaScript(mediaPageScript('seek',87));
  state = await mediaState(win);
  check('media: seek affects only the selected original video', state.states['actual-video'].position===87 &&
    state.states['hidden-video'].position===311 && state.states['decoy-video'].position===93, state);

  await win.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{code:pageScript({op:'releasePlayer'})}]);
  await win.webContents.executeJavaScript(`document.querySelector('#decoy-video').style.visibility='hidden'; document.querySelector('#actual-video').style.visibility='hidden';`);
  const hiddenProbe = await win.webContents.executeJavaScript(mediaPageScript());
  check('media: ignores hidden videos even without a marked player', hiddenProbe===null, hiddenProbe);
  await win.webContents.executeJavaScript(`document.querySelector('#actual-video').style.visibility='visible';
    const iframe=document.createElement('iframe');iframe.id='episode-frame';iframe.style.cssText='width:720px;height:405px';
    iframe.srcdoc='<p>Local episode-frame fixture</p>';document.body.appendChild(iframe);`);
  await win.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{code:pageScript({op:'markPlayer',selector:'#episode-frame'})}]);
  const frameProbe = await win.webContents.executeJavaScript(mediaPageScript());
  const framePause = await win.webContents.executeJavaScript(mediaPageScript('pause'));
  state = await mediaState(win);
  check('media: top-document video cannot replace the marked iframe player', frameProbe===null && framePause===null &&
    !state.states['actual-video'].paused && state.states['actual-video'].position===87, {probe:frameProbe,control:framePause,...state});
  check('media: probe and controls never read or replace media source', Object.values(state.states).every((value)=>
    value.sourceReads===0 && value.sourceWrites===0), state.states);
}

app.whenReady().then(async () => {
  mkdirSync(artifacts, { recursive:true });
  const win = new BrowserWindow({
    width:960, height:640, show:false, frame:false, focusable:false, skipTaskbar:true,
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}
  });
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  win.showInactive();
  try {
    await runFixture(win, 'overlay', '<header id="site-overlay" style="position:fixed;inset:0;z-index:2147483647;background:#74213e">Site navigation overlay</header>', [
      ['website chrome cannot cover player', (s)=>s.centerIsPlayer],
      ['keeps original video element', (s)=>s.videoIdentity],
      ['keeps site controls and subtitles', (s)=>s.controlsVisible && s.subtitlesVisible],
    ]);
    await runFixture(win, 'hidden-media', '<iframe id="hidden-advert" style="visibility:hidden;position:absolute;inset:0;width:900px;height:506px"></iframe>', [
      ['selects visible episode instead of hidden larger media', (s)=>s.targetContainsVideo],
      ['keeps original video element', (s)=>s.videoIdentity],
    ]);
    await runFixture(win, 'native-controls', '', [
      ['preserves original video and controls', (s)=>s.videoIdentity && s.targetContainsVideo && s.controlsVisible],
      ['preserves subtitle overlay', (s)=>s.subtitlesVisible],
    ]);

    await runFixture(win, 'captcha', '<iframe id="visible-captcha" src="about:blank#turnstile" style="position:absolute;inset:0;width:900px;height:506px"></iframe>', [
      ['does not select a visible larger challenge iframe', (s)=>s.targetContainsVideo],
    ]);

    // A fixed player wrapper alone does not reset absolute offsets and fixed
    // dimensions on the site's actual video or intermediate ratio wrapper.
    for (const nested of [false,true]) {
      await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(fixture()));
      await win.webContents.executeJavaScript('(() => {'+
        'const video=document.querySelector("video");'+
        (nested?'const wrapper=document.createElement("div");wrapper.className="ratio";wrapper.style.cssText="position:absolute;top:140px;left:70px;width:420px;height:236px;padding-top:80px;transform:translateY(30px);overflow:hidden";video.before(wrapper);wrapper.append(video);':'')+
        'video.style.cssText="position:absolute;top:160px;left:50px;width:420px;height:236px;min-width:700px;transform:translateY(30px);object-fit:cover";})()');
      await win.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD,[{code:pageScript({op:'markPlayer',selector:'#player-shell',keep:true})}]);
      const css=await win.webContents.insertCSS(FOCUS_CSS);
      const bounds=await win.webContents.executeJavaScript('(() => { const v=document.querySelector("video"),r=v.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,vw:innerWidth,vh:innerHeight,fit:getComputedStyle(v).objectFit,identity:v===window.originalVideo,controls:document.querySelector("#controls").checkVisibility()};})()');
      check('offset-'+nested+': original video fills the focused viewport without cropping',Math.abs(bounds.x)<1&&Math.abs(bounds.y)<1&&Math.abs(bounds.w-bounds.vw)<1&&Math.abs(bounds.h-bounds.vh)<1&&bounds.fit==='contain'&&bounds.identity&&bounds.controls,bounds);
      writeFileSync(path.join(artifacts,'player-focus-offset-'+nested+'.png'),(await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD,[{code:pageScript({op:'releasePlayer'})}]);
      await win.webContents.removeInsertedCSS(css);
      const restored=await win.webContents.executeJavaScript('document.querySelector("video").getBoundingClientRect().width');
      check('offset-'+nested+': original site dimensions restored when focus exits',restored===700,restored);
    }

    // Real same-origin decoded frames exercise the Anime4K overlay in a transformed containing block.
    const bytes=readFileSync(path.join(root,'test/cache/release-1.5.2-ui/sintel-trailer.mp4')).toString('base64');
    const upscaleScript=readFileSync(path.join(root,'test/cache/player-focus/upscale.js'),'utf8');
    await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(fixture()));
    await win.webContents.executeJavaScript('(()=>{const wrapper=document.querySelector("#player-shell");wrapper.style.cssText="position:relative;width:640px;height:360px;transform:translate(30px,40px) scale(.8)";const v=document.querySelector("video");v.src="data:video/mp4;base64,'+bytes+'";v.muted=true;v.loop=true;return v.play();})()');
    await win.webContents.executeJavaScript(upscaleScript+';globalThis.testUpscale=AniVerseUpscale;testUpscale.apply({enabled:true,mode:"A",darken:false,thin:false});');
    let drawing;
    const deadline=Date.now()+30000;
    do{
      await new Promise(r=>setTimeout(r,100));
      drawing=await win.webContents.executeJavaScript('(()=>{const v=document.querySelector("video"),c=document.querySelector("[data-aniverse-upscale]"),a=v.getBoundingClientRect(),b=c?.getBoundingClientRect();return {visible:c&&getComputedStyle(c).visibility==="visible",width:c?.width,video:[a.x,a.y,a.width,a.height],canvas:b?[b.x,b.y,b.width,b.height]:[],time:v.currentTime,identity:v===window.originalVideo};})()');
    }while(!drawing.visible&&Date.now()<deadline);
    check('upscale: real 4K filter remains aligned inside transformed wrappers',drawing.visible&&drawing.width===3840&&drawing.identity&&drawing.time>0&&drawing.video.every((value,index)=>Math.abs(value-drawing.canvas[index])<1),drawing);
    writeFileSync(path.join(artifacts,'player-focus-upscale-transformed.png'),(await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript('testUpscale.stop()');
    check('upscale: stop removes the overlay and preserves the original video',await win.webContents.executeJavaScript('!document.querySelector("[data-aniverse-upscale]")&&document.querySelector("video")===window.originalVideo'));
    await runMediaFixture(win);
  } finally {
    const failed = results.filter((result)=>!result.passed);
    writeFileSync(path.join(artifacts, 'player-focus.json'), JSON.stringify({passed:failed.length===0,results,captureErrors},null,2)+'\n');
    win.destroy();
    app.exit(failed.length ? 1 : 0);
  }
}).catch((error)=>{
  console.error(error);
  app.exit(1);
});
