import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CHROMIUM_CACHE_DIR_NAME } from "../branding.js";
import {
  readFirefoxNativeCapabilityReport,
  supportsFirefoxNativeConfig,
  type FirefoxNativeCapabilityReport,
} from "./firefox-native-capabilities.js";

export interface ManagedFirefoxBinary {
  version: string;
  binaryPath: string;
  installDir: string;
  capabilityReport: FirefoxNativeCapabilityReport;
}

const EXACT_FIREFOX_VERSION = /^\d+\.\d+(?:\.\d+)?$/;

export function getManagedFirefoxRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENT_BROWSER_FIREFOX_CACHE_DIR;
  return override ? path.resolve(override) : path.join(os.homedir(), CHROMIUM_CACHE_DIR_NAME);
}

export function normalizeManagedFirefoxVersion(value: unknown): string | null {
  if (value === undefined || value === null || value === "" || value === "auto") return null;
  if (typeof value !== "string" || !EXACT_FIREFOX_VERSION.test(value)) {
    throw new Error(`Invalid Firefox version: ${JSON.stringify(value)}`);
  }
  return value;
}

function binaryForInstall(
  installDir: string,
  platform: NodeJS.Platform,
): string {
  if (platform === "darwin") {
    return path.join(installDir, "Firefox.app", "Contents", "MacOS", "firefox");
  }
  if (platform === "win32") return path.join(installDir, "firefox.exe");
  return path.join(installDir, "firefox");
}

function detectBinaryVersion(binaryPath: string): string | null {
  try {
    const result = spawnSync(binaryPath, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.error || (typeof result.status === "number" && result.status !== 0)) return null;
    const raw = String(result.stdout || result.stderr || "").trim();
    return raw.match(/Mozilla Firefox\s*(\d+\.\d+(?:\.\d+)?)/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function listManagedFirefoxBinaries(
  root = getManagedFirefoxRoot(),
  platform: NodeJS.Platform = process.platform,
): ManagedFirefoxBinary[] {
  if (!fs.existsSync(root)) return [];
  const candidates: ManagedFirefoxBinary[] = [];
  try {
    for (const entry of fs.readdirSync(root)) {
      const match = entry.match(/^firefox-(\d+\.\d+(?:\.\d+)?)$/);
      if (!match) continue;
      const installDir = path.join(root, entry);
      const binaryPath = binaryForInstall(installDir, platform);
      try {
        if (!fs.statSync(binaryPath).isFile() || !supportsFirefoxNativeConfig(binaryPath, platform)) continue;
        const capabilityReport = readFirefoxNativeCapabilityReport(binaryPath, platform);
        const version = detectBinaryVersion(binaryPath);
        if (!capabilityReport || !version || version !== match[1] || capabilityReport.browserVersion !== version) continue;
        candidates.push({ version, binaryPath, installDir, capabilityReport });
      } catch {
        // Ignore one incomplete or tampered install without hiding healthy builds.
      }
    }
  } catch {
    return [];
  }
  return candidates.sort((a, b) => compareFirefoxVersions(b.version, a.version));
}

export function findManagedFirefoxBinary(
  requestedVersion?: string | null,
  root = getManagedFirefoxRoot(),
  platform: NodeJS.Platform = process.platform,
): ManagedFirefoxBinary | null {
  const version = normalizeManagedFirefoxVersion(requestedVersion);
  const candidates = listManagedFirefoxBinaries(root, platform);
  return version
    ? candidates.find((candidate) => candidate.version === version) ?? null
    : candidates[0] ?? null;
}

export function compareFirefoxVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const leftPart = Number.isFinite(left[index]) ? left[index] : 0;
    const rightPart = Number.isFinite(right[index]) ? right[index] : 0;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}
