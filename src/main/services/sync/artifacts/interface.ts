export interface SyncOperationContext { signal?: AbortSignal; now: number; limits: { maxPayloadBytes: number } }
export interface ArtifactHandler {
  name: string;
  push(ctx: SyncOperationContext): Promise<{ bytes: number } | null>;
  pull(ctx: SyncOperationContext, payload: any): Promise<{ imported: boolean }>;
}
