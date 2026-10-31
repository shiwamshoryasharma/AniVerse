import type {
  AiringItem,
  BrowseQuery,
  HomeData,
  HoverInfo,
  MediaCard,
  MediaDetails,
  MediaSeason,
  Page,
} from '../../shared/types';
import { broaderSearch, discoveryScore } from './search';
import { pendingRelease } from '../../shared/release';
import type { Store } from '../db/store';
import { type FetchFn, RateGate, requestJson } from '../net/http';
import { AppError, nowSec, stripHtml } from '../util';

export const ANILIST_GRAPHQL = 'https://graphql.anilist.co';

const CARD = `
fragment card on Media {
  id idMal type
  title { romaji english native userPreferred } synonyms
  coverImage { extraLarge large color }
  bannerImage format status episodes duration averageScore season seasonYear genres isAdult
  nextAiringEpisode { episode airingAt }
  startDate { year month day }
}`;

// AniList treats some null arguments badly (`id_not_in: null` and `format_in: null`
// return HTTP 500, `countryOfOrigin: null` matches nothing), so queries only
// mention the filters that are actually set and inline the adult filter.
const adultArg = (showAdult: boolean) => (showAdult ? '' : ', isAdult: false');

const homeQuery = (showAdult: boolean) => `${CARD}
query ($season: MediaSeason, $year: Int, $since: Int, $now: Int) {
  spotlight: Page(perPage: 12) { media(sort: TRENDING_DESC, type: ANIME${adultArg(showAdult)}) { ...card description(asHtml: false) } }
  trending: Page(perPage: 20) { media(sort: TRENDING_DESC, type: ANIME${adultArg(showAdult)}) { ...card } }
  popularSeason: Page(perPage: 20) { media(season: $season, seasonYear: $year, sort: POPULARITY_DESC, type: ANIME${adultArg(showAdult)}) { ...card } }
  upcoming: Page(perPage: 20) { media(status: NOT_YET_RELEASED, sort: POPULARITY_DESC, type: ANIME${adultArg(showAdult)}) { ...card } }
  topRated: Page(perPage: 20) { media(sort: SCORE_DESC, type: ANIME${adultArg(showAdult)}) { ...card } }
  recent: Page(perPage: 36) { airingSchedules(airingAt_greater: $since, airingAt_lesser: $now, sort: TIME_DESC) { id episode airingAt media { ...card } } }
}`;

const BROWSE_TYPES: Record<string, string> = {
  search: 'String',
  genre_in: '[String]',
  genre_not_in: '[String]',
  tag_in: '[String]',
  season: 'MediaSeason',
  seasonYear: 'Int',
  format_in: '[MediaFormat]',
  status: 'MediaStatus',
  countryOfOrigin: 'CountryCode',
  source: 'MediaSource',
  averageScore_greater: 'Int',
  episodes_greater: 'Int',
  episodes_lesser: 'Int',
  sort: '[MediaSort]',
  id_not_in: '[Int]',
  id_in:'[Int]',
  isAdult: 'Boolean',
};

/** Builds a browse query that declares and uses only the given filter keys. */
export function browseQuery(filterKeys: string[]): string {
  const keys = filterKeys.filter((k) => k in BROWSE_TYPES);
  return `${CARD}
query ($page: Int, $perPage: Int${keys.map((k) => `, $${k}: ${BROWSE_TYPES[k]}`).join('')}) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage hasNextPage }
    media(type: ANIME${keys.map((k) => `, ${k}: $${k}`).join('')}) { ...card }
  }
}`;
}

const DETAILS_QUERY = `${CARD}
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    ...card
    description(asHtml: false) synonyms source countryOfOrigin popularity favourites siteUrl
    studios(isMain: true) { nodes { name } }
    startDate { year month day } endDate { year month day }
    trailer { id site }
    tags { name rank isMediaSpoiler }
    relations { edges { relationType(version: 2) node { ...card } } }
    recommendations(perPage: 14, sort: RATING_DESC) { nodes { mediaRecommendation { ...card } } }
    characters(perPage: 12, sort: [ROLE, RELEVANCE, ID]) {
      edges { role node { name { userPreferred } image { medium } } voiceActors(language: JAPANESE, sort: RELEVANCE) { name { userPreferred } image { medium } } }
    }
    streamingEpisodes { title thumbnail url site }
    externalLinks { site url type color }
  }
}`;

const searchQuery = (showAdult: boolean) => `${CARD}
query ($search: String) {
  Page(perPage: 24) { media(search: $search, type: ANIME, sort: SEARCH_MATCH${adultArg(showAdult)}) { ...card } }
}`;

