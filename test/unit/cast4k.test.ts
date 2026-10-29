import { describe, expect, it } from 'vitest';
import { shaderFiles, transcodeArgs } from '../../electron/cast/sender4k';
describe('sender-side 4K pipeline', () => {
  it('keeps 4K computation on the sender and encodes a receiver-readable HEVC HLS stream', () => {
    const args = transcodeArgs('C:/local/episode.mp4', 25, 'hevc_nvenc', { width: 3840, height: 2160 });
    expect(args).toContain('hevc_nvenc');
    expect(args.join(' ')).toContain('libplacebo=w=3840:h=2160');
    expect(args.join(' ')).toContain('pad=3840:2160');
    expect(args).toContain('hvc1');
    expect(args).toContain('fmp4');
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,pipe');
    expect(args.at(-1)).toBe('index.m3u8');
  });
  it('selects real restoration/denoise filters and optional line effects', () => {
    expect(shaderFiles({ enabled: true, mode: 'C+A', darken: true, thin: false })).toEqual([
      'Anime4K_Clamp_Highlights.glsl', 'Anime4K_Upscale_Denoise_CNN_x2_M.glsl', 'Anime4K_Restore_CNN_M.glsl', 'Anime4K_Darken_Fast.glsl',
    ]);
  });
});
