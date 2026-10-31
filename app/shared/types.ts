// Domain types shared by the core (main process) and the renderer.
// Keep this file free of runtime imports so both bundles can use it.

export type MediaFormat = 'TV' | 'TV_SHORT' | 'MOVIE' | 'SPECIAL' | 'OVA' | 'ONA' | 'MUSIC';
export type MediaStatus = 'FINISHED' | 'RELEASING' | 'NOT_YET_RELEASED' | 'CANCELLED' | 'HIATUS';
export type MediaSeason = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';
export type ListStatus = 'CURRENT' | 'PLANNING' | 'COMPLETED' | 'PAUSED' | 'DROPPED' | 'REPEATING';

export interface MediaTitle {
  romaji: string | null;
  english: string | null;
  native: string | null;
  userPreferred: string;
}

export interface MediaCard {
  id: number;
  idMal: number | null;
  title: MediaTitle;
  cover: string;
  coverColor: string | null;
  banner: string | null;
  format: MediaFormat | null;
  status: MediaStatus | null;
  episodes: number | null;
  duration: number | null;
  score: number | null;
  season: MediaSeason | null;
  seasonYear: number | null;
  genres: string[];
  isAdult: boolean;
  nextAiring: { episode: number; airingAt: number } | null;
  startDate: FuzzyDate | null;
  description: string | null;
}

export interface FuzzyDate {
  year: number | null;
  month: number | null;
  day: number | null;
}

export interface MediaCharacter {
  name: string;
  image: string | null;
  role: string;
  voiceActor: { name: string; image: string | null } | null;
}

export interface MediaRelation {
  relationType: string;
  media: MediaCard;
}

export interface StreamingEpisode {
  title: string;
  thumbnail: string | null;
  url: string;
  site: string;
}

export interface MediaDetails extends MediaCard {
  synonyms: string[];
  studios: string[];
  source: string | null;
  countryOfOrigin: string | null;
  endDate: FuzzyDate | null;
  popularity: number | null;
  favourites: number | null;
  trailer: { id: string; site: string } | null;
  tags: { name: string; rank: number; isSpoiler: boolean }[];
  relations: MediaRelation[];
  recommendations: MediaCard[];
  characters: MediaCharacter[];
  streamingEpisodes: StreamingEpisode[];
  externalLinks: { site: string; url: string; type: string | null; color: string | null }[];
  siteUrl: string;
}

export interface AiringItem {
  id: number;
  episode: number;
  airingAt: number;
  media: MediaCard;
}

export interface HomeData {
  spotlight: MediaCard[];
  trending: MediaCard[];
  popularSeason: MediaCard[];
  upcoming: MediaCard[];
  topRated: MediaCard[];
  recentlyAired: AiringItem[];
  season: { season: MediaSeason; year: number };
}

export type BrowseSort =
  | 'TRENDING_DESC'
  | 'POPULARITY_DESC'
  | 'SCORE_DESC'
  | 'START_DATE_DESC'
  | 'UPDATED_AT_DESC'
  | 'TITLE_ROMAJI'
  | 'FAVOURITES_DESC'
  | 'EPISODES_DESC';

export interface BrowseQuery {
  search?: string;
  genres?: string[];
  excludedGenres?: string[];
  tags?: string[];
  season?: MediaSeason;
  year?: number;
  formats?: MediaFormat[];
  status?: MediaStatus;
  country?: 'JP' | 'KR' | 'CN' | 'TW';
  sourceMaterial?: string;
  minScore?: number;
  minEpisodes?: number;
  maxEpisodes?: number;
  sort?: BrowseSort;
  excludeLibrary?: boolean;
  page?: number;
  perPage?: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  hasNext: boolean;
  total: number;
}

/** Minimal, storable description of a title used by library/history rows. */
export interface MediaSnapshot {
  id: number;
  idMal: number | null;
  title: string;
  cover: string;
  banner: string | null;
  format: MediaFormat | null;
  episodes: number | null;
}

