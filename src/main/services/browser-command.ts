import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import * as path from "node:path";

const MAX_OUTPUT = 1024 * 1024;
const CACHE_LIMIT = 64;
type CommandOutput = { stdout: string; stderr: string };
interface CommandProbe {
  identity: string;
  response: Promise<CommandOutput | null>;
}
// Pending probes coalesce too; failures are removed, never retained for retry.
const probes = new Map<string, CommandProbe>();

async function executableIdentity(binaryPath: string): Promise<string | null> {
  try {
    const info = await stat(binaryPath);
    return info.isFile()
      ? [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":")
      : null;
  } catch {
    return null;
  }
}

interface BrowserCommandOptions {
  timeout: number;
  shell?: boolean;
  /** One retry for a terminated --version timeout, never a longer deadline. */
  retryTimeout?: boolean;
}

async function probeCommand(binary: string, args: readonly string[], options: BrowserCommandOptions, identity: string): Promise<CommandOutput | null> {
  const once = () => new Promise<{ output: CommandOutput | null; timedOut: boolean }>(resolve => {
    try {
      // The callback follows child termination and drained stdio. A retry must
      // not overlap the timed-out process or accept a different executable.
      execFile(binary, [...args], {
        timeout: options.timeout, shell: options.shell ?? false, killSignal: "SIGKILL",
        maxBuffer: MAX_OUTPUT, encoding: "utf8", windowsHide: true,
      }, (error, stdout, stderr) => {
        const excessiveOutput = Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT;
        const timedOut = !excessiveOutput && error?.killed === true && error.signal === "SIGKILL" && error.code == null;
        const output = error || excessiveOutput ? null : { stdout, stderr };
        resolve({ output, timedOut });
      });
    } catch {
      resolve({ output: null, timedOut: false });
    }
  });
  const first = await once();
  if (first.timedOut && options.retryTimeout && !options.shell && args.length === 1 && args[0] === "--version" &&
      await executableIdentity(binary) === identity) {
    return (await once()).output;
  }
  return first.output;
}

export async function runBrowserCommand(
  binaryPath: string,
  args: readonly string[],
  options: BrowserCommandOptions,
): Promise<{ stdout: string; stderr: string } | null> {
  options = { timeout: options.timeout, shell: options.shell === true, retryTimeout: options.retryTimeout === true };
  args = [...args]; // Both attempts belong to the same captured command/deadline.
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) return null;
  const resolved = path.resolve(binaryPath);
  const key = JSON.stringify([resolved, args, options.timeout, options.shell, options.retryTimeout]);
  const identity = await executableIdentity(resolved);
  if (!identity) {
    probes.delete(key);
    return null;
  }
  let probe = probes.get(key);
  if (!probe || probe.identity !== identity) {
    const response = probeCommand(resolved, args, options, identity);
    probe = { identity, response };
    if (!probes.has(key) && probes.size >= CACHE_LIMIT) {
      const oldest = probes.keys().next().value;
      if (oldest !== undefined) probes.delete(oldest);
    }
    probes.set(key, probe);
  }
  const result = await probe.response;
  // Do not publish a response belonging to a deleted/replaced executable.
  const unchanged = await executableIdentity(resolved) === identity;
  if (!result || !unchanged) {
    if (probes.get(key) === probe) probes.delete(key);
    return null;
  }
  return result;
}
