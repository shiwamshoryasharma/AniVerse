import assert from 'node:assert/strict';

const deviceId = 'chrome:isolated-mirror-fixture';

export async function verifyGuestMirror(page, rpc, poll, webContentsId, nextUrl) {
  // The Windows Cast chooser opens Chrome before presenting a receiver to click.
  assert.ok(Array.isArray(await rpc('cast.chromeDevices')));
  await page.evaluate(async ({deviceId}) => {
    const tauri = window.__TAURI__;
    const invoke = (method, input) => tauri.core.invoke('desktop_rpc', {method,input});
    const test = window.aniverseMirrorFixture = { frames:0, offered:0, sequences:[], ended:[], result:null };
    await tauri.event.listen('aniverse:player/captureEnded', ({payload}) => {
      if (payload.purpose === 'mirror') {
        test.ended.push(payload.ticket);
        test.elapsedToEnd = Math.round(performance.now() - test.startedAt);
      }
    });
    await tauri.event.listen('aniverse:cast/mirrorFrame', async ({payload}) => {
      test.offered++;
      if (payload.ticket !== test.result?.ticket || test.acknowledging) return;
      if (Object.keys(payload).sort().join(',') !== 'sequence,ticket') {
        test.unexpectedPayload = true;
        return;
      }
      test.acknowledging = true;
      const data = {ticket:payload.ticket, sequence:payload.sequence, bytes:[]};
      try {
        if (test.forgeryRejected === undefined) {
          try { await invoke('cast.mirrorChunk',{...data,bytes:[1]}); test.forgeryRejected = false; }
          catch { test.forgeryRejected = true; }
        }
        await invoke('cast.mirrorChunk',data);
        test.sequences.push(payload.sequence);
        test.frames++;
        if (test.replayRejected === undefined) {
          try { await invoke('cast.mirrorChunk',data); test.replayRejected = false; }
          catch { test.replayRejected = true; }
        }
      } catch (error) { test.lastAckError = error.message ?? String(error); }
      finally { test.acknowledging = false; }
    });
    const button = document.createElement('button');
    button.id = 'fixture-start-mirror';
    button.style = 'position:fixed;left:0;top:0;z-index:99999';
    button.textContent = 'Start fixture mirroring';
    button.onclick = async () => {
      test.startedAt = performance.now();
      try {
        test.result = await invoke('cast.mirrorPrepare', {
          webContentsId:test.guest,deviceId,title:'Neutral source mirror',upscale:false,
        });
      } catch (error) {test.result = {error:error.message ?? String(error)};}
    };
    document.body.append(button);
  },{deviceId});

  const start = async (guest) => {
    await page.evaluate(id => { Object.assign(window.aniverseMirrorFixture,{guest:id,result:null}); },guest);
    await page.locator('#fixture-start-mirror').click();
    return poll(() => page.evaluate(() => window.aniverseMirrorFixture.result),10000);
  };
  assert.match((await start(999999))?.error ?? '',/owned|source|player/i);
  assert.match((await start(webContentsId))?.error ?? '',/player-only|focused/i);
  assert.equal((await rpc('site.focus',{webContentsId,on:true})).focused,true);
  const grant = await start(webContentsId);
  assert.ok(grant?.ticket,JSON.stringify(grant));
  const sampled = await poll(() => page.evaluate(ticket => {
    const state = window.aniverseMirrorFixture;
    return state.frames >= 3 || state.ended.includes(ticket) ? state : null;
  },grant.ticket));
  if (!sampled || sampled.frames < 3) {
    const {frames,offered,ended,lastAckError,elapsedToEnd} = sampled ?? await page.evaluate(() => window.aniverseMirrorFixture);
    const playback = await rpc('cast.state');
    assert.fail(JSON.stringify({frames,offered,ended:ended.length,lastAckError,elapsedToEnd,status:playback.status,error:playback.error}));
  }
  const playback = await poll(async () => {
    const state = await rpc('cast.state');
    return ['playing','error','ended'].includes(state.status) ? state : null;
  });
  const {status,error} = playback ?? await rpc('cast.state');
  assert.equal(status,'playing',JSON.stringify({acknowledgedFrames:sampled.frames,status,error}));
  const evidence = await page.evaluate(() => {
    const { frames,sequences,forgeryRejected,replayRejected,unexpectedPayload } = window.aniverseMirrorFixture;
    return { frames,sequences,forgeryRejected,replayRejected,unexpectedPayload };
  });
  assert.ok(evidence.forgeryRejected && evidence.replayRejected && !evidence.unexpectedPayload);
  assert.ok(evidence.sequences.every((sequence,index,list) => !index || sequence > list[index-1]));
  await rpc('cast.mirrorStop',{ticket:'00000000-0000-0000-0000-000000000000'}).catch(() => undefined);
  assert.ok(await poll(() => page.evaluate(count => window.aniverseMirrorFixture.frames > count,evidence.frames)));
  assert.equal(await rpc('player.control',{action:'pause',webContentsId}),true);
  assert.equal((await rpc('site.focus',{webContentsId,on:false})).focused,false);
  assert.ok(await poll(() => page.evaluate(ticket => window.aniverseMirrorFixture.ended.includes(ticket),grant.ticket),2000));
  const terminal = await poll(async () => {
    const state = await rpc('cast.state');
    return ['idle','ended','error'].includes(state.status) ? state : null;
  });
  const {status:chromeStopped,error:stopError} = terminal ?? await rpc('cast.state');
  assert.ok(['idle','ended'].includes(chromeStopped),JSON.stringify({captureRevoked:true,lastChromeStatus:chromeStopped,stopError}));
  await rpc('site.surface',{action:'navigate',webContentsId,url:nextUrl});
  await page.locator('#fixture-start-mirror').evaluate(button => button.remove());
  return { acknowledgedFrames:evidence.frames, chromePlaying:true, chromeStopped, revokedOnLeavingPlayerOnlyMode:true, videoOnly:true };
}