/** What a source adapter needs to look a title up. */
export interface MediaRef {
  id: number;
  idMal: number | null;
  titles: string[];
  episodes: number | null;
  format: MediaFormat | null;
  seasonYear: number | null;
}

// ---------------------------------------------------------------- sources

export type SourceKind = 'web' | 'youtube';

export interface SourceCapabilities {
  /** Adapter can search the site for a title. */
  search: boolean;
  /** Adapter returns an episode list for a title. */
  episodes: boolean;
  /** Adapter returns playable streams (native player or official embed). */
  streams: boolean;
  /** Comments can be read through an authorised integration. */
  comments: boolean;
  /** Site supports signing in inside its isolated session. */
  login: boolean;
}

export interface SourceInfo {
  id: string;
  name: string;
  url: string;
  host: string;
  kind: SourceKind;
  enabled: boolean;
  order: number;
  adblock: boolean;
  autoCloudflare: boolean;
  /** Search URL with a `{query}` placeholder; null when not discovered yet. */
  searchTemplate: string | null;
  searchTemplateSource: 'user' | 'recipe' | 'opensearch' | 'form' | 'jsonld' | 'ui' | null;
  /** When automatic search discovery last ran (unix seconds), null if never. */
  searchCheckedAt: number | null;
  capabilities: SourceCapabilities;
  partition: string;
  /** Line number in the config file (1-based). */
  line: number;
}

export interface SourceOverridePatch {
  enabled?: boolean;
  order?: number;
  adblock?: boolean;
  autoCloudflare?: boolean;
  name?: string;
  searchTemplate?: string | null;
}

export interface SourceEpisode {
  number: number;
  title: string;
  thumbnail: string | null;
  ref: string;
  publishedAt: number | null;
}

export interface SourceMatch {
  sourceId: string;
  /** `web`: open `pageUrl` in the isolated session; `episodes`: adapter-provided list. */
  mode: 'web' | 'episodes';
  pageUrl: string | null;
  pinned: boolean;
  /** Title page learned by the site navigator (web sources). */
  titleUrl: string | null;
  /** Episode pages learned by the site navigator, by episode number. */
  episodeUrls: Record<number, string>;
  episodes: SourceEpisode[];
  note: string | null;
}

export interface SubtitleTrack {
  label: string;
  lang: string;
  url: string;
}

export type Stream =
  | { type: 'hls' | 'dash' | 'mp4'; url: string; label: string; subtitles: SubtitleTrack[] }
  | { type: 'youtube'; videoId: string; label: string }
  | { type: 'web'; url: string; label: string };

// ---------------------------------------------------------------- library

export interface ProgressEntry {
  mediaId: number;
  episode: number;
  position: number;
  duration: number;
  completed: boolean;
  sourceId: string | null;
  updatedAt: number;
}

export interface ProgressSave {
  media: MediaSnapshot;
  episode: number;
  position: number;
  duration: number;
  sourceId: string | null;
}

export interface ContinueItem {
  media: MediaSnapshot;
  episode: number;
  position: number;
  duration: number;
  completed: boolean;
  sourceId: string | null;
  updatedAt: number;
}

export interface HistoryEntry {
  id: number;
  media: MediaSnapshot;
  episode: number;
  sourceId: string | null;
  position: number;
  duration: number;
  watchedAt: number;
}

export interface FavouriteEntry {
  media: MediaSnapshot;
  addedAt: number;
}

export interface LibraryEntry {
  media: MediaSnapshot;
  status: ListStatus;
  progress: number;
  score: number | null;
  updatedAt: number;
}

export interface MediaLibraryState {
  favourite: boolean;
  entry: LibraryEntry | null;
  progress: ProgressEntry[];
  pinned: Record<string, string>;
}

// ---------------------------------------------------------------- accounts

export type Provider = 'anilist' | 'mal';

