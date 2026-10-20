import {
  diffFingerprints, summarizeDrift,
  checkPersonaConsistency, mismatchesAsDrift,
} from "../fingerprint-baseline.js";
import { checkEnvironmentRisk, shouldBlockEnvironmentRisk, summarizeEnvFindings, type EnvRiskFinding } from "../environment-risk.js";
import type { Fingerprint, FingerprintDrift } from "../fingerprint-baseline.js";
import { analyzeFingerprintDrift, type FingerprintDriftAnalysis } from "../fingerprint-drift-policy.js";
import type { FingerprintComparisonReport } from "../fingerprint-drift-reports.js";
import { getHostBrowserPlatform } from "../browser-platform-policy.js";
import type { BrowserProfileMeta } from "../../types.js";

export interface LaunchDriftCheck {
  checked: boolean;
  risky?: boolean;
  drift?: FingerprintDrift[];
  observedAt?: number;
  partial?: boolean;
  review?: boolean;
  blockingUnavailable?: boolean;
  report?: FingerprintComparisonReport;
  error?: string;
}

export class LaunchBlockedError extends Error {
  readonly code: string;
  readonly driftBlocked: boolean;
  constructor(code: string, message: string, readonly driftCheck?: LaunchDriftCheck) {
    super(message);
    this.name = "LaunchBlockedError";
    this.code = code;
    this.driftBlocked = code === "fingerprint-drift" || code === "fingerprint-check-unavailable";
  }
}

/** Native GPU identity cannot make a foreign OS persona truthful. Storage stays portable. */
export function assertHostPlatformCompatible(
  meta: Pick<BrowserProfileMeta, "engine" | "fingerprintMode" | "platform">,
  host: string = process.platform,
): void {
  if (meta.engine === "firefox" || meta.fingerprintMode === "off") return;
  const hostPlatform = getHostBrowserPlatform(host);
  const requestedPlatform = meta.platform || "windows";
  if (hostPlatform !== null && requestedPlatform === hostPlatform) return;
  const remedy = hostPlatform
    ? `Use a ${hostPlatform} profile on this host, or run this portable profile on a matching host.`
    : "Run managed Chromium on a supported macOS or Windows host.";
  throw new LaunchBlockedError(
    "host-platform-mismatch",
    `Managed Chromium launch blocked: profile platform ${requestedPlatform} does not match the native GPU host ${hostPlatform || host}. ${remedy} Alternatively, explicitly select fingerprint-off or Firefox. The saved profile has not been changed; GPU compatibility is not verified by renaming GPU strings.`,
  );
}

export interface DriftGuardDeps {
  captureFingerprint: (port: number) => Promise<any>;
  audit: (detail: string) => void;
  auditBlock: (detail: string) => void;
  auditError?: (detail: string) => void;
  assertCurrent?: () => void;
  recordComparison?: (current: Fingerprint, analysis: FingerprintDriftAnalysis, observedAt: number) => FingerprintComparisonReport;
}

