import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const FIREFOX_CAPABILITIES_SWITCH = "--agent-browser-capabilities";
export const FIREFOX_NATIVE_REQUIRED_SWITCH = "--agent-browser-native-required";
export const FIREFOX_NATIVE_CONFIG_PREF = "agent.browser.fingerprint.config";
export const FIREFOX_NATIVE_MODE_ENV = "AGENT_BROWSER_FIREFOX_NATIVE";
export const FIREFOX_CAPABILITY_PRODUCT = "agent-browser-firefox";
export const FIREFOX_CAPABILITY_SCHEMA_VERSION = 1;
export const FIREFOX_EXPECTED_SOURCE_STAMP = "9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc";

export const FIREFOX_NATIVE_CONFIG_CAPABILITIES = Object.freeze([
  "config-v1",
  "native-required-v1",
  "snapshot-v1",
] as const);

export const FIREFOX_NATIVE_PARITY_CAPABILITIES = Object.freeze([
  ...FIREFOX_NATIVE_CONFIG_CAPABILITIES,
  "navigator-v1",
  "screen-v1",
  "canvas-v1",
  "webgl-v1",
  "webgpu-v1",
  "audio-v1",
  "fonts-v1",
  "geolocation-v1",
  "media-devices-v1",
  "speech-voices-v1",
  "storage-quota-v1",
] as const);

export interface FirefoxNativeCapabilityReport {
  product: typeof FIREFOX_CAPABILITY_PRODUCT;
  capabilitySchemaVersion: typeof FIREFOX_CAPABILITY_SCHEMA_VERSION;
  browserVersion: string;
  buildId: string;
  sourceStamp: string;
  capabilities: readonly string[];
}

interface CapabilityCacheEntry {
  binaryMtimeMs: number;
  binaryCtimeMs: number;
  binarySize: number;
  markerMtimeMs: number;
  markerCtimeMs: number;
  markerSize: number;
  report: FirefoxNativeCapabilityReport | null;
}

const REPORT_MARKER = Buffer.from(`\"product\":\"${FIREFOX_CAPABILITY_PRODUCT}\"`, "utf8");
const capabilityCache = new Map<string, CapabilityCacheEntry>();

function capabilityMarkerPath(binaryPath: string, platform = process.platform): string {
  const binaryDirectory = path.dirname(binaryPath);
  if (platform === "darwin") return path.join(binaryDirectory, "XUL");
  if (platform === "win32") return path.join(binaryDirectory, "xul.dll");
  return path.join(binaryDirectory, "libxul.so");
}

function fileContainsMarker(filePath: string, marker: Buffer): boolean {
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024 + marker.length - 1);
  let carry = 0;
  let position = 0;
  try {
    for (;;) {
      const read = fs.readSync(descriptor, buffer, carry, 64 * 1024, position);
      if (read === 0) return false;
      const length = carry + read;
      if (buffer.subarray(0, length).includes(marker)) return true;
      carry = Math.min(marker.length - 1, length);
      if (carry > 0) buffer.copyWithin(0, length - carry, length);
      position += read;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function validCapabilityReport(value: unknown): FirefoxNativeCapabilityReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.product !== FIREFOX_CAPABILITY_PRODUCT ||
      candidate.capabilitySchemaVersion !== FIREFOX_CAPABILITY_SCHEMA_VERSION ||
      typeof candidate.browserVersion !== "string" ||
      !/^154\.0(?:\.\d+)?$/.test(candidate.browserVersion) ||
      typeof candidate.buildId !== "string" ||
      !/^\d{14}$/.test(candidate.buildId) ||
      candidate.sourceStamp !== FIREFOX_EXPECTED_SOURCE_STAMP ||
      !Array.isArray(candidate.capabilities)) {
    return null;
  }
  const capabilities = candidate.capabilities;
  if (capabilities.some((capability) =>
    typeof capability !== "string" || !/^[a-z0-9][a-z0-9-]*-v\d+$/.test(capability)
  )) {
    return null;
  }
  const uniqueCapabilities = [...new Set(capabilities as string[])];
  if (uniqueCapabilities.length !== capabilities.length) return null;
  return Object.freeze({
    product: FIREFOX_CAPABILITY_PRODUCT,
    capabilitySchemaVersion: FIREFOX_CAPABILITY_SCHEMA_VERSION,
    browserVersion: candidate.browserVersion,
    buildId: candidate.buildId,
    sourceStamp: candidate.sourceStamp,
    capabilities: Object.freeze(uniqueCapabilities),
  });
}

