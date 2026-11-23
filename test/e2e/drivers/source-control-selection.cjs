const assert = require('node:assert/strict');
const {app, BrowserWindow, session} = require('electron');
app.setPath('userData', process.env.AV_CONTROL_PROFILE);
app.setPath('sessionData', process.env.AV_CONTROL_PROFILE);
app.whenReady().then(async () => {
  const {pageScript} = require(process.env.AV_CONTROL_BUNDLE);
  const html = '<video width="480" height="270"></video>' +
    '<div><button class="bg-primary text-primary-foreground">Sub</button><button>Dub</button></div>' +
    '<div style="display:grid"><button class="bg-primary text-primary-foreground">North</button><button>South</button></div>' +
    '<div class="servers"><div data-type="sub">S-Sub <button class="download-action">Download</button></div></div>' +
    '<div class="episode-list"><a data-num="1" href="#one" class="active">1</a><a data-num="2" href="#two">2</a></div>' +
    '<div><button>4. The first chapter gets an unusually long and detailed synopsis</button>' +
    '<button>5. Another episode includes an unusually long and detailed synopsis</button>' +
    '<button>6. The third chapter has an unusually long and detailed synopsis</button></div>' +
    '<button><span>07</span><span>Episode 7</span><span>Now playing</span>Another long synopsis</button>' +
    '<script>' +
    'document.querySelectorAll("button").forEach(button=>button.onclick=()=>{' +
    'for(const sibling of button.parentElement.children)sibling.className=sibling===button?"bg-primary text-primary-foreground":"";' +
    '});document.querySelector("[data-num=\\"2\\"]").onclick=event=>{event.preventDefault();' +
    'document.querySelector("[data-num=\\"1\\"]").classList.remove("active");event.target.classList.add("active");};' +
    '</script>';
  const alternate = '<div class="servers"><button role="switch" aria-label="Backup server" aria-checked="false" ' +
    'onclick="this.setAttribute(&quot;aria-checked&quot;, this.getAttribute(&quot;aria-checked&quot;) === &quot;false&quot;)">' +
    'Backup serverBackup</button></div>';
  await session.defaultSession.protocol.handle('https', request => new Response(
    new URL(request.url).pathname.endsWith('/alternate') ? alternate : html,
    {headers:{'content-type':'text/html'}},
  ));
  const win = new BrowserWindow({show:false, webPreferences:{sandbox:true, contextIsolation:true}});
  await win.loadURL('https://control-selection.test/watch/neutral');
  const run = operation => win.webContents.executeJavaScriptInIsolatedWorld(1017, [{code:pageScript(operation)}]);
  const options = () => run({op:'siteOptions'});
  const choose = async (kind, value) => {
    const target = (await options()).find(option => option.kind === kind && option.value === value);
    assert.ok(target?.pick, 'Control is available for selection');
    await run({op:'click', pick:target.pick});
    assert.equal((await options()).find(option => option.kind === kind && option.value === value)?.active, true);
  };
  const initial = await options();
  assert.equal(initial.find(option => option.kind === 'type' && option.value === 'sub')?.active, true);
  assert.deepEqual(initial.filter(option => option.kind === 'server').map(option => option.value), ['north', 'south']);
  await choose('type', 'dub');
  await choose('server', 'south');
  const card = await run({op:'findEpisode', episode:5, slug:'neutral'});
  assert.equal(card.href, null);
  assert.ok(card.pick);
  assert.ok((await run({op:'episodeCards', slug:'neutral'})).some(episode => episode.episode === 5));
  assert.deepEqual(await run({op:'episodeCheck', episode:7}), {matches:true});
  assert.deepEqual(await run({op:'episodeCheck', episode:8}), {matches:false});
  const next = await run({op:'findEpisode', episode:2, slug:'neutral'});
  assert.equal(next.href, null);
  assert.ok(next.pick);
  await run({op:'click', pick:next.pick});
  assert.deepEqual(await run({op:'episodeCheck', episode:2}), {matches:true});
  await win.loadURL('https://control-selection.test/watch/alternate');
  const alternateOptions = await options();
  assert.equal(alternateOptions.find(option => option.value === 'backup serverbackup')?.label, 'Backup server');
  assert.equal(alternateOptions.find(option => option.value === 'default')?.active, true);
  await choose('server', 'backup serverbackup');
  await choose('server', 'default');
  console.log('PASS active audio, adjacent provider switching, excluded download row, and in-page episode selection');
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
