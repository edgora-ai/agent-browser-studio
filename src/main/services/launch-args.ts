import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { getConfig, getProfilesDir, saveConfig } from "./config-manager.js";
import { validateDirId } from "./utils.js";

export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  path: string;
  icon?: string;
  manifestHash?: string;
  crxUrl?: string;
}

const EXTENSION_ID_RE = /^[a-p]{32}$/;

/** Get the Extensions directory for a browser profile. */
export function getProfileExtensionsDir(dirId: string): string {
  const profileDir = resolveProfileDir(dirId);
  return path.join(profileDir, "Default", "Extensions");
}

/** Recursively find manifest.json inside an extension directory (up to 3 levels deep) */
function findManifestDir(rootDir: string, depth = 3): string | null {
  if (depth === 0) return null;
  if (fs.existsSync(path.join(rootDir, "manifest.json"))) return rootDir;
  try {
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const childDir = path.join(rootDir, entry.name);
      if (fs.existsSync(path.join(childDir, "manifest.json"))) return childDir;
      const deeper = findManifestDir(childDir, depth - 1);
      if (deeper) return deeper;
    }
  } catch { /* ignore */ }
  return null;
}

/** Resolve __MSG_<key>__ locale strings from _locales/<lang>/messages.json */
function resolveLocaleName(manifest: any, field: string): string | null {
  const raw = manifest[field];
  if (!raw || typeof raw !== "string" || !raw.startsWith("__MSG_")) return null;
  const locale = manifest.default_locale || "en";
  const manifestDir = manifest._manifestPath ? path.dirname(manifest._manifestPath) : null;
  if (!manifestDir) return null;

  const key = raw.substring(6, raw.length - 2).toLowerCase();
  const candidates = [
    locale,
    locale.replace("-", "_"),
    locale.split("-")[0],
    "en",
  ];

  for (const c of candidates) {
    const p = path.join(manifestDir, "_locales", c, "messages.json");
    if (fs.existsSync(p)) {
      try {
        const msgs = JSON.parse(fs.readFileSync(p, "utf-8"));
        const matched = Object.keys(msgs).find(k => k.toLowerCase() === key);
        if (matched && msgs[matched].message) return msgs[matched].message;
      } catch { /* skip */ }
    }
  }
  return null;
}

/** Load Chrome Extension icon */
function loadExtensionIcon(manifestDir: string, manifest: any): string | null {
  const icons = manifest.icons || {};
  const sizes = Object.keys(icons).map(Number).sort((a, b) => b - a);
  if (sizes.length === 0) return null;
  const iconFile = icons[sizes[0]];
  if (!iconFile) return null;
  const iconPath = path.resolve(manifestDir, iconFile);
  if (fs.existsSync(iconPath) && isPathInside(iconPath, manifestDir)) {
    try {
      const manifestReal = fs.realpathSync(manifestDir);
      const iconReal = fs.realpathSync(iconPath);
      const stat = fs.lstatSync(iconPath);
      if (stat.isSymbolicLink() || !stat.isFile() || !isPathInside(iconReal, manifestReal)) return null;
      const ext = path.extname(iconPath).substring(1);
      const data = fs.readFileSync(iconPath).toString("base64");
      return `data:image/${ext};base64,${data}`;
    } catch { return null; }
  }
  return null;
}

