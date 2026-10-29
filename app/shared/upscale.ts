import { z } from 'zod';
export const upscaleSchema = z.object({
  enabled: z.boolean().default(false), mode: z.enum(['A', 'B', 'C', 'A+A', 'B+B', 'C+A']).default('A'),
  darken: z.boolean().default(false), thin: z.boolean().default(false),
}).strict();
export type UpscaleSettings = z.infer<typeof upscaleSchema>;
export const DEFAULT_UPSCALE: UpscaleSettings = { enabled: false, mode: 'A', darken: false, thin: false };
export interface UpscaleStatus { state: 'off' | 'waiting' | 'active' | 'unavailable'; message: string; width?: number; height?: number }
export function upscaleSize(width: number, height: number, textureLimit: number): { width: number; height: number } | null {
  if (![width, height, textureLimit].every((v) => Number.isFinite(v) && v > 0)) return null;
  const ratio = Math.min(3840 / width, 2160 / height, textureLimit / width, textureLimit / height);
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}
