import { describe, expect, it } from 'vitest';
import { MirrorIngress } from '../../app/core/mirrorIngress';
import { mirrorTranscodeArgs } from '../../electron/cast/sender4k';
describe('website mirroring ingress', () => {
  it('writes bounded media chunks in order and rejects missing or repeated sequence numbers', async () => {
    const written: number[] = [];
    const ingress = new MirrorIngress(async (bytes) => { written.push(bytes[0]!); });
    await ingress.push(0, new Uint8Array([3]));
    await expect(ingress.push(0, new Uint8Array([8]))).rejects.toThrow(/sequence/);
    await expect(ingress.push(2, new Uint8Array([8]))).rejects.toThrow(/sequence/);
    await ingress.push(1, new Uint8Array([4]));
    expect(written).toEqual([3, 4]);
    ingress.close();
    await expect(ingress.push(2, new Uint8Array([9]))).rejects.toThrow(/closed/);
  });
  it('rejects oversized chunks before passing them to the encoder', async () => {
    let bytes = 0;
    const ingress = new MirrorIngress(async (chunk) => { bytes += chunk.length; });
    await expect(ingress.push(0, new Uint8Array(2_000_001))).rejects.toThrow(/size/);
    expect(bytes).toBe(0);
  });
  it('encodes only the provided capture pipe, without fetching website streams or desktop audio', () => {
    const normal = mirrorTranscodeArgs(false, 'h264_nvenc');
    expect(normal[normal.indexOf('-i') + 1]).toBe('pipe:0');
    expect(normal[normal.indexOf('-protocol_whitelist') + 1]).toBe('file,pipe');
    expect(normal).toContain('h264_nvenc');
    expect(normal.join(' ')).not.toMatch(/gdigrab|dshow|https?:/);
    const fourK = mirrorTranscodeArgs(true, 'hevc_nvenc');
    expect(fourK.join(' ')).toContain('libplacebo=w=3840:h=2160');
    expect(fourK).toContain('hvc1');
  });
});
