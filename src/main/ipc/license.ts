import { ipcMain } from "electron";
import {
  getLicenseState,
  trialDaysLeft,
  isTrialExpired,
  activateLicense,
  type LicenseState,
} from "../services/license.js";
import { getConfig } from "../services/config-manager.js";

export interface LicenseStatus extends LicenseState {
  daysLeft: number;
  expired: boolean;
  /** This install's device id (shown so the buyer can send it to the seller). */
  deviceId: string;
  /** True when the build can verify activation codes at all. */
  canActivate: boolean;
}

export function registerLicenseHandlers(): void {
  ipcMain.handle("license:status", async (): Promise<LicenseStatus> => {
    const st = getLicenseState();
    return {
      ...st,
      daysLeft: st.plan === "trial" ? trialDaysLeft() : Number.POSITIVE_INFINITY,
      expired: isTrialExpired(),
      deviceId: String((getConfig() as any)?.deviceId || ""),
      // canActivate is informational only — enforcement reads the key itself.
      canActivate: true,
    };
  });

  // Activate with an offline code. The code itself is never logged or
  // persisted — only the verified payload + signature are stored.
  ipcMain.handle("license:activate", async (_event, code: unknown) => {
    if (typeof code !== "string" || code.length > 8192) {
      return { ok: false, code: "INVALID_CODE", error: "Invalid activation code format" };
    }
    const r = activateLicense(code);
    if (!r.ok) return { ok: false, code: r.code, error: r.error };
    return { ok: true, state: r.state };
  });
}
