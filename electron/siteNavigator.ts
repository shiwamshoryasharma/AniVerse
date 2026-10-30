import type { WebContents } from 'electron';
import { readFileSync, statSync } from 'node:fs';
import type { Store } from '../app/core/db/store';
import { isChallengeTitle } from '../app/core/net/cloudflare';
import { parseRecipes, recipeFor, type RecipeBook, type SiteRecipe } from '../app/core/sources/recipes';
import type { SourceRegistry } from '../app/core/sources/registry';
import { episodeFromUrl, seasonOf } from '../app/core/sources/text';
import { buildSearchUrl, siteDomain } from '../app/core/sources/web';
import { sleep } from '../app/core/util';
import type { OpenEpisodeRequest, OpenEpisodeResult, ProbeResult, SiteOption, SiteOptions, SiteStatusEvent, SourceInfo } from '../app/shared/types';
import { FOCUS_CSS, pageScript, recipeSelector, SCROLLBAR_CSS, type PageOp, type PickResult, type RawSiteOption } from './sitePage';

const WORLD = 1017;
const EMPTY_OPTIONS: SiteOptions = { types: [], servers: [] };

/** Removes episode markers so pages of the same title compare equal. */
export function titleKey(url: string): string {
  try {
    const u = new URL(url);
    for (const k of ['ep', 'episode', 'e', 'lang', 'server']) u.searchParams.delete(k);
    const path = u.pathname
      .replace(/\/(?:episode|ep)[-_]?\d{1,4}\/?$/i, '')
      .replace(/[-_](?:episode|ep)[-_]?\d{1,4}\/?$/i, '')
      .replace(/(\/watch\/[^/]+)\/\d{1,4}\/?$/i, '$1')
      .replace(/\/+$/, '');
    return `${u.host.replace(/^www\./, '')}${path}?${u.searchParams.toString()}`;
  } catch {
    return url;
  }
}

/** Builds episode N's URL from a known episode URL that carries its number. */
export function deriveEpisodeUrl(known: Record<number, string>, n: number): string | null {
  for (const [key, url] of Object.entries(known)) {
    const m = Number(key);
    if (!m || m === n) continue;
    try {
      const u = new URL(url);
      if (episodeFromUrl(url) !== m) continue;
      for (const k of ['ep', 'episode', 'e']) {
        if (u.searchParams.get(k) === String(m)) {
          u.searchParams.set(k, String(n));
          return u.toString();
        }
      }
      const path = u.pathname.replace(new RegExp(`((?:episode|ep)[-_/]?)0*${m}(?=/|$|-|\\.)`, 'i'), `$1${n}`);
      if (path !== u.pathname) {
        u.pathname = path;
        return u.toString();
      }
      const watch = u.pathname.replace(new RegExp(`(/watch/[^/]+/)0*${m}(/?)$`, 'i'), `$1${n}$2`);
      if (watch !== u.pathname) {
        u.pathname = watch;
        return u.toString();
      }
    } catch {
      // ignore malformed entries
    }
  }
  return null;
}

/**
 * Search terms that site search boxes match reliably: punctuation stripped
 * (curly apostrophes break many sites), then the short head of the title
 * ("Frieren" for "Frieren: Beyond Journey’s End"), then the romaji title.
 * Results are still matched against the full titles.
 */
