import { z } from 'zod';
export const upscaleSchema = z.object({
  enabled: z.boolean().default(false), mode: z.enum(['A', 'B', 'C', 'A+A', 'B+B', 'C+A']).default('A'),
  darken: z.boolean().default(false), thin: z.boolean().default(false),
}).strict();
export type UpscaleSettings = z.infer<typeof upscaleSchema>;
export const DEFAULT_UPSCALE: UpscaleSettings = { enabled: false, mode: 'A', darken: false, thin: false };
export interface UpscaleStatus { state: 'off' | 'waiting' | 'active' | 'unavailable'; message: string; width?: number; height?: number }
type Size = { width: number; height: number };
export function upscaleSize(width: number, height: number, textureLimit: number, surface?: Size): Size | null {
  const limits = surface ? [width, height, textureLimit, surface.width, surface.height] : [width, height, textureLimit];
  if (!limits.every((v) => Number.isFinite(v) && v > 0)) return null;
  const maxWidth = Math.min(3840, textureLimit, surface?.width ?? Infinity);
  const maxHeight = Math.min(2160, textureLimit, surface?.height ?? Infinity);
  const ratio = Math.min(maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}
