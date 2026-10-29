import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { AppError, errorMessage } from '../app/core/util';
import { upscaleSchema } from '../app/shared/upscale';
import { RPC_CHANNEL, type RpcContract, type RpcError, type RpcMethod } from '../app/shared/rpc';

const id = z.number().int().positive();
const text = (max = 500) => z.string().max(max);
const url = z.string().max(4000).refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) URL');
const format = z.enum(['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC']);
const listStatus = z.enum(['CURRENT', 'PLANNING', 'COMPLETED', 'PAUSED', 'DROPPED', 'REPEATING']);
const provider = z.enum(['anilist', 'mal']);
const sourceId = z.string().regex(/^[a-z0-9-]{1,80}$/);

const snapshot = z.object({
  id,
  idMal: id.nullable(),
  title: text(300),
  cover: z.string().max(2000),
  banner: z.string().max(2000).nullable(),
  format: format.nullable(),
  episodes: z.number().int().nonnegative().nullable(),
});

const mediaRef = z.object({
  id,
  idMal: id.nullable(),
  titles: z.array(text(300)).min(1).max(12),
  episodes: z.number().int().nonnegative().nullable(),
  format: format.nullable(),
  seasonYear: z.number().int().nullable(),
});

/** Methods without input ignore whatever the renderer sends. */
const none = z.unknown().transform((): void => undefined) as unknown as z.ZodType<void>;

const browse = z.object({
  search: text(200).optional(),
  genres: z.array(text(60)).max(20).optional(),
  excludedGenres: z.array(text(60)).max(20).optional(),
  tags: z.array(text(80)).max(20).optional(),
  season: z.enum(['WINTER', 'SPRING', 'SUMMER', 'FALL']).optional(),
  year: z.number().int().min(1940).max(2100).optional(),
  formats: z.array(format).max(7).optional(),
  status: z.enum(['FINISHED', 'RELEASING', 'NOT_YET_RELEASED', 'CANCELLED', 'HIATUS']).optional(),
  country: z.enum(['JP', 'KR', 'CN', 'TW']).optional(),
  sourceMaterial: z.enum(['ORIGINAL', 'MANGA', 'LIGHT_NOVEL', 'VISUAL_NOVEL', 'VIDEO_GAME', 'NOVEL', 'WEB_NOVEL', 'OTHER']).optional(),
  minScore: z.number().int().min(0).max(100).optional(),
  minEpisodes: z.number().int().min(0).max(5000).optional(),
  maxEpisodes: z.number().int().min(0).max(5000).optional(),
  sort: z.enum(['TRENDING_DESC', 'POPULARITY_DESC', 'SCORE_DESC', 'START_DATE_DESC', 'UPDATED_AT_DESC', 'TITLE_ROMAJI', 'FAVOURITES_DESC', 'EPISODES_DESC']).optional(),
  excludeLibrary: z.boolean().optional(),
  page: z.number().int().min(1).max(500).optional(),
  perPage: z.number().int().min(1).max(50).optional(),
});

const settingsPatch = z
  .object({
    profile: z.object({ name: text(40), bio: text(280) }).partial(),
    appearance: z
      .object({
        style: z.enum(['classic', 'aurora', 'paper']),
        accent: z.enum(['ember', 'aqua', 'violet', 'sakura', 'crimson']),
        density: z.enum(['compact', 'comfortable']),
        fontFamily: z.enum(['inter', 'system', 'arial', 'serif', 'mono']),
        reduceMotion: z.boolean(),
        titleLanguage: z.enum(['english', 'romaji', 'native']),
        showAdult: z.boolean(),
        spoilerShield: z.boolean(),
      })
      .partial(),
    player: z
      .object({
        autoplay: z.boolean(),
        autoNext: z.boolean(),
        resume: z.boolean(),
        volume: z.number(),
        speed: z.number(),
        seekStep: z.number(),
        skipStep: z.number(),
        completeThreshold: z.number(),
        preferredQuality: z.enum(['auto', '1080', '720', '480']),
        theater: z.boolean(),
        siteFocus: z.boolean(),
        upscale: z.object({ enabled: z.boolean(), mode: z.enum(['A', 'B', 'C', 'A+A', 'B+B', 'C+A']), darken: z.boolean(), thin: z.boolean() }).partial().strict(),
        subtitleStyle:z.object({size:z.number().finite().min(16).max(48),color:z.enum(['white','yellow','cyan','green']),background:z.number().finite().min(0).max(1),offset:z.number().finite().min(-15).max(15)}).partial(),
      })
      .partial(),
    accounts: z
      .object({
        youtubeApiKey: z.string().regex(/^[\w-]{0,80}$/),
        autoSync: z.boolean(),
        twoWay: z.boolean(),
      })
      .partial(),
    privacy: z.object({ adblock: z.boolean(), blockPopups: z.boolean(), autoCloudflare: z.boolean(), watchInsights:z.boolean() }).partial(),
    updates: z.object({ autoCheck: z.boolean(), autoDownload: z.boolean() }).partial(),
  })
  .partial();