export interface AccountInfo {
  provider: Provider;
  connected: boolean;
  /** This build ships a client ID for the provider (sign-in is available). */
  clientIdConfigured: boolean;
  /** A browser sign-in is in progress. */
  signingIn: boolean;
  /** The saved session expired or was revoked: the user must reconnect. */
  needsReconnect: boolean;
  userName: string | null;
  avatar: string | null;
  expiresAt: number | null;
  lastSyncAt: number | null;
  lastError: string | null;
  pending: number;
}

export interface SyncReport {
  pushed: number;
  failed: number;
  pulled: number;
  /** Entries edited both here and on a service, settled by "newest edit wins". */
  resolved: number;
  errors: string[];
}

// ---------------------------------------------------------------- comments

export type CommentProvider = 'anilist' | 'mal' | 'youtube';

export interface CommentItem {
  id: string;
  provider: CommentProvider;
  author: { name: string; avatar: string | null; url: string | null };
  body: string;
  createdAt: number;
  likes: number | null;
  url: string | null;
}

export interface CommentChannel {
  provider: CommentProvider;
  label: string;
  status: 'ok' | 'empty' | 'needs-config' | 'needs-login' | 'unavailable' | 'error';
  canPost: boolean;
  threadId: number | null;
  threadTitle: string | null;
  threadUrl: string | null;
  message: string | null;
  count: number;
}

export interface CommentsQuery {
  mediaId: number;
  idMal: number | null;
  episode: number;
  titles: string[];
  youtubeVideoId?: string | null;
}

export interface CommentsResult {
  channels: CommentChannel[];
  items: CommentItem[];
}

// ---------------------------------------------------------------- settings

export type AccentName = 'ember' | 'aqua' | 'violet' | 'sakura' | 'crimson' | 'festival';

export interface Settings {
  profile: {
    name: string;
    bio: string;
    /** media://profile/… URLs of the uploaded images, or null. */
    avatar: string | null;
    banner: string | null;
  };
  appearance: {
    style: 'classic' | 'aurora' | 'paper';
    accent: AccentName;
    density: 'compact' | 'comfortable';
    fontFamily: 'inter' | 'system' | 'arial' | 'serif' | 'mono';
    reduceMotion: boolean;
    titleLanguage: 'english' | 'romaji' | 'native';
    showAdult: boolean;
    spoilerShield: boolean;
  };
  player: {
    autoplay: boolean;
    autoNext: boolean;
    resume: boolean;
    volume: number;
    speed: number;
    seekStep: number;
    skipStep: number;
    completeThreshold: number;
    preferredQuality: 'auto' | '1080' | '720' | '480';
    theater: boolean;
    /** Show only the site's player (not the whole page) when watching on a website. */
    siteFocus: boolean;
    upscale: import('./upscale').UpscaleSettings;
    subtitleStyle: { size:number; color:'white'|'yellow'|'cyan'|'green'; background:number; offset:number };
  };
  accounts: {
    youtubeApiKey: string;
    /** Push watched episodes and list changes to connected services as they happen. */
    autoSync: boolean;
    /** Also bring changes made on AniList/MyAnimeList into AniVerse (newest edit wins). */
    twoWay: boolean;
  };
  privacy: {
    adblock: boolean;
    blockPopups: boolean;
    autoCloudflare: boolean;
    watchInsights: boolean;
  };
  updates: {
    /** Look for a new release at start-up and every few hours. */
    autoCheck: boolean;
    /** Download a found update in the background (only the changed blocks when possible). */
    autoDownload: boolean;
  };
}

