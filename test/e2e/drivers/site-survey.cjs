// Site survey driver: runs inside the AniVerse main process (see runTestDriver in
// electron/main.ts) so websites see a normal browser — no remote debugging, so
// navigator.webdriver stays false. Drives every selected website through the
// site navigator (search → title → episode → player) and records how it went.
// Launch with test/e2e/site-survey.mjs. Output: test/artifacts/site-survey.json + survey-<id>.png
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const artifacts = path.join(root, 'test', 'artifacts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function survey({ window, webContents }) {
  mkdirSync(artifacts, { recursive: true });
  const only = new Set((process.env.SURVEY_SOURCES ?? '').split(',').filter(Boolean));
  const MEDIA_ID = Number(process.env.SURVEY_ID ?? 154587);
  const EPISODE = Number(process.env.SURVEY_EP ?? 3);
  const PER_SITE_MS = Number(process.env.SURVEY_TIMEOUT ?? 80000);

  const ui = (code) => window.webContents.executeJavaScript(code, true);
  const rpc = (method, input) => ui(`window.aniverse.invoke(${JSON.stringify(method)}, ${JSON.stringify(input ?? null) === 'null' ? 'undefined' : JSON.stringify(input)}).catch((e) => ({ error: e.message }))`);
  const until = async (code, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
      const v = await ui(code).catch(() => null);
      if (v) return v;
    }
    return null;
  };
  const inspect = (wc) =>
    wc
      .executeJavaScript(`(() => {
        const iframes = [...document.querySelectorAll('iframe')].filter(f => f.offsetWidth > 200).map(f => { try { return new URL(f.src).host } catch { return f.src.slice(0, 40) } });
        return {
          url: location.href, title: document.title, webdriver: navigator.webdriver,
          forms: [...document.forms].filter(f => (f.method || 'get').toLowerCase() === 'get').map(f => f.getAttribute('action')).slice(0, 3),
          players: { iframes, videos: document.querySelectorAll('video').length },
          marked: !!document.querySelector('[data-aniverse-player]'),
        };
      })()`)
      .catch((e) => ({ error: e.message }));

  await until(`!!document.querySelector('.app')`, 30000);
  const details = await rpc('meta.details', { id: MEDIA_ID });
  const titles = [...new Set([details.title.english, details.title.romaji, ...(details.synonyms ?? []).slice(0, 2)].filter(Boolean))];
  const sources = (await rpc('sources.list')).filter((s) => s.kind === 'web' && (!only.size || only.has(s.id)));
  console.log(`Survey: "${titles[0]}" episode ${EPISODE} on ${sources.length} sites`);

  const report = [];
  for (const s of sources) {
    const started = Date.now();
    const entry = { id: s.id, host: s.host, start: s.url };
    try {
      // Leave the previous site first so its webview is gone before we look for the new one.
      await ui(`location.hash = '#/sources'`);
      await until(`!document.querySelector('webview')`, 10000);
      await ui(`location.hash = ${JSON.stringify(`#/sources/${s.id}`)}`);
      const wcId = await until(`(() => { try { return document.querySelector('webview')?.getWebContentsId() || 0 } catch { return 0 } })()`, 30000);
      const wc = wcId && webContents.fromId(wcId);
      if (!wc) throw new Error('site view did not open');
      await sleep(2500);
      entry.home = await inspect(wc);
      const navs = [];
      const onNav = (_e, u, code) => navs.push(`${code} ${u}`);
      const onSpa = (_e, u, main) => main && navs.push(`spa ${u}`);
      wc.on('did-navigate', onNav);
      wc.on('did-navigate-in-page', onSpa);
      await ui(`window.__siteStatus = []; window.__off?.(); window.__off = window.aniverse.on('site.status', (e) => e.message && window.__siteStatus.push(e.message)); true`);
      entry.result = await Promise.race([
        rpc('site.openEpisode', { webContentsId: wcId, sourceId: s.id, mediaId: MEDIA_ID, titles, episode: EPISODE, focus: true }),
        sleep(PER_SITE_MS).then(() => ({ timeout: true })),
      ]);
      entry.statuses = await ui('window.__siteStatus');
      entry.final = await inspect(wc);
      entry.navs = navs;
      wc.off('did-navigate', onNav);
      wc.off('did-navigate-in-page', onSpa);
      entry.searchTemplate = (await rpc('sources.list')).find((x) => x.id === s.id)?.searchTemplate ?? null;
      await sleep(1500);
      writeFileSync(path.join(artifacts, `survey-${s.id}.png`), (await window.webContents.capturePage()).toPNG());
    } catch (err) {
      entry.error = String(err?.message ?? err).split('\n')[0];
    }
    entry.ms = Date.now() - started;
    report.push(entry);
    const r = entry.result ?? {};
    const opts = r.options ? ` types=${r.options.types.map((o) => o.label).join('/') || '-'} servers=${r.options.servers.length}` : '';
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${s.id.padEnd(16)} ${String(entry.ms).padStart(6)}ms via=${r.via ?? '-'} focus=${r.focused ?? '-'}${opts} ${r.timeout ? 'TIMEOUT' : ''} ${entry.error ?? (r.ok ? '' : r.message ?? r.error ?? '')}`);
  }
  writeFileSync(path.join(artifacts, 'site-survey.json'), JSON.stringify({ titles, episode: EPISODE, report }, null, 2));
};
