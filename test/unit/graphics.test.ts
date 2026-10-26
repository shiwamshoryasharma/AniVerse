import { describe, expect, it } from 'vitest';
import { summarizeGraphics } from '../../app/shared/graphics';

const accelerated = { video_decode: 'enabled', gpu_compositing: 'enabled' };

describe('graphics adapter diagnostics', () => {
  it('warns when a hybrid laptop renders on the integrated GPU despite an available NVIDIA GPU', () => {
    const result = summarizeGraphics(
      {
        gpuDevice: [
          { vendorId: 0x8086, deviceId: 0x46a6, active: true, vendorString: 'Intel', deviceString: 'Intel(R) Iris(R) Xe Graphics' },
          { vendorId: 0x10de, deviceId: 0x2684, active: false, vendorString: 'NVIDIA', deviceString: 'NVIDIA GeForce RTX 4090' },
        ],
      },
      accelerated,
      'high-performance',
    );
    expect(result.preference).toBe('high-performance');
    expect(result.adapters.map((adapter) => adapter.kind)).toEqual(['integrated', 'dedicated']);
    expect(result.activeAdapter).toBe('Intel(R) Iris(R) Xe Graphics');
    expect(result.dedicatedAvailable).toBe(true);
    expect(result.dedicatedActive).toBe(false);
    expect(result.hardwareDecode).toBe(true);
    expect(result.warning).toEqual(expect.any(String));
    expect(result.warning?.length).toBeGreaterThan(0);
  });

  it('reports an active NVIDIA adapter and hardware decoding without a warning', () => {
    const result = summarizeGraphics(
      {
        gpuDevice: [
          { vendorId: 0x8086, deviceId: 0x46a6, active: false, deviceString: 'Intel(R) Iris(R) Xe Graphics' },
          { vendorId: 0x10de, deviceId: 0x2684, active: true, deviceString: 'NVIDIA GeForce RTX 4090' },
        ],
      },
      accelerated,
      'high-performance',
    );
    expect(result.activeAdapter).toBe('NVIDIA GeForce RTX 4090');
    expect(result.dedicatedAvailable).toBe(true);
    expect(result.dedicatedActive).toBe(true);
    expect(result.hardwareDecode).toBe(true);
    expect(result.warning).toBeNull();
    expect(result.adapters[1]).toMatchObject({ name: 'NVIDIA GeForce RTX 4090', vendorId: 0x10de, deviceId: 0x2684, active: true, kind: 'dedicated' });
  });

  it('distinguishes AMD discrete Radeon RX graphics from Ryzen integrated Radeon graphics', () => {
    const result = summarizeGraphics(
      {
        gpuDevice: [
          { vendorId: 0x1002, deviceId: 0x164e, active: false, deviceString: 'AMD Radeon(TM) Graphics' },
          { vendorId: 0x1002, deviceId: 0x744c, active: true, deviceString: 'AMD Radeon RX 7900 XTX' },
        ],
      },
      accelerated,
      'high-performance',
    );
    expect(result.adapters.map((adapter) => adapter.kind)).toEqual(['integrated', 'dedicated']);
    expect(result.activeAdapter).toBe('AMD Radeon RX 7900 XTX');
    expect(result.dedicatedActive).toBe(true);
    expect(result.warning).toBeNull();
  });

  it('distinguishes Intel Arc discrete graphics from Intel UHD integrated graphics', () => {
    const result = summarizeGraphics(
      {
        gpuDevice: [
          { vendorId: 0x8086, deviceId: 0x4680, active: false, deviceString: 'Intel(R) UHD Graphics 770' },
          { vendorId: 0x8086, deviceId: 0x56a0, active: true, deviceString: 'Intel(R) Arc(TM) A770 Graphics' },
        ],
      },
      accelerated,
      'system',
    );
    expect(result.preference).toBe('system');
    expect(result.adapters.map((adapter) => adapter.kind)).toEqual(['integrated', 'dedicated']);
    expect(result.activeAdapter).toBe('Intel(R) Arc(TM) A770 Graphics');
    expect(result.dedicatedAvailable).toBe(true);
    expect(result.dedicatedActive).toBe(true);
  });

  it('does not mistake a software renderer for a dedicated GPU or hardware decoding', () => {
    const result = summarizeGraphics(
      { gpuDevice: [{ vendorId: 0x1ae0, deviceId: 0xc0de, active: true, deviceString: 'ANGLE (Google, Vulkan SwiftShader Device)' }] },
      { video_decode: 'disabled_software', gpu_compositing: 'disabled_software' },
      'system',
    );
    expect(result.adapters[0].kind).toBe('software');
    expect(result.dedicatedAvailable).toBe(false);
    expect(result.dedicatedActive).toBe(false);
    expect(result.hardwareDecode).toBe(false);
    expect(result.warning).toEqual(expect.any(String));
  });

  it('warns when hardware video decoding is unavailable even with an active dedicated adapter', () => {
    const result = summarizeGraphics(
      { gpuDevice: [{ vendorId: 0x10de, deviceId: 0x2684, active: true, deviceString: 'NVIDIA GeForce RTX 4090' }] },
      { video_decode: 'disabled_software', gpu_compositing: 'enabled' },
      'high-performance',
    );
    expect(result.dedicatedActive).toBe(true);
    expect(result.hardwareDecode).toBe(false);
    expect(result.warning).toEqual(expect.any(String));
  });

  it.each([undefined, null, 42, 'unavailable', {}, { gpuDevice: null }, { gpuDevice: 'invalid' }])(
    'handles missing or malformed GPU information without inventing an adapter: %j',
    (info) => {
      const result = summarizeGraphics(info, {}, 'system');
      expect(result).toMatchObject({
        preference: 'system',
        adapters: [],
        activeAdapter: null,
        dedicatedAvailable: false,
        dedicatedActive: false,
        hardwareDecode: false,
      });
      expect(result.warning === null || typeof result.warning === 'string').toBe(true);
    },
  );

  it('handles malformed device rows without throwing or reporting a dedicated GPU', () => {
    const result = summarizeGraphics(
      { gpuDevice: [null, 7, 'invalid', { vendorId: 'broken', deviceId: Number.NaN, deviceString: null, active: 'yes' }] },
      {},
      'system',
    );
    expect(result.dedicatedAvailable).toBe(false);
    expect(result.dedicatedActive).toBe(false);
    expect(result.hardwareDecode).toBe(false);
    for (const adapter of result.adapters) {
      expect(typeof adapter.name).toBe('string');
      expect(Number.isFinite(adapter.vendorId)).toBe(true);
      expect(Number.isFinite(adapter.deviceId)).toBe(true);
      expect(typeof adapter.active).toBe('boolean');
    }
  });

  it('keeps unknown hardware classified as unknown rather than guessing that it is discrete', () => {
    const result = summarizeGraphics(
      { gpuDevice: [{ vendorId: 0x1234, deviceId: 0x5678, active: true, deviceString: 'Example Display Adapter' }] },
      accelerated,
      'system',
    );
    expect(result.adapters[0]).toMatchObject({ name: 'Example Display Adapter', kind: 'unknown', active: true });
    expect(result.activeAdapter).toBe('Example Display Adapter');
    expect(result.dedicatedAvailable).toBe(false);
    expect(result.dedicatedActive).toBe(false);
  });

  it('deduplicates repeated NVIDIA rows and preserves an active flag from any duplicate', () => {
    const result = summarizeGraphics(
      {
        gpuDevice: [
          { vendorId: 0x10de, deviceId: 0x2684, active: false, deviceString: 'NVIDIA GeForce RTX 4090' },
          { vendorId: 0x10de, deviceId: 0x2684, active: true, deviceString: 'NVIDIA GeForce RTX 4090' },
          { vendorId: 0x10de, deviceId: 0x2684, active: false, deviceString: 'NVIDIA GeForce RTX 4090' },
        ],
      },
      accelerated,
      'high-performance',
    );
    expect(result.adapters).toHaveLength(1);
    expect(result.adapters[0]).toMatchObject({ active: true, kind: 'dedicated' });
    expect(result.activeAdapter).toBe('NVIDIA GeForce RTX 4090');
    expect(result.dedicatedAvailable).toBe(true);
    expect(result.dedicatedActive).toBe(true);
    expect(result.warning).toBeNull();
  });
});
