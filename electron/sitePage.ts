/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { SiteRecipe } from '../app/core/sources/recipes';
import {seriesMarkers} from '../app/core/sources/text';

/**
 * Operations the site navigator runs inside a source page (in an isolated JS
 * world, so the page cannot tamper with them). They only read the page's own
 * links/controls and click or follow them, exactly like a user would.
 */
export type PageOp =
  | { op: 'findTitle'; titles: string[]; season: number; selector?: string }
  | { op: 'episodeCards'; slug:string|null }
  | { op: 'findEpisode'; episode: number; slug: string | null; selector?: string }
  | { op: 'watchLink'; slug: string | null; selector?: string }
  | { op: 'openSearch'; attempt: number }
  | { op: 'fillSearch'; query: string }
  | { op: 'viewAll' }
  | { op: 'episodesTab' }
  | { op: 'click'; pick: string }
  | { op: 'markPlayer'; selector?: string; keep?: boolean }
  | { op: 'releasePlayer' }
  | { op: 'titleCheck'; titles: string[]; season: number }
  | { op: 'siteOptions' }
  | { op: 'pageInfo' }
  | { op: 'availability' };

export interface RawSiteOption {
  pick: string;
  kind: 'type' | 'server';
  label: string;
  value: string;
  active: boolean;
  group: string | null;
}

export interface PickResult {
  href: string | null;
  pick: string | null;
  score: number;
}

export function pageScript(args: PageOp): string {
  return `(${PAGE_FN.toString()})(${JSON.stringify(args)},${seriesMarkers.toString()})`;
}

export function recipeSelector(recipe: SiteRecipe | null, key: 'titleLink' | 'watchLink' | 'episodeLink' | 'player', episode?: number): string | undefined {
  const sel = recipe?.[key];
  if (!sel) return undefined;
  return episode === undefined ? sel : sel.replace(/\{n\}/g, String(episode));
}

