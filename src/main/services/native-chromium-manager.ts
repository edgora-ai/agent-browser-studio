import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { CHROMIUM_CACHE_DIR_NAME } from "../branding.js";
import { bundledChromiumBinaryPath, bundledChromiumBinaryPathAsync, readBundledBrowsersManifest, readBundledBrowsersManifestAsync } from "./bundled-native-browsers.js";
import { runBrowserCommand } from "./browser-command.js";

export interface ManagedChromiumBinary {
  version: string;
  binaryPath: string;
  installDir: string;
}

const EXACT_CHROMIUM_VERSION = /^\d+\.\d+\.\d+\.\d+$/;

export function getManagedChromiumRoot(): string {
  const override = process.env.AGENT_BROWSER_CHROMIUM_CACHE_DIR
    || process.env.CLOAKLITE_CHROMIUM_CACHE_DIR; // pre-rename compatibility
  return override ? path.resolve(override) : path.join(os.homedir(), CHROMIUM_CACHE_DIR_NAME);
}

export function normalizeManagedChromiumVersion(value: unknown): string | null {
  if (value === undefined || value === null || value === "" || value === "auto") return null;
  if (typeof value !== "string" || !EXACT_CHROMIUM_VERSION.test(value)) {
    throw new Error(`Invalid Chromium version: ${JSON.stringify(value)}`);
  }
  return value;
}

export function listManagedChromiumBinaries(
  root = getManagedChromiumRoot(),
  platform: NodeJS.Platform = process.platform,
): ManagedChromiumBinary[] {
  const candidates: ManagedChromiumBinary[] = [];

  const bundled = bundledChromiumBinaryPath(platform);
  if (bundled) {
    const manifest = readBundledBrowsersManifest(platform);
    candidates.push({
      version: detectBinaryVersion(bundled) || manifest?.chromiumVersion || "bundled",
      binaryPath: bundled,
      installDir: path.dirname(bundled),
    });
  }

  return localChromiumCandidates(root, platform, candidates);
}

function localChromiumCandidates(
  root: string,
  platform: NodeJS.Platform,
  candidates: ManagedChromiumBinary[],
): ManagedChromiumBinary[] {
  if (!fs.existsSync(root)) return candidates;

  try {
    for (const entry of fs.readdirSync(root)) {
      const candidate = localChromiumCandidate(root, entry, platform);
      if (!candidate) continue;
      try {
        if (fs.existsSync(candidate.binaryPath) && fs.statSync(candidate.binaryPath).isFile()) {
          candidates.push(candidate);
        }
      } catch {
        // Ignore one incomplete/broken install without hiding healthy builds.
      }
    }
  } catch {
    return candidates;
  }

  return candidates.sort((a, b) => compareChromiumVersions(b.version, a.version));
}

function localChromiumCandidate(root: string, entry: string, platform: NodeJS.Platform): ManagedChromiumBinary | null {
  const match = entry.match(/^chromium-(\d+(?:\.\d+){3})$/);
  if (!match) return null;
  const installDir = path.join(root, entry);
  const binaryPath = platform === "darwin"
    ? path.join(installDir, "Chromium.app", "Contents", "MacOS", "Chromium")
    : path.join(installDir, platform === "win32" ? "chrome.exe" : "chromium");
  return { version: match[1], binaryPath, installDir };
}

export async function listManagedChromiumBinariesAsync(
  root = getManagedChromiumRoot(),
  platform: NodeJS.Platform = process.platform,
): Promise<ManagedChromiumBinary[]> {
  const manifest = await readBundledBrowsersManifestAsync(platform);
  const candidates: ManagedChromiumBinary[] = [];
  const bundled = await bundledChromiumBinaryPathAsync(platform);
  if (bundled) {
    const output = await runBrowserCommand(bundled, ["--version"], { timeout: 5000 });
    const raw = (output?.stdout || output?.stderr || "").trim();
    candidates.push({
      version: raw.match(/Chromium\s*(\d+\.\d+\.\d+\.\d+)/i)?.[1] || manifest?.chromiumVersion || "bundled",
      binaryPath: bundled,
      installDir: path.dirname(bundled),
    });
  }
  let entries: string[];
  try { entries = await fs.promises.readdir(root); } catch { return candidates; }
  for (const entry of entries) {
    const candidate = localChromiumCandidate(root, entry, platform);
    if (!candidate) continue;
    try {
      if ((await fs.promises.stat(candidate.binaryPath)).isFile()) candidates.push(candidate);
    } catch {
      // One incomplete install must not hide the remaining healthy builds.
    }
  }
  return candidates.sort((a, b) => compareChromiumVersions(b.version, a.version));
}

export async function findManagedChromiumBinaryAsync(
  requestedVersion?: string | null,
  root = getManagedChromiumRoot(),
  platform: NodeJS.Platform = process.platform,
): Promise<ManagedChromiumBinary | null> {
  const version = normalizeManagedChromiumVersion(requestedVersion);
  const candidates = await listManagedChromiumBinariesAsync(root, platform);
  return version ? candidates.find(candidate => candidate.version === version) || null : candidates[0] || null;
}

function detectBinaryVersion(binaryPath: string): string | null {
  try {
    const result = spawnSync(binaryPath, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const raw = String(result.stdout || result.stderr || "").trim();
    const match = raw.match(/Chromium\s*(\d+\.\d+\.\d+\.\d+)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function findManagedChromiumBinary(
  requestedVersion?: string | null,
  root = getManagedChromiumRoot(),
  platform: NodeJS.Platform = process.platform,
): ManagedChromiumBinary | null {
  const version = normalizeManagedChromiumVersion(requestedVersion);
  const candidates = listManagedChromiumBinaries(root, platform);
  return version
    ? candidates.find((candidate) => candidate.version === version) || null
    : candidates[0] || null;
}

export function compareChromiumVersions(a: string, b: string): number {
  const va = a.split(".").map(Number);
  const vb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const ai = Number.isFinite(va[i]) ? va[i] : 0;
    const bi = Number.isFinite(vb[i]) ? vb[i] : 0;
    if (ai !== bi) return ai > bi ? 1 : -1;
  }
  return 0;
}
