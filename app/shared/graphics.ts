export type UiRenderingMode = 'stable' | 'accelerated';
export interface UiRenderingState { active: UiRenderingMode; preferred: UiRenderingMode; restartRequired: boolean }

export type GpuPreference = 'high-performance' | 'system';
export interface GraphicsAdapter {
  name: string;
  vendorId: number;
  deviceId: number;
  active: boolean;
  kind: 'dedicated' | 'integrated' | 'software' | 'unknown';
}
export interface GraphicsSummary {
  preference: GpuPreference;
  adapters: GraphicsAdapter[];
  activeAdapter: string | null;
  dedicatedAvailable: boolean;
  dedicatedActive: boolean;
  hardwareDecode: boolean;
  warning: string | null;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Names identify known families; an unknown adapter is never guessed to be discrete. */
function adapterKind(name: string): GraphicsAdapter['kind'] {
  if (/swiftshader|basic render|software|llvmpipe/i.test(name)) return 'software';
  if (/geforce|quadro|tesla|nvidia.*rtx|radeon.*(?:rx\s*\d|pro\s*w\d|wx\s*\d)|arc.*\b[ab]\d{3}\b/i.test(name)) return 'dedicated';
  if (/iris|uhd|intel.*hd|radeon.*(?:\(tm\)\s*graphics|\b\d{3,4}m\b)|intel.*arc.*(?:\d{3}[vt]|graphics)/i.test(name)) return 'integrated';
  return 'unknown';
}

export function summarizeGraphics(info: unknown, features: { video_decode?: string; gpu_compositing?: string }, preference: GpuPreference): GraphicsSummary {
  const rows = object(info).gpuDevice;
  const adapters: GraphicsAdapter[] = [];
  for (const item of Array.isArray(rows) ? rows : []) {
    const row = object(item);
    if (!Number.isFinite(row.vendorId) || !Number.isFinite(row.deviceId)) continue;
    const name = typeof row.deviceString === 'string' && row.deviceString.trim()
      ? row.deviceString.trim() : typeof row.vendorString === 'string' ? row.vendorString : 'Unknown graphics adapter';
    const vendorId = Number(row.vendorId), deviceId = Number(row.deviceId);
    const existing = adapters.find((a) => a.vendorId === vendorId && a.deviceId === deviceId && a.name === name);
    if (existing) { existing.active ||= row.active === true; continue; }
    adapters.push({ name, vendorId, deviceId, active: row.active === true, kind: adapterKind(name) });
  }
  const active = adapters.find((adapter) => adapter.active);
  const dedicatedAvailable = adapters.some((adapter) => adapter.kind === 'dedicated');
  const dedicatedActive = adapters.some((adapter) => adapter.active && adapter.kind === 'dedicated');
  const hardwareDecode = /^enabled(?:_|$)/.test(features.video_decode ?? '');
  const warning = preference === 'high-performance' && dedicatedAvailable && !dedicatedActive
    ? 'A dedicated GPU is available, but Chromium is using another adapter. Select High performance for AniVerse in your operating system graphics settings, then restart.'
    : !hardwareDecode ? 'Hardware video decoding is unavailable. Some formats may use software decoding; check your graphics driver and system settings.'
    : !active ? 'The active graphics adapter could not be confirmed.' : null;
  return { preference, adapters, activeAdapter: active?.name ?? null, dedicatedAvailable, dedicatedActive, hardwareDecode, warning };
}
