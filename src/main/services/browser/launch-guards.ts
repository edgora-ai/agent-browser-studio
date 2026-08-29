import {
  diffFingerprints, hasRiskyDrift, summarizeDrift,
  checkPersonaConsistency, mismatchesAsDrift,
} from "../fingerprint-baseline.js";
import { checkEnvironmentRisk, shouldBlockEnvironmentRisk, summarizeEnvFindings, type EnvRiskFinding } from "../environment-risk.js";
import type { FingerprintDrift } from "../fingerprint-baseline.js";

export interface LaunchDriftCheck {
  checked: boolean;
  risky?: boolean;
  drift?: FingerprintDrift[];
  error?: string;
}

export class LaunchBlockedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LaunchBlockedError";
    this.code = code;
  }
}

export interface DriftGuardDeps {
  captureFingerprint: (port: number) => Promise<any>;
  audit: (detail: string) => void;
  auditBlock: (detail: string) => void;
  auditError?: (detail: string) => void;
}

export async function runFingerprintDriftGuard(
  deps: DriftGuardDeps,
  opts: { cdpPort: number; meta: any; cfg: any; passThrough: boolean },
): Promise<LaunchDriftCheck> {
  let driftCheck: LaunchDriftCheck = { checked: false };
  if (opts.passThrough || !opts.meta.fingerprintBaseline) return driftCheck;
  try {
    const current = await deps.captureFingerprint(opts.cdpPort);
    const drift = diffFingerprints(opts.meta.fingerprintBaseline, current);
    const personaCheck = checkPersonaConsistency(
      { platform: opts.meta.platform || "windows", timezone: opts.meta.timezone },
      current,
    );
    const personaDrift = mismatchesAsDrift(personaCheck);
    const combinedDrift = [...drift, ...personaDrift];
    const risky = hasRiskyDrift(drift) || personaDrift.length > 0;
    driftCheck = { checked: true, risky, drift: combinedDrift };
    if (drift.length || personaDrift.length) {
      deps.audit(combinedDrift.length + " field(s) changed" + (risky ? " (risky)" : "") + ": " + summarizeDrift(combinedDrift));
    }
    if (risky && opts.cfg.blockOnFingerprintDrift !== false) {
      const reason = "Fingerprint drift blocked (" + summarizeDrift(combinedDrift) + "). Re-capture the baseline or set blockOnFingerprintDrift=false to launch.";
      deps.auditBlock(reason);
      throw new LaunchBlockedError("fingerprint-drift", reason);
    }
  } catch (e: any) {
    if (e instanceof LaunchBlockedError) throw e;
    const msg = (e && e.message) || String(e);
    try { deps.auditError?.("fingerprint drift capture failed: " + msg); } catch {}
    // eslint-disable-next-line no-console
    console.warn("[launch-guards] fingerprint drift check failed:", msg);
    driftCheck = { checked: false, error: msg };
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
