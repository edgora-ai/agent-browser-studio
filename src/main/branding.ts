import * as path from "node:path";
import type { App } from "electron";

export const PRODUCT_NAME = "Agent Browser Studio";
export const PRODUCT_SLUG = "agent-browser-studio";
export const APP_ID = "com.ahoo.agent-browser-studio";
export const APP_DATA_DIR_NAME = "AgentBrowserStudio";
export const PROFILE_DIR_NAME = "profiles";
export const CHROMIUM_CACHE_DIR_NAME = ".agent-browser-studio";
export const PROFILE_ID_PREFIX = "ab_";
export const LEGACY_PROFILE_ID_PREFIX = "cb_";

export const LEGACY_PRODUCT_NAME = "CloakLite";
export const LEGACY_PROFILE_DIR_NAME = "cloak-profiles";
export const LEGACY_CHROMIUM_CACHE_DIR_NAME = ".roxy-lite-cloak";

export function isManagedProfileId(value: string): boolean {
  return value.startsWith(PROFILE_ID_PREFIX) || value.startsWith(LEGACY_PROFILE_ID_PREFIX);
}

export function hasExplicitUserDataDir(argv: readonly string[] = process.argv): boolean {
  return argv.some((arg) => arg === "--user-data-dir" || arg.startsWith("--user-data-dir="));
}

export function configureProductIdentity(electronApp: App, argv: readonly string[] = process.argv): {
  canonical: boolean;
  userDataDir: string;
} {
  if (electronApp.name !== PRODUCT_NAME) electronApp.setName(PRODUCT_NAME);
  if (!hasExplicitUserDataDir(argv)) {
    electronApp.setPath("userData", path.join(electronApp.getPath("appData"), APP_DATA_DIR_NAME));
  }
  return {
    canonical: !hasExplicitUserDataDir(argv),
    userDataDir: electronApp.getPath("userData"),
  };
}