export const schemas: { [M in RpcMethod]: z.ZodType<RpcContract[M][0]> } = {
  'changelog.state': none,
  'changelog.markSeen': z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/) }),
  'drive.state': none,
  'drive.configure': none,
  'drive.connect': z.object({ shared: z.boolean() }),
  'drive.cancel': none,
  'drive.disconnect': none,
  'drive.folder': z.object({ value: text(500) }),
  'drive.export': none,
  'drive.preview': none,
  'drive.import': z.object({ ticket: z.uuid(), applySettings: z.boolean() }),
  'meta.home': none,
  'meta.browse': browse,
  'meta.details': z.object({ id }),
  'meta.search': z.object({ q: text(200) }),
  'meta.schedule': z.object({ from: z.number().int(), to: z.number().int() }).refine((v) => v.to > v.from && v.to - v.from <= 15 * 86400, 'Range too large'),
  'meta.genres': none,
  'meta.latest': z.object({ page: z.number().int().min(1).max(20) }),
  'meta.hover': z.object({ id }),

  'sources.list': none,
  'sources.reload': none,
  'sources.update': z.object({
    id: sourceId,
    patch: z
      .object({
        enabled: z.boolean(),
        order: z.number().int().min(0).max(10000),
        adblock: z.boolean(),
        autoCloudflare: z.boolean(),
        name: text(60),
        searchTemplate: z.string().max(2000).nullable(),
      })
      .partial(),
  }),
  'sources.openConfig': none,
  'sources.match': z.object({ sourceId, media: mediaRef }),
  'sources.streams': z.object({ sourceId, ref: z.string().max(4000) }),
  'sources.discover': z.object({ id: sourceId }),
  'sources.session': z.object({ id: sourceId }),
  'sources.clearSession': z.object({ id: sourceId }),
  'sources.pin': z.object({ sourceId, mediaId: id, url: url.nullable() }),

  'site.openEpisode': z.object({
    webContentsId: id,
    sourceId,
    mediaId: id,
    titles: z.array(text(300)).min(1).max(12),
    episode: z.number().int().min(1).max(10000),
    adopt: z.boolean().optional(),
    focus: z.boolean().optional(),
  }),
  'site.focus': z.object({ webContentsId: id, on: z.boolean() }),
  'site.options': z.object({ webContentsId: id }),
  'site.choose': z.object({ webContentsId: id, sourceId, kind: z.enum(['type', 'server']), value: text(60) }),
  'site.forget': z.object({ sourceId, mediaId: id }),


  'toolkit.bookmarks': z.object({mediaId:id.optional(),search:text(200).optional()}),
  'toolkit.saveBookmark': z.object({id:id.optional(),media:snapshot,episode:id,position:z.number().finite().min(0).max(604800),duration:z.number().finite().positive().max(604800),sourceId:sourceId.nullable(),note:text(1000),tags:z.array(text(30)).max(8)}),
  'toolkit.deleteBookmark': z.object({id}),
  'toolkit.skips': z.object({mediaId:id}),
  'toolkit.saveSkip': z.object({mediaId:id,kind:z.enum(['intro','outro']),start:z.number().finite().min(0).max(604800),end:z.number().finite().positive().max(604800),enabled:z.boolean(),sourceId:sourceId.nullable(),duration:z.number().finite().positive().max(604800)}),
  'toolkit.deleteSkip': z.object({mediaId:id,kind:z.enum(['intro','outro'])}),
  'toolkit.record': z.object({sessionId:z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),mediaId:id,episode:id,sourceId:sourceId.nullable(),position:z.number().finite().min(0).max(604800),duration:z.number().finite().positive().max(604800),paused:z.boolean(),totalFrames:z.number().int().min(0).max(1e10).nullable().optional(),droppedFrames:z.number().int().min(0).max(1e10).nullable().optional()}),
  'toolkit.insights': none,
  'toolkit.clearInsights': none,
  'planner.get': none,
  'planner.build': z.object({budget:z.number().int().min(5).max(360),startDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}),
  'collection.list': none,
  'collection.scan': z.object({choose:z.boolean()}),
  'collection.match': z.object({id,media:snapshot,episode:id}),
  'collection.remove': z.object({id}),
  'collection.open': z.object({id}),
  'themes.list': none,
  'themes.save': z.object({name:z.string().trim().min(1).max(60)}),
  'themes.apply': z.object({id:z.string().uuid()}),
  'themes.delete': z.object({id:z.string().uuid()}),
  'themes.import': none,
  'themes.export': z.object({id:z.string().uuid()}),
  'player.openSubtitles': none,

  'profile.setImage': z.object({
    kind: z.enum(['avatar', 'banner']),
    dataUrl: z
      .string()
      .max(12_000_000)
      .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'Expected a PNG, JPEG or WebP data URL'),
  }),
  'profile.clearImage': z.object({ kind: z.enum(['avatar', 'banner']) }),

  'library.continue': none,
  'library.state': z.object({ mediaId: id }),
  'library.saveProgress': z.object({
    media: snapshot,
    episode: z.number().int().min(1).max(10000),
    position: z.number().min(0).max(86400),
    duration: z.number().min(0).max(86400),
    sourceId: sourceId.nullable(),
  }),
  'library.markWatched': z.object({ media: snapshot, episode: z.number().int().min(1).max(10000), watched: z.boolean() }),
  'library.history': z.object({ limit: z.number().int().min(1).max(200), offset: z.number().int().min(0) }),
  'library.clearHistory': z.object({ id: id.nullable() }),
  'library.dismissContinue': z.object({ mediaId: id }),
  'library.favourites': none,
  'library.toggleFavourite': z.object({ media: snapshot }),
  'library.entries': z.object({ status: listStatus.nullable() }),
  'library.setStatus': z.object({ media: snapshot, status: listStatus.nullable() }),
  'library.setScore': z.object({ media: snapshot, score: z.number().min(0).max(10).nullable() }),

  'accounts.list': none,
  'accounts.connect': z.object({ provider }),
  'accounts.cancel': z.object({ provider }),
  'accounts.disconnect': z.object({ provider }),
  'accounts.sync': z.object({ provider: provider.nullable() }),

  'comments.list': z.object({
    mediaId: id,
    idMal: id.nullable(),
    episode: z.number().int().min(1).max(10000),
    titles: z.array(text(300)).min(1).max(12),
    youtubeVideoId: z.string().regex(/^[\w-]{11}$/).nullable().optional(),
  }),
  'comments.post': z.object({ provider: z.literal('anilist'), threadId: id, body: z.string().min(1).max(5000) }),

  'settings.get': none,
  'settings.set': settingsPatch as z.ZodType<RpcContract['settings.set'][0]>,

  'player.openFile': none,

  'cast.mirrorPrepare': z.object({ webContentsId: id, deviceId: text(200).min(1), title: text(300), upscale: z.boolean() }),
  'cast.mirrorChunk': z.object({ ticket: z.uuid(), sequence: z.number().int().nonnegative(), bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.length > 0 && bytes.length <= 2_000_000, 'Invalid capture chunk size') }),
  'cast.mirrorStop': z.object({ ticket: z.uuid() }),
  'cast.capabilities': none,
  'cast.devices': none,
  'cast.start': z.object({
    deviceId: z.string().min(1).max(200),
    media: z.object({
      url: z.string().max(4000).refine((u) => /^(https?:\/\/|media:\/\/local\/)/i.test(u), 'Only http(s) streams or opened files can be cast'),
      kind: z.enum(['hls', 'dash', 'mp4']),
      upscale4k: z.boolean().optional(),
      title: text(300),
      subtitle: text(300).optional(),
      image: url.optional(),
      startAt: z.number().min(0).max(86400).optional(),
      subtitles: z.array(z.object({ label: text(80), lang: text(20), url: z.string().max(4000) })).max(10).optional(),
    }),
  }),
  'cast.control': z.object({ action: z.enum(['play', 'pause', 'seek', 'volume']), value: z.number().optional() }),
  'cast.stop': none,
  'cast.state': none,
  'player.upscale': z.object({ webContentsId: id, options: upscaleSchema }),
  'player.probe': z.object({ webContentsId: id }),
  'player.control': z.object({ webContentsId: id, action: z.enum(['play', 'pause', 'seek', 'resync']), value: z.number().finite().min(0).max(604800).optional() }),

  'adblock.stats': none,
  'app.info': none,
  'app.openGraphicsSettings': none,
  'app.openExternal': z.object({ url }),
  'app.cacheClear': none,

  'update.state': none,
  'update.check': none,
  'update.download': none,
  'update.install': none,
};

