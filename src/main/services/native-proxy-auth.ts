import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const NATIVE_PROXY_AUTH_CAPABILITY = "roxy-proxy-auth-file-v1";
export const NATIVE_QUIC_PROXY_CAPABILITY = "roxy-quic-proxy-v1";
export const NATIVE_PROXY_AUTH_SWITCH = "--roxy-proxy-auth-file";

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
  return readNativeChromiumCapabilities(binaryPath).has(NATIVE_PROXY_AUTH_CAPABILITY);
}

export function supportsNativeQuicProxy(binaryPath: string): boolean {
  return readNativeChromiumCapabilities(binaryPath).has(NATIVE_QUIC_PROXY_CAPABILITY);
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
  try {
    const output = execFileSync(resolved, ["--version", "--roxy-capabilities"], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    capabilities = new Set(output.split(/\s+/).filter((value) => /^roxy-[a-z0-9-]+-v\d+$/.test(value)));
  } catch {
    capabilities = new Set();
  }
  capabilityCache.set(resolved, { mtimeMs: stat.mtimeMs, size: stat.size, capabilities });
  return capabilities;
}

export function writeNativeProxyAuthFile(
  credentials: { host: string; port: number; username: string; password: string },
  temporaryRoot = os.tmpdir(),
): NativeProxyAuthFile {
  const directory = fs.mkdtempSync(path.join(path.resolve(temporaryRoot), "cloak-native-proxy-auth-"));
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
