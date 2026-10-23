// E2E-only caller-owned launcher. Importing this module has no disk/child/port
// effects. No app.ts -> diag.ts, discovery, reset/rm, process sweep or kill.
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { _electron, type ElectronApplication } from "playwright";
import { buildIsolatedTestLaunchEnv } from "./launch-env.js";

export interface NetworkHeadlessAppHandle {
  app: ElectronApplication; port: number; token: string; userDataDir: string;
  awaitState(): { pending: number; timedOut: boolean };
  /** Normal exact-owned main close only, AFTER its cached native runtime is empty. */
  close(absoluteDeadlineAt: number): Promise<void>;
}
interface Ledger { pending: Set<Promise<unknown>>; timedOut: boolean }
function required(condition: unknown, code: string): asserts condition {
  if (!condition) throw Object.assign(new Error(code), { code });
}
function canonicalDirectory(directory: string): string {
  required(path.isAbsolute(directory) && fs.realpathSync(directory) === path.resolve(directory), "HEADLESS_CANONICAL_DIRECTORY_REQUIRED");
  const stat = fs.lstatSync(directory);
  required(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.(), "HEADLESS_OWNED_DIRECTORY_REQUIRED"); return directory;
}
async function bounded<T>(ledger: Ledger, code: string, end: number, factory: () => T | PromiseLike<T>): Promise<T> {
  required(Date.now() < end, code); let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve().then(() => { required(Date.now() < end, code); return factory(); });
  ledger.pending.add(operation); operation.then(() => ledger.pending.delete(operation), () => ledger.pending.delete(operation));
  const expired = () => { ledger.timedOut = true; return Object.assign(new Error(code), { code }); };
  try {
    const value = await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(expired()), Math.max(1, end - Date.now())); })]);
    if (Date.now() >= end) throw expired(); return value;
  } catch (error) { if (Date.now() >= end) ledger.timedOut = true; throw error; }
  finally { if (timer) clearTimeout(timer); }
}
async function health(port: number, end: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    required(Date.now() < end, "HEADLESS_HEALTH_ABSOLUTE_DEADLINE");
    const req = http.get({ hostname: "127.0.0.1", port, path: "/health" }, res => {
      let bytes = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16 * 1024) req.destroy(new Error("HEADLESS_HEALTH_BUDGET")); else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => {
        try {
          required(Date.now() < end && res.statusCode === 200 && String(res.headers["content-type"]).includes("application/json"), "HEADLESS_EXACT_TIMELY_REST_JSON_HEALTH_REQUIRED");
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          required(body && typeof body === "object" && !Array.isArray(body), "HEADLESS_REST_HEALTH_OBJECT_REQUIRED"); resolve(body as Record<string, unknown>);
        } catch (error) { reject(error); }
      });
    });
    const cancel = () => req.destroy(Object.assign(new Error("HEADLESS_HEALTH_DEADLINE"), { code: "HEADLESS_HEALTH_DEADLINE" }));
    const timer = setTimeout(cancel, Math.max(1, end - Date.now())); req.once("close", () => clearTimeout(timer));
    req.setTimeout(Math.max(1, end - Date.now()), cancel); req.on("error", reject);
  });
}
export async function launchNetworkHeadlessApp(options: {
  repoDir: string; ownedRoot: string; userDataDir: string; chromiumBinary: string;
  token: string; mcpToken: string; timeoutMs?: number; absoluteDeadlineAt: number;
}): Promise<NetworkHeadlessAppHandle> {
  required(process.env.ABS_NETWORK_ACCEPTANCE === "1" && process.env.ABS_NETWORK_ACCEPTANCE_DIST_READY === "1", "HEADLESS_EXPLICIT_NETWORK_OPT_IN_REQUIRED");
  required(process.env.AGENT_BROWSER_E2E_UNSANDBOXED !== "1", "HEADLESS_UNSANDBOXED_FORBIDDEN");
  const ledger: Ledger = { pending: new Set(), timedOut: false }, end = Math.min(options.absoluteDeadlineAt, Date.now() + Math.min(options.timeoutMs ?? 30_000, 30_000));
  required(Number.isFinite(end) && Date.now() < end, "HEADLESS_ABSOLUTE_LAUNCH_DEADLINE_REQUIRED");
  const repo = canonicalDirectory(options.repoDir), owner = canonicalDirectory(options.ownedRoot);
  required(path.isAbsolute(options.userDataDir) && path.dirname(options.userDataDir) === owner && path.resolve(options.userDataDir) === options.userDataDir, "HEADLESS_FRESH_DIRECT_OWNED_CHILD_REQUIRED");
  let absent = false;
  try { fs.lstatSync(options.userDataDir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") absent = true; else throw error; }
  required(absent, "HEADLESS_EXISTING_USERDATA_REFUSED");
  required(path.isAbsolute(options.chromiumBinary) && fs.realpathSync(options.chromiumBinary) === options.chromiumBinary && fs.lstatSync(options.chromiumBinary).isFile(), "HEADLESS_EXPLICIT_CANONICAL_CHROMIUM_REQUIRED");
  fs.accessSync(options.chromiumBinary, fs.constants.X_OK);
  required(/^synthetic-[A-Za-z0-9-]{1,96}$/.test(options.token) && /^synthetic-[A-Za-z0-9-]{1,96}$/.test(options.mcpToken), "HEADLESS_SYNTHETIC_TOKENS_REQUIRED");
  const executablePath = path.join(repo, "node_modules/electron/dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
  required(fs.statSync(executablePath).isFile(), "HEADLESS_REPOSITORY_ELECTRON_REQUIRED"); fs.accessSync(executablePath, fs.constants.X_OK);
  fs.mkdirSync(options.userDataDir, { mode: 0o700 });
  const env = buildIsolatedTestLaunchEnv({ userDataDir: options.userDataDir, fixtureEnv: {
    AGENT_BROWSER_CHROMIUM_BINARY_PATH: options.chromiumBinary, AGENT_BROWSER_API_PORT: "0", AGENT_BROWSER_API_TOKEN: options.token,
    AGENT_BROWSER_MCP_PORT: "0", AGENT_BROWSER_MCP_TOKEN: options.mcpToken, TZ: "UTC", LANG: "en_US.UTF-8",
  } });
  let app: ElectronApplication | undefined;
  try {
    app = await bounded(ledger, "HEADLESS_ELECTRON_LAUNCH_DEADLINE", end, () => _electron.launch({ executablePath, args: [repo, `--user-data-dir=${options.userDataDir}`, "--headless"], env, timeout: Math.max(1, end - Date.now()) }).then(value => { app = value; return value; }));
    const ownedPid = app.process().pid; required(Number.isInteger(ownedPid) && Number(ownedPid) > 0, "HEADLESS_LAUNCH_PID_REQUIRED");
    let port = 0;
    while (Date.now() < end) {
      const state = await bounded(ledger, "HEADLESS_MAIN_STATUS_DEADLINE", Math.min(end, Date.now() + 5_000), () => app!.evaluate(async ({ app }, input) => {
        const p = process.getBuiltinModule("node:path"), u = process.getBuiltinModule("node:url"), vm = process.getBuiltinModule("node:vm");
        if (Date.now() >= input.end || process.pid !== input.pid || app.getAppPath() !== input.repo || app.getPath("userData") !== input.userData || !process.argv.includes("--headless")) throw new Error("HEADLESS_MAIN_IDENTITY_CONTRADICTION");
        const url = u.pathToFileURL(p.join(app.getAppPath(), "dist/main/services/rest-api-server.js")).href;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let rest: any;
        try { rest = await Promise.race([vm.runInThisContext(`import(${JSON.stringify(url)})`, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }), new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error("HEADLESS_MAIN_IMPORT_DEADLINE")), Math.max(1, input.end - Date.now())); })]); }
        finally { if (timer) clearTimeout(timer); }
        if (Date.now() >= input.end) throw new Error("HEADLESS_MAIN_LATE_STATUS_REJECTED");
        return { pid: process.pid, port: rest.getRestApiPort(), running: rest.isRestApiServerRunning(), fixtureTokenMatches: rest.getRestApiToken() === input.token };
      }, { pid: ownedPid, repo, userData: options.userDataDir, token: options.token, end: Math.min(end, Date.now() + 5_000) }));
      required(Date.now() < end && state.pid === ownedPid && state.fixtureTokenMatches, "HEADLESS_TIMELY_OWN_MAIN_REST_IDENTITY_REQUIRED");
      if (state.running) { required(Number.isInteger(state.port) && state.port > 0 && state.port <= 65535, "HEADLESS_REAL_DYNAMIC_REST_PORT_REQUIRED"); port = state.port; break; }
      await bounded(ledger, "HEADLESS_READY_DELAY_DEADLINE", end, () => new Promise<void>(resolve => setTimeout(resolve, Math.min(75, Math.max(1, end - Date.now())))));
    }
    required(port > 0, "HEADLESS_OWN_REST_LISTENER_DEADLINE");
    const body = await bounded(ledger, "HEADLESS_HEALTH_DEADLINE", end, () => health(port, Math.min(end, Date.now() + 3_000)));
    required(body.status === "ok" && body.service === "agent-browser-studio-api" && body.port === port && body.mode === "headless" && body.profiles === 0 && !ledger.timedOut && ledger.pending.size === 0, "HEADLESS_EXACT_OWNED_REST_SERVICE_REQUIRED");
    const ownedApp = app;
    return { app: ownedApp, port, token: options.token, userDataDir: options.userDataDir,
      awaitState: () => ({ pending: ledger.pending.size, timedOut: ledger.timedOut }),
      async close(absoluteDeadlineAt: number) {
        const closeEnd = Math.min(absoluteDeadlineAt, Date.now() + 16_000);
        required(!ledger.timedOut && ledger.pending.size === 0, "HEADLESS_UNSETTLED_LOSERS_FORBID_IMPLICIT_MAIN_CLOSE");
        const matches = await bounded(ledger, "HEADLESS_NORMAL_CLOSE_IDENTITY_DEADLINE", Math.min(closeEnd, Date.now() + 4_000), () => ownedApp.evaluate(async ({ app }, input) => {
          const p = process.getBuiltinModule("node:path"), u = process.getBuiltinModule("node:url"), vm = process.getBuiltinModule("node:vm");
          if (Date.now() >= input.end || process.pid !== input.pid || app.getAppPath() !== input.repo || app.getPath("userData") !== input.userData) return false;
          const url = u.pathToFileURL(p.join(app.getAppPath(), "dist/main/services/browser/runtime-table.js")).href;
          let timer: ReturnType<typeof setTimeout> | undefined; let runtime: any;
          try { runtime = await Promise.race([vm.runInThisContext(`import(${JSON.stringify(url)})`, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }), new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error("HEADLESS_CACHED_RUNTIME_READ_DEADLINE")), Math.max(1, input.end - Date.now())); })]); }
          finally { if (timer) clearTimeout(timer); }
          return Date.now() < input.end && runtime.runningProcesses.size === 0;
        }, { pid: ownedPid, repo, userData: options.userDataDir, end: Math.min(closeEnd, Date.now() + 4_000) }));
        required(matches && Date.now() < closeEnd, "HEADLESS_NORMAL_CLOSE_OWNERSHIP_CHANGED_OR_RUNTIME_NOT_EMPTY");
        await bounded(ledger, "HEADLESS_NORMAL_CLOSE_DEADLINE", closeEnd, () => ownedApp.close());
      },
    };
  } catch (error) {
    const cause = error && typeof error === "object" && "code" in error ? error.code : null;
    throw Object.assign(new Error("HEADLESS_STARTUP_OR_SERVICE_IDENTITY_UNVERIFIED"), { code: "HEADLESS_STARTUP_OR_SERVICE_IDENTITY_UNVERIFIED", ownedPid: app?.process().pid ?? null,
      pendingOwnedOperations: ledger.pending.size, timedOut: ledger.timedOut,
      causeCode: typeof cause === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(cause) ? cause : "unavailable" });
  }
}
