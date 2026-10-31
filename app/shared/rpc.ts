// Typed contract between the renderer and the main process.
// Each entry is [input, output]. The main process validates every input
// with the zod schema registered for the same method (electron/ipc.ts).

import type {
  AccountInfo,
  AdblockStats,
  AiringItem,
  AppInfo,
  AppNotice,
  CastDevice,
  CastMedia,
  CastState,
  BrowseQuery,
  CloudflareEvent,
  CommentItem,
  CommentsQuery,
  CommentsResult,
  ContinueItem,
  DeepPartial,
  FavouriteEntry,
  HistoryEntry,
  HomeData,
  HoverInfo,
  OpenEpisodeRequest,
  OpenEpisodeResult,
  SiteStatusEvent,
  SiteOptions,
  SiteEpisodeCard,
  LibraryEntry,
  ListStatus,
  MediaCard,
  MediaDetails,
  MediaLibraryState,
  MediaRef,
  MediaSnapshot,
  Page,
  ProbeResult,
  ProgressSave,
  Provider,
  Settings,
  SourceInfo,
  SourceCatalogueRequest,
  SourceCataloguePage,
  SourceMatch,
  SourceOverridePatch,
  Stream,
  SyncReport,
  SyncStatusEvent,
  UpdateState,
} from './types';

export interface RpcContract {
  'changelog.state': [void, import('./changelog').ChangelogState];
  'changelog.markSeen': [{ version: string }, import('./changelog').ChangelogState];
  'drive.state': [void, import('./drive').DriveState];
  'drive.configure': [void, import('./drive').DriveState];
  'drive.connect': [{ shared: boolean }, import('./drive').DriveState];
  'drive.cancel': [void, void];
  'drive.disconnect': [void, import('./drive').DriveState];
  'drive.folder': [{ value: string }, import('./drive').DriveState];
  'drive.export': [void, import('./drive').DriveState];
  'drive.preview': [void, import('./drive').DrivePreview];
  'drive.import': [{ ticket: string; applySettings: boolean }, import('./drive').BackupSummary];
  'meta.home': [void, HomeData];
  'meta.browse': [BrowseQuery, Page<MediaCard>];
  'meta.details': [{ id: number }, MediaDetails];
  'meta.search': [{ q: string }, MediaCard[]];
  'meta.schedule': [{ from: number; to: number }, AiringItem[]];
  'meta.latest': [{ page: number }, { items: AiringItem[]; hasNext: boolean }];
  'meta.genres': [void, { genres: string[]; tags: string[] }];
  'meta.hover': [{ id: number }, HoverInfo];

  'sources.list': [void, SourceInfo[]];
  'sources.catalogue':[SourceCatalogueRequest,SourceCataloguePage];
  'sources.audio': [void,{mediaId:number;audio:('sub'|'dub')[];episodes:{episode:number;audio:('sub'|'dub')[]}[]}[]];
  'sources.reload': [void, SourceInfo[]];
  'sources.update': [{ id: string; patch: SourceOverridePatch }, SourceInfo];
  'sources.openConfig': [void, { path: string }];
  'sources.match': [{ sourceId: string; media: MediaRef }, SourceMatch];
  'sources.streams': [{ sourceId: string; ref: string }, Stream[]];
  'sources.discover': [{ id: string }, SourceInfo];
  'sources.session': [{ id: string }, { cookies: number; signedIn: boolean }];
  'sources.clearSession': [{ id: string }, void];
  'sources.pin': [{ sourceId: string; mediaId: number; url: string | null }, void];

  'site.openEpisode': [OpenEpisodeRequest, OpenEpisodeResult];
  'site.focus': [{ webContentsId: number; on: boolean }, { focused: boolean }];
  'site.options': [{ webContentsId: number }, SiteOptions];
  'site.episodes':[{webContentsId:number},SiteEpisodeCard[]];
  'site.choose': [{ webContentsId: number; sourceId: string; kind: 'type' | 'server'; value: string }, { options: SiteOptions; focused: boolean }];
  'site.forget': [{ sourceId: string; mediaId: number }, void];


