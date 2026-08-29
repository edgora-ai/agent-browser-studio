import { acquireRestoreLock } from "../profile-restore-lock.js";
import { validateDirId } from "../utils.js";
import { isManagedProfileId } from "../../branding.js";
import { getConfig } from "../config-manager.js";
import { runningProcesses } from "./runtime-table.js";
import { findBrowserByProfileSync } from "../process-discovery.js";
import { getProfilesDir } from "../config-manager.js";
import * as path from "node:path";
import { sanitizeBrowserEngine } from "../browser-engine.js";
import { CleanupStack } from "./cleanup-stack.js";

export interface LaunchPipelineDeps {
  launchFirefoxProfile: (dirId: string, meta: any, cfg: any, headless: boolean | undefined, releaseLock: (() => void) | null) => Promise<any>;
  launchChromiumProfile: (dirId: string, meta: any, cfg: any, headless: boolean | undefined, cleanup: CleanupStack) => Promise<any>;
}

export async function launchBrowserPipeline(
  dirId: string,
  opts: { headless?: boolean } | undefined,
  deps: LaunchPipelineDeps,
): Promise<any> {
  validateDirId(dirId);
  if (!isManagedProfileId(dirId)) throw new Error(`Profile ${dirId.slice(0, 8)} is not a managed profile`);
  let releaseLock: (() => void) | null = null;
  try { releaseLock = acquireRestoreLock(dirId); } catch { throw new Error(`Profile ${dirId.slice(0, 8)} is being restored; launch is temporarily blocked`); }
  const cleanup = new CleanupStack();
  if (releaseLock) cleanup.push(async () => { try { releaseLock?.(); } catch {} });

  const cfg = getConfig() as any;
  const meta = cfg.browserProfiles?.[dirId];
  if (!meta) throw new Error(`Managed profile not found: ${dirId}`);

  const existing = runningProcesses.get(dirId);
  if (existing) {
    try { process.kill(existing.pid, 0); return { pid: existing.pid, cdpPort: existing.port, driftCheck: { checked: false }, envCheck: { checked: false } }; }
    catch { runningProcesses.delete(dirId); }
  }
  const expectedDir = path.resolve(getProfilesDir(), dirId);
  try {
    const ps = findBrowserByProfileSync(dirId, expectedDir);
    if (ps) {
      runningProcesses.set(dirId, { pid: ps.pid, process: null, port: ps.cdpPort, lastActivityAt: Date.now() });
      return { pid: ps.pid, cdpPort: ps.cdpPort, driftCheck: { checked: false }, envCheck: { checked: false } };
    }
  } catch {}

  if (sanitizeBrowserEngine(meta.engine) === "firefox") {
    return deps.launchFirefoxProfile(dirId, meta, cfg, opts?.headless, releaseLock);
  }
  try {
    const r = await deps.launchChromiumProfile(dirId, meta, cfg, opts?.headless, cleanup);
    return r;
  } catch (e) {
    await cleanup.run();
    throw e;
  }
}