/* eslint-disable */
// Serialised into the page with Function.prototype.toString — keep it self-contained.
function PAGE_FN(A: PageOp, markers:typeof seriesMarkers): unknown {
  const norm = (s: unknown) =>
    String(s || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[’'`]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const toks = (s: unknown) => new Set(norm(s).split(' ').filter((t) => t.length >= 2 || /\d/.test(t)));
  const dice = (a: unknown, b: unknown) => {
    const x = toks(a);
    const y = toks(b);
    if (!x.size || !y.size) return 0;
    let c = 0;
    x.forEach((t) => {
      if (y.has(t)) c++;
    });
    return (2 * c) / (x.size + y.size);
  };
  const abs = (h: string | null) => {
    if (!h) return null;
    try {
      const u = new URL(h, location.href);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
    } catch {
      return null;
    }
  };
  const host = (h: string) => h.replace(/^www\./, '');
  const onSite = (u: URL) => host(u.hostname) === host(location.hostname);
  const vis = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const area = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };
  const text = (el: Element | null | undefined) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const epFromUrl = (u: URL) => {
    for (const k of ['ep', 'episode', 'e']) {
      const v = u.searchParams.get(k);
      if (v && /^\d{1,4}$/.test(v)) return Number(v);
    }
    const m = u.pathname.match(/(?:episode|ep)[-_/]?(\d{1,4})(?:\/|$|-|\.)/i);
    if (m) return Number(m[1]);
    const w = u.pathname.match(/\/watch\/[^/]+\/(\d{1,4})\/?$/i);
    return w ? Number(w[1]) : null;
  };
  let picks = 0;
  const mark = (el: Element) => {
    const id = 'av' + Date.now().toString(36) + picks++;
    el.setAttribute('data-aniverse-pick', id);
    return id;
  };
  const SECTION = /^(episodes?|details?|info(rmation)?|overview|synopsis|description|summary|comments?|reviews?|recommend(ed|ations?)|related|characters?|staff|trailers?|more like this|you (may|might) also like|seasons?|servers?|share|genres?)\b/i;
  const NOT_TITLE = /\/(genres?|filter|search|browse|community|users?|profile|tags?|studios?|producers?|types?|status|seasons?|years?|login|register|signup|news|blog|discuss|forum|az-list|schedule|contact|faq|dmca|terms|privacy|random|requests?)(\/|$)/i;

  if (A.op === 'availability') {
    const headings=[document.title,...document.querySelectorAll('h1,h2,[role="alert"]')].map(value=>typeof value==='string'?value:text(value));
    const missing=headings.some(value=>/\b(?:page not found|content not found|episode not found|video unavailable|content unavailable|content removed|404.{0,30}not found|410.{0,30}gone)\b/i.test(value));
    return {missing:missing&&!document.querySelector('video,iframe[src]')};
  }
  if (A.op === 'pageInfo') {
    return { url: location.href, title: document.title, ready: document.readyState, width: innerWidth, height: innerHeight };
  }

  if (A.op === 'siteOptions') {
    // Audio type toggles (SUB/DUB/…) and server buttons the site shows next to its player.
    document.querySelectorAll('[data-aniverse-opt]').forEach((e) => e.removeAttribute('data-aniverse-opt'));
    const TYPE = /^(h-?sub|hard\s?sub|soft\s?sub|s-?sub|sub(bed|titled|s)?|dub(bed|s)?|eng(lish)?\s?dub|raw)$/i;
    const typeValue = (t: string) => (/dub/i.test(t) ? 'dub' : /raw/i.test(t) ? 'raw' : 'sub');
    const isActive = (el: Element) =>
      /(^|[\s_-])(active|selected|current|is-active|on|checked)($|[\s_-])/i.test(String((el as HTMLElement).className)) ||
      ['aria-pressed', 'aria-selected', 'aria-checked', 'aria-current'].some((a) => /^(true|page)$/.test(el.getAttribute(a) || '')) ||
      /^(active|on|checked)$/i.test(el.getAttribute('data-state') || '');
    const CLICKABLE = 'button, a, [role="button"], [role="tab"], [role="radio"], li, label, [data-id], [data-server], [data-type], [data-link-id]';
    const leaf = (els: Element[]) => els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
    const player = document.querySelector('[data-aniverse-player]') || [...document.querySelectorAll('iframe, video')].sort((a, b) => area(b) - area(a))[0];
    const near = (el: Element) => {
      if (!player) return true;
      const p = player.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return Math.abs(r.top - p.bottom) < 900 && r.left < p.right + 600;
    };
    // Download rows ("DL", "Kiwi Sub 720p") sit next to the servers but don't switch playback.
    const DOWNLOAD = '[class*="download" i], [class*="mapper-dl" i], [class*="dl-row" i], [class*="dl-links" i], a[download]';
    const clickables = [...document.querySelectorAll(CLICKABLE)].filter(
      (el) => vis(el) && near(el) && !el.closest('header, footer, nav, [class*="comment" i]') && !el.closest(DOWNLOAD) && !/^(dl|download)$/i.test(text(el)),
    );
    // A real SUB/DUB switch is something you can click. "SUB:" / "DUB:" captions above
    // each server group are plain text; those groups become the audio choice below.
    const interactive = (el: Element) =>
      el.matches('button, a[href], input, [role="button"], [role="tab"], [role="radio"], [role="switch"], [onclick]') || getComputedStyle(el).cursor === 'pointer';
    let out: RawSiteOption[] = [];
    const seen = new Set<string>();
    leaf(clickables.filter((el) => TYPE.test(text(el)) && interactive(el))).forEach((el) => {
      const label = text(el);
      const key = 'type:' + label.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ pick: '', kind: 'type', label, value: typeValue(label), active: isActive(el) || isActive(el.parentElement!), group: null });
      el.setAttribute('data-aniverse-opt', String(out.length - 1));
    });
    const containers = [...document.querySelectorAll('[class*="server" i], [id*="server" i], [class*="source" i], [id*="source" i], [class*="mirror" i], [class*="provider" i], [data-server]')].filter(vis);
    const serverEls = leaf(
      clickables.filter((el) => {
        const t = text(el);
        return t.length > 0 && t.length <= 24 && !TYPE.test(t) && !/^(servers?|sources?|sub|dub)$/i.test(t) && containers.some((c) => c === el || c.contains(el));
      }),
    );
    serverEls.forEach((el) => {
      // A server row is often labelled "SUB:" / "DUB:" (or marked data-type="dub") — find the nearest such label.
      let group: string | null = null;
      const typed = el.closest('[data-type]')?.getAttribute('data-type') || '';
      if (/^(sub|dub|raw|softsub|hardsub|s-sub|h-sub)$/i.test(typed)) group = typeValue(typed);
      for (let p = el.parentElement, i = 0; p && i < 4 && !group; p = p.parentElement, i++) {
        const lbl = [...p.children].map((c) => text(c)).find((t) => /^(h-?sub|s-?sub|soft\s?sub|sub|dub|raw)\s*:?$/i.test(t));
        if (lbl) group = typeValue(lbl);
      }
      const label = text(el);
      const key = 'server:' + (group || '') + label.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ pick: '', kind: 'server', label, value: label.toLowerCase(), active: isActive(el), group });
      el.setAttribute('data-aniverse-opt', String(out.length - 1));
    });
    out.forEach((o, i) => {
      const el = document.querySelector('[data-aniverse-opt="' + i + '"]');
      if (el) o.pick = mark(el);
    });
    out = out.filter((o) => o.pick);

    // Servers grouped by audio but no switch: offer SUB/DUB from the groups. Choosing one
    // clicks the same-named server in that group (HD-1 → DUB HD-1), else its first server.
    const servers = out.filter((o) => o.kind === 'server');
    const groups = [...new Set(servers.map((o) => o.group).filter((g): g is string => !!g))];
    if (!out.some((o) => o.kind === 'type') && groups.length >= 2) {
      const current = servers.find((o) => o.active);
      // Sites that don't mark the active server usually carry it in the address (?lang=dub, /dub/).
      const fromUrl = location.search.match(/[?&](?:lang|type|audio|version|track)=(sub|dub|raw)\b/i)?.[1] ?? location.pathname.match(/\/(sub|dub)(?:\/|$)/i)?.[1];
      const activeGroup = current?.group ?? (fromUrl && groups.includes(fromUrl.toLowerCase()) ? fromUrl.toLowerCase() : groups[0]);
      for (const g of groups) {
        const inGroup = servers.filter((o) => o.group === g);
        const target = inGroup.find((o) => current && o.value === current.value) ?? inGroup[0];
        out.push({ pick: target.pick, kind: 'type', label: g.toUpperCase(), value: g, active: g === activeGroup, group: null });
      }
      // only the servers of the audio that's playing
      out = out.filter((o) => o.kind !== 'server' || o.group === activeGroup);
    }
    return out;
  }

  const titleScore = (t: unknown, titles: string[], season: number) => {
    const identity=markers(String(t||''));
    const n = norm(identity.title);
    if (!n || n.length > 300) return 0;
    const part=Math.max(1,...titles.map(title=>markers(title).part??1));
    if(identity.season!==null&&identity.season!==season)return 0;
    if(identity.part!==null&&identity.part!==part)return 0;
    let best = 0;
    for (const title of titles) {
      const alias=markers(title);
      // A named arc can omit its season, but a numbered alias alone must not
      // authorize the unqualified parent or a different part of that series.
      if(identity.season===null&&season>1&&alias.season!==null)continue;
      if(identity.part===null&&part>1&&alias.part!==null)continue;
      if(alias.season!==null&&alias.season!==season)continue;
      if(alias.part!==null&&alias.part!==part)continue;
      const nt = norm(alias.title);
      if (!nt) continue;
      if (n === nt) return 1.1;
      if (nt.length >= 4 && (' ' + n + ' ').includes(' ' + nt + ' ')) best = Math.max(best, 1 - Math.min(0.3, (n.length - nt.length) / (n.length * 3)));
      else best = Math.max(best, dice(identity.title, alias.title));
    }
    return best;
  };

  if (A.op === 'titleCheck') {
    // Does the page we landed on look like the requested title (and season)?
    const heads = [document.querySelector('h1'), document.querySelector('h2')].map(text).filter(Boolean);
    const named = [...document.querySelectorAll('h1, h2, h3')].map(text).find((t) => t && t.length <= 160 && !SECTION.test(t));
    const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
    const texts = [...heads, named, og, document.title.split(/[|–—-]\s/)[0]].filter(Boolean);
    let s = 0;
    for (const t of texts) s = Math.max(s, titleScore(t, A.titles, A.season || 1));
    return { score: s, checked: texts.length };
  }

  if (A.op === 'findTitle') {
    const season = A.season || 1;
    const score = (t: unknown) => titleScore(t, A.titles, season);
    const found = new Map<string, { s: number; el: Element; href: string | null }>();
    const consider = (el: Element, u: URL | null, texts: unknown[]) => {
      let s = 0;
      for (const t of texts) if (t) s = Math.max(s, score(t));
      if (s < 0.72) return;
      if (u && /\/(watch|anime|series|title|info|details?|show|tv|movie|a|v)\//i.test(u.pathname)) s += 0.03;
      if (vis(el)) s += 0.01;
      const key = u ? u.href : 'el' + found.size;
      const prev = found.get(key);
      if (!prev || s > prev.s) found.set(key, { s, el, href: u ? u.href : null });
    };
    const anchors = A.selector ? document.querySelectorAll(A.selector) : document.querySelectorAll('a[href]');
    anchors.forEach((a) => {
      const u = abs(a.getAttribute('href'));
      if (!u || !onSite(u) || NOT_TITLE.test(u.pathname) || u.pathname === '/' || u.pathname === location.pathname) return;
      const img = a.querySelector('img');
      const heading = a.querySelector('h1,h2,h3,h4,h5,h6,[class*="title" i],[class*="name" i]');
      const ds = (a as HTMLElement).dataset || {};
      consider(a, u, [img?.getAttribute('alt'), a.getAttribute('title'), a.getAttribute('aria-label'), ds.en, ds.jp, ds.title, text(heading), text(a).length < 160 ? text(a) : null]);
    });
    if (!A.selector) {
      // Instant-search dropdowns often render results as clickable items without links.
      document.querySelectorAll('[role="option"], [data-href], li[data-id]').forEach((el) => {
        if (el.closest('a[href]') || !vis(el)) return;
        const dh = el.getAttribute('data-href');
        consider(el, dh ? abs(dh) : null, [el.querySelector('img')?.getAttribute('alt'), el.getAttribute('aria-label'), text(el.querySelector('[class*="title" i],[class*="name" i]')), text(el).length < 160 ? text(el) : null]);
      });
    }
    // Best candidates first; the navigator verifies the page and falls back to the next one.
    const ranked = [...found.values()].sort((a, b) => b.s - a.s).slice(0, 3);
    if (!ranked.length) return null;
    return ranked.map((c) => ({ href: c.href, pick: c.href ? null : mark(c.el), score: c.s }));
  }

  if(A.op==='episodeCards'){
    const found=new Map<number,{episode:number;thumbnail:string|null;audio:('sub'|'dub')[]}>();
    const nodes=document.querySelectorAll('a[href],button,[role="button"],[data-episode],[data-episode-number],[data-number],[data-num],[data-ep]');
    for(const el of nodes){
      if(found.size>=500)break;
      const u=abs(el.getAttribute('href')||el.getAttribute('data-href'));
      const episodeList=el.closest('[class*="episode" i],[id*="episode" i],[class*="ep-list" i]');
      if(u&&(!onSite(u)||(A.slug&&!u.pathname.toLowerCase().includes(A.slug.toLowerCase())&&!episodeList)))continue;
      const ds=(el as HTMLElement).dataset||{};
      const marker=[ds.episode,ds.episodeNumber,ds.number,ds.num,ds.ep].find(value=>value&&/^\d{1,4}$/.test(value));
      const explicit=text(el).match(/^(?:ep(?:isode)?\.?\s*#?\s*)0*(\d{1,4})(?!\d)/i);
      const episode=marker?Number(marker):((u?epFromUrl(u):null)??(explicit?Number(explicit[1]):null));
      if(!episode||episode>5000)continue;
      let card=el;
      for(let parent=el.parentElement,i=0;!card.querySelector('img')&&parent&&i<2;i++,parent=parent.parentElement){
        if(parent.querySelectorAll('img').length!==1)break;
        card=parent;
      }
      const image=card.querySelector('img');
      const src=image?.getAttribute('data-src')||image?.getAttribute('data-original')||(image as HTMLImageElement|null)?.currentSrc||image?.getAttribute('src');
      const thumbnail=src?abs(src)?.href??null:null;
      const labels=[text(card),...Array.from(card.querySelectorAll('span,b,strong,small,em,[title],[aria-label],[data-type]')).slice(0,40).map(node=>[text(node),node.getAttribute('title'),node.getAttribute('aria-label'),node.getAttribute('data-type')].filter(Boolean).join(' '))].join(' ').slice(0,2000);
      const audio:('sub'|'dub')[]=[];
      if(/\b(?:sub|subbed|subtitled)\b/i.test(labels))audio.push('sub');
      if(/\b(?:dub|dubbed)\b/i.test(labels))audio.push('dub');
      const previous=found.get(episode);
      found.set(episode,{episode,thumbnail:previous?.thumbnail??thumbnail,audio:[...new Set([...(previous?.audio??[]),...audio])]});
    }
    return [...found.values()].sort((a,b)=>a.episode-b.episode);
  }

  if (A.op === 'findEpisode') {
    const N = A.episode;
    // "EP 3 Killing Magic …" (explicit prefix, long card text) or a bare "3" (short button text).
    const explicit = new RegExp('^(?:ep(?:isode)?\\.?\\s*#?\\s*)0*' + N + '(?!\\d)', 'i');
    const bare = new RegExp('^0*' + N + '(?!\\d)');
    const badge = new RegExp('^(?:ep(?:isode)?\\.?\\s*#?\\s*)0*' + N + '$', 'i');
    // Sites with obfuscated class names: the card sits in a run of sibling "EP n" items.
    const anyEp = /^(?:ep(?:isode)?\.?\s*#?\s*)\d+(?!\d)/i;
    const inEpisodeList = (el: Element) => {
      for (let p = el.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) {
        if (p.childElementCount < 3) continue;
        const eps = [...p.children].filter((c) => anyEp.test(text(c)) || [...c.querySelectorAll('span, small, strong, b')].some((d) => d.childElementCount === 0 && anyEp.test(text(d)))).length;
        if (eps >= 3) return true;
      }
      return false;
    };
    let best: { s: number; el: Element; u: URL | null } | null = null;
    const nodes = A.selector
      ? [...document.querySelectorAll(A.selector)]
      : [...document.querySelectorAll('a[href], button, li, [role="button"], [role="link"], [role="option"], [data-href], [data-episode], [data-num], [data-number], [data-ep]')];
    if (!A.selector) {
      // Episode cards whose only marker is a badge ("Episode 3") inside a clickable card.
      document.querySelectorAll('span, small, strong, b, em, p, div').forEach((el) => {
        if (el.childElementCount > 1 || !badge.test(text(el))) return;
        const card = el.closest('a[href], button, [role="button"], [role="link"], [onclick], li');
        if (card && !nodes.includes(card)) nodes.push(card);
      });
    }
    nodes.forEach((el) => {
      let s = A.selector ? 3 : 0;
      const ds = (el as HTMLElement).dataset || {};
      for (const k of ['episode', 'num', 'number', 'ep', 'episodeNumber', 'epNum', 'episodeNum', 'slug']) {
        if (ds[k] !== undefined && String(ds[k]).trim() === String(N)) {
          s += 3;
          break;
        }
      }
      const link = el.tagName === 'A' ? el : el.querySelector('a[href]');
      const u = link ? abs(link.getAttribute('href')) : el.hasAttribute('data-href') ? abs(el.getAttribute('data-href')) : null;
      if (u && epFromUrl(u) === N) s += 3;
      const t = text(el);
      if (t && ((t.length <= 160 && explicit.test(t)) || (t.length <= 40 && bare.test(t)))) s += 2;
      else if ([...el.querySelectorAll('span, small, strong, b, em, p, div')].some((c) => c.childElementCount <= 1 && badge.test(text(c)))) s += 2;
      if (s < 2) return;
      if (el.closest('[class*="episode" i], [id*="episode" i], [class*="ep-list" i], [class*="ep-item" i], [class*="eps" i]') || inEpisodeList(el)) s += 1.5;
      if (u && A.slug && u.pathname.includes(A.slug)) s += 2;
      if (u && !onSite(u)) s -= 3;
      if (el.closest('header, footer, nav, [class*="comment" i], [class*="pagination" i]')) s -= 2;
      if (el.tagName === 'A') s += 0.5;
      if (!best || s > best.s) best = { s, el, u };
    });
    const b = best as { s: number; el: Element; u: URL | null } | null;
    if (!b || b.s < 3) return null;
    return { href: b.u && onSite(b.u) && b.el.tagName === 'A' ? b.u.href : null, pick: b.u && b.el.tagName === 'A' ? null : mark(b.el), score: b.s };
  }

  if (A.op === 'watchLink') {
    const nodes = A.selector ? [...document.querySelectorAll(A.selector)] : [...document.querySelectorAll('a[href]')];
    for (const a of nodes) {
      const u = abs(a.getAttribute('href'));
      if (!u || !onSite(u) || !vis(a)) continue;
      const t = text(a);
      if (A.selector || (/^(watch( now)?|play( now)?|start watching|watch episode 1|watch ep 1)$/i.test(t) && (!A.slug || u.pathname.includes(A.slug) || /\/watch/i.test(u.pathname)))) {
        return { href: u.href, pick: null, score: 1 };
      }
    }
    return null;
  }

  const isSearchInput = (i: HTMLInputElement) =>
    vis(i) && !i.disabled && !i.readOnly && /^(search|text|)$/i.test(i.type) && (i.type === 'search' || /search|keyword|query|find|tìm|検索/i.test([i.name, i.placeholder, i.getAttribute('aria-label'), i.id, String(i.className)].join(' ')));

  if (A.op === 'openSearch') {
    if ([...document.querySelectorAll('input')].some((i) => isSearchInput(i as HTMLInputElement))) return { input: true, clicked: false, more: false };
    if (A.attempt < 0) return { input: false, clicked: false, more: false };
    // Rank likely search openers: real buttons labelled "search" first, decorative icons last.
    const rank = (el: Element) => {
      const label = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('placeholder')].join(' ');
      let r = 0;
      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') r += 3;
      if (/search/i.test(label)) r += 3;
      if (/search/i.test(text(el).slice(0, 40))) r += 2;
      if (el.closest('header, nav, [class*="header" i]')) r += 1;
      if (area(el) < 120) r -= 2;
      return r;
    };
    const openers = [...document.querySelectorAll('button, [role="button"], a[href^="#"], a:not([href]), [class*="search" i]')]
      .filter((el) => vis(el) && !el.closest('form') && /search/i.test([el.getAttribute('aria-label'), el.getAttribute('title'), text(el).slice(0, 40), String((el as HTMLElement).className)].join(' ')))
      .map((el) => ({ el, r: rank(el) }))
      .sort((a, b) => b.r - a.r);
    const pick = openers[A.attempt];
    if (!pick) return { input: false, clicked: false, more: false };
    (pick.el as HTMLElement).click();
    return { input: false, clicked: true, more: A.attempt + 1 < openers.length };
  }

  if (A.op === 'fillSearch') {
    const input = [...document.querySelectorAll('input')].find((i) => isSearchInput(i as HTMLInputElement)) as HTMLInputElement | undefined;
    if (!input) return { ok: false };
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, A.query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, form: !!input.form };
  }

  if (A.op === 'episodesTab') {
    // Title pages that keep the episode list behind an "Episodes" tab.
    const label = /^(all\s+)?episodes?(\s*[([]?\d+[)\]]?)?$/i;
    const tabs = [...document.querySelectorAll('[role="tab"]'), ...document.querySelectorAll('button, a, [role="button"]')];
    const el = tabs.find((e) => vis(e) && label.test(text(e)) && e.getAttribute('aria-selected') !== 'true' && !e.closest('header, footer, nav'));
    if (!el) return { clicked: false };
    (el as HTMLElement).click();
    return { clicked: true };
  }

  if (A.op === 'viewAll') {
    const el = [...document.querySelectorAll('a, button, [role="button"], li')].find((e) => vis(e) && /^(view|see|show)\s+(all|more)(\s+results)?\b/i.test(text(e)));
    if (!el) return { clicked: false };
    (el as HTMLElement).click();
    return { clicked: true };
  }

  if (A.op === 'click') {
    const el = document.querySelector('[data-aniverse-pick="' + A.pick + '"]') as HTMLElement | null;
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }

  // Marks the page's player (and its ancestors) for FOCUS_CSS. Returns the element's tag, or null.
  const markPlayer = (selector?: string): string | null => {
    document.querySelectorAll('[data-aniverse-player],[data-aniverse-chain],[data-aniverse-media],[data-aniverse-media-chain]').forEach((e) => {
      e.removeAttribute('data-aniverse-player');
      e.removeAttribute('data-aniverse-chain');
      e.removeAttribute('data-aniverse-media');
      e.removeAttribute('data-aniverse-media-chain');
    });
    const ratioOk = (el: Element, min = 1.1, max = 2.6) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.width / r.height >= min && r.width / r.height <= max;
    };
    let target: Element | undefined;
    if (selector) target = [...document.querySelectorAll(selector)].filter(vis).sort((a, b) => area(b) - area(a))[0];
    if (!target) {
      const media = [...document.querySelectorAll('iframe, video')].filter((el) => {
        const r = el.getBoundingClientRect();
        // Challenge/ad frames can be larger than the episode, even while hidden.
        const challenge = el.tagName === 'IFRAME' && /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com/i.test(el.getAttribute('src') || '');
        return !challenge && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && r.width >= 240 && r.height >= 135 && ratioOk(el);
      });
      target = media.sort((a, b) => area(b) - area(a))[0];
      if (target && target.tagName === 'VIDEO') {
        // Include the custom player's controls: climb while the wrapper is about the video's size.
        const base = area(target);
        for (let p = target.parentElement; p && p !== document.body && area(p) <= base * 1.4; p = p.parentElement) target = p;
      }
    }
    if (!target) {
      target = [...document.querySelectorAll('[id*="player" i], [class*="player" i]')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && r.width >= 320 && r.height >= 180 && ratioOk(el, 1.2, 2.4);
        })
        .sort((a, b) => area(b) - area(a))[0];
    }
    if (!target) return null;
    target.setAttribute('data-aniverse-player', '');
    const picture = target.matches('video,iframe') ? target : [...target.querySelectorAll('video,iframe')]
      .filter(el => el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && area(el)>0 &&
        !/recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com/i.test(el.getAttribute('src') || ''))
      .sort((a,b)=>area(b)-area(a))[0];
    if (picture) {
      picture.setAttribute('data-aniverse-media','');
      for(let p=picture.parentElement;p&&p!==target;p=p.parentElement)p.setAttribute('data-aniverse-media-chain','');
    }
    for (let p = target.parentElement; p && p !== document.documentElement; p = p.parentElement) p.setAttribute('data-aniverse-chain', '');
    return target.tagName;
  };

  // Lives in this page's isolated world for as long as the page does.
  const keeper = window as unknown as { __aniverseKeeper?: MutationObserver; __aniverseKeeperSelector?: string };

  if (A.op === 'markPlayer') {
    const tag = markPlayer(A.selector);
    if (A.keep) {
      // Sites swap their player element in place (server switch, next episode, ad slot):
      // re-mark it whenever the marked one is gone, so player-only mode never drops.
      keeper.__aniverseKeeperSelector = A.selector;
      if (!keeper.__aniverseKeeper) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const check = () => {
          if(!keeper.__aniverseKeeper)return;
          const current = document.querySelector('[data-aniverse-player]');
          if (!current || !current.isConnected || area(current) < 240 * 135 || !document.querySelector('[data-aniverse-media]')) markPlayer(keeper.__aniverseKeeperSelector);
        };
        keeper.__aniverseKeeper = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(check, 150);
        });
        keeper.__aniverseKeeper.observe(document.documentElement, { childList: true, subtree: true });
      }
    }
    return tag ? { found: true, tag } : { found: false };
  }

  if (A.op === 'releasePlayer') {
    keeper.__aniverseKeeper?.disconnect();
    keeper.__aniverseKeeper = undefined;
    document.querySelectorAll('[data-aniverse-player],[data-aniverse-chain],[data-aniverse-media],[data-aniverse-media-chain]').forEach((e) => {
      e.removeAttribute('data-aniverse-player');
      e.removeAttribute('data-aniverse-chain');
      e.removeAttribute('data-aniverse-media');
      e.removeAttribute('data-aniverse-media-chain');
    });
    return true;
  }

  return null;
}
/* eslint-enable */