export type Handlers = { [M in RpcMethod]: (input: RpcContract[M][0], event: IpcMainInvokeEvent) => Promise<RpcContract[M][1]> | RpcContract[M][1] };

/**
 * Single validated RPC entry point. Requests are accepted only from the main
 * window's top frame; inputs are parsed with the method's schema; errors are
 * returned as data so their codes survive IPC serialisation.
 */
export function registerRpc(handlers: Handlers, isTrustedSender: (event: IpcMainInvokeEvent) => boolean) {
  ipcMain.handle(RPC_CHANNEL, async (event, method: unknown, input: unknown) => {
    if (!isTrustedSender(event)) return fail({ code: 'unauthorised', message: 'Untrusted sender.' });
    if (typeof method !== 'string' || !(method in schemas)) return fail({ code: 'invalid-input', message: `Unknown method ${String(method)}` });
    const m = method as RpcMethod;
    const parsed = schemas[m].safeParse(input);
    if (!parsed.success) {
      return fail({ code: 'invalid-input', message: parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') });
    }
    try {
      const data = await (handlers[m] as (i: unknown, e: IpcMainInvokeEvent) => unknown)(parsed.data, event);
      return { ok: true, data };
    } catch (err) {
      if (err instanceof AppError) return fail({ code: err.code, message: err.message });
      console.error(`[rpc] ${m} failed:`, err);
      return fail({ code: 'internal', message: errorMessage(err) });
    }
  });
}

function fail(error: RpcError) {
  return { ok: false, error };
}