export async function runFingerprintDriftGuard(
  deps: DriftGuardDeps,
  opts: { cdpPort: number; meta: any; cfg: any; passThrough: boolean; expectedBrowserVersion?: string | null },
): Promise<LaunchDriftCheck> {
  let driftCheck: LaunchDriftCheck = { checked: false };
  if (opts.passThrough || !opts.meta.fingerprintBaseline) return driftCheck;
  try {
    deps.assertCurrent?.();
    const current = await deps.captureFingerprint(opts.cdpPort);
    deps.assertCurrent?.();
    const drift = diffFingerprints(opts.meta.fingerprintBaseline, current);
    const personaCheck = checkPersonaConsistency(
      { platform: opts.meta.platform || "windows", timezone: opts.meta.timezone },
      current,
    );
    const personaDrift = mismatchesAsDrift(personaCheck);
    const combinedDrift = [...drift, ...personaDrift];
    const observedAt = Date.now();
    const analysis = analyzeFingerprintDrift(opts.meta.fingerprintBaseline, current, combinedDrift, {
      expectedBrowserVersion: opts.expectedBrowserVersion, observedAt,
    });
    const { risky } = analysis;
    driftCheck = { checked: !analysis.blockingUnavailable, risky, drift: combinedDrift, observedAt,
      partial: analysis.partial, review: analysis.counts.review > 0, blockingUnavailable: analysis.blockingUnavailable,
      ...(analysis.blockingUnavailable ? { error: "Required fingerprint evidence is unavailable" } : {}) };
    if (deps.recordComparison) {
      try { driftCheck.report = deps.recordComparison(current, analysis, observedAt); }
      catch (error) { console.warn("[launch-guards] could not retain fingerprint comparison:", error); }
    }
    if (combinedDrift.length) {
      deps.audit(combinedDrift.length + " field(s) compared" + (risky ? " (risky)" : "") + ": " + summarizeDrift(combinedDrift));
    }
    if (risky && opts.cfg.blockOnFingerprintDrift !== false) {
      const riskFields = analysis.changes.filter(change => change.severity === "risk");
      const reason = "Fingerprint drift blocked (" + summarizeDrift(riskFields) + "). The baseline is unchanged. Open fingerprint details to review exact values. If an identity change was intended, explicitly accept the reviewed snapshot while stopped, then start and verify again; conflicts with profile settings must be fixed instead.";
      deps.auditBlock(reason);
      throw new LaunchBlockedError("fingerprint-drift", reason, driftCheck);
    }
    if (analysis.blockingUnavailable && opts.cfg.blockOnFingerprintDrift !== false) {
      throw new LaunchBlockedError("fingerprint-check-unavailable",
        "Fingerprint check unavailable: required probes could not verify the locked baseline. Review unavailable fields and retry; missing evidence is not observed identity drift.", driftCheck);
    }
  } catch (e: any) {
    if (e instanceof LaunchBlockedError) throw e;
    const msg = (e && e.message) || String(e);
    try { deps.auditError?.("fingerprint drift capture failed: " + msg); }
    catch (error) { console.warn("[launch-guards] failed to record fingerprint capture error:", error); }
    // eslint-disable-next-line no-console
    console.warn("[launch-guards] fingerprint drift check failed:", msg);
    driftCheck = { checked: false, error: msg };
    if (opts.cfg.blockOnFingerprintDrift !== false) {
      throw new LaunchBlockedError("fingerprint-check-unavailable",
        "Fingerprint check unavailable: the locked baseline could not be verified, so launch was refused. Retry the capture; this is not evidence of fingerprint drift.", driftCheck);
    }
  }
  return driftCheck;
}

export interface EnvGuardDeps {
  auditHigh: (detail: string) => void;
  auditError?: (detail: string) => void;
}

export function runEnvironmentRiskGuard(
  deps: EnvGuardDeps,
  opts: { meta: any; resolvedProxy: any; cfg: any; passThrough: boolean },
): { checked: boolean; high?: boolean; findings?: EnvRiskFinding[]; error?: string } {
  if (opts.passThrough) return { checked: false };
  try {
    const envResult = checkEnvironmentRisk(
      { timezone: opts.meta.timezone, locale: opts.meta.locale, platform: opts.meta.platform },
      { proxy: { mode: opts.resolvedProxy.mode, config: opts.resolvedProxy.config ? { type: opts.resolvedProxy.config.type } : null } },
    );
    const out = { checked: true, high: !envResult.ok, findings: envResult.findings } as any;
    if (!envResult.ok) {
      deps.auditHigh("high: " + summarizeEnvFindings(envResult.findings, "high") + (envResult.findings.some((f) => f.severity === "medium") ? "; medium: " + summarizeEnvFindings(envResult.findings, "medium") : ""));
    }
    if (shouldBlockEnvironmentRisk(envResult, opts.cfg.blockOnEnvironmentRisk)) {
      const reason = "Environment risk blocked (" + summarizeEnvFindings(envResult.findings, "high") + "). Fix the host environment or set blockOnEnvironmentRisk=false to launch.";
      throw new LaunchBlockedError("env-risk", reason);
    }
    return out;
  } catch (e: any) {
    if (e instanceof LaunchBlockedError) throw e;
    const msg = (e && e.message) || String(e);
    try { deps.auditError?.("environment risk check failed: " + msg); } catch {}
    // eslint-disable-next-line no-console
    console.warn("[launch-guards] environment risk check failed:", msg);
    return { checked: false, error: msg };
  }
}
