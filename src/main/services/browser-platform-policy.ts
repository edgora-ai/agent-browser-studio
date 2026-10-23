import type { BrowserPlatform } from "../types.js";

/** Supported native Chromium host platform, not a portable profile default. */
export function getHostBrowserPlatform(host: string = process.platform): Exclude<BrowserPlatform, "android"> | null {
  if (host === "darwin") return "macos";
  if (host === "win32") return "windows";
  return null;
}
