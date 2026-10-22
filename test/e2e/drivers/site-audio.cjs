// SUB/DUB switching on real sites, in-process (see site-survey.cjs for why).
// For each site: open an episode, read the audio/server options, choose DUB, read them again,
// and check the site's player is still the only thing shown.
//   AUDIO_SOURCES=example-to,other-site-to node test/e2e/native.mjs test/e2e/drivers/site-audio.cjs
// (source ids from config/streaming-sites.txt: the host with dots as dashes)
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function audio({ window, webContents }) {
  const only = (process.env.AUDIO_SOURCES ?? '').split(',').filter(Boolean);
  if (!only.length) throw new Error('Set AUDIO_SOURCES to the source ids to test (see config/streaming-sites.txt).');
  const MEDIA_ID = Number(process.env.SURVEY_ID ?? 154587);
  const EPISODE = Number(process.env.SURVEY_EP ?? 3);
  const ui = (code) => window.webContents.executeJavaScript(code, true);
  const rpc = (m, i) => ui(`window.aniverse.invoke(${JSON.stringify(m)}, ${i === undefined ? 'undefined' : JSON.stringify(i)}).catch((e) => ({ error: e.message }))`);
  const until = async (code, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
      const v = await ui(code).catch(() => null);
      if (v) return v;
    }
    return null;
  };
  const summary = (o) => ({
    audio: (o.types ?? []).map((t) => `${t.label}${t.active ? '*' : ''}`).join(' ') || '-',
    servers: (o.servers ?? []).map((s) => `${s.label}${s.active ? '*' : ''}${s.group ? `(${s.group})` : ''}`).join(' ') || '-',
  });
  const focusState = (wc) => wc.executeJavaScript(`(() => { const p = document.querySelector('[data-aniverse-player]'); return { marked: !!p, tag: p && p.tagName, url: location.href } })()`).catch(() => null);

  await until(`!!document.querySelector('.app')`, 30000);
  const details = await rpc('meta.details', { id: MEDIA_ID });
  const titles = [...new Set([details.title.english, details.title.romaji].filter(Boolean))];
  const report = [];
  for (const id of only) {
    const entry = { id };
    try {
      await ui(`location.hash = '#/sources'`);
      await until(`!document.querySelector('webview')`, 10000);
      await ui(`location.hash = ${JSON.stringify(`#/sources/${id}`)}`);
      const wcId = await until(`(() => { try { return document.querySelector('webview')?.getWebContentsId() || 0 } catch { return 0 } })()`, 30000);
      const wc = webContents.fromId(wcId);
      await sleep(2000);
      const opened = await rpc('site.openEpisode', { webContentsId: wcId, sourceId: id, mediaId: MEDIA_ID, titles, episode: EPISODE, focus: true });
      entry.opened = { ok: opened.ok, via: opened.via, focused: opened.focused };
      entry.before = summary(opened.options ?? {});
      if (!(opened.options?.types ?? []).length) {
        // Why no options? Dump the candidate controls and the player as the page sees them.
        entry.diagnose = await wc
          .executeJavaScript(`(() => {
            const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)].join(','); };
            const cands = [...document.querySelectorAll('button, a, li, label, [role="tab"]')].filter((e) => /^(sub|dub|hd-?\\d|vidstream)/i.test((e.textContent || '').trim())).slice(0, 8);
            const p = document.querySelector('[data-aniverse-player]');
            return { player: p ? p.tagName + ' ' + r(p) : null, media: [...document.querySelectorAll('iframe, video')].map((m) => m.tagName + ' ' + r(m)).slice(0, 6),
              candidates: cands.map((e) => e.tagName + ' "' + e.textContent.trim().slice(0, 14) + '" ' + r(e) + ' visible=' + !!(e.offsetParent || e.getClientRects().length) + ' ' + (e.closest('header, footer, nav') ? 'in-header/nav' : '')) };
          })()`)
          .catch((e) => e.message);
      }
      // Like the Watch page: if the switches weren't rendered yet, read them again a bit later.
      if (!(opened.options?.types ?? []).length) {
        await sleep(4000);
        opened.options = await rpc('site.options', { webContentsId: wcId });
        entry.later = summary(opened.options ?? {});
      }
      const dub = (opened.options?.types ?? []).find((t) => t.value === 'dub');
      if (dub) {
        // Press AniVerse's own DUB button, like the user does, and wait until it's done.
        await until(`[...document.querySelectorAll('.opt-btn')].some((b) => b.textContent.trim() === ${JSON.stringify(dub.label)} && !b.disabled)`, 20000);
        await ui(`[...document.querySelectorAll('.opt-btn')].find((b) => b.textContent.trim() === ${JSON.stringify(dub.label)})?.click()`);
        await sleep(500);
        await until(`![...document.querySelectorAll('.opt-btn')].some((b) => b.disabled)`, 30000);
        await sleep(6000);
        const now = await rpc('site.options', { webContentsId: wcId });
        entry.after = summary(now ?? {});
        entry.buttons = await ui(`[...document.querySelectorAll('.opt-btn')].map((b) => b.textContent.trim() + (b.classList.contains('active') ? '*' : '')).join(' ')`);
        entry.page = await focusState(wc);
        entry.media = await wc
          .executeJavaScript(`(() => { const p = document.querySelector('[data-aniverse-player]'); return p ? (p.src || p.currentSrc || '').slice(0, 120) : null })()`)
          .catch(() => null);
        writeFileSync(path.join(root, 'test', 'artifacts', `audio-${id}-dub.png`), (await window.webContents.capturePage()).toPNG());
        // put the site preference back to SUB for the user's own sessions
        await rpc('site.choose', { webContentsId: wcId, sourceId: id, kind: 'type', value: 'sub' });
      }
      writeFileSync(path.join(root, 'test', 'artifacts', `audio-${id}.png`), (await window.webContents.capturePage()).toPNG());
    } catch (err) {
      entry.error = String(err?.message ?? err);
    }
    report.push(entry);
    console.log(JSON.stringify(entry));
  }
  writeFileSync(path.join(root, 'test', 'artifacts', 'site-audio.json'), JSON.stringify(report, null, 2));
};
