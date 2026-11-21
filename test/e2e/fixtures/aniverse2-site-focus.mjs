import assert from 'node:assert/strict';

const html = '<!doctype html><link rel="stylesheet" href="/focus.css"><script defer src="/focus.js"></script>' +
  '<header>Fixture source header</header><main><div id="player"></div><aside>Episode list<div class="servers"><button aria-pressed="true">SUB</button><button aria-pressed="false">DUB</button></div><div id="chat">Chat</div></aside></main>';
const css = 'body{margin:12px}header,aside,#chat{min-height:30px}main{display:grid;grid-template-columns:380px 300px}video{display:block;width:360px;height:202px}';
const script = "(() => {" +
  "let video; const player = document.querySelector('#player');" +
  "const choices=Array.from(document.querySelectorAll('.servers button'));" +
  "choices.forEach(button=>button.onclick=()=>choices.forEach(choice=>choice.setAttribute('aria-pressed',String(choice===button))));" +
  "const visible = id => document.querySelector(id).checkVisibility({checkVisibilityCSS:true,checkOpacity:true});" +
  "const timer = setInterval(async () => {" +
  "  const mark = document.querySelector('[data-aniverse-player]'); const box = mark?.getBoundingClientRect();" +
  "  const values = new URLSearchParams({header:visible('header'),episodes:visible('aside'),chat:visible('#chat')," +
  "    marker:!!mark,fit:!!box&&Math.abs(box.x)<3&&Math.abs(box.y)<3&&Math.abs(box.width-innerWidth)<3&&Math.abs(box.height-innerHeight)<3," +
  "    frames:video?.getVideoPlaybackQuality().totalVideoFrames??0});" +
  "  const response = await fetch('/focus-observe?'+values).catch(()=>null);" +
  "  if (response?.status === 200 && !video) {" +
  "    video = Object.assign(document.createElement('video'),{src:'/sub.mp4',autoplay:true,muted:true,controls:true,loop:true});" +
  "    player.appendChild(video);" +
  "  }" +
  "},150); setTimeout(()=>clearInterval(timer),22000); })()";

export function createSiteFocusFixture() {
  let reveal = false;
  let latest;
  const chrome = (expected) => latest && ['header','episodes','chat'].every(name => latest[name] === String(expected));
  function serve(req, res, route) {
    if (route === '/focus-observe') {
      latest = Object.fromEntries(new URL(req.url,'http://fixture.test').searchParams);
      res.writeHead(reveal ? 200 : 204); res.end(); return true;
    }
    const file = {
      '/focus-fixture': ['text/html; charset=utf-8',html],
      '/focus.css': ['text/css; charset=utf-8',css],
      '/focus.js': ['text/javascript; charset=utf-8',script],
    }[route];
    if (!file) return false;
    res.writeHead(200, {'Content-Type':file[0], 'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'"});
    res.end(file[1]);
    return true;
  }
  async function verify(rpc, poll, source, bounds) {
    const {webContentsId} = await rpc('site.surface',{action:'attach',sourceId:source.id,partition:source.partition,bounds});
    try {
      await rpc('site.surface',{action:'place',webContentsId,bounds,visible:true});
      await rpc('site.surface',{action:'navigate',webContentsId,url:new URL('/focus-fixture',source.url).href});
      assert.ok(await poll(()=>chrome(true)&&latest.marker==='false'), 'Fixture chrome did not render before focus');
      assert.deepEqual(await rpc('site.focus',{webContentsId,on:true}), {focused:false}, 'A missing player was marked');
      reveal = true;
      assert.ok(await poll(()=>chrome(false)&&latest.marker==='true'&&latest.fit==='true'&&Number(latest.frames)>5,9000),
        'A player inserted under strict CSP was not fitted and isolated from the website chrome');
      const options = await rpc('site.options',{webContentsId});
      assert.deepEqual(options.types.map(type=>type.value).sort(), ['dub','sub'], 'Hidden audio controls were missed');
      const selection = await rpc('site.choose',{webContentsId,sourceId:source.id,kind:'type',value:'dub'});
      assert.equal(selection.options.types.find(type=>type.active)?.value,'dub');
      assert.equal(selection.focused,true);
      assert.ok(await poll(()=>chrome(false)&&latest.fit==='true',5000), 'Audio switching revealed the website chrome');
      const initialFrames=Number(latest.frames);
      assert.deepEqual(await rpc('site.focus',{webContentsId,on:false}), {focused:false});
      assert.ok(await poll(()=>chrome(true)&&latest.marker==='false'&&Number(latest.frames)>initialFrames,5000),
        'Whole-site mode did not restore the chrome and keep playing');
      assert.deepEqual(await rpc('site.focus',{webContentsId,on:true}), {focused:true});
      assert.ok(await poll(()=>chrome(false)&&latest.marker==='true'&&latest.fit==='true',5000),
        'Re-entering player-only mode did not hide the fixture chrome');
    } finally {
      await rpc('site.surface',{action:'detach',webContentsId});
    }
  }
  return {serve,verify};
}