export function readFirefoxNativeCapabilityReport(
  binaryPath: string,
  platform = process.platform,
): FirefoxNativeCapabilityReport | null {
  const resolved = path.resolve(binaryPath);
  const markerPath = capabilityMarkerPath(resolved, platform);
  let binaryStat: fs.Stats;
  let markerStat: fs.Stats;
  try {
    binaryStat = fs.statSync(resolved);
    markerStat = fs.statSync(markerPath);
    if (!binaryStat.isFile() || !markerStat.isFile()) return null;
  } catch {
    return null;
  }

  const cacheKey = `${platform}:${resolved}`;
  const cached = capabilityCache.get(cacheKey);
  if (cached &&
      cached.binaryMtimeMs === binaryStat.mtimeMs &&
      cached.binaryCtimeMs === binaryStat.ctimeMs &&
      cached.binarySize === binaryStat.size &&
      cached.markerMtimeMs === markerStat.mtimeMs &&
      cached.markerCtimeMs === markerStat.ctimeMs &&
      cached.markerSize === markerStat.size) {
    return cached.report;
  }

  let report: FirefoxNativeCapabilityReport | null = null;
  try {
    if (fileContainsMarker(markerPath, REPORT_MARKER)) {
      const output = execFileSync(resolved, [FIREFOX_CAPABILITIES_SWITCH], {
        encoding: "utf8",
        timeout: 3_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      report = validCapabilityReport(JSON.parse(output));
    }
  } catch {
    report = null;
  }

  if (!capabilityCache.has(cacheKey) && capabilityCache.size >= 64) {
    const oldest = capabilityCache.keys().next().value;
    if (oldest !== undefined) capabilityCache.delete(oldest);
  }
  capabilityCache.set(cacheKey, {
    binaryMtimeMs: binaryStat.mtimeMs,
    binaryCtimeMs: binaryStat.ctimeMs,
    binarySize: binaryStat.size,
    markerMtimeMs: markerStat.mtimeMs,
    markerCtimeMs: markerStat.ctimeMs,
    markerSize: markerStat.size,
    report,
  });
  return report;
}

interface AsyncCapabilityResult {
  report: FirefoxNativeCapabilityReport | null;
  definitive: boolean;
}
interface AsyncCapabilityProbe {
  identity: string;
  response: Promise<AsyncCapabilityResult>;
}
const asyncCapabilityCache = new Map<string, AsyncCapabilityProbe>();
const CAPABILITY_PROBE_TIMEOUT = 3_000;

function fileStatIdentity(info: fs.Stats): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
}

/** Status also tracks an absent marker so a newly installed XUL invalidates it. */
export async function getFirefoxNativeSelectionIdentityAsync(
  binaryPath: string,
  platform = process.platform,
): Promise<string | null> {
  const resolved = path.resolve(binaryPath);
  try {
    const binary = await fs.promises.stat(resolved);
    if (!binary.isFile()) return null;
    let marker: fs.Stats | null;
    try {
      marker = await fs.promises.stat(capabilityMarkerPath(resolved, platform));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      marker = null;
    }
    return `${fileStatIdentity(binary)}:${marker ? fileStatIdentity(marker) : "missing"}`;
  } catch {
    return null;
  }
}

async function capabilityIdentity(binaryPath: string, markerPath: string): Promise<{
  identity: string;
  markerSize: number;
} | null> {
  try {
    const [binary, marker] = await Promise.all([
      fs.promises.stat(binaryPath), fs.promises.stat(markerPath),
    ]);
    if (!binary.isFile() || !marker.isFile()) return null;
    return {
      identity: `${fileStatIdentity(binary)}:${fileStatIdentity(marker)}`,
      markerSize: marker.size,
    };
  } catch {
    return null;
  }
}

async function fileContainsMarkerAsync(filePath: string, marker: Buffer, size: number): Promise<boolean | null> {
  const deadline = Date.now() + CAPABILITY_PROBE_TIMEOUT;
  const file = await fs.promises.open(filePath, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024 + marker.length - 1);
  let carry = 0;
  let position = 0;
  try {
    // Fixed memory, a snapshot size limit (even if XUL grows), and a deadline.
    // Each disk read yields instead of scanning the whole XUL on the main thread.
    while (position < size) {
      // A deadline is inconclusive, unlike a completed scan proving absence.
      if (Date.now() >= deadline) return null;
      const { bytesRead } = await file.read(buffer, carry, Math.min(64 * 1024, size - position), position);
      if (bytesRead === 0) return false;
      const length = carry + bytesRead;
      if (buffer.subarray(0, length).includes(marker)) return true;
      carry = Math.min(marker.length - 1, length);
      if (carry > 0) buffer.copyWithin(0, length - carry, length);
      position += bytesRead;
    }
    return false;
  } finally {
    await file.close();
  }
}

function probeCapabilityReportAsync(binaryPath: string): Promise<FirefoxNativeCapabilityReport | null> {
  return new Promise((resolve) => {
    try {
      // This probe cannot use the binary-only command cache: capability code
      // lives in XUL, so replacing XUL must execute a fresh attestation command.
      execFile(binaryPath, [FIREFOX_CAPABILITIES_SWITCH], {
        encoding: "utf8",
        timeout: CAPABILITY_PROBE_TIMEOUT,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }, (error, stdout) => {
        if (error) return resolve(null);
        try {
          resolve(validCapabilityReport(JSON.parse(stdout.trim())));
        } catch {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

export async function readFirefoxNativeCapabilityReportAsync(
  binaryPath: string,
  platform = process.platform,
): Promise<FirefoxNativeCapabilityReport | null> {
  const resolved = path.resolve(binaryPath);
  const markerPath = capabilityMarkerPath(resolved, platform);
  const cacheKey = `${platform}:${resolved}`;
  const current = await capabilityIdentity(resolved, markerPath);
  if (!current) {
    asyncCapabilityCache.delete(cacheKey);
    return null;
  }
  let probe = asyncCapabilityCache.get(cacheKey);
  if (!probe || probe.identity !== current.identity) {
    const response = (async (): Promise<AsyncCapabilityResult> => {
      try {
        const marker = await fileContainsMarkerAsync(markerPath, REPORT_MARKER, current.markerSize);
        if (marker === null) return { report: null, definitive: false };
        if (!marker) return { report: null, definitive: true };
        const report = await probeCapabilityReportAsync(resolved);
        return { report, definitive: report !== null };
      } catch {
        // One missing, unreadable, or changing binary must not hide other builds.
        return { report: null, definitive: false };
      }
    })();
    probe = { identity: current.identity, response };
    if (!asyncCapabilityCache.has(cacheKey) && asyncCapabilityCache.size >= 64) {
      const oldest = asyncCapabilityCache.keys().next().value;
      if (oldest !== undefined) asyncCapabilityCache.delete(oldest);
    }
    asyncCapabilityCache.set(cacheKey, probe);
  }
  const result = await probe.response;
  const after = await capabilityIdentity(resolved, markerPath);
  if (!result.definitive || after?.identity !== current.identity) {
    if (asyncCapabilityCache.get(cacheKey) === probe) asyncCapabilityCache.delete(cacheKey);
    return null;
  }
  // Both attested reports and definitive marker absence are identity-bound;
  // timeouts, I/O errors, invalid reports, and process failures always retry.
  return result.report;
}

export function readFirefoxNativeCapabilities(
  binaryPath: string,
  platform = process.platform,
): ReadonlySet<string> {
  return new Set(readFirefoxNativeCapabilityReport(binaryPath, platform)?.capabilities ?? []);
}

function includesEvery(capabilities: ReadonlySet<string>, required: readonly string[]): boolean {
  return required.every((capability) => capabilities.has(capability));
}

export function supportsFirefoxNativeConfig(
  binaryPath: string,
  platform = process.platform,
): boolean {
  return includesEvery(
    readFirefoxNativeCapabilities(binaryPath, platform),
    FIREFOX_NATIVE_CONFIG_CAPABILITIES,
  );
}

export function supportsFirefoxNativeParity(
  binaryPath: string,
  platform = process.platform,
): boolean {
  return includesEvery(
    readFirefoxNativeCapabilities(binaryPath, platform),
    FIREFOX_NATIVE_PARITY_CAPABILITIES,
  );
}

export function firefoxNativeModeRequested(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[FIREFOX_NATIVE_MODE_ENV] === "1";
}
