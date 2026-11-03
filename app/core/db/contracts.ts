/** Platform-neutral persistence seams used by shared metadata and settings. */
export interface MetadataCache {
  cacheContext(): number;
  cacheGet<T>(key: string): T | null;
  cacheGetStale<T>(key: string): T | null;
  cacheSet(key: string, value: unknown, ttlSec: number, context: number): void;
  libraryIds(): number[];
}
export interface SettingsStore {
  getKv<T>(key: string, fallback: T): T;
  setKv(key: string, value: unknown): void;
}
export interface SyncPayload { mediaId: number; idMal: number | null; favourite?: boolean }