  'toolkit.bookmarks': [{mediaId?:number;search?:string}, import('./workspace').SceneBookmark[]];
  'toolkit.saveBookmark': [import('./workspace').BookmarkInput, import('./workspace').SceneBookmark];
  'toolkit.deleteBookmark': [{id:number}, void];
  'toolkit.skips': [{mediaId:number}, import('./workspace').SkipRange[]];
  'toolkit.saveSkip': [import('./workspace').SkipRange, import('./workspace').SkipRange[]];
  'toolkit.deleteSkip': [{mediaId:number;kind:'intro'|'outro'}, void];
  'toolkit.record': [import('./workspace').PlaybackPoint, void];
  'toolkit.insights': [void, import('./workspace').WatchInsights];
  'toolkit.clearInsights': [void, void];
  'planner.get': [void, import('./workspace').WatchPlan|null];
  'planner.build': [{budget:number;startDate:string}, import('./workspace').WatchPlan];
  'collection.list': [void, import('./workspace').LocalMedia[]];
  'collection.scan': [{choose:boolean}, {files:import('./workspace').LocalMedia[];skipped:number}];
  'collection.match': [{id:number;media:MediaSnapshot;episode:number}, import('./workspace').LocalMedia];
  'collection.remove': [{id:number}, void];
  'collection.open': [{id:number}, {url:string;name:string;media:MediaSnapshot|null;episode:number|null}];
  'themes.list': [void, import('./theme').SavedTheme[]];
  'themes.save': [{name:string}, import('./theme').SavedTheme];
  'themes.apply': [{id:string}, Settings];
  'themes.delete': [{id:string}, void];
  'themes.import': [void, import('./theme').SavedTheme|null];
  'themes.export': [{id:string}, {saved:boolean}];
  'player.openSubtitles': [void, {name:string;text:string}|null];

  'profile.setImage': [{ kind: 'avatar' | 'banner'; dataUrl: string }, Settings];
  'profile.clearImage': [{ kind: 'avatar' | 'banner' }, Settings];

  'library.continue': [void, ContinueItem[]];
  'library.state': [{ mediaId: number }, MediaLibraryState];
  'library.saveProgress': [ProgressSave, { completedNow: boolean }];
  'library.markWatched': [{ media: MediaSnapshot; episode: number; watched: boolean }, void];
  'library.history': [{ limit: number; offset: number }, HistoryEntry[]];
  'library.clearHistory': [{ id: number | null }, void];
  'library.dismissContinue': [{ mediaId: number }, void];
  'library.favourites': [void, FavouriteEntry[]];
  'library.toggleFavourite': [{ media: MediaSnapshot }, { favourite: boolean }];
  'library.entries': [{ status: ListStatus | null }, LibraryEntry[]];
  'library.setStatus': [{ media: MediaSnapshot; status: ListStatus | null }, void];
  /** Score on a 0–10 scale (null = no score); the title must be in the list. */
  'library.setScore': [{ media: MediaSnapshot; score: number | null }, void];

  'accounts.list': [void, AccountInfo[]];
  /** Opens the provider's sign-in page in the system browser and resolves once AniVerse receives the redirect. */
  'accounts.connect': [{ provider: Provider }, AccountInfo];
  'accounts.cancel': [{ provider: Provider }, void];
  'accounts.disconnect': [{ provider: Provider }, void];
  /** provider null = every connected service. */
  'accounts.sync': [{ provider: Provider | null }, SyncReport];

  'comments.list': [CommentsQuery, CommentsResult];
  'comments.post': [{ provider: 'anilist'; threadId: number; body: string }, CommentItem];

  'settings.get': [void, Settings];
  'settings.set': [DeepPartial<Settings>, Settings];

  'player.openFile': [void, { url: string; name: string } | null];

