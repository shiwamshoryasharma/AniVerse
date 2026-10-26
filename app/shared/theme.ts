import { z } from 'zod';
export const themePresetSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(60),
    appearance: z
      .object({
        accent: z.enum(['ember', 'aqua', 'violet', 'sakura', 'crimson']),
        density: z.enum(['compact', 'comfortable']),
        fontFamily: z.enum(['inter', 'system', 'arial', 'serif', 'mono']),
        reduceMotion: z.boolean(),
      })
      .strict(),
    player: z.object({ theater: z.boolean(), preferredQuality: z.enum(['auto', '1080', '720', '480']) }).strict(),
  })
  .strict();
export type ThemePreset = z.infer<typeof themePresetSchema>;
export interface SavedTheme {
  id: string;
  preset: ThemePreset;
}
