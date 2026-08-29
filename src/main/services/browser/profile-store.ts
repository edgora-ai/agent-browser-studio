import { getConfig } from "../config-manager.js";
import type { BrowserProfileMeta } from "../../types.js";

// Thin profile metadata facade to deduplicate BrowserProfileMeta normalization
// that was duplicated between browser-manager.ts and config-manager.ts.
// This module does not own persistence; it delegates to config-manager's
// getProfileMeta/setProfileMeta.

export function getProfileMetaFacade(dirId: string): BrowserProfileMeta | null {
  const { getProfileMeta } = require("../config-manager.js");
  return getProfileMeta(dirId);
}

export function setProfileMetaFacade(dirId: string, patch: Partial<BrowserProfileMeta>): BrowserProfileMeta {
  const { setProfileMeta } = require("../config-manager.js");
  return setProfileMeta(dirId, patch);
}

export function listProfileMetas(): Record<string, BrowserProfileMeta> {
  const cfg = getConfig() as any;
  return (cfg.browserProfiles || {}) as Record<string, BrowserProfileMeta>;
}