export function searchQueries(titles: string[]): string[] {
  const clean = (t: string) =>
    t
      .replace(/[’'`´]/g, '')
      .replace(/[“”"!?.,;:()[\]{}~|/\\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const out: string[] = [];
  const add = (q: string) => {
    if (q.length >= 3 && !out.some((x) => x.toLowerCase() === q.toLowerCase())) out.push(q);
  };
  if (titles[0]) add(clean(titles[0]));
  for (const title of titles.slice(1,5)) add(clean(title));
  const head = titles[0]?.split(/\s*[:–—]\s*|\s+-\s+/)[0] ?? '';
  if (head.length >= 4) add(clean(head));
  return out.slice(0, 6);
}

/** Path segment that identifies the title on the site (`/anime/<slug>` → slug). */
function slugOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const seg = parts.find((p, i) => i > 0 && !/^(?:ep|episode)[-_]?\d+$/i.test(p) && !/^\d+$/.test(p)) ?? parts[0];
    return seg && seg.length >= 4 ? seg : null;
  } catch {
    return null;
  }
}

/** Groups raw page options for the renderer (servers of the active audio type first). */
export function toSiteOptions(raw: RawSiteOption[] | null): SiteOptions {
  if (!raw?.length) return EMPTY_OPTIONS;
  const map = (o: RawSiteOption): SiteOption => ({ kind: o.kind, label: o.label, value: o.value, active: o.active, group: o.group });
  const types = raw.filter((o) => o.kind === 'type').map(map);
  const activeType = types.find((t) => t.active)?.value ?? null;
  let servers = raw.filter((o) => o.kind === 'server').map(map);
  if (activeType && servers.some((s) => s.group)) servers = servers.filter((s) => !s.group || s.group === activeType);
  return { types, servers };
}

interface SitePreference {
  type?: string;
  server?: string;
}

/**
 * Drives a source webview to a title's episode page using the site's own
 * search, links and buttons (in an isolated world), then isolates the site's
 * player and exposes its SUB/DUB and server switches. It never extracts media
 * URLs — the site's own player plays.
 */
export class SiteNavigator {
  private jobs = new Map<number, number>();
  private focusCss = new Map<number, string>();
  private focusWanted = new Map<number, boolean>();
  private focusGen = new Map<number, number>();
  private recipes: RecipeBook = {};
  private recipesMtime = -1;

  constructor(
    private store: Store,
    private registry: SourceRegistry,
    private recipesFile: string,
    private emit: (e: SiteStatusEvent) => void,
    private probe: (wc: WebContents) => Promise<ProbeResult | null>,
    private autoplay: () => boolean,
    private control?: (wc: WebContents, action: 'seek' | 'play' | 'pause', value?: number) => Promise<boolean>,
  ) {}

  /** Recipes are re-read when the file changes (cheap mtime check). */
  book(): RecipeBook {
    try {
      const mtime = statSync(this.recipesFile).mtimeMs;
      if (mtime !== this.recipesMtime) {
        const parsed = parseRecipes(readFileSync(this.recipesFile, 'utf8'));
        for (const w of parsed.warnings) console.warn(`[recipes] ${w}`);
        this.recipes = parsed.recipes;
        this.recipesMtime = mtime;
      }
    } catch {
      this.recipes = {};
    }
    return this.recipes;
  }

  /** Applies app scrollbars and re-applies focus mode after every page load. */
  attach(wc: WebContents) {
    const restyle = () => {
      if (wc.isDestroyed()) return;
      void wc.insertCSS(SCROLLBAR_CSS).catch(() => undefined);
      if (this.focusWanted.get(wc.id)) setTimeout(() => void this.focus(wc, true, null), 1200);
    };
    wc.on('dom-ready', restyle);
    wc.on('did-frame-finish-load',(_event,isMainFrame)=>{if(!isMainFrame&&this.focusWanted.get(wc.id))void this.focusChildren(wc,true);});
    wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
      if (isMainFrame && this.focusWanted.get(wc.id)) setTimeout(() => void this.focus(wc, true, null), 1200);
    });
    wc.once('destroyed', () => {
      this.jobs.delete(wc.id);
      this.focusCss.delete(wc.id);
      this.focusWanted.delete(wc.id);
      this.focusGen.delete(wc.id);
    });
  }

  /** Player documents inside cross-origin embeds need their own layout repair. No media URLs or source data leave the frame. */
  private async focusChildren(wc:WebContents,on:boolean) {
    if(wc.isDestroyed())return;
    for(const frame of wc.mainFrame.framesInSubtree){
      if(frame===wc.mainFrame||/recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com/i.test(frame.url))continue;
      if(wc.isDestroyed()||this.focusWanted.get(wc.id)!==on)return;
      const code=on
        ?'(()=>{const result='+pageScript({op:'markPlayer',keep:true})+';if(!result?.found)return;let style=document.getElementById("aniverse-frame-focus");if(!style){style=document.createElement("style");style.id="aniverse-frame-focus";document.documentElement.append(style);}style.textContent='+JSON.stringify(FOCUS_CSS)+';})()'
        :pageScript({op:'releasePlayer'})+';document.getElementById("aniverse-frame-focus")?.remove();';
      await frame.executeJavaScript(code).catch(()=>undefined);
    }
  }

  private async page<T>(wc: WebContents, op: PageOp): Promise<T | null> {
    if (wc.isDestroyed()) return null;
    try {
      return (await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: pageScript(op) }], true)) as T;
    } catch (err) {
      // Navigations abort scripts routinely; anything else is a bug in a page op worth seeing.
      const message = err instanceof Error ? err.message : String(err);
      if (!/destroyed|navigat|context|frame/i.test(message)) console.warn(`[site] ${op.op} failed: ${message}`);
      return null;
    }
  }

  private async settle(wc: WebContents, alive: () => boolean, extraMs = 900, status?: (m: string) => void) {
    const deadline = Date.now() + 20000;
    while (alive() && wc.isLoading() && Date.now() < deadline) await sleep(150);
    // Wait out a Cloudflare interstitial (the user may need to complete it).
    const cfDeadline = Date.now() + 90000;
    while (alive() && isChallengeTitle(wc.getTitle()) && Date.now() < cfDeadline) {
      status?.('Waiting for the site’s security check…');
      await sleep(500);
    }
    await sleep(extraMs);
  }

  private async load(wc: WebContents, url: string, alive: () => boolean, status?: (m: string) => void) {
    await wc.loadURL(url).catch(() => undefined);
    await this.settle(wc, alive, 900, status);
  }

  private async poll<T>(fn: () => Promise<T | null>, alive: () => boolean, timeoutMs: number): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    while (alive() && Date.now() < deadline) {
      const r = await fn();
      if (r && (!Array.isArray(r) || r.length)) return r;
      await sleep(450);
    }
    return null;
  }

  private onSite(source: SourceInfo, url: string) {
    try {
      return siteDomain(new URL(url).hostname) === siteDomain(source.host);
    } catch {
      return false;
    }
  }

  async openEpisode(wc: WebContents, source: SourceInfo, req: OpenEpisodeRequest): Promise<OpenEpisodeResult> {
    const token = (this.jobs.get(wc.id) ?? 0) + 1;
    this.jobs.set(wc.id, token);
    const alive = () => this.jobs.get(wc.id) === token && !wc.isDestroyed();
    const status = (message: string | null) => {
      if (alive()) this.emit({ webContentsId: wc.id, sourceId: source.id, message });
    };
    const N = req.episode;
    const recipe = recipeFor(this.book(), source.host);
    const cache = recipe?.cacheLinks !== false;
    const links = cache ? this.store.getSiteLinks(source.id, req.mediaId) : {};
    const pinned = this.store.getPin(source.id, req.mediaId);
    let titlePage: string | null = pinned ?? links[0] ?? null;
    // Keep the site quiet while AniVerse works behind the loading screen.
    if (!req.adopt) wc.setAudioMuted(true);

    const finish = async (ok: boolean, via: OpenEpisodeResult['via'], message: string | null): Promise<OpenEpisodeResult> => {
      const url = wc.isDestroyed() ? '' : wc.getURL();
      if(ok&&alive()&&(await this.page<{missing:boolean}>(wc,{op:'availability'}))?.missing)return fail('This source no longer has the requested page.',via,'not-found');
      if (ok && alive() && cache && this.onSite(source, url)) {
        this.store.setSiteLink(source.id, req.mediaId, N, url);
        if (!links[0] && !pinned && titlePage) this.store.setSiteLink(source.id, req.mediaId, 0, titlePage);
      }
      let focused = false;
      let options = EMPTY_OPTIONS;
      if (ok && alive()) {
        status('Getting the player ready…');
        options = await this.applyPreferences(wc, source, alive);
        if (req.focus ?? true) focused = await this.focus(wc, true, recipe);
        if (alive()) wc.setAudioMuted(false);
        if (focused && alive() && !req.adopt) await this.kickPlayback(wc, alive);
      } else if (alive()) {
        wc.setAudioMuted(false);
      }
      status(null);
      return { ok, url, via, focused, message, options };
    };
    const fail = (message: string | null, via: OpenEpisodeResult['via'] = null, failure: OpenEpisodeResult['failure'] = 'unavailable'): OpenEpisodeResult => {
      failure = !alive() ? 'cancelled' : isChallengeTitle(wc.getTitle()) ? 'blocked' : failure;
      if (failure === 'blocked') message = 'Complete this source’s security check, then retry the episode.';
      if (alive()) wc.setAudioMuted(false);
      status(null);
      return { ok: false, failure, url: wc.isDestroyed() ? '' : wc.getURL(), via, focused: false, message, options: EMPTY_OPTIONS };
    };

    try {
      const current = wc.getURL();
      const known = Object.entries(links)
        .filter(([k]) => Number(k) > 0)
        .map(([, u]) => u);

      // 0. The site already shows this episode.
      if (req.adopt || (links[N] && links[N] === current)) return finish(true, 'current', null);
      if (episodeFromUrl(current) === N && known.some((u) => titleKey(u) === titleKey(current))) return finish(true, 'current', null);

      // 1. Learned episode page, or one derived from a sibling episode's URL pattern.
      if (links[N]) {
        status(`Loading episode ${N}…`);
        await this.load(wc, links[N], alive, status);
        return finish(true, 'cache', null);
      }
      const derived = deriveEpisodeUrl(links, N);
      if (derived) {
        status(`Loading episode ${N}…`);
        await this.load(wc, derived, alive, status);
        if (episodeFromUrl(wc.getURL()) === N) return finish(true, 'derived', null);
      }

      // 2. Title page: pinned/learned, or found through the site's search.
      if (titlePage) {
        status('Opening the series…');
        await this.load(wc, titlePage, alive, status);
      } else {
        titlePage = await this.searchTitle(wc, source, recipe, req, alive, status);
        if (!alive()) return fail(null);
        if (!titlePage) return fail(`Couldn’t find this title on ${source.name}.`, null, 'not-found');
      }

      // 3. Title links that already point at an episode (`/watch/<id>/1`): derive N directly.
      const here = wc.getURL();
      const hereEp = episodeFromUrl(here);
      if (hereEp !== null) {
        if (hereEp === N) return finish(true, 'search', null);
        const direct = deriveEpisodeUrl({ [hereEp]: here }, N);
        if (direct) {
          status(`Loading episode ${N}…`);
          await this.load(wc, direct, alive, status);
          if (episodeFromUrl(wc.getURL()) === N) return finish(true, 'derived', null);
        }
      }

      // 4. Episode N on the title page (or its watch page).
      const found = await this.openEpisodeOnPage(wc, recipe, N, slugOf(titlePage), alive, status);
      if (!alive()) return fail(null);
      if (!found) return fail(`Opened the series on ${source.name}, but couldn’t find episode ${N}.`, 'title', 'not-found');
      return finish(true, 'search', null);
    } catch (err) {
      if(alive()&&(await this.page<{missing:boolean}>(wc,{op:'availability'}))?.missing)return fail('This source no longer has the requested page.',null,'not-found');
      return fail((err as Error).message);
    }
  }

  private async searchTitle(wc: WebContents, source: SourceInfo, recipe: SiteRecipe | null, req: OpenEpisodeRequest, alive: () => boolean, status: (m: string | null) => void): Promise<string | null> {
    const season = Math.max(1, ...req.titles.map((t) => seasonOf(t) ?? 1));
    const titleSelector = recipeSelector(recipe, 'titleLink');
    // Make sure discovery (OpenSearch / GET form / SearchAction) has had a chance first.
    if (!this.registry.get(source.id).searchTemplate && !this.store.isPrivate(req.mediaId)) await this.registry.discover(source.id).catch(() => null);

    for (const query of searchQueries(req.titles)) {
      if (!alive()) return null;
      status('Searching for the series…');
      const template = this.registry.get(source.id).searchTemplate;
      if (template) await this.load(wc, buildSearchUrl(template, query), alive, status);
      else if (!(await this.searchWithSiteBox(wc, source, query, alive, status))) continue;

      const findHits = () => this.page<PickResult[]>(wc, { op: 'findTitle', titles: req.titles, season, selector: titleSelector });
      let hits = await this.poll(findHits, alive, 7000);
      if (!hits && (await this.page<{ clicked: boolean }>(wc, { op: 'viewAll' }))?.clicked) {
        await this.settle(wc, alive, 1500, status);
        this.learnFromUrl(source, wc.getURL(), query);
        hits = await this.poll(findHits, alive, 6000);
      }
      if (!hits) continue;

      // Try the best candidates; keep the first page whose heading matches the requested title/season.
      const results = wc.getURL();
      for (const hit of hits) {
        if (!alive()) return null;
        status('Opening the series…');
        if (hit.href) await this.load(wc, hit.href, alive, status);
        else {
          await this.page(wc, { op: 'click', pick: hit.pick! });
          await this.settle(wc, alive, 1800, status);
        }
        const check = await this.page<{ score: number; checked: number }>(wc, { op: 'titleCheck', titles: req.titles, season });
        if (!check || check.checked === 0 || check.score >= 0.6) return wc.getURL();
        if (hit !== hits[hits.length - 1]) await this.load(wc, results, alive, status);
      }
    }
    return null;
  }

  /** Uses the site's own search box (SPA sites without a search URL), learning the URL it produces. */
  private async searchWithSiteBox(wc: WebContents, source: SourceInfo, query: string, alive: () => boolean, status: (m: string | null) => void): Promise<boolean> {
    if (!this.onSite(source, wc.getURL())) await this.load(wc, source.url, alive, status);
    type Opened = { input: boolean; clicked: boolean; more: boolean };
    const hasInput = async () => (await this.page<Opened>(wc, { op: 'openSearch', attempt: -1 }))?.input ?? false;
    // Single-page apps render their header after load: give the search box a moment to appear.
    let ready = !!(await this.poll(async () => ((await hasInput()) ? true : null), alive, 3500));
    for (let attempt = 0; !ready && attempt < 4 && alive(); attempt++) {
      const r = await this.page<Opened>(wc, { op: 'openSearch', attempt });
      if (!r?.clicked) break;
      await sleep(900);
      ready = await hasInput();
      if (!ready && !r.more) break;
    }
    // Common keyboard shortcuts for search overlays: "/" and Ctrl+K.
    for (const shortcut of [{ keyCode: '/', modifiers: [] }, { keyCode: 'K', modifiers: ['control'] }] as const) {
      if (ready || !alive()) break;
      wc.focus();
      wc.sendInputEvent({ type: 'keyDown', keyCode: shortcut.keyCode, modifiers: [...shortcut.modifiers] });
      if (!shortcut.modifiers.length) wc.sendInputEvent({ type: 'char', keyCode: shortcut.keyCode });
      wc.sendInputEvent({ type: 'keyUp', keyCode: shortcut.keyCode, modifiers: [...shortcut.modifiers] });
      await sleep(900);
      ready = await hasInput();
    }
    if (!ready) return false;
    const filled = await this.page<{ ok: boolean }>(wc, { op: 'fillSearch', query });
    if (!filled?.ok) return false;
    await sleep(700);
    const before = wc.getURL();
    for (const type of ['keyDown', 'char', 'keyUp'] as const) wc.sendInputEvent({ type, keyCode: type === 'char' ? '\r' : 'Enter' });
    await sleep(1200);
    await this.settle(wc, alive, 900, status);
    if (wc.getURL() !== before) this.learnFromUrl(source, wc.getURL(), query);
    return true;
  }

  private learnFromUrl(source: SourceInfo, url: string, query: string) {
    if (!source.partition.startsWith('persist:') || !this.onSite(source, url)) return;
    const variants = [encodeURIComponent(query), encodeURIComponent(query).replace(/%20/g, '+'), query.replace(/ /g, '+'), query];
    for (const v of variants) {
      if (url.includes(v)) {
        this.registry.learnSearch(source.id, url.replace(v, '{query}'));
        return;
      }
    }
  }

  private async openEpisodeOnPage(wc: WebContents, recipe: SiteRecipe | null, n: number, slug: string | null, alive: () => boolean, status: (m: string | null) => void): Promise<boolean> {
    const find = () => this.page<PickResult>(wc, { op: 'findEpisode', episode: n, slug, selector: recipeSelector(recipe, 'episodeLink', n) });
    status(`Finding episode ${n}…`);
    let ep = await this.poll(find, alive, 6000);
    if (!ep && (await this.page<{ clicked: boolean }>(wc, { op: 'episodesTab' }))?.clicked) {
      await this.settle(wc, alive, 1200, status);
      ep = await this.poll(find, alive, 5000);
    }
    if (!ep) {
      // Info pages often link to a separate watch page that lists the episodes.
      const watch = await this.page<PickResult>(wc, { op: 'watchLink', slug, selector: recipeSelector(recipe, 'watchLink') });
      if (watch?.href) {
        await this.load(wc, watch.href, alive, status);
        if (episodeFromUrl(wc.getURL()) === n) return true;
        ep = await this.poll(find, alive, 8000);
      }
    }
    if (!ep) return false;
    status(`Loading episode ${n}…`);
    if (ep.href) {
      if (ep.href !== wc.getURL()) await this.load(wc, ep.href, alive, status);
    } else {
      await this.page(wc, { op: 'click', pick: ep.pick! });
      await this.settle(wc, alive, 1500, status);
    }
    return true;
  }

  // ---------------------------------------------------------------- SUB/DUB & servers

  async options(wc: WebContents): Promise<SiteOptions> {
    return toSiteOptions(await this.page<RawSiteOption[]>(wc, { op: 'siteOptions' }));
  }

  /** Clicks a SUB/DUB toggle or server on the site, remembers it for this site, and re-isolates the player. */
  async choose(wc: WebContents, source: SourceInfo, kind: 'type' | 'server', value: string): Promise<{ options: SiteOptions; focused: boolean }> {
    const raw = (await this.page<RawSiteOption[]>(wc, { op: 'siteOptions' })) ?? [];
    const target = raw.find((o) => o.kind === kind && o.value === value);
    if (target) {
      const job = (this.jobs.get(wc.id) ?? 0) + 1;
      this.jobs.set(wc.id, job);
      const alive = () => !wc.isDestroyed() && this.jobs.get(wc.id) === job;
      const playback = await this.probe(wc).catch(() => null);
      const wasFocused = this.focusWanted.get(wc.id) ?? false;
      await this.page(wc, { op: 'click', pick: target.pick });
      const pref = this.store.getKv<SitePreference>(`site-pref:${source.id}`, {});
      this.store.setKv(`site-pref:${source.id}`, kind === 'type' ? { ...pref, type: value } : { ...pref, server: value });
      await this.settle(wc, alive, 1600);
      const focused = wasFocused && alive() ? await this.focus(wc, true, null) : false;
      // A server/audio switch replaces the site's player. Restore the same episode's
      // position through the original video clock, never by extracting its URL.
      if (playback && !playback.ended && playback.currentTime > 1 && this.control) {
        for (const end = Date.now() + 10000; alive() && Date.now() < end; await sleep(400)) {
          const next = await this.probe(wc).catch(() => null);
          if (!next || (next.video?.readyState ?? 0) < 2) continue;
          if (Math.abs(next.duration - playback.duration) <= Math.max(60, playback.duration * 0.1)) {
            await this.control(wc, 'seek', playback.currentTime);
            await this.control(wc, playback.paused ? 'pause' : 'play');
          }
          break;
        }
      }
      return { options: alive() ? await this.options(wc) : EMPTY_OPTIONS, focused: alive() && focused };
    }
    return { options: toSiteOptions(raw), focused: this.focusWanted.get(wc.id) ?? false };
  }

  /** Re-applies the user's preferred audio type and server for this site. */
  private async applyPreferences(wc: WebContents, source: SourceInfo, alive: () => boolean): Promise<SiteOptions> {
    const pref = this.store.getKv<SitePreference>(`site-pref:${source.id}`, {});
    // Many sites load their server list a moment after the page: wait for it to appear.
    let raw: RawSiteOption[] = [];
    for (const end = Date.now() + 5000; alive() && Date.now() < end; await sleep(400)) {
      raw = (await this.page<RawSiteOption[]>(wc, { op: 'siteOptions' })) ?? [];
      if (raw.length) break;
    }
    for (const kind of ['type', 'server'] as const) {
      const wanted = kind === 'type' ? pref.type : pref.server;
      if (!wanted || !alive()) continue;
      const option = toSiteOptions(raw)[kind === 'type' ? 'types' : 'servers'].find((o) => o.value === wanted);
      const target = raw.find((o) => o.kind === kind && o.value === wanted);
      if (option && target && !option.active) {
        await this.page(wc, { op: 'click', pick: target.pick });
        await this.settle(wc, alive, 1400);
        raw = (await this.page<RawSiteOption[]>(wc, { op: 'siteOptions' })) ?? raw;
      }
    }
    return toSiteOptions(raw);
  }

  /** Some site players wait for a click ("tap to load server"); give one if nothing is playing. */
  private async kickPlayback(wc: WebContents, alive: () => boolean) {
    if (!this.autoplay()) return;
    await sleep(2500);
    if (!alive()) return;
    const p = await this.probe(wc).catch(() => null);
    if (p && !p.paused) return;
    const info = await this.page<{ width: number; height: number }>(wc, { op: 'pageInfo' });
    if (!info || !alive()) return;
    const x = Math.round(info.width / 2);
    const y = Math.round(info.height / 2);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }

  /** Shows only the site's player (or restores the full page). Returns whether a player was found. */
  async focus(wc: WebContents, on: boolean, recipe: SiteRecipe | null, waitMs = 9000): Promise<boolean> {
    if (wc.isDestroyed()) return false;
    // Only the latest request may insert CSS, so toggling off always wins over a pending retry.
    const gen = (this.focusGen.get(wc.id) ?? 0) + 1;
    this.focusGen.set(wc.id, gen);
    const current = () => this.focusGen.get(wc.id) === gen && !wc.isDestroyed();
    this.focusWanted.set(wc.id, on);
    const previous = this.focusCss.get(wc.id);
    if (previous) {
      await wc.removeInsertedCSS(previous).catch(() => undefined);
      this.focusCss.delete(wc.id);
    }
    if (!on) {
      await this.page(wc, { op: 'releasePlayer' });
      await this.focusChildren(wc,false);
      return false;
    }
    let resolved = recipe;
    try {
      resolved ??= recipeFor(this.book(), new URL(wc.getURL()).hostname);
    } catch {
      // about:blank etc.
    }
    const deadline = Date.now() + waitMs;
    while (current() && Date.now() < deadline) {
      const r = await this.page<{ found: boolean }>(wc, { op: 'markPlayer', selector: recipeSelector(resolved, 'player'), keep: true });
      if (!current()) return false;
      if (r?.found) {
        const key = await wc.insertCSS(FOCUS_CSS).catch(() => null);
        if (key && current()) this.focusCss.set(wc.id, key);
        else if (key) await wc.removeInsertedCSS(key).catch(() => undefined);
        if(current())await this.focusChildren(wc,true);
        return current();
      }
      await sleep(600);
    }
    return false;
  }
}
