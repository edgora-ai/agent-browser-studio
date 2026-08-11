import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ManagedChromiumBinary {
  version: string;
  binaryPath: string;
  installDir: string;
}

const EXACT_CHROMIUM_VERSION = /^\d+\.\d+\.\d+\.\d+$/;

export function getManagedChromiumRoot(): string {
  const override = process.env.CLOAKLITE_CHROMIUM_CACHE_DIR;
  return override ? path.resolve(override) : path.join(os.homedir(), ".roxy-lite-cloak");
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
  if (!fs.existsSync(root)) return [];

  const candidates: ManagedChromiumBinary[] = [];
  try {
    for (const entry of fs.readdirSync(root)) {
      const match = entry.match(/^chromium-(\d+(?:\.\d+){3})$/);
      if (!match) continue;
      const installDir = path.join(root, entry);
      const binaryPath = platform === "darwin"
        ? path.join(installDir, "Chromium.app", "Contents", "MacOS", "Chromium")
        : platform === "win32"
          ? path.join(installDir, "chrome.exe")
          : path.join(installDir, "chromium");
      try {
        if (fs.existsSync(binaryPath) && fs.statSync(binaryPath).isFile()) {
          candidates.push({ version: match[1], binaryPath, installDir });
        }
      } catch {
        // Ignore one incomplete/broken install without hiding healthy builds.
      }
    }
  } catch {
    return [];
  }

  return candidates.sort((a, b) => compareChromiumVersions(b.version, a.version));
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
