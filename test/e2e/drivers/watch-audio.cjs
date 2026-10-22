// SUB/DUB through the Watch page exactly as a user does it: open the episode on a website
// source, wait for AniVerse's SUB/DUB buttons, press DUB, and check the site switched while
// only its player stays visible. Screenshots: test/artifacts/watch-audio-<id>-{sub,dub}.png.
//   AUDIO_SOURCES=example-to SURVEY_ID=213805 SURVEY_EP=4 node test/e2e/native.mjs test/e2e/drivers/watch-audio.cjs
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function watchAudio({ window, webContents }) {
  const only = (process.env.AUDIO_SOURCES ?? '').split(',').filter(Boolean);
  if (!only.length) throw new Error('Set AUDIO_SOURCES to the source ids to test (see config/streaming-sites.txt).');
  const MEDIA_ID = Number(process.env.SURVEY_ID ?? 154587);
  const EPISODE = Number(process.env.SURVEY_EP ?? 3);
  const ui = (code) => window.webContents.executeJavaScript(code, true);
  const until = async (code, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
      const v = await ui(code).catch(() => null);
      if (v) return v;
    }
    return null;
  };
  const buttons = () => ui(`[...document.querySelectorAll('.opt-btn')].map((b) => b.textContent.trim() + (b.classList.contains('active') ? '*' : '') + (b.disabled ? '(off)' : '')).join(' ')`);
  const pageState = (wc) =>
    wc
      .executeJavaScript(
        `(() => { const p = document.querySelector('[data-aniverse-player]'); return { marked: !!p, tag: p && p.tagName, src: p ? (p.src || '').slice(0, 90) : null, url: location.href } })()`,
      )
      .catch((e) => ({ error: String(e) }));
  // What the embedded player itself reports: playing? which audio tracks / which one is on?
  const playerState = async (wc) => {
    const out = [];
    for (const f of wc.mainFrame.framesInSubtree) {
      if (f === wc.mainFrame) continue;
      const s = await f
        .executeJavaScript(
          `(() => { const v = document.querySelector('video'); if (!v) return null;
            const jw = typeof window.jwplayer === 'function' ? window.jwplayer() : null;
            const hls = window.hls || window.Hls && window.player && window.player.hls;
            const tracks = jw && jw.getAudioTracks ? jw.getAudioTracks().map((t) => t.name || t.language) : hls && hls.audioTracks ? hls.audioTracks.map((t) => t.name || t.lang) : v.audioTracks ? [...v.audioTracks].map((t) => t.label || t.language) : null;
            const current = jw && jw.getCurrentAudioTrack ? jw.getCurrentAudioTrack() : hls ? hls.audioTrack : null;
            return { host: location.host, time: Math.round(v.currentTime), paused: v.paused, tracks, current } })()`,
        )
        .catch(() => null);
      if (s) out.push(s);
    }
    return out;
  };
  const shot = async (name) => writeFileSync(path.join(root, 'test', 'artifacts', `watch-audio-${name}.png`), (await window.webContents.capturePage()).toPNG());

  await until(`!!document.querySelector('.app')`, 30000);
  const report = [];
  for (const id of only) {
    const entry = { id };
    try {
      await ui(`location.hash = '#/sources'`);
      await until(`!document.querySelector('webview')`, 10000);
      await ui(`location.hash = ${JSON.stringify(`#/watch/${MEDIA_ID}/${EPISODE}?source=${id}`)}`);
      const wcId = await until(`(() => { try { return document.querySelector('webview')?.getWebContentsId() || 0 } catch { return 0 } })()`, 30000);
      const wc = webContents.fromId(wcId);
      // the Watch page's own retries end 10 s after the episode opened
      const ready = await until(`[...document.querySelectorAll('.opt-btn')].some((b) => /dub/i.test(b.textContent) && !b.disabled)`, 90000);
      entry.before = await buttons();
      entry.beforePage = await pageState(wc);
      entry.beforePlayer = await playerState(wc);
      await shot(`${id}-sub`);
      if (ready) {
        await ui(`[...document.querySelectorAll('.opt-btn')].find((b) => /^dub$/i.test(b.textContent.trim()))?.click()`);
        await sleep(500);
        await until(`![...document.querySelectorAll('.opt-btn')].some((b) => b.disabled)`, 45000);
        await sleep(8000);
        entry.after = await buttons();
        entry.afterPage = await pageState(wc);
        entry.player = await playerState(wc);
        entry.toasts = await ui(`[...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()).join(' | ')`);
        await shot(`${id}-dub`);
        // put the site preference back to SUB for the user's own sessions
        await ui(`[...document.querySelectorAll('.opt-btn')].find((b) => /^sub$/i.test(b.textContent.trim()))?.click()`);
        await until(`![...document.querySelectorAll('.opt-btn')].some((b) => b.disabled)`, 45000);
      }
    } catch (err) {
      entry.error = String(err?.message ?? err);
    }
    report.push(entry);
    console.log(JSON.stringify(entry));
  }
  writeFileSync(path.join(root, 'test', 'artifacts', 'watch-audio.json'), JSON.stringify(report, null, 2));
};
