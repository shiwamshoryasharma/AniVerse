import { z } from 'zod';
import { themePresetSchema } from './theme';
import { upscaleSchema } from './upscale';
const id = z.number().int().positive();
const timestamp = z.number().int().nonnegative().max(1e14);
const seconds = z.number().finite().nonnegative().max(604800);
const image = z.string().max(2000).refine((v) => !v || /^https:\/\//.test(v), 'Images must be public HTTPS URLs');
export const backupMediaSchema = z.object({
  id, idMal: id.nullable(), title: z.string().max(300), cover: image, banner: image.nullable(),
  format: z.enum(['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC']).nullable(),
  episodes: z.number().int().nonnegative().max(100000).nullable(),
}).strict();
const appearance = z.object({
  style: z.enum(['classic', 'aurora', 'paper']).default('classic'),
  accent: z.enum(['ember', 'aqua', 'violet', 'sakura', 'crimson']),
  density: z.enum(['compact', 'comfortable']), fontFamily: z.enum(['inter', 'system', 'arial', 'serif', 'mono']),
  reduceMotion: z.boolean(), titleLanguage: z.enum(['english', 'romaji', 'native']),
  showAdult: z.boolean(), spoilerShield: z.boolean(),
}).strict();
const player = z.object({
  autoplay: z.boolean(), autoNext: z.boolean(), resume: z.boolean(), volume: z.number().min(0).max(1),
  speed: z.number().min(0.25).max(3), seekStep: z.number().int().min(1).max(60), skipStep: z.number().int().min(5).max(300),
  completeThreshold: z.number().min(0.5).max(1), preferredQuality: z.enum(['auto', '1080', '720', '480']),
  theater: z.boolean(), siteFocus: z.boolean(),
  subtitleStyle: z.object({ size: z.number().min(16).max(48), color: z.enum(['white', 'yellow', 'cyan', 'green']), background: z.number().min(0).max(1), offset: z.number().min(-15).max(15) }).strict(),
  upscale: upscaleSchema.default({ enabled: false, mode: 'A', darken: false, thin: false }),
}).strict();
const planItem = z.object({ media: backupMediaSchema, episode: id, minutes: z.number().positive().max(360), estimated: z.boolean() }).strict();
export const backupSchema = z.object({
  format: z.literal('aniverse.backup'), version: z.literal(1),
  appVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/), createdAt: z.iso.datetime(),
  settings: z.object({ appearance, player }).strict(), media: z.array(backupMediaSchema).max(20000),
  library: z.array(z.object({ mediaId: id, status: z.enum(['CURRENT', 'PLANNING', 'COMPLETED', 'PAUSED', 'DROPPED', 'REPEATING']), progress: z.number().int().nonnegative().max(100000), score: z.number().min(0).max(10).nullable(), updatedAt: timestamp }).strict()).max(20000),
  progress: z.array(z.object({ mediaId: id, episode: id, position: seconds, duration: seconds, completed: z.boolean(), updatedAt: timestamp }).strict().refine((r) => r.position <= r.duration)).max(100000),
  history: z.array(z.object({ mediaId: id, episode: id, position: seconds, duration: seconds, watchedAt: timestamp }).strict()).max(100000),
  favourites: z.array(z.object({ mediaId: id, addedAt: timestamp }).strict()).max(20000),
  bookmarks: z.array(z.object({ mediaId: id, episode: id, position: seconds, duration: seconds, note: z.string().max(1000), tags: z.array(z.string().max(30)).max(8), createdAt: timestamp }).strict().refine((r) => r.position <= r.duration)).max(20000),
  skips: z.array(z.object({ mediaId: id, kind: z.enum(['intro', 'outro']), start: seconds, end: seconds, duration: seconds }).strict().refine((r) => r.end > r.start && r.end <= r.duration)).max(40000),
  themes: z.array(themePresetSchema).max(30),
  plan: z.object({ budget: z.number().min(5).max(360), days: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), minutes: z.number().nonnegative().max(360), items: z.array(planItem).max(100),
  }).strict()).length(7), unscheduled: z.number().int().nonnegative() }).strict().nullable(),
}).strict().superRefine((data, ctx) => {
  const ids = new Set(data.media.map((m) => m.id));
  if (ids.size !== data.media.length) ctx.addIssue({ code: 'custom', message: 'Duplicate media IDs' });
  for (const key of ['library', 'progress', 'history', 'favourites', 'bookmarks', 'skips'] as const)
    if (data[key].some((r) => !ids.has(r.mediaId))) ctx.addIssue({ code: 'custom', message: 'Record references missing metadata' });
});
export type AppBackup = z.infer<typeof backupSchema>;
