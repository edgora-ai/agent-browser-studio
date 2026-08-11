import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const NATIVE_PROXY_AUTH_CAPABILITY = "agent-browser-proxy-auth-file-v1";
export const NATIVE_QUIC_PROXY_CAPABILITY = "agent-browser-quic-proxy-v1";
export const NATIVE_FINGERPRINT_CONFIG_CAPABILITY = "agent-browser-fingerprint-config-v1";
export const NATIVE_PROXY_AUTH_SWITCH = "--agent-browser-proxy-auth-file";
export const NATIVE_CAPABILITIES_SWITCH = "--agent-browser-capabilities";

export const LEGACY_NATIVE_PROXY_AUTH_CAPABILITY = "roxy-proxy-auth-file-v1";
export const LEGACY_NATIVE_QUIC_PROXY_CAPABILITY = "roxy-quic-proxy-v1";
export const LEGACY_NATIVE_PROXY_AUTH_SWITCH = "--roxy-proxy-auth-file";
export const LEGACY_NATIVE_CAPABILITIES_SWITCH = "--roxy-capabilities";

interface CapabilityCacheEntry {
  mtimeMs: number;
  size: number;
  capabilities: ReadonlySet<string>;
}

export interface NativeProxyAuthFile {
  filePath: string;
  cleanup: () => void;
}

const capabilityCache = new Map<string, CapabilityCacheEntry>();

export function supportsNativeProxyAuth(binaryPath: string): boolean {
  const capabilities = readNativeChromiumCapabilities(binaryPath);
  return capabilities.has(NATIVE_PROXY_AUTH_CAPABILITY) || capabilities.has(LEGACY_NATIVE_PROXY_AUTH_CAPABILITY);
}

export function supportsNativeQuicProxy(binaryPath: string): boolean {
  const capabilities = readNativeChromiumCapabilities(binaryPath);
  return capabilities.has(NATIVE_QUIC_PROXY_CAPABILITY) || capabilities.has(LEGACY_NATIVE_QUIC_PROXY_CAPABILITY);
}

export function supportsAgentBrowserFingerprintConfig(binaryPath: string): boolean {
  return readNativeChromiumCapabilities(binaryPath).has(NATIVE_FINGERPRINT_CONFIG_CAPABILITY);
}

export function nativeProxyAuthSwitch(binaryPath: string): string {
  return readNativeChromiumCapabilities(binaryPath).has(NATIVE_PROXY_AUTH_CAPABILITY)
    ? NATIVE_PROXY_AUTH_SWITCH
    : LEGACY_NATIVE_PROXY_AUTH_SWITCH;
}

export function readNativeChromiumCapabilities(binaryPath: string): ReadonlySet<string> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(binaryPath);
    if (!stat.isFile()) return new Set();
  } catch {
    return new Set();
  }

  const resolved = path.resolve(binaryPath);
  const cached = capabilityCache.get(resolved);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.capabilities;
  }

  let capabilities: ReadonlySet<string> = new Set();
  for (const capabilitySwitch of [NATIVE_CAPABILITIES_SWITCH, LEGACY_NATIVE_CAPABILITIES_SWITCH]) {
    try {
      const output = execFileSync(resolved, ["--version", capabilitySwitch], {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const advertised = output.split(/\s+/).filter((value) =>
        /^(?:agent-browser|roxy)-[a-z0-9-]+-v\d+$/.test(value),
      );
      if (advertised.length) {
        capabilities = new Set(advertised);
        break;
      }
    } catch {
      // Older builds do not understand the new query; try the legacy alias.
    }
  }
  capabilityCache.set(resolved, { mtimeMs: stat.mtimeMs, size: stat.size, capabilities });
  return capabilities;
}

export function writeNativeProxyAuthFile(
  credentials: { host: string; port: number; username: string; password: string },
  temporaryRoot = os.tmpdir(),
): NativeProxyAuthFile {
  const directory = fs.mkdtempSync(path.join(path.resolve(temporaryRoot), "agent-browser-native-proxy-auth-"));
  fs.chmodSync(directory, 0o700);
  const filePath = path.join(directory, "credentials.json");
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    host: credentials.host,
    port: credentials.port,
    username: credentials.username,
    password: credentials.password,
  }), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.chmodSync(filePath, 0o600);

  let cleaned = false;
  return {
    filePath,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // Best effort; the browser normally consumes and deletes the file.
      }
      try {
        fs.rmdirSync(directory);
      } catch {
        // Leave an unexpected non-empty directory intact for inspection.
      }
    },
  };
}