export const FOCUS_CSS = `
html:has([data-aniverse-player]), body:has([data-aniverse-player]) { overflow: hidden !important; }
/* Keep layout/DOM intact so the site's audio/server controls remain discoverable. */
[data-aniverse-chain] > :not([data-aniverse-chain]):not([data-aniverse-player]),
[data-aniverse-chain] > :not([data-aniverse-chain]):not([data-aniverse-player]) * {
  visibility: hidden !important; pointer-events: none !important;
}
[data-aniverse-chain] { transform: none !important; filter: none !important; contain: none !important; perspective: none !important;
  backdrop-filter: none !important; will-change: auto !important; clip-path: none !important; overflow: visible !important; z-index: 2147483646 !important; }
[data-aniverse-player] { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; max-width: none !important;
  max-height: none !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; border: 0 !important; border-radius: 0 !important;
  z-index: 2147483647 !important; background: #000 !important; transform: none !important; aspect-ratio: auto !important; }
[data-aniverse-player], [data-aniverse-media-chain] { box-sizing: border-box !important; content-visibility: visible !important; }
[data-aniverse-media-chain] {
  position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important;
  min-width: 0 !important; min-height: 0 !important; max-width: none !important; max-height: none !important;
  margin: 0 !important; padding: 0 !important; border: 0 !important; transform: none !important;
  filter: none !important; perspective: none !important; contain: none !important; overflow: visible !important; aspect-ratio: auto !important;
}
[data-aniverse-media]:not([data-aniverse-player]) {
  position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important;
  min-width: 0 !important; min-height: 0 !important; max-width: none !important; max-height: none !important;
  margin: 0 !important; padding: 0 !important; border: 0 !important; transform: none !important; aspect-ratio: auto !important;
}
video[data-aniverse-media] { object-fit: contain !important; object-position: center !important; }
`;

/** AniVerse scrollbars inside source pages, so every scroll surface matches the app. */
export const SCROLLBAR_CSS = `
html, body, * { scrollbar-width: auto !important; scrollbar-color: auto !important; }
::-webkit-scrollbar { width: 9px !important; height: 9px !important; background: transparent !important; }
::-webkit-scrollbar-track { background: transparent !important; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,.16) !important; border-radius: 9px !important; border: 2px solid transparent !important; background-clip: content-box !important; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.32) !important; background-clip: content-box !important; }
::-webkit-scrollbar-corner, ::-webkit-scrollbar-button { display: none !important; background: transparent !important; }
`;
