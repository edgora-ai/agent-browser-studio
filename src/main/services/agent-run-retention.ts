// The recorder registers its existing process-local ownership map. Keeping the
// lookup here avoids a config-manager ↔ recorder import cycle and lets the
// save normalizer protect a run while finishRun is still committing its result.
let isOwned: (runId: string) => boolean = () => false;
let cleanupEvicted: ((runIds: string[]) => void) | null = null;

export function registerActiveRunLookup(lookup: (runId: string) => boolean): void {
  isOwned = lookup;
}

export function isOwnedRun(runId: string): boolean {
  return isOwned(runId);
}

/** Once the recorder is loaded it owns all result-store/SQLite cleanup, without
 * forcing config-manager (used by UI-only modules) to load the agent database. */
export function registerRunEvictionCleanup(cleanup: (runIds: string[]) => void): void {
  cleanupEvicted = cleanup;
}

/** Config saves report only IDs actually removed by normalization, after the
 * config commit succeeds. Both recorder trimming and non-recorder saves use the
 * same result-store/SQLite cleanup path. */
export function cleanupNormalizedRunEvictions(
  draftRuns: { id: string; status: string }[] | undefined,
  savedRuns: { id: string; status: string }[] | undefined,
): void {
  if (!Array.isArray(draftRuns)) return;
  const keptIds = new Set((savedRuns || []).map((run) => run.id));
  const evicted = [...new Set(draftRuns.filter((run) =>
    run && typeof run.id === "string" && !keptIds.has(run.id) && !isProtectedRun(run)
      && (run.status === "done" || run.status === "error"),
  ).map((run) => run.id))];
  if (evicted.length && cleanupEvicted) cleanupEvicted(evicted);
  else if (evicted.length) console.warn(`[runs] ${evicted.length} normalized runs lost without recorder cleanup; startup reconcile required`);
}

export function isProtectedRun(run: { id: string; status: string } | null | undefined): boolean {
  return !!run && (run.status === "running" || (typeof run.id === "string" && isOwned(run.id)));
}

/** Stable oldest-terminal-first eviction. Raw running rows must be selected
 * before load-time crash recovery turns them into interrupted errors. If more
 * than limit runs are protected, keep all of them until they finish. */
export function retainAgentRuns<T extends { id: string; status: string }>(runs: T[], limit: number): { kept: T[]; dropped: T[] } {
  let excess = Math.max(0, runs.length - limit);
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const run of runs) {
    if (excess > 0 && !isProtectedRun(run)) {
      dropped.push(run);
      excess--;
    } else {
      kept.push(run);
    }
  }
  return { kept, dropped };
}