const SCHEDULE_QUERY = `${CARD}
query ($page: Int, $from: Int, $to: Int) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage }
    airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) { id episode airingAt media { ...card } }
  }
}`;

const GENRES_QUERY = `query { GenreCollection MediaTagCollection { name isAdult category } }`;

const HOVER_QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    description(asHtml: false)
    studios(isMain: true) { nodes { name } }
    staff(perPage: 8, sort: [RELEVANCE, ROLE]) { edges { role node { name { full } } } }
    tags { name rank isMediaSpoiler }
  }
}`;

/** Staff roles that credit the work's original author. */
const CREATOR_ROLE = /original (creator|story|work|character design)|^story( & art)?$|^author$|original manga|original novel/i;

// ------------------------------------------------------------------ raw shapes

interface RawMedia {
  id: number;
  idMal: number | null;
  type?: string;
  synonyms?: string[] | null;
  title: { romaji: string | null; english: string | null; native: string | null; userPreferred: string };
  coverImage: { extraLarge: string | null; large: string | null; color: string | null };
  bannerImage: string | null;
  format: MediaCard['format'];
  status: MediaCard['status'];
  episodes: number | null;
  duration: number | null;
  averageScore: number | null;
  season: MediaSeason | null;
  seasonYear: number | null;
  genres: string[] | null;
  isAdult: boolean;
  nextAiringEpisode: { episode: number; airingAt: number } | null;
  startDate?: MediaCard['startDate'];
  description?: string | null;
}

interface RawDetails extends RawMedia {
  synonyms: string[] | null;
  source: string | null;
  countryOfOrigin: string | null;
  popularity: number | null;
  favourites: number | null;
  siteUrl: string;
  studios: { nodes: { name: string }[] } | null;
  endDate: MediaDetails['endDate'];
  trailer: { id: string; site: string } | null;
  tags: { name: string; rank: number; isMediaSpoiler: boolean }[] | null;
  relations: { edges: { relationType: string; node: RawMedia }[] } | null;
  recommendations: { nodes: { mediaRecommendation: RawMedia | null }[] } | null;
  characters: {
    edges: {
      role: string;
      node: { name: { userPreferred: string }; image: { medium: string | null } | null };
      voiceActors: { name: { userPreferred: string }; image: { medium: string | null } | null }[];
    }[];
  } | null;
  streamingEpisodes: { title: string; thumbnail: string | null; url: string; site: string }[] | null;
  externalLinks: { site: string; url: string; type: string | null; color: string | null }[] | null;
}

interface RawAiring {
  id: number;
  episode: number;
  airingAt: number;
  media: RawMedia | null;
}

/** Sort key for unreleased titles: soonest known premiere first, undated ones last. */
function releaseKey(m: MediaCard): number {
  if (m.nextAiring) return m.nextAiring.airingAt;
  const d = m.startDate;
  if (d?.year) return Date.UTC(d.year, (d.month ?? 12) - 1, d.day ?? 28) / 1000;
  if (m.seasonYear) return Date.UTC(m.seasonYear, { WINTER: 1, SPRING: 4, SUMMER: 7, FALL: 10 }[m.season ?? 'FALL'], 28) / 1000;
  return Number.MAX_SAFE_INTEGER;
}

export function mapCard(raw: RawMedia): MediaCard {
  return {
    id: raw.id,
    idMal: raw.idMal ?? null,
    title: {
      romaji: raw.title.romaji,
      english: raw.title.english,
      native: raw.title.native,
      userPreferred: raw.title.userPreferred,
    },
    cover: raw.coverImage.extraLarge ?? raw.coverImage.large ?? '',
    coverColor: raw.coverImage.color,
    banner: raw.bannerImage,
    format: raw.format,
    status: raw.status,
    episodes: raw.episodes,
    duration: raw.duration,
    score: raw.averageScore,
    season: raw.season,
    seasonYear: raw.seasonYear,
    genres: raw.genres ?? [],
    isAdult: raw.isAdult,
    nextAiring: raw.nextAiringEpisode,
    startDate: raw.startDate ?? null,
    description: stripHtml(raw.description ?? null),
  };
}

export function mapDetails(raw: RawDetails): MediaDetails {
  return {
    ...mapCard(raw),
    synonyms: raw.synonyms ?? [],
    studios: raw.studios?.nodes.map((n) => n.name) ?? [],
    source: raw.source,
    countryOfOrigin: raw.countryOfOrigin,
    endDate: raw.endDate,
    popularity: raw.popularity,
    favourites: raw.favourites,
    trailer: raw.trailer,
    tags: (raw.tags ?? []).map((t) => ({ name: t.name, rank: t.rank, isSpoiler: t.isMediaSpoiler })),
    relations: (raw.relations?.edges ?? [])
      .filter((e) => e.node && e.node.type === 'ANIME')
      .map((e) => ({ relationType: e.relationType, media: mapCard(e.node) })),
    recommendations: (raw.recommendations?.nodes ?? [])
      .map((n) => n.mediaRecommendation)
      .filter((m): m is RawMedia => !!m)
      .map(mapCard),
    characters: (raw.characters?.edges ?? []).map((e) => ({
      name: e.node.name.userPreferred,
      image: e.node.image?.medium ?? null,
      role: e.role,
      voiceActor: e.voiceActors[0] ? { name: e.voiceActors[0].name.userPreferred, image: e.voiceActors[0].image?.medium ?? null } : null,
    })),
    streamingEpisodes: raw.streamingEpisodes ?? [],
    externalLinks: raw.externalLinks ?? [],
    siteUrl: raw.siteUrl,
  };
}

export function currentSeason(date = new Date()): { season: MediaSeason; year: number } {
  const m = date.getMonth();
  const season: MediaSeason = m <= 1 || m === 11 ? 'WINTER' : m <= 4 ? 'SPRING' : m <= 7 ? 'SUMMER' : 'FALL';
  // December belongs to next year's winter season on AniList.
  const year = m === 11 ? date.getFullYear() + 1 : date.getFullYear();
  return { season, year };
}

/** GraphQL variables for a browse query. Unset filters are omitted entirely (see browseQuery). */
export function browseVariables(q: BrowseQuery, excludeIds: number[], showAdult: boolean): Record<string, unknown> {
  const search = q.search?.trim() || undefined;
  const vars: Record<string, unknown> = {
    page: q.page ?? 1,
    perPage: Math.min(q.perPage ?? 30, 50),
    search,
    genre_in: q.genres?.length ? q.genres : undefined,
    genre_not_in: q.excludedGenres?.length ? q.excludedGenres : undefined,
    tag_in: q.tags?.length ? q.tags : undefined,
    season: q.season,
    seasonYear: q.year,
    format_in: q.formats?.length ? q.formats : undefined,
    status: q.status,
    countryOfOrigin: q.country,
    source: q.sourceMaterial,
    averageScore_greater: q.minScore ? q.minScore - 1 : undefined,
    episodes_greater: q.minEpisodes ? q.minEpisodes - 1 : undefined,
    episodes_lesser: q.maxEpisodes ? q.maxEpisodes + 1 : undefined,
    sort: search ? ['SEARCH_MATCH', q.sort ?? 'POPULARITY_DESC'] : [q.sort ?? 'POPULARITY_DESC'],
    id_not_in: q.excludeLibrary && excludeIds.length ? excludeIds : undefined,
    isAdult: showAdult ? undefined : false,
  };
  for (const key of Object.keys(vars)) if (vars[key] === undefined) delete vars[key];
  return vars;
}

export class AniListClient {
  private gate = new RateGate(12, 28);
  private inflight = new Map<string, Promise<unknown>>();

  constructor(
    private fetchFn: FetchFn,
    private store: Store,
    private options: { showAdult: () => boolean; token: () => string | null },
  ) {}

  /** Executes a GraphQL operation. `ttl` > 0 enables the SQLite response cache. */
  async query<T>(query: string, variables: Record<string, unknown>, opts: { ttl?: number; auth?: boolean; token?: string } = {}): Promise<T> {
    const key = `anilist:${hash(query)}:${JSON.stringify(variables)}`;
    const cacheContext=this.store.cacheContext();
    if (opts.ttl) {
      const cached = this.store.cacheGet<T>(key);
      if (cached) return cached;
    }
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = this.gate
      .run(async () => {
        const headers: Record<string, string> = {};
        const token = opts.auth ? (opts.token ?? this.options.token()) : null;
        if (opts.auth && !token) throw new AppError('unauthorised', 'Connect your AniList account in Settings → Accounts first.');
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await requestJson<{ data: T | null; errors?: { message: string; status?: number }[] }>(this.fetchFn, {
          url: ANILIST_GRAPHQL,
          method: 'POST',
          headers,
          body: { query, variables },
        }).catch((err: unknown) => {
          // An expired/revoked token comes back as HTTP 400 "Invalid token", not 401.
          if (token && err instanceof AppError && err.code === 'network' && /responded 40[01]/.test(err.message) && /invalid token/i.test(err.message)) {
            throw new AppError('unauthorised', 'AniList session expired. Reconnect in Settings → Accounts.');
          }
          throw err;
        });
        if (res.errors?.length) {
          const first = res.errors[0];
          if (first.status === 401 || /invalid token/i.test(first.message)) throw new AppError('unauthorised', 'AniList session expired. Reconnect in Settings → Accounts.');
          if (first.status === 404 || /not found/i.test(first.message)) throw new AppError('not-found', 'AniList: not found.');
          if (!res.data) throw new AppError('network', `AniList: ${first.message}`);
        }
        if (!res.data) throw new AppError('network', 'AniList returned no data.');
        if (opts.ttl) this.store.cacheSet(key, res.data, opts.ttl, cacheContext);
        return res.data;
      })
      .catch((err) => {
        // Offline / rate-limited: fall back to the last good response when we have one.
        if (opts.ttl && !(err instanceof AppError && (err.code === 'unauthorised' || err.code === 'not-found'))) {
          const stale = this.store.cacheGetStale<T>(key);
          if (stale) return stale;
        }
        throw err;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  async home(): Promise<HomeData> {
    const season = currentSeason();
    const now = nowSec();
    type R = Record<'spotlight' | 'trending' | 'popularSeason' | 'upcoming' | 'topRated', { media: RawMedia[] }> & { recent: { airingSchedules: RawAiring[] } };
    const showAdult = this.options.showAdult();
    const data = await this.query<R>(homeQuery(showAdult), { season: season.season, year: season.year, since: roundTo(now, 300) - 3 * 86400, now: roundTo(now, 300) }, { ttl: 600 });
    // Titles that haven't premiered get their own "Coming soon" section instead of
    // the hero, charts and season grid (which would otherwise offer to play them).
    const released = (m: MediaCard) => !pendingRelease(m)?.title;
    const trending = data.trending.media.map(mapCard);
    const popularSeason = data.popularSeason.media.map(mapCard);
    const upcoming = new Map<number, MediaCard>();
    for (const m of [...popularSeason, ...trending, ...data.upcoming.media.map(mapCard)]) if (!released(m) && !upcoming.has(m.id)) upcoming.set(m.id, m);
    return {
      spotlight: data.spotlight.media.filter((m) => m.bannerImage).map(mapCard).filter(released).slice(0, 9),
      trending: trending.filter(released),
      popularSeason: popularSeason.filter(released),
      upcoming: [...upcoming.values()].sort((a, b) => releaseKey(a) - releaseKey(b)),
      topRated: data.topRated.media.map(mapCard),
      recentlyAired: mapAiring(data.recent.airingSchedules, showAdult),
      season,
    };
  }

  async browse(q: BrowseQuery): Promise<Page<MediaCard>> {
    const vars = browseVariables(q, this.store.libraryIds(), this.options.showAdult());
    let data = await this.query<{ Page: { pageInfo: { total: number; currentPage: number; hasNextPage: boolean }; media: RawMedia[] } }>(
      browseQuery(Object.keys(vars)),
      vars,
      { ttl: 600 },
    );
    // Broaden an empty first page without dropping the user's other filters.
    const wider=q.search?broaderSearch(q.search):null;
    if(!data.Page.media.length&&wider&&(q.page??1)===1){
      data=await this.query(browseQuery(Object.keys(vars)),{...vars,search:wider},{ttl:600});
      data={Page:{...data.Page,pageInfo:{...data.Page.pageInfo,hasNextPage:false,total:data.Page.media.length}}};
    }
    return {
      items: data.Page.media.map(mapCard),
      page: data.Page.pageInfo.currentPage,
      hasNext: data.Page.pageInfo.hasNextPage,
      total: data.Page.pageInfo.total,
    };
  }

  async details(id: number): Promise<MediaDetails> {
    const data = await this.query<{ Media: RawDetails }>(DETAILS_QUERY, { id }, { ttl: 3600 });
    return mapDetails(data.Media);
  }

  /** Resolve only public catalogue IDs, with the same official metadata/adult/library filters. */
  async catalogueCards(ids:number[],query:BrowseQuery={}):Promise<MediaCard[]>{
    const selected=[...new Set(ids.filter(id=>Number.isInteger(id)&&id>0))].slice(0,50);
    if(!selected.length)return [];
    const vars=browseVariables({...query,search:undefined,page:1,perPage:50},this.store.libraryIds(),this.options.showAdult());
    vars.id_in=selected;
    const data=await this.query<{Page:{media:RawMedia[]}}>(browseQuery(Object.keys(vars)),vars,{ttl:600});
    return data.Page.media.map(mapCard);
  }

  async search(q: string): Promise<MediaCard[]> {
    if (!q.trim()) return [];
    const fetchResults=async(search:string)=>(await this.query<{Page:{media:RawMedia[]}}>(
      searchQuery(this.options.showAdult()),{search},{ttl:1800})).Page.media;
    const primary=await fetchResults(q.trim());
    const wider=broaderSearch(q);
    const nearby=primary.length<8&&wider ? await fetchResults(wider).catch(()=>[]) : [];
    const unique=[...new Map([...primary,...nearby].filter(raw=>this.options.showAdult()||!raw.isAdult).map(raw=>[raw.id,raw])).values()];
    return unique.map(raw=>({raw,score:discoveryScore(q,[...Object.values(raw.title),...(raw.synonyms??[])])}))
      .sort((a,b)=>b.score-a.score).slice(0,24).map(({raw})=>mapCard(raw));
  }

  /**
   * Recently aired shows, newest first (one card per show), 36 per page.
   * Cached briefly so new episodes appear soon after they air.
   */
  async latest(page = 1): Promise<{ items: AiringItem[]; hasNext: boolean }> {
    const now = nowSec();
    const data = await this.query<{ Page: { pageInfo: { hasNextPage: boolean }; airingSchedules: RawAiring[] } }>(
      SCHEDULE_QUERY.replace('sort: TIME)', 'sort: TIME_DESC)'),
      { page, from: now - 14 * 86400, to: roundTo(now, 60) },
      { ttl: 90 },
    );
    const seen = new Set<number>();
    const items = mapAiring(data.Page.airingSchedules, this.options.showAdult())
      .filter((a) => !seen.has(a.media.id) && seen.add(a.media.id))
      .slice(0, 36);
    return { items, hasNext: data.Page.pageInfo.hasNextPage };
  }

  async schedule(from: number, to: number): Promise<AiringItem[]> {
    const items: RawAiring[] = [];
    for (let page = 1; page <= 6; page++) {
      const data = await this.query<{ Page: { pageInfo: { hasNextPage: boolean }; airingSchedules: RawAiring[] } }>(
        SCHEDULE_QUERY,
        { page, from, to },
        { ttl: 900 },
      );
      items.push(...data.Page.airingSchedules);
      if (!data.Page.pageInfo.hasNextPage) break;
    }
    return mapAiring(items, this.options.showAdult());
  }

  /** Extra details for hover cards (studio, original creator, synopsis, tags); cached for a week. */
  async hoverInfo(id: number): Promise<HoverInfo> {
    type R = {
      Media: {
        description: string | null;
        studios: { nodes: { name: string }[] } | null;
        staff: { edges: { role: string; node: { name: { full: string } } }[] } | null;
        tags: { name: string; rank: number; isMediaSpoiler: boolean }[] | null;
      };
    };
    const data = await this.query<R>(HOVER_QUERY, { id }, { ttl: 7 * 86400 });
    const creators = [...new Set((data.Media.staff?.edges ?? []).filter((e) => CREATOR_ROLE.test(e.role.trim())).map((e) => e.node.name.full))];
    return {
      studios: data.Media.studios?.nodes.map((n) => n.name) ?? [],
      creators: creators.slice(0, 2),
      description: stripHtml(data.Media.description),
      tags: (data.Media.tags ?? [])
        .filter((t) => !t.isMediaSpoiler && t.rank >= 60)
        .slice(0, 4)
        .map((t) => t.name),
    };
  }

  async genres(): Promise<{ genres: string[]; tags: string[] }> {
    const data = await this.query<{ GenreCollection: string[]; MediaTagCollection: { name: string; isAdult: boolean }[] }>(GENRES_QUERY, {}, { ttl: 7 * 86400 });
    const showAdult = this.options.showAdult();
    return {
      genres: data.GenreCollection.filter((g) => showAdult || g !== 'Hentai'),
      tags: data.MediaTagCollection.filter((t) => showAdult || !t.isAdult).map((t) => t.name),
    };
  }
}

function mapAiring(items: RawAiring[], showAdult: boolean): AiringItem[] {
  return items
    .filter((a) => a.media && (showAdult || !a.media.isAdult))
    .map((a) => ({ id: a.id, episode: a.episode, airingAt: a.airingAt, media: mapCard(a.media!) }));
}

function roundTo(n: number, step: number) {
  return Math.floor(n / step) * step;
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
