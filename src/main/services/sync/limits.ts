export interface SyncLimits {
  maxPayloadBytes: number;
  maxProfileCount: number;
}
export const DEFAULT_SYNC_LIMITS: SyncLimits = { maxPayloadBytes: 150 * 1024 * 1024, maxProfileCount: 200 };
