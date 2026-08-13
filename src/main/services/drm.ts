// Widevine/DRM discovery for persistent profiles.
//
// Locates a Widevine Content Decryption Module (CDM) on the host (Chrome app
// bundles, browser user-data dirs, or an explicit override), stages a managed
// copy under <appData>/cdm/widevine/<version>/, and returns the launch flags
// Chromium needs to expose `navigator.requestMediaKeySystemAccess`. A running
// instance can be probed over CDP for real availability evidence.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getAppDataDir, getConfig, getDrmConfig, setProfileMeta } from "./config-manager.js";
import { cdpConnect, cdpDisconnect, cdpEvaluate } from "./local-agent.js";

export interface WidevineCdmInfo {
  /** Directory containing manifest.json + _platform_specific/. */
  path: string;
  /** Absolute path of the platform CDM library. */
  libraryPath: string;
  /** CDM version parsed from manifest.json. */
  version: string;
  /** How the CDM was located. */
  source: "configured" | "chrome" | "user-data" | "managed";
}

export interface DrmStatus {
  available: boolean;
  cdm: WidevineCdmInfo | null;
  configuredPath: string | null;
  detectedAt: number | null;
  profilesWithDrm: string[];
}

const CDM_LIB = process.platform === "win32" ? "widevinecdm.dll"
  : process.platform === "darwin" ? "libwidevinecdm.dylib"
  : "libwidevinecdm.so";

const PLATFORM_DIRS: Record<string, string[]> = {
  darwin: ["mac_arm64", "mac_x64", "universal", "mac"],
  win32: ["win_x64", "win_arm64", "win"],
  linux: ["linux_x64", "linux_arm64", "linux"],
};

function platformOf(p: NodeJS.Platform): string {
  return PLATFORM_DIRS[p] ? p : "linux";
}

/** Parse the CDM version out of a WidevineCdm manifest.json. */
export function readCdmManifestVersion(cdmDir: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cdmDir, "manifest.json"), "utf8"));
    if (raw && typeof raw.version === "string" && /^\d+\.\d+\.\d+\.\d+/.test(raw.version)) return raw.version;
  } catch { /* ignore */ }
  return null;
}

/** Locate the platform CDM library inside a WidevineCdm directory. */
export function findCdmLibrary(cdmDir: string, platform: NodeJS.Platform = process.platform): string | null {
  const root = path.join(cdmDir, "_platform_specific");
  if (fs.existsSync(root)) {
    for (const sub of PLATFORM_DIRS[platformOf(platform)] || []) {
      const lib = path.join(root, sub, CDM_LIB);
      if (fs.existsSync(lib)) return lib;
    }
  }
  // Fallback: shallow recursive search for the CDM library.
  let found: string | null = null;
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || found) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === CDM_LIB) { found = path.join(dir, e.name); return; }
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(cdmDir, 0);
  return found;
}

/** Validate that a directory is a usable Widevine CDM for this platform. */
export function validateCdmDir(cdmDir: string, platform: NodeJS.Platform = process.platform): WidevineCdmInfo | null {
  if (!fs.existsSync(path.join(cdmDir, "manifest.json"))) return null;
  const version = readCdmManifestVersion(cdmDir);
  if (!version) return null;
  const libraryPath = findCdmLibrary(cdmDir, platform);
  if (!libraryPath) return null;
  return { path: cdmDir, libraryPath, version, source: "user-data" };
}

export interface FindCdmOptions {
  cdmPath?: string | null;
  platform?: NodeJS.Platform;
  homeDir?: string;
  appDataDir?: string;
}

/** Candidate Widevine CDM dirs inside installed Chromium-family app bundles. */
export function chromeCdmCandidates(platform: NodeJS.Platform = process.platform): Array<{ path: string; source: WidevineCdmInfo["source"] }> {
  const out: Array<{ path: string; source: WidevineCdmInfo["source"] }> = [];
  if (platform === "darwin") {
    const base = "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions";
    try {
      for (const v of fs.readdirSync(base).sort().reverse()) {
        out.push({ path: path.join(base, v, "Libraries", "WidevineCdm"), source: "chrome" });
      }
    } catch { /* not installed */ }
    for (const name of ["Brave Browser.app", "Microsoft Edge.app", "Chromium.app"]) {
      const app = path.join("/Applications", name);
      try {
        const frameworks = path.join(app, "Contents", "Frameworks");
        for (const fw of fs.readdirSync(frameworks)) {
          const base2 = path.join(frameworks, fw, "Versions");
          if (!fs.existsSync(base2)) continue;
          for (const v of fs.readdirSync(base2).sort().reverse()) {
            out.push({ path: path.join(base2, v, "Libraries", "WidevineCdm"), source: "chrome" });
          }
        }
      } catch { /* not installed */ }
    }
  }
  if (platform === "win32") {
    const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env["LOCALAPPDATA"]];
    for (const root of roots) {
      if (!root) continue;
      for (const sub of [path.join(root, "Google", "Chrome", "Application"), path.join(root, "Google", "Chrome", "Application")]) {
        try {
          for (const v of fs.readdirSync(sub).sort().reverse()) {
            if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) out.push({ path: path.join(sub, v, "WidevineCdm"), source: "chrome" });
          }
        } catch { /* ignore */ }
      }
    }
  }
  if (platform === "linux") {
    for (const p of ["/opt/google/chrome/WidevineCdm", "/usr/lib/chromium/WidevineCdm", "/usr/lib/chromium-browser/WidevineCdm"]) {
      out.push({ path: p, source: "chrome" });
    }
  }
  return out;
}