/** List all installed extensions for a profile */
export function listExtensions(dirId: string): ExtensionInfo[] {
  const extDir = getProfileExtensionsDir(dirId);
  if (!fs.existsSync(extDir)) return [];

  const result: ExtensionInfo[] = [];
  const cfg = getConfig() as any;
  const extensionState = cfg.browserProfiles?.[dirId]?.extensions || {};
  try {
    for (const entry of fs.readdirSync(extDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const extPath = path.join(extDir, entry.name);

      const manifestDir = findManifestDir(extPath) || path.join(extPath,
        fs.readdirSync(extPath, { withFileTypes: true })
          .filter(d => d.isDirectory())[0]?.name || ""
      );
      const manifestPath = path.join(manifestDir, "manifest.json");

      let name = entry.name, version = "?", description = "";
      let icon: string | null = null;
      let manifestHash: string | undefined;

      if (fs.existsSync(manifestPath)) {
        try {
          const manifestRaw = fs.readFileSync(manifestPath, "utf-8");
          manifestHash = crypto.createHash("sha512").update(manifestRaw).digest("hex");
          const manifest = JSON.parse(manifestRaw);
          manifest._manifestPath = manifestPath;
          if (manifest.name?.startsWith?.("__MSG_")) {
            const resolved = resolveLocaleName(manifest, "name");
            if (resolved) name = resolved;
          } else {
            name = manifest.name || name;
          }
          if (manifest.description?.startsWith?.("__MSG_")) {
            const resolved = resolveLocaleName(manifest, "description");
            if (resolved) description = resolved;
          } else {
            description = manifest.description || "";
          }
          version = manifest.version || version;
          icon = loadExtensionIcon(manifestDir, manifest);
        } catch { /* use defaults */ }
      }

      result.push({
        id: entry.name, name, version, description,
        enabled: extensionState[entry.name] !== false, path: manifestDir || extPath,
        icon: icon || undefined, manifestHash,
      });
    }
  } catch { /* empty */ }
  return result;
}

export function verifyExtensionSha(dirId: string, extId: string, expectedHash: string): boolean {
  const exts = listExtensions(dirId);
  const ext = exts.find(e => e.id === extId);
  if (!ext || !ext.manifestHash) return false;
  return ext.manifestHash === expectedHash;
}

export function computeCrxSha(crxPath: string): string {
  const raw = fs.readFileSync(crxPath);
  return crypto.createHash("sha512").update(raw).digest("hex");
}

export function deleteExtension(dirId: string, extId: string): boolean {
  validateExtensionId(extId);
  const extDir = resolveProfileFile(dirId, "Default", "Extensions", extId);
  try {
    if (fs.existsSync(extDir)) {
      fs.rmSync(extDir, { recursive: true, force: true });
      const cfg = getConfig() as any;
      const meta = cfg.browserProfiles?.[dirId];
      if (meta?.extensions) {
        delete meta.extensions[extId];
        try { const { transact } = require("./config/store.js"); transact((draft:any)=>{ const m=draft.browserProfiles?.[dirId]; if(m?.extensions) delete m.extensions[extId]; }); } catch { saveConfig(cfg); }
      }
      return true;
    }
  } catch { /* fail */ }
  return false;
}

export async function checkExtensionUpdate(dirId: string, extId: string): Promise<{
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  error?: string;
}> {
  const ext = listExtensions(dirId).find(e => e.id === extId);
  const currentVersion = ext?.version || "?";
  if (!ext) {
    return { currentVersion, latestVersion: null, hasUpdate: false, error: "Extension not installed" };
  }

  try {
    const latestVersion = await fetchLatestExtensionVersion(extId);
    if (!latestVersion) {
      return { currentVersion, latestVersion: null, hasUpdate: false, error: "Latest version unavailable" };
    }
    return { currentVersion, latestVersion, hasUpdate: compareVersions(latestVersion, currentVersion) > 0 };
  } catch (e: any) {
    return { currentVersion, latestVersion: null, hasUpdate: false, error: e.message || String(e) };
  }
}

function fetchLatestExtensionVersion(extId: string): Promise<string | null> {
  if (!/^[a-p]{32}$/.test(extId)) return Promise.resolve(null);
  const updateUrl = `https://clients2.google.com/service/update2/crx?response=updatecheck&prodversion=149.0&x=id%3D${extId}%26uc`;
  return new Promise((resolve, reject) => {
    import("node:https").then(https => {
      const req = https.get(updateUrl, { timeout: 10000 }, res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => {
          const m = body.match(/version=[\"']([^\"']+)[\"']/);
          resolve(m ? m[1] : null);
        });
      });
      req.on("timeout", () => {
        req.destroy(new Error("Extension update check timed out"));
      });
      req.on("error", reject);
    }).catch(reject);
  });
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(n => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map(n => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface BookmarkItem {
  name: string;
  url: string;
  children: BookmarkItem[];
}

export interface BookmarkRoot {
  roots: {
    bookmark_bar?: { children: BookmarkItem[] };
    other?: { children: BookmarkItem[] };
    synced?: { children: BookmarkItem[] };
  };
  version: number;
}

/** Read bookmarks for a profile */
export function readBookmarks(dirId: string): BookmarkRoot | null {
  const bmPath = resolveProfileFile(dirId, "Default", "Bookmarks");
  if (!fs.existsSync(bmPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(bmPath, "utf-8"));
  } catch { return null; }
}

/** Write bookmarks to a profile */
export function writeBookmarks(dirId: string, bookmarks: BookmarkRoot): boolean {
  const bmPath = resolveProfileFile(dirId, "Default", "Bookmarks");
  try {
    fs.writeFileSync(bmPath, JSON.stringify(bookmarks, null, 2), "utf-8");
    return true;
  } catch { return false; }
}

/** Add a single bookmark */
export function addBookmark(dirId: string, url: string, name: string): boolean {
  const bookmarks = readBookmarks(dirId);
  if (!bookmarks?.roots?.bookmark_bar?.children) return false;
  bookmarks.roots.bookmark_bar.children.push({ name, url, children: [], type: "url" } as any);
  return writeBookmarks(dirId, bookmarks);
}

/**
 * Read the Chrome Preferences JSON for a profile.
 */
export function readPreferences(dirId: string): any {
  const prefPath = resolveProfileFile(dirId, "Default", "Preferences");
  if (!fs.existsSync(prefPath)) return null;
  try { return JSON.parse(fs.readFileSync(prefPath, "utf-8")); }
  catch { return null; }
}

/**
 * Write Chrome Preferences for a profile.
 */
export function writePreferences(dirId: string, prefs: any): boolean {
  const prefPath = resolveProfileFile(dirId, "Default", "Preferences");
  try {
    fs.writeFileSync(prefPath, JSON.stringify(prefs, null, 2), "utf-8");
    return true;
  } catch { return false; }
}

/**
 * Apply common managed Chromium profile settings.
 */
export function applyProfileSettings(dirId: string, settings: {
  homepage?: string;
  startupUrls?: string[];
  allowPopups?: string[];
  blockPopups?: string[];
  downloadDir?: string;
  pdfDownload?: boolean;
}): boolean {
  const prefs = readPreferences(dirId) || {};

  if (settings.homepage) {
    prefs.session = prefs.session || {};
    prefs.session.restore_on_startup = 4;
    prefs.session.startup_urls = [settings.homepage];
  }

  if (settings.allowPopups) {
    prefs.profile = prefs.profile || {};
    prefs.profile.content_settings = prefs.profile.content_settings || {};
    prefs.profile.content_settings.exceptions = prefs.profile.content_settings.exceptions || {};
    prefs.profile.content_settings.exceptions.popups = {};
    for (const domain of settings.allowPopups) {
      prefs.profile.content_settings.exceptions.popups[`[*.]${domain},*`] = { setting: 1 };
    }
  }

  if (settings.downloadDir) {
    prefs.download = prefs.download || {};
    prefs.download.default_directory = settings.downloadDir;
    if (settings.pdfDownload) {
      prefs.plugins = prefs.plugins || {};
      prefs.plugins.always_open_pdf_externally = true;
    }
  }

  return writePreferences(dirId, prefs);
}

export function getBlockDomainPagePath(): string {
  return path.join(path.dirname(getProfilesDir()), "web-forward-cache", "blockDomain.html");
}

function resolveProfileDir(dirId: string): string {
  validateDirId(dirId);
  const baseDir = path.resolve(getProfilesDir());
  const profileDir = path.resolve(baseDir, dirId);
  if (!isPathInside(profileDir, baseDir)) {
    throw new Error(`Profile path escapes profiles directory: ${JSON.stringify(dirId)}`);
  }
  return profileDir;
}

function resolveProfileFile(dirId: string, ...segments: string[]): string {
  const profileDir = resolveProfileDir(dirId);
  const filePath = path.resolve(profileDir, ...segments);
  if (!isPathInside(filePath, profileDir)) {
    throw new Error(`Profile file path escapes profile: ${JSON.stringify(segments.join("/"))}`);
  }
  return filePath;
}

function validateExtensionId(extId: string): void {
  if (!EXTENSION_ID_RE.test(extId)) {
    throw new Error(`Invalid extension ID: ${JSON.stringify(extId)}`);
  }
}

function isPathInside(childPath: string, basePath: string): boolean {
  const relative = path.relative(basePath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