/** Self-update state (electron/updater.ts), pushed to the renderer as `update.status`. */
export interface UpdateState {
  status: 'disabled' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  /** Installed version. */
  current: string;
  /** The newer version that was found / downloaded. */
  version: string | null;
  releaseDate: string | null;
  /** Release page with the notes for `version`. */
  releaseUrl: string | null;
  progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null;
  /** Epoch ms of the last finished check. */
  checkedAt: number | null;
  error: string | null;
  /** Why updating is off (development build, portable copy, …) when status is 'disabled'. */
  reason: string | null;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

// ---------------------------------------------------------------- runtime

export interface ProbeResult {
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  url: string;
  video?: {
    width: number; height: number; readyState: number; bufferedAhead: number;
    totalFrames: number | null; droppedFrames: number | null; playbackRate: number;
  };
}

export interface PrivacyState { incognito:boolean; privateMediaIds:number[] }

export interface AppInfo {
  security:{engine:'rust-wasm';ready:boolean;abi:number;sha256:string};
  version: string;
  electron: string;
  chrome: string;
  platform: string;
  configPath: string;
  dataPath: string;
  graphics: import('./graphics').GraphicsSummary & { renderer: string | null; uiRendering: import('./graphics').UiRenderingState };
}

export interface CloudflareEvent {
  sourceId: string;
  state: 'checking' | 'needs-user' | 'cleared' | 'failed';
  message: string;
}

export interface AdblockStats {
  securityBlocked: Record<string,number>;
  updating: boolean;
  error: string | null;
  enabled: boolean;
  ready: boolean;
  listsUpdatedAt: number | null;
  blocked: Record<string, number>;
  popupsBlocked: Record<string, number>;
}

export interface SyncStatusEvent {
  provider: Provider;
  state: 'syncing' | 'ok' | 'error';
  message: string;
}

export interface AppNotice {
  level: 'info' | 'warn' | 'error';
  message: string;
  sourceId?: string;
  /** Optional URL the user may choose to open in the system browser. */
  url?: string;
}

export interface OpenEpisodeRequest {
  webContentsId: number;
  sourceId: string;
  mediaId: number;
  titles: string[];
  episode: number;
  /** The site already shows this episode (user navigated there): just remember it. */
  adopt?: boolean;
  focus?: boolean;
}

export interface SiteEpisodeCard {
  episode:number;
  thumbnail:string|null;
  /** Only language badges explicitly reported for this episode. Empty means unknown. */
  audio:('sub'|'dub')[];
}

export interface OpenEpisodeResult {
  ok: boolean;
  failure?: 'not-found' | 'blocked' | 'unavailable' | 'cancelled';
  url: string;
  via: 'current' | 'cache' | 'derived' | 'search' | 'title' | null;
  episodes?:SiteEpisodeCard[];
  focused: boolean;
  message: string | null;
  options: SiteOptions;
}

/** A SUB/DUB toggle or server button found on a site's episode page. */
export interface SiteOption {
  kind: 'type' | 'server';
  label: string;
  /** `sub` / `dub` / `raw` for types; the lowercased label for servers. */
  value: string;
  active: boolean;
  /** For servers listed per audio type ("SUB: HD-1 HD-2"), the type they belong to. */
  group: string | null;
}

export interface SiteOptions {
  types: SiteOption[];
  servers: SiteOption[];
}

export interface SiteStatusEvent {
  webContentsId: number;
  sourceId: string;
  message: string | null;
}

export interface HoverInfo {
  studios: string[];
  creators: string[];
  description: string | null;
  tags: string[];
}

// ---------------------------------------------------------------- casting

export interface CastDevice {
  transport?: 'chrome';
  id: string;
  name: string;
  model: string;
  host: string;
  port: number;
}

/** Media sent to a Cast device (the device streams it; no screen mirroring). */
export interface CastMedia {
  url: string;
  kind: 'hls' | 'dash' | 'mp4';
  title: string;
  subtitle?: string;
  image?: string;
  startAt?: number;
  subtitles?: SubtitleTrack[];
  /** Process an opened local video on the sender before streaming it to a 4K receiver. */
  upscale4k?: boolean;
}

export interface CastState {
  transport?: 'chrome' | 'direct' | null;
  processing?: { width: number; height: number; encoder: string; live?: boolean } | null;
  device: { id: string; name: string } | null;
  status: 'idle' | 'connecting' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';
  currentTime: number;
  duration: number;
  title: string | null;
  volume: number;
  error: string | null;
}