  'cast.mirrorPrepare': [{ webContentsId: number; deviceId: string; title: string; upscale: boolean }, { ticket: string }];
  'cast.mirrorChunk': [{ ticket: string; sequence: number; bytes: Uint8Array }, void];
  'cast.mirrorStop': [{ ticket: string }, void];
  'cast.windowsDisplay': [{ target: 'connect' | 'display' | 'sound' }, { opened: 'connect' | 'display' | 'sound'; fallback: boolean }];
  'player.capturePrepare': [{ webContentsId: number }, { ticket: string }];
  'player.captureStop': [{ ticket: string }, void];
  'cast.capabilities': [void, { available: boolean; version: string | null; message: string }];
  'cast.devices': [void, CastDevice[]];
  'cast.chromeDevices': [void, CastDevice[]];
  'cast.chromeClose': [void, void];
  'cast.start': [{ deviceId: string; media: CastMedia }, CastState];
  'cast.control': [{ action: 'play' | 'pause' | 'seek' | 'volume'; value?: number }, CastState];
  'cast.stop': [void, CastState];
  'cast.state': [void, CastState];
  'player.upscale': [{ webContentsId: number; options: import('./upscale').UpscaleSettings }, import('./upscale').UpscaleStatus];
  'player.probe': [{ webContentsId: number }, ProbeResult | null];
  'player.control': [{ webContentsId: number; action: 'play' | 'pause' | 'seek' | 'resync'; value?: number }, boolean];

  'adblock.stats': [void, AdblockStats];
  'adblock.update': [void, AdblockStats];
  'privacy.state': [void, import('./types').PrivacyState];
  'privacy.incognito': [{on:boolean}, import('./types').PrivacyState];
  'privacy.title': [{mediaId:number;on:boolean}, import('./types').PrivacyState];
  'privacy.watchSources': [{mediaId:number}, {leaseId:string|null;sources:SourceInfo[]}];
  'privacy.releaseSources': [{leaseId:string}, void];
  'app.info': [void, AppInfo];
  'app.openGraphicsSettings': [void, void];
  'app.setUiRendering': [{ mode: import('./graphics').UiRenderingMode }, import('./graphics').UiRenderingState];
  'app.restart': [void, void];
  'app.openExternal': [{ url: string }, void];
  'app.cacheClear': [void, void];

  'update.state': [void, UpdateState];
  /** Looks for a newer release now (and downloads it when automatic downloads are on). */
  'update.check': [void, UpdateState];
  'update.download': [void, UpdateState];
  /** Quits AniVerse, installs the downloaded update silently and starts the new version. */
  'update.install': [void, void];
}

export type RpcMethod = keyof RpcContract;
export type RpcInput<M extends RpcMethod> = RpcContract[M][0];
export type RpcOutput<M extends RpcMethod> = RpcContract[M][1];

export interface EventContract {
  'sources.changed': SourceInfo[];
  'privacy.changed': import('./types').PrivacyState;
  'cloudflare.status': CloudflareEvent;
  'sync.status': SyncStatusEvent;
  'adblock.stats': AdblockStats;
  'app.notice': AppNotice;
  'site.status': SiteStatusEvent;
  'player.captureEnded': { ticket: string; purpose: 'mirror' | 'upscale' };
  'cast.status': CastState;
  'update.status': UpdateState;
}

export type EventName = keyof EventContract;

export interface RpcError {
  code: 'invalid-input' | 'not-found' | 'unauthorised' | 'network' | 'cloudflare' | 'config' | 'internal';
  message: string;
}

/** Surface exposed by the preload script on `window.aniverse`. */
export interface AniverseBridge {
  invoke<M extends RpcMethod>(method: M, input: RpcInput<M>): Promise<RpcOutput<M>>;
  on<E extends EventName>(event: E, listener: (payload: EventContract[E]) => void): () => void;
  platform: string;
}

export const RPC_CHANNEL = 'aniverse:rpc';
export const EVENT_CHANNEL = 'aniverse:event';
