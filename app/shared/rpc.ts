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
  SourceMatch,
  SourceOverridePatch,
  Stream,
  SyncReport,
  SyncStatusEvent,
  UpdateState,
} from './types';

export interface RpcContract {
  'meta.home': [void, HomeData];
  'meta.browse': [BrowseQuery, Page<MediaCard>];
  'meta.details': [{ id: number }, MediaDetails];
  'meta.search': [{ q: string }, MediaCard[]];
  'meta.schedule': [{ from: number; to: number }, AiringItem[]];
  'meta.latest': [{ page: number }, { items: AiringItem[]; hasNext: boolean }];
  'meta.genres': [void, { genres: string[]; tags: string[] }];
  'meta.hover': [{ id: number }, HoverInfo];

  'sources.list': [void, SourceInfo[]];
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
  'site.choose': [{ webContentsId: number; sourceId: string; kind: 'type' | 'server'; value: string }, { options: SiteOptions; focused: boolean }];
  'site.forget': [{ sourceId: string; mediaId: number }, void];

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

  'cast.devices': [void, CastDevice[]];
  'cast.start': [{ deviceId: string; media: CastMedia }, CastState];
  'cast.control': [{ action: 'play' | 'pause' | 'seek' | 'volume'; value?: number }, CastState];
  'cast.stop': [void, CastState];
  'cast.state': [void, CastState];
  'player.probe': [{ webContentsId: number }, ProbeResult | null];
  'player.control': [{ webContentsId: number; action: 'play' | 'pause' | 'seek' | 'resync'; value?: number }, boolean];

  'adblock.stats': [void, AdblockStats];
  'app.info': [void, AppInfo];
  'app.openGraphicsSettings': [void, void];
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
  'cloudflare.status': CloudflareEvent;
  'sync.status': SyncStatusEvent;
  'adblock.stats': AdblockStats;
  'app.notice': AppNotice;
  'site.status': SiteStatusEvent;
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
