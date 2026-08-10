import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProxyConfig } from "../types.js";

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 2_000;
const MAX_READY_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const EXPECTED_PROXY_HOST = "roxy-masque.local";

interface ReadyMessage {
  version: number;
  proxyHost: string;
  listenHost: string;
  port: number;
  spki: string;
  capabilities: string[];
}

interface OneShotConfigFile {
  filePath: string;
  cleanup: () => void;
}

export interface MasqueSocksBridge {
  proxyHost: typeof EXPECTED_PROXY_HOST;
  listenHost: "127.0.0.1";
  port: number;
  spki: string;
  capabilities: readonly string[];
  pid: number;
  close: () => Promise<void>;
}

export interface MasqueSocksBridgeOptions {
  binaryPath?: string;
  temporaryRoot?: string;
  startTimeoutMs?: number;
}

export function resolveMasqueBridgeBinary(explicitPath?: string): string {
  const binaryName = process.platform === "win32" ? "roxy-masque-bridge.exe" : "roxy-masque-bridge";
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicitPath,
    process.env.CLOAK_MASQUE_BRIDGE_PATH,
    resourcesPath ? path.join(resourcesPath, "native", binaryName) : null,
    path.resolve(moduleDir, "..", "..", "native", binaryName),
    path.resolve(process.cwd(), "dist", "native", binaryName),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      // Try the next deterministic location.
    }
  }
  throw new Error(`MASQUE bridge binary is unavailable (${binaryName})`);
}

export async function startMasqueSocksBridge(
  proxy: ProxyConfig,
  options: MasqueSocksBridgeOptions = {},
): Promise<MasqueSocksBridge> {
  validateSOCKSProxy(proxy);
  const binaryPath = resolveMasqueBridgeBinary(options.binaryPath);
  const config = writeOneShotConfig(proxy, options.temporaryRoot || os.tmpdir());
  let child: ChildProcessWithoutNullStreams | null = null;

  try {
    child = spawn(binaryPath, ["--config", config.filePath, "--watch-stdin"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child!.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const ready = await waitForReady(child, options.startTimeoutMs || START_TIMEOUT_MS);
    config.cleanup();

    let closing = false;
    return {
      proxyHost: EXPECTED_PROXY_HOST,
      listenHost: "127.0.0.1",
      port: ready.port,
      spki: ready.spki,
      capabilities: Object.freeze([...ready.capabilities]),
      pid: child.pid!,
      close: async () => {
        if (closing) return;
        closing = true;
        if (child!.exitCode !== null || child!.signalCode !== null) return;
        child!.stdin.end();
        if (await exitsWithin(exited, STOP_TIMEOUT_MS)) return;
        child!.kill("SIGTERM");
        if (await exitsWithin(exited, STOP_TIMEOUT_MS)) return;
        child!.kill("SIGKILL");
        await exited;
      },
    };
  } catch (error) {
    config.cleanup();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    throw error;
  }
}

function validateSOCKSProxy(proxy: ProxyConfig): void {
  if (proxy.type !== "socks5" && proxy.type !== "socks5h") {
    throw new Error("MASQUE bridge requires a SOCKS5 proxy");
  }
  if (!proxy.host || /[\x00\r\n]/.test(proxy.host)) throw new Error("SOCKS5 proxy host is invalid");
  if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) {
    throw new Error("SOCKS5 proxy port is invalid");
  }
  if (Buffer.byteLength(proxy.username || "", "utf8") > 255 ||
      Buffer.byteLength(proxy.password || "", "utf8") > 255) {
    throw new Error("SOCKS5 username and password must be at most 255 bytes");
  }
  if (!proxy.username && proxy.password) throw new Error("SOCKS5 password requires a username");
}

function writeOneShotConfig(proxy: ProxyConfig, temporaryRoot: string): OneShotConfigFile {
  const directory = fs.mkdtempSync(path.join(path.resolve(temporaryRoot), "cloak-masque-socks-"));
  fs.chmodSync(directory, 0o700);
  const filePath = path.join(directory, "proxy.json");
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username || "",
    password: proxy.password || "",
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
        // The helper normally consumes the file before reporting readiness.
      }
      try {
        fs.rmdirSync(directory);
      } catch {
        // Preserve unexpected contents for inspection.
      }
    },
  };
}

function waitForReady(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<ReadyMessage> {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("MASQUE bridge readiness timed out")), timeoutMs);

    const appendStderr = (chunk: Buffer): void => {
      if (process.env.ROXY_MASQUE_BRIDGE_DEBUG === "1") {
        process.stderr.write(`[roxy-masque-bridge] ${chunk.toString("utf8")}`);
      }
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > MAX_STDERR_BYTES) stderr = stderr.subarray(stderr.length - MAX_STDERR_BYTES);
    };
    const onStdout = (chunk: Buffer): void => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > MAX_READY_BYTES) {
        finish(new Error("MASQUE bridge readiness message is too large"));
        return;
      }
      const newline = stdout.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const value = JSON.parse(stdout.subarray(0, newline).toString("utf8")) as unknown;
        finish(null, validateReadyMessage(value));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const detail = stderr.toString("utf8").trim().slice(-2_000);
      finish(new Error(`MASQUE bridge exited before readiness (code=${code}, signal=${signal})${detail ? `: ${detail}` : ""}`));
    };
    const finish = (error: Error | null, ready?: ReadyMessage): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeListener("data", onStdout);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve(ready!);
    };

    child.stderr.on("data", appendStderr);
    child.stdout.on("data", onStdout);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function validateReadyMessage(value: unknown): ReadyMessage {
  if (!value || typeof value !== "object") throw new Error("MASQUE bridge returned invalid readiness JSON");
  const ready = value as Partial<ReadyMessage>;
  if (ready.version !== 1 || ready.proxyHost !== EXPECTED_PROXY_HOST || ready.listenHost !== "127.0.0.1") {
    throw new Error("MASQUE bridge returned an incompatible readiness identity");
  }
  if (!Number.isInteger(ready.port) || ready.port! < 1 || ready.port! > 65535) {
    throw new Error("MASQUE bridge returned an invalid port");
  }
  if (typeof ready.spki !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(ready.spki)) {
    throw new Error("MASQUE bridge returned an invalid SPKI pin");
  }
  if (!Array.isArray(ready.capabilities) ||
      !ready.capabilities.every((entry) => typeof entry === "string") ||
      !ready.capabilities.includes("connect") || !ready.capabilities.includes("connect-udp")) {
    throw new Error("MASQUE bridge is missing required capabilities");
  }
  return ready as ReadyMessage;
}

async function exitsWithin(
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  timeoutMs: number,
): Promise<boolean> {
  return Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