/** Candidate Widevine CDM dirs in browser user-data dirs (Chrome/Chromium/Edge/Brave). */
export function userDataCdmCandidates(platform: NodeJS.Platform = process.platform, homeDir = os.homedir()): string[] {
  const out: string[] = [];
  if (platform === "darwin") {
    const base = path.join(homeDir, "Library", "Application Support");
    for (const name of ["Google/Chrome", "Chromium", "Microsoft Edge", "BraveSoftware/Brave-Browser", "Google/Chrome for Testing"]) {
      out.push(path.join(base, name, "WidevineCdm"));
    }
  }
  if (platform === "win32") {
    const local = process.env["LOCALAPPDATA"] || path.join(homeDir, "AppData", "Local");
    for (const name of ["Google/Chrome", "Chromium", "Microsoft/Edge", "BraveSoftware/Brave-Browser"]) {
      out.push(path.join(local, name, "User Data", "WidevineCdm"));
    }
  }
  if (platform === "linux") {
    const config = path.join(homeDir, ".config");
    for (const name of ["google-chrome", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser"]) {
      out.push(path.join(config, name, "WidevineCdm"));
    }
  }
  return out;
}

export function managedCdmRoot(appDataDir?: string): string {
  return path.join(appDataDir || getAppDataDir(), "cdm", "widevine");
}

/** Candidate managed CDM dirs we staged previously. */
export function managedCdmCandidates(appDataDir?: string): string[] {
  const root = managedCdmRoot(appDataDir);
  try {
    return fs.readdirSync(root).map((v) => path.join(root, v));
  } catch { return []; }
}

/** Locate a usable Widevine CDM, in priority order: configured, Chrome apps, user-data, managed. */
export function findWidevineCdm(opts?: FindCdmOptions): WidevineCdmInfo | null {
  const platform = opts?.platform || process.platform;
  const homeDir = opts?.homeDir || os.homedir();
  const appDataDir = opts?.appDataDir || getAppDataDir();
  const configured = opts && "cdmPath" in opts ? opts.cdmPath : getDrmConfig().cdmPath;
  const candidates: Array<{ path: string; source: WidevineCdmInfo["source"] }> = [];
  if (configured) candidates.push({ path: configured, source: "configured" });
  candidates.push(...chromeCdmCandidates(platform));
  for (const c of userDataCdmCandidates(platform, homeDir)) candidates.push({ path: c, source: "user-data" });
  for (const c of managedCdmCandidates(appDataDir)) candidates.push({ path: c, source: "managed" });
  const seen = new Set<string>();
  for (const cand of candidates) {
    const resolved = path.resolve(cand.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const info = validateCdmDir(resolved, platform);
    if (info) { info.source = cand.source; return info; }
  }
  return null;
}

/** Stage (or reuse) a managed copy of the CDM under <appData>/cdm/widevine/<version>/. */
export function ensureManagedCdm(opts?: FindCdmOptions): WidevineCdmInfo | null {
  const found = findWidevineCdm(opts);
  if (!found) return null;
  const platform = opts?.platform || process.platform;
  const dest = path.join(managedCdmRoot(opts?.appDataDir), found.version);
  if (fs.existsSync(path.join(dest, "manifest.json"))) {
    const lib = findCdmLibrary(dest, platform);
    if (lib) return { path: dest, libraryPath: lib, version: found.version, source: "managed" };
  }
  try {
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(found.path, dest, { recursive: true, force: true });
    const lib = findCdmLibrary(dest, platform) || found.libraryPath;
    return { path: dest, libraryPath: lib, version: found.version, source: "managed" };
  } catch (e: any) {
    // Fall back to the source CDM directly when staging fails.
    return found;
  }
}

export function getDrmStatus(opts?: FindCdmOptions): DrmStatus {
  const cfg = getConfig();
  const drmCfg = getDrmConfig();
  const cdm = findWidevineCdm(opts);
  return {
    available: !!cdm,
    cdm,
    configuredPath: drmCfg.cdmPath || null,
    detectedAt: drmCfg.detectedAt || null,
    profilesWithDrm: Object.entries(cfg.browserProfiles || {}).filter(([, m]) => !!m?.drm).map(([id]) => id),
  };
}

export function setProfileDrm(dirId: string, enabled: boolean): void {
  setProfileMeta(dirId, { drm: !!enabled });
}

/** Widevine launch flags for a DRM-enabled profile (empty when unavailable). */
export function drmLaunchArgs(dirId: string): string[] {
  const cfg = getConfig();
  const meta = cfg.browserProfiles?.[dirId];
  if (!meta?.drm) return [];
  const cdm = ensureManagedCdm();
  if (!cdm) return [];
  return [`--widevine-cdm-path=${cdm.path}`, `--widevine-cdm-version=${cdm.version}`];
}

/** Probe a running profile over CDP for real Widevine availability. */
export async function probeDrmViaCdp(cdpPort: number): Promise<{ available: boolean; keySystems: string[]; error?: string }> {
  const client = await cdpConnect(cdpPort);
  try {
    const expression = `(async () => {
      const cfg = [{ initDataTypes: ["cenc"], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }];
      try {
        await navigator.requestMediaKeySystemAccess("com.widevine.alpha", cfg);
        return { available: true, keySystems: ["com.widevine.alpha"] };
      } catch (e) {
        return { available: false, keySystems: [] };
      }
    })()`;
    const result = await cdpEvaluate(client, expression);
    return { available: !!result?.available, keySystems: result?.keySystems || [] };
  } catch (e: any) {
    return { available: false, keySystems: [], error: e?.message || String(e) };
  } finally {
    cdpDisconnect(client);
  }
}
