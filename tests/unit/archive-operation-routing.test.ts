// R3 caller-seam REDs. Run whole production preload/IPC/REST and renderer
// modules in controlled VM realms. HTTP is an in-memory server callback, NOT
// a socket or real HTTP acceptance; native dialogs and unrelated services are
// explicit fixture boundaries. ZIP publication, CRC readback and config-store
// transactions use real bytes below exclusive disposable mkdtemp roots.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import * as crypto from "node:crypto";
import * as util from "node:util";
import * as zlib from "node:zlib";
import { EventEmitter } from "node:events";
import ts from "typescript";

const PROJECT = path.resolve(__dirname, "../..");
const SOURCE = path.join(PROJECT, "src/main");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "archive-operation-routing-")));
const A = "ab_archive_one";
const B = "ab_archive_two";
const TOKEN = "synthetic-archive-routing-token";
const compiled = new Map<string, string>();
const forbidden: string[] = [];
const proof = {
  ipcBridgeInvokes: 0, ipc: {} as Record<string, number>, rest: {} as Record<string, number>,
  nativeSave: 0, nativeOpen: 0, nativeConfirm: 0, serviceExports: 0, serviceExportBatches: 0, serviceImportBatches: 0,
  realPostPublishWarnings: 0, rendererRealIpcLoads: 0, lateCommittedReadbacks: 0,
  syntheticDiscoveryScans: 0, confirmedStoppedStatuses: 0, transferRefusals: 0, revisionReadbacks: 0,
};
const active: Array<() => Promise<void>> = [];
const hash = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function deny(name: string): (...args: any[]) => never {
  return () => { forbidden.push(name); throw new Error(`PROHIBITED ${name}`); };
}
function opaque(name: string): any {
  return new Proxy(Object.create(null), { get: (_target, key) => key === "__esModule" ? true : key === "then" ? undefined : deny(`${name}.${String(key)}`) });
}
function compile(file: string): string {
  if (!compiled.has(file)) compiled.set(file, ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText);
  return compiled.get(file)!;
}
class Clock {
  now = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms = 0): number => {
    const id = ++this.seq; this.timers.set(id, { at: this.now + ms, fn }); return id;
  };
  clearTimeout = (id: number): void => { this.timers.delete(id); };
  advance(ms: number): void {
    const end = this.now + ms;
    for (let guard = 0; guard < 1000; guard++) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { this.now = end; return; }
      this.now = next[1].at; this.timers.delete(next[0]); next[1].fn();
    }
    throw new Error("Fixture timer did not settle");
  }
}

async function fixture() {
  const dir = fs.mkdtempSync(path.join(ROOT, "case-"));
  const profilesDir = path.join(dir, "profiles");
  const out = path.join(dir, "exports");
  const configPath = path.join(dir, "config.json");
  fs.mkdirSync(out);
  fs.mkdirSync(path.join(dir, "home"));
  const running = new Set<string>();
  const runtime = { overrides: new Map<string, Record<string, unknown>>(), discoveryAvailable: true };
  const syntheticOwnerPid = 41_001;
  const clock = new Clock();
  const modules = new Map<string, { exports: any }>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const pending = new Set<Promise<any>>();
  const trace = {
    invokes: [] as Array<{ channel: string; args: any[]; result?: any }>,
    services: [] as Array<{ name: string; args: any[]; result?: any; error?: string }>,
    native: [] as Array<{ kind: string; options: any }>,
    rendererKeys: [] as string[],
    discovery: [] as Array<{ profileDir: string; available: boolean; candidates: number }>,
    statuses: [] as Array<{ dirId: string; value: Record<string, unknown> }>,
  };
  const faults = { warnAfterPublication: false, published: false };
  const native = {
    savePath: path.join(out, "native.zip"), saveCancelled: false, openCancelled: false,
    openPaths: [out], saveDeferred: undefined as ReturnType<typeof deferred<any>> | undefined,
    confirmResponse: 0, beforeConfirmation: undefined as undefined | (() => void | Promise<void>),
  };
  let store: any;
  let callback: ((req: any, res: any) => Promise<void>) | undefined;
  const owned = (file: unknown) => typeof file === "string" && (path.resolve(file) === dir || path.resolve(file).startsWith(dir + path.sep));
  // The production path guard lstats ancestors from '/' down. Permit metadata
  // only for this fixture's verified canonical directory ancestors, never
  // readdir/open/read/write outside the exclusively owned tree.
  const ancestors = new Set<string>();
  for (let parent = path.dirname(dir); ; parent = path.dirname(parent)) {
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Fixture canonical ancestor is not a real directory");
    ancestors.add(parent);
    if (path.dirname(parent) === parent) break;
  }
  const runtimeFs = new Proxy(fs, { get(target, key) {
    if (key === "promises") return opaque("filesystem.promises");
    const fn = (target as any)[key];
    if (typeof fn !== "function") return fn;
    return (...args: any[]) => {
      const operands = [args[0], ...(["renameSync", "linkSync", "symlinkSync", "copyFileSync"].includes(String(key)) ? [args[1]] : [])];
      for (const operand of operands) if (typeof operand === "string" && !owned(operand)) {
        const ancestorMetadata = ["lstatSync", "statSync", "realpathSync", "existsSync"].includes(String(key)) && ancestors.has(path.resolve(operand));
        if (!ancestorMetadata) deny(`filesystem escape ${String(key)}`)();
      }
      if (key === "fsyncSync" && faults.warnAfterPublication && faults.published && fs.fstatSync(args[0]).isDirectory()) {
        faults.warnAfterPublication = false; proof.realPostPublishWarnings++;
        throw Object.assign(new Error("EIO: synthetic post-publication directory fsync"), { code: "EIO", syscall: "fsync" });
      }
      const result = fn(...args);
      if ((key === "linkSync" || key === "renameSync") && String(args[1]).endsWith(".zip")) faults.published = true;
      return result;
    };
  } });
  const config = new Proxy({
    getConfig: () => store.getCommittedConfig(),
    getProfileMeta: (id: string) => store.getCommittedConfig().browserProfiles[id] || null,
    getAppDataDir: () => dir, getProfilesDir: () => profilesDir, getConfigPath: () => configPath,
    // Normalization defaults are a fixture boundary; identity validation/hash,
    // archive, config transactions and caller routing remain production code.
    portableProfileContent: (raw: any) => structuredClone(raw),
    normalizePortableProfileMeta: (raw: any) => {
      if (!raw || typeof raw.name !== "string") throw new Error("Invalid fixture profile metadata");
      // Production normalization returns an object in its module's own realm.
      return vm.runInContext("JSON.parse", context)(JSON.stringify({ ...raw, updatedAt: Date.now() }));
    },
  } as Record<string, any>, { get: (target, key: string) => key in target ? target[key] : opaque("config-manager")[key] });
  const inspectSyntheticLaunches = (profileDir: string) => {
    if (!owned(profileDir)) deny("discovery profile escape")();
    const id = path.basename(profileDir);
    const candidates = runtime.discoveryAvailable && running.has(id) ? [{
      pid: id === A ? 47_001 : 47_002, executablePath: path.join(dir, "synthetic-browser"), engine: "chromium",
      args: [`--user-data-dir=${profileDir}`], profileDirs: [profileDir], cdpPorts: [], malformed: false,
    }] : [];
    proof.syntheticDiscoveryScans++;
    trace.discovery.push({ profileDir, available: runtime.discoveryAvailable, candidates: candidates.length });
    return { available: runtime.discoveryAvailable, candidates, tracked: null };
  };
  const discovery = new Proxy({
    inspectBrowserLaunchesSync: inspectSyntheticLaunches,
    findBrowserByProfileSync: (_id: string, profileDir: string) => {
      const scan = inspectSyntheticLaunches(profileDir);
      if (!scan.available) throw new Error("Synthetic process discovery unavailable");
      return scan.candidates.length ? { pid: scan.candidates[0].pid, cdpPort: 0 } : null;
    },
    getRunningProcessesAsync: async () => {
      if (!runtime.discoveryAvailable) throw new Error("Synthetic process discovery unavailable");
      return [...running].map((id) => ({ pid: id === A ? 47_001 : 47_002, args: `synthetic-browser --user-data-dir=${path.join(profilesDir, id)}` }));
    },
  } as Record<string, any>, { get: (target, key: string) => key in target ? target[key] : opaque("process-discovery")[key] });
  const syntheticStatus = (id: string) => {
    const scan = inspectSyntheticLaunches(path.join(profilesDir, id));
    const present = scan.candidates[0];
    const value = {
      running: Boolean(present), pid: present?.pid ?? null, cdpPort: null, stopping: false,
      unknown: !scan.available, state: !scan.available ? "unknown" : present ? "running" : "stopped",
      ...runtime.overrides.get(id),
    };
    if (value.running === false && value.pid === null && value.stopping === false && value.unknown === false && value.state === "stopped") proof.confirmedStoppedStatuses++;
    trace.statuses.push({ dirId: id, value: structuredClone(value) });
    return value;
  };
  const browser = new Proxy({
    statusBrowser: syntheticStatus,
    touchProfileActivity: (_id: string) => undefined,
    listBrowserProfiles: () => Object.entries(config.getConfig().browserProfiles).map(([dirId, value]: any) => ({ ...value, dirId, ...syntheticStatus(dirId) })),
  } as Record<string, any>, { get: (target, key: string) => key in target ? target[key] : opaque("browser-manager")[key] });
  const electron = {
    app: { getPath: (name: string) => name === "home" ? path.join(dir, "home") : dir },
    dialog: {
      showSaveDialog: async (options: any) => {
        proof.nativeSave++; trace.native.push({ kind: "save", options: structuredClone(options) });
        return native.saveDeferred ? native.saveDeferred.promise : { canceled: native.saveCancelled, filePath: native.saveCancelled ? undefined : native.savePath };
      },
      showOpenDialog: async (options: any) => {
        proof.nativeOpen++; trace.native.push({ kind: "open", options: structuredClone(options) });
        return { canceled: native.openCancelled, filePaths: native.openCancelled ? [] : native.openPaths };
      },
      showMessageBox: async (options: any) => {
        proof.nativeConfirm++; trace.native.push({ kind: "confirmation", options: structuredClone(options) });
        await native.beforeConfirmation?.();
        return { response: native.confirmResponse };
      },
    },
    ipcMain: { handle: (channel: string, handler: any) => handlers.set(channel, async (...args: any[]) => {
      proof.ipc[channel] = (proof.ipc[channel] || 0) + 1;
      return handler(...args);
    }) },
  };
  const allow = new Set([
    "ipc/profile.ts", "services/profile-archive.ts", "services/zip-writer.ts", "services/archive-path-guard.ts",
    "services/profile-portability.ts", "services/profile-identity.ts", "services/config/store.ts", "services/config/limits.ts",
    "services/rest-api-server.ts", "services/http/auth.ts", "services/http/body.ts", "services/main-i18n.ts", "branding.ts",
    "services/profile-restore-lock.ts", "services/profile-data-revision.ts",
  ]);
  function boundary(relative: string, original: any): any {
    if (relative !== "services/profile-archive.ts") return original;
    return new Proxy(original, { get(target, key: string) {
      if (!["exportProfileArchive", "exportProfileArchives", "importProfileArchive", "importProfileArchives"].includes(key)) return target[key];
      return asyncOrSync;
      function asyncOrSync(...args: any[]) {
        if (key === "exportProfileArchive") proof.serviceExports++;
        if (key === "exportProfileArchives") proof.serviceExportBatches++;
        if (key === "importProfileArchives") proof.serviceImportBatches++;
        const observation: (typeof trace.services)[number] = { name: key, args: structuredClone(args) };
        trace.services.push(observation);
        try {
          const value = target[key](...args);
          if (value && typeof value.then === "function") return value.then((result: any) => { observation.result = structuredClone(result); return result; }, (error: Error) => { observation.error = error.message; throw error; });
          observation.result = structuredClone(value); return value;
        } catch (error) { observation.error = (error as Error).message; throw error; }
      }
    } });
  }
  const context = vm.createContext({
    Buffer, URL, TextDecoder: util.TextDecoder, structuredClone,
    console: { log() {}, warn() {}, error() {} },
    process: { platform: process.platform, pid: syntheticOwnerPid, getuid: process.getuid?.bind(process),
      kill: (pid: number, signal: number) => {
        if (pid !== syntheticOwnerPid || signal !== 0) return deny("unexpected process signal")();
        return true; // Only the synthetic restore-lease owner is known alive.
      }, argv: ["node", "synthetic-archive-fixture"], uptime: () => 1, env: {
      HOME: path.join(dir, "home"), NODE_ENV: "test", AGENT_BROWSER_API_TOKEN: TOKEN, AGENT_BROWSER_API_PORT: "0",
    } },
    setImmediate, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    fetch: deny("network"),
  });
  function load(relative: string): any {
    if (modules.has(relative)) return modules.get(relative)!.exports;
    const full = path.join(SOURCE, relative);
    const module = { exports: {} as any }; modules.set(relative, module);
    const req = (name: string): any => {
      if (name === "electron") return electron;
      if (name === "node:fs") return runtimeFs;
      if (name === "node:path") return path;
      if (name === "node:crypto") return crypto;
      if (name === "node:util") return util;
      if (name === "node:zlib") return zlib;
      if (name === "node:os") return { tmpdir: () => dir, homedir: () => path.join(dir, "home"), hostname: () => "synthetic-archive-host" };
      if (name === "node:http") return { createServer: (handler: any) => {
        callback = handler;
        const server: any = new EventEmitter();
        server.listen = (_port: number, _host: string, ready: () => void) => ready();
        server.address = () => ({ port: 1 });
        server.close = (done: () => void) => done();
        return server;
      } };
      if (name.startsWith("node:")) return opaque(name);
      const logical = path.relative(SOURCE, path.resolve(path.dirname(full), name.replace(/\.js$/, ".ts"))).replace(/\\/g, "/");
      if (logical === "services/config-manager.ts") return config;
      if (logical === "services/config/paths.ts") return { getConfigPath: () => configPath };
      if (logical === "services/browser-manager.ts") return browser;
      if (logical === "services/process-discovery.ts") return discovery;
      if (logical === "services/team.ts") return { requireProfileMutation: () => ({ ok: true }) };
      if (logical === "services/license.ts") return { checkCreateAllowed: () => ({ allowed: true }) };
      if (logical === "services/utils.ts") return { validateDirId: (id: string) => { if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid fixture dirId"); } };
      if (logical === "services/audit-log.ts") return { recordAudit: (_event: any) => undefined };
      if (logical === "services/server-mode.ts") return { isHeadlessMode: () => false };
      if (allow.has(logical)) return boundary(logical, load(logical));
      return opaque(logical);
    };
    const execute = vm.runInContext(`(function(require,module,exports){\n${compile(full)}\n})`, context, { filename: full });
    execute(req, module, module.exports);
    return module.exports;
  }
  store = load("services/config/store.ts");
  const initial = { version: 4, browserProfiles: {
    [A]: { name: "Routing A", fingerprintSeed: 101, platform: "windows", tags: ["synthetic"] },
    [B]: { name: "Routing B", fingerprintSeed: 202, platform: "windows", tags: ["synthetic"] },
  }, proxies: {}, accounts: [], extensionRepository: {} };
  store.adoptLoadedConfig(initial);
  fs.writeFileSync(configPath, JSON.stringify(initial));
  for (const id of [A, B]) {
    fs.mkdirSync(path.join(profilesDir, id, "Default"), { recursive: true });
    fs.writeFileSync(path.join(profilesDir, id, "Default", "Preferences"), JSON.stringify({ sentinel: id }));
    fs.writeFileSync(path.join(profilesDir, id, "sentinel.txt"), `archive routing sentinel ${id}\n`);
  }
  load("ipc/profile.ts").registerProfileHandlers();
  const invoke = (channel: string, ...args: any[]) => {
    proof.ipcBridgeInvokes++;
    const observation: (typeof trace.invokes)[number] = { channel, args: structuredClone(args) };
    trace.invokes.push(observation);
    const operation = Promise.resolve().then(() => {
      if (!handlers.has(channel)) throw new Error(`Unknown IPC handler ${channel}`);
      return handlers.get(channel)!({ sender: {} }, ...args);
    }).then((result) => { observation.result = structuredClone(result); return result; });
    pending.add(operation);
    operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  };
  let api: any;
  vm.runInNewContext(fs.readFileSync(path.join(SOURCE, "preload.cjs"), "utf8"), { require: (name: string) => {
    if (name !== "electron") return deny("preload external require")();
    return { contextBridge: { exposeInMainWorld: (key: string, value: any) => { if (key !== "agentBrowserAPI") deny("unexpected preload surface")(); api = value; } }, ipcRenderer: { invoke, on: deny("native IPC listener"), removeListener: deny("native IPC listener removal") } };
  } }, { filename: "real-preload.cjs" });
  const rest = load("services/rest-api-server.ts");
  await rest.startRestApiServer().ready;
  if (!callback) throw new Error("Production REST callback was not registered");
  async function request(method: string, route: string, body?: unknown, auth = true) {
    const req: any = new EventEmitter();
    req.method = method; req.url = route; req.socket = { remoteAddress: "127.0.0.1" };
    const text = body === undefined ? "" : JSON.stringify(body);
    req.headers = { host: "127.0.0.1:1", "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}) };
    req.destroy = deny("unexpected request destroy");
    const response = { status: 0, body: undefined as any, headers: {} as Record<string, string> };
    const res = {
      setHeader: (key: string, value: string) => { response.headers[key.toLowerCase()] = value; },
      writeHead: (status: number, headers: Record<string, string>) => { response.status = status; Object.assign(response.headers, headers); },
      end: (value?: string) => { response.body = value ? JSON.parse(value) : undefined; },
    };
    const key = `${method} ${route}`; proof.rest[key] = (proof.rest[key] || 0) + 1;
    const operation = callback!(req, res);
    if (text) req.emit("data", Buffer.from(text)); req.emit("end");
    await operation;
    return response;
  }
  // Telemetry is an unrelated fixture sink, not another native IPC endpoint.
  api.observability = { timing: async () => undefined, counter: async () => undefined, log: async () => undefined };
  const toasts: Array<{ text: string; level: string }> = [];
  const helpers = { toast: (text: string, level: string) => toasts.push({ text, level }), esc: String, escAttr: String, icon: () => "", fmt: String };
  const window: any = { agentBrowserAPI: api, agentBrowser: { api, R: api, state: { currentTab: "profiles" }, helpers }, i18n: { t: (_key: string, fallback: string) => fallback }, performance: { now: () => clock.now } };
  const renderer = vm.createContext({
    window, performance: window.performance, document: { getElementById: () => null, querySelectorAll: () => [] },
    console: { log() {}, warn() {}, error() {} }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    localStorage: { getItem: () => null, setItem: deny("unexpected renderer persistent storage") },
  });
  vm.runInContext(fs.readFileSync(path.join(PROJECT, "src/renderer/js/app/ipc.js"), "utf8"), renderer, { filename: "real-renderer-ipc.js" });
  proof.rendererRealIpcLoads++;
  const realRendererCall = window.agentBrowser.ipc.call;
  window.agentBrowser.ipc.call = (key: string, ...args: any[]) => { trace.rendererKeys.push(key); return realRendererCall(key, ...args); };
  vm.runInContext(fs.readFileSync(path.join(PROJECT, "src/renderer/js/app/profiles.js"), "utf8"), renderer, { filename: "real-renderer-profiles.js" });
  const zip = load("services/zip-writer.ts");
  const archives = load("services/profile-archive.ts");
  async function settle() {
    await flush();
    while (pending.size) { await Promise.all([...pending]); await flush(); }
    await flush();
  }
  active.push(async () => {
    native.saveDeferred?.resolve({ canceled: true });
    await settle();
    await rest.stopRestApiServer();
    if (path.dirname(dir) !== ROOT || fs.lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe fixture cleanup");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function existing() {
    const file = path.join(out, "existing.zip");
    await zip.writeZipArchive(file, [{ name: "previous.txt", data: Buffer.from("old target sentinel") }]);
    faults.published = false;
    return { file, hash: hash(file) };
  }
  function readEntry(file: string, name: string): Buffer {
    const bytes = fs.readFileSync(file), entry = zip.readZipEntries(bytes).find((item: any) => item.name === name);
    if (!entry) throw new Error(`Missing verified archive entry ${name}`);
    return zip.extractZipEntry(bytes, entry);
  }
  return { dir, out, configPath, profilesDir, running, runtime, clock, trace, faults, native, api, invoke, request, agent: window.agentBrowser, toasts, settle, existing, readEntry, archives, zip, dataRevisions: load("services/profile-data-revision.ts"), mainI18n: load("services/main-i18n.ts") };
}

afterEach(async () => {
  for (const cleanup of active.splice(0)) await cleanup();
  expect(forbidden, "a prohibited fixture-boundary call is a harness failure, never a behavioral RED").toEqual([]);
});
afterAll(() => {
  console.info("ARCHIVE_ROUTING_HIT_PROOF", JSON.stringify({ ...proof, forbiddenCalls: forbidden.length, compiledRestSources: [...compiled.keys()].filter((file) => file.endsWith("/services/rest-api-server.ts")).length }));
  if (path.dirname(ROOT) !== fs.realpathSync(os.tmpdir()) || !path.basename(ROOT).startsWith("archive-operation-routing-") || fs.lstatSync(ROOT).isSymbolicLink()) throw new Error("Unsafe archive routing root cleanup");
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("archive operation routing controls", () => {
  it("executes real preload/IPC/service/ZIP readback while preserving an unconfirmed existing archive", async () => {
    const f = await fixture();
    const fresh = path.join(f.out, "fresh.zip");
    const result = await f.api.profile.exportArchive(A, fresh);
    expect(result.success).toBe(true);
    expect(f.trace.statuses.find((item) => item.dirId === A)?.value).toMatchObject({ running: false, pid: null, stopping: false, unknown: false, state: "stopped" });
    expect(f.trace.discovery).toContainEqual({ profileDir: path.join(f.profilesDir, A), available: true, candidates: 0 });
    expect(f.trace.invokes.at(-1)?.channel).toBe("profile:export-archive");
    expect(f.trace.services.at(-1)?.name).toBe("exportProfileArchive");
    expect(f.readEntry(fresh, "sentinel.txt").toString()).toBe(`archive routing sentinel ${A}\n`);
    expect(JSON.parse(f.readEntry(fresh, "meta.json").toString()).profile.name).toBe("Routing A");
    const old = await f.existing();
    const refused = await f.api.profile.exportArchive(A, old.file);
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/ARCHIVE_DESTINATION_EXISTS/);
    expect(hash(old.file)).toBe(old.hash);
  });

  it("exercises actual REST auth/body/dispatch without a socket and verifies exported bytes", async () => {
    const f = await fixture();
    expect((await f.request("GET", "/health", undefined, false)).status).toBe(200);
    const file = path.join(f.out, "rest-control.zip");
    expect((await f.request("POST", `/api/profiles/${A}/export`, { destPath: file }, false)).status).toBe(401);
    expect(f.trace.services).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(false);
    const response = await f.request("POST", `/api/profiles/${A}/export`, { destPath: file });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(f.trace.services.at(-1)?.name).toBe("exportProfileArchive");
    expect(f.readEntry(file, "sentinel.txt").toString()).toBe(`archive routing sentinel ${A}\n`);
  });
});

describe("archive confirmed-stop refusal controls", () => {
  const unsafe: Array<{ label: string; status?: Record<string, unknown>; running?: boolean; unavailable?: boolean }> = [
    { label: "running", running: true },
    { label: "stopping after PID clear", status: { stopping: true, state: "stopping" } },
    { label: "unknown", status: { unknown: true, state: "unknown" } },
    { label: "missing PID evidence", status: { pid: undefined } },
    { label: "uncleared positive PID", status: { pid: 47_001 } },
    { label: "failed process discovery", unavailable: true },
  ];
  it.each(unsafe.flatMap((scenario) => ["ipc", "rest"].map((transport) => ({ ...scenario, transport }))))("refuses $label through $transport without replacing even an explicitly approved ZIP", async ({ status, running, unavailable, transport }) => {
    const f = await fixture();
    const old = await f.existing();
    const beforeConfig = fs.readFileSync(f.configPath);
    const beforeProfile = fs.readFileSync(path.join(f.profilesDir, A, "sentinel.txt"));
    if (running) f.running.add(A);
    if (status) f.runtime.overrides.set(A, status);
    if (unavailable) f.runtime.discoveryAvailable = false;
    const response = transport === "ipc"
      ? { body: await f.api.profile.exportArchive(A, old.file, { overwrite: true }), status: undefined }
      : await f.request("POST", `/api/profiles/${A}/export`, { destPath: old.file, overwrite: true });
    expect(response.body).toMatchObject({ success: false, outcome: "failed", code: "PROFILE_STOP_REQUIRED" });
    if (transport === "rest") expect(response.status).toBe(400);
    expect(f.trace.services).toHaveLength(1);
    expect(f.trace.services[0].name).toBe("exportProfileArchive");
    expect(f.trace.services[0].error).toBeTypeOf("string");
    expect(f.trace.statuses.at(-1)?.dirId).toBe(A);
    if (unavailable) expect(f.trace.discovery.at(-1)).toMatchObject({ available: false });
    expect(hash(old.file)).toBe(old.hash);
    expect(fs.readFileSync(f.configPath)).toEqual(beforeConfig);
    expect(fs.readFileSync(path.join(f.profilesDir, A, "sentinel.txt"))).toEqual(beforeProfile);
    expect(fs.readdirSync(f.out)).toEqual(["existing.zip"]);
    expect(fs.readdirSync(path.join(f.dir, "locks"))).toEqual([]);
    expect(fs.existsSync(path.join(f.dir, "profile-data-revisions"))).toBe(false);
    proof.transferRefusals++;
  });
});

describe("archive caller-seam regressions (original behavioral REDs)", () => {
  it("forwards explicit overwrite through the production preload envelope", async () => {
    const f = await fixture(); const old = await f.existing();
    const result = await f.api.profile.exportArchive(A, old.file, { overwrite: true });
    expect(f.trace.invokes).toHaveLength(1);
    expect(f.trace.invokes[0].channel).toBe("profile:export-archive");
    expect(f.trace.services).toHaveLength(1);
    expect(f.trace.invokes[0].args[0], "preload must not discard caller's explicit replacement consent").toMatchObject({ overwrite: true });
    expect(result.success).toBe(true);
    expect(f.readEntry(old.file, "sentinel.txt").toString()).toContain(A);
  });

  it("passes explicit overwrite from the registered IPC handler to the real archive service", async () => {
    const f = await fixture(); const old = await f.existing();
    const result = await f.invoke("profile:export-archive", { dirId: A, destPath: old.file, overwrite: true });
    expect(f.trace.services).toHaveLength(1);
    expect(f.trace.services[0].name).toBe("exportProfileArchive");
    expect(f.trace.services[0].args[2], "real IPC handler dropped overwrite before real ZIP publication").toEqual({ overwrite: true });
    expect(result.success).toBe(true);
    expect(f.readEntry(old.file, "sentinel.txt").toString()).toContain(A);
  });

  it("passes explicit REST overwrite to the real archive service", async () => {
    const f = await fixture(); const old = await f.existing();
    const response = await f.request("POST", `/api/profiles/${A}/export`, { destPath: old.file, overwrite: true });
    expect(f.trace.services).toHaveLength(1);
    expect(f.trace.services[0].name).toBe("exportProfileArchive");
    expect(f.trace.services[0].args[2], "authenticated REST body overwrite never reached the service").toEqual({ overwrite: true });
    expect(response).toMatchObject({ status: 200, body: { success: true } });
    expect(f.readEntry(old.file, "sentinel.txt").toString()).toContain(A);
  });

  it("honors a native save dialog's accepted existing destination with explicit replacement policy", async () => {
    const f = await fixture(); const old = await f.existing(); f.native.savePath = old.file;
    const result = await f.api.profile.exportArchive(A);
    expect(f.trace.native.map((item) => item.kind)).toEqual(["save"]);
    expect(f.trace.services).toHaveLength(1);
    expect(f.trace.services[0].args[1]).toBe(old.file);
    expect(f.trace.services[0].args[2], "native acceptance currently still calls default no-overwrite").toMatchObject({ overwrite: true });
    expect(result.success).toBe(true);
  });

  it.each(["export", "import"])("does not display a false %s failure when the native picker was cancelled", async (kind) => {
    const f = await fixture(); f.native.saveCancelled = true; f.native.openCancelled = true;
    const before = fs.readFileSync(f.configPath);
    if (kind === "export") f.agent.exportProfileArchive(A); else f.agent.importProfileArchive();
    await f.settle();
    expect(f.trace.native).toHaveLength(1);
    expect(f.trace.services).toHaveLength(0);
    expect(fs.readFileSync(f.configPath)).toEqual(before);
    expect(fs.readdirSync(f.out)).toEqual([]);
    expect(f.toasts.filter((toast) => toast.level === "error"), "intentional native cancellation is not an archive operation failure").toEqual([]);
  });

  it.each(["ipc", "rest"])("preserves actual post-publication ZIP warnings through %s", async (transport) => {
    const f = await fixture(); const file = path.join(f.out, "warning.zip");
    f.faults.warnAfterPublication = true; f.faults.published = false;
    const result = transport === "ipc" ? await f.api.profile.exportArchive(A, file)
      : (await f.request("POST", `/api/profiles/${A}/export`, { destPath: file })).body;
    expect(result.success).toBe(true);
    expect(f.trace.services).toHaveLength(1);
    const actualWarnings = f.trace.services[0].result.warnings;
    expect(actualWarnings).toHaveLength(1);
    expect(actualWarnings[0]).toMatch(/published.*durability.*EIO/i);
    expect(f.readEntry(file, "sentinel.txt").toString()).toContain(A);
    expect(result.warnings, "caller stripped the real committed-warning receipt").toEqual(actualWarnings);
  });

  it.each(["ipc", "rest"])("does not report all-skipped export as success through %s", async (transport) => {
    const f = await fixture(); f.running.add(A); f.running.add(B);
    const result = transport === "ipc" ? await f.api.profile.exportArchives([A, B], f.out)
      : (await f.request("POST", "/api/profiles/export", { dirIds: [A, B], destDir: f.out })).body;
    expect(result.report).toMatchObject({ exported: [], skipped: [{ dirId: A, reason: "running-or-unconfirmed", code: "PROFILE_STOP_REQUIRED" }, { dirId: B, reason: "running-or-unconfirmed", code: "PROFILE_STOP_REQUIRED" }], failed: [] });
    expect(f.trace.services.at(-1)?.name).toBe("exportProfileArchives");
    expect(fs.readdirSync(f.out)).toEqual([]);
    expect(result.success, "real report exported 0, skipped 2, failed 0").toBe(false);
  });

  it.each(["ipc", "rest"])("does not report a partially skipped export as full success through %s", async (transport) => {
    const f = await fixture(); f.running.add(B);
    const result = transport === "ipc" ? await f.api.profile.exportArchives([A, B], f.out)
      : (await f.request("POST", "/api/profiles/export", { dirIds: [A, B], destDir: f.out })).body;
    expect(result.report.exported).toHaveLength(1);
    expect(result.report.skipped).toEqual([{ dirId: B, reason: "running-or-unconfirmed", code: "PROFILE_STOP_REQUIRED" }]);
    expect(result.report.failed).toEqual([]);
    expect(f.readEntry(result.report.exported[0].filePath, "sentinel.txt").toString()).toContain(A);
    expect(result.success, "real report exported 1, skipped 1, failed 0").toBe(false);
  });

  it.each(["ipc", "rest"])("does not report mixed real import success/failure as full success through %s", async (transport) => {
    const f = await fixture(); const good = path.join(f.out, "good.zip"); const bad = path.join(f.out, "corrupt.zip");
    await f.archives.exportProfileArchive(A, good);
    fs.writeFileSync(bad, "synthetic existing corrupt ZIP");
    const before = new Set(Object.keys(JSON.parse(fs.readFileSync(f.configPath, "utf8")).browserProfiles));
    const result = transport === "ipc" ? await f.api.profile.importArchives([good, bad])
      : (await f.request("POST", "/api/profiles/import-batch", { zipPaths: [good, bad] })).body;
    expect(result.report.imported).toHaveLength(1);
    expect(result.report.failed).toHaveLength(1);
    expect(result.report.failed[0].zipPath).toBe(bad);
    const imported = result.report.imported[0].dirId;
    expect(before.has(imported)).toBe(false);
    const saved = JSON.parse(fs.readFileSync(f.configPath, "utf8")).browserProfiles[imported];
    expect(saved).toMatchObject({ fingerprintSeed: 101, platform: "windows" });
    expect(result.report.imported[0].identity).toMatchObject({
      configuration: { state: "retained", changes: [], reasons: [] },
      runtime: { state: "not-verified", reason: "no-live-comparison" },
    });
    expect(result.report.imported[0].identity.configuration.beforeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.report.imported[0].identity.configuration.afterHash).toBe(result.report.imported[0].identity.configuration.beforeHash);
    expect(fs.readFileSync(path.join(f.profilesDir, imported, "sentinel.txt"), "utf8")).toContain(A);
    const revision = JSON.parse(fs.readFileSync(path.join(f.dir, "profile-data-revisions", imported + ".json"), "utf8"));
    expect(revision).toEqual({ version: 1, dirId: imported, revision: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) });
    expect(f.dataRevisions.getProfileDataRevision(imported)).toBe(revision.revision);
    proof.revisionReadbacks++;
    expect(result.success, "real report imported 1 and rejected 1 corrupt ZIP").toBe(false);
  });

  it.each(["export", "import"])("rejects a REST %s array that becomes empty after filtering", async (kind) => {
    const f = await fixture(); const before = fs.readFileSync(f.configPath);
    const route = kind === "export" ? "/api/profiles/export" : "/api/profiles/import-batch";
    const body = kind === "export" ? { dirIds: [null, 7], destDir: f.out } : { zipPaths: [null, 7] };
    const response = await f.request("POST", route, body);
    expect(fs.readFileSync(f.configPath)).toEqual(before);
    expect(fs.readdirSync(f.out)).toEqual([]);
    expect(response.status, `route=${route}; actual service calls=${JSON.stringify(f.trace.services.map((call) => ({ name: call.name, firstArgument: call.args[0] })))}`).toBe(400);
  });

  it.each(["all-skipped", "partial"])("does not render a green %s batch export toast", async (outcome) => {
    const f = await fixture(); f.running.add(B); if (outcome === "all-skipped") f.running.add(A);
    f.agent.toggleProfileSelect(A, true); f.agent.toggleProfileSelect(B, true);
    f.agent.batchExportSelected(); await f.settle();
    const invocation = f.trace.invokes.findLast((item) => item.channel === "profile:export-archives");
    expect(invocation).toBeDefined();
    const report = invocation!.result.report;
    expect(report.exported).toHaveLength(outcome === "partial" ? 1 : 0);
    expect(report.skipped).toHaveLength(outcome === "partial" ? 1 : 2);
    expect(f.toasts).toHaveLength(1);
    expect(f.toasts[0].text).toMatch(outcome === "partial" ? /1.*1/ : /0.*2/);
    expect(f.toasts[0].level, "real renderer currently uses failed==0 as the green-success condition").not.toBe("success");
  });

  it.each(["ipc", "rest"])("requires explicit batch replacement consent and preserves old ZIPs until supplied via %s", async (transport) => {
    const f = await fixture();
    const call = (overwrite?: boolean) => transport === "ipc"
      ? f.api.profile.exportArchives([A, B], f.out, overwrite === undefined ? undefined : { overwrite })
      : f.request("POST", "/api/profiles/export", { dirIds: [A, B], destDir: f.out, ...(overwrite === undefined ? {} : { overwrite }) }).then((r) => r.body);
    const first = await call();
    expect(first).toMatchObject({ success: true, outcome: "completed" });
    const files = first.report.exported.map((item: any) => ({ path: item.filePath, hash: hash(item.filePath) }));
    fs.writeFileSync(path.join(f.profilesDir, A, "sentinel.txt"), "new explicitly approved A bytes");
    const refused = await call();
    expect(refused).toMatchObject({ success: false, outcome: "failed" });
    expect(refused.report.failed).toHaveLength(2);
    expect(refused.report.failed.every((item: any) => item.code === "ARCHIVE_DESTINATION_EXISTS")).toBe(true);
    for (const file of files) expect(hash(file.path)).toBe(file.hash);
    const replaced = await call(true);
    expect(replaced).toMatchObject({ success: true, outcome: "completed" });
    expect(replaced.report.exported).toHaveLength(2);
    expect(f.readEntry(replaced.report.exported[0].filePath, "sentinel.txt").toString()).toBe("new explicitly approved A bytes");
    expect(f.trace.services.at(-1)?.args[2]).toEqual({ overwrite: true });
    expect(f.trace.native).toEqual([]);
  });

  it("does not interpret a directory picker as replacement approval when the separate confirmation is cancelled", async () => {
    const f = await fixture();
    const seeded = await f.archives.exportProfileArchives([A, B], f.out);
    const originals = seeded.exported.map((item: any) => ({ path: item.filePath, hash: hash(item.filePath) }));
    f.native.confirmResponse = 0;
    const result = await f.api.profile.exportArchives([A, B]);
    expect(result).toMatchObject({ success: false, cancelled: true, outcome: "cancelled", code: "ARCHIVE_CANCELLED" });
    expect(f.trace.native.map((item) => item.kind)).toEqual(["open", "confirmation"]);
    expect(f.trace.native[1].options).toMatchObject({ defaultId: 0, cancelId: 0 });
    for (const original of originals) { expect(f.trace.native[1].options.detail).toContain(original.path); expect(hash(original.path)).toBe(original.hash); }
    expect(f.trace.services).toHaveLength(0);
  });

  it("replaces only explicitly listed native batch conflicts, not a new file appearing during confirmation", async () => {
    const f = await fixture();
    const seeded = await f.archives.exportProfileArchives([A], f.out);
    const approved = seeded.exported[0].filePath;
    const late = path.join(f.out, `Routing_B-${B}.zip`);
    let lateHash = "";
    f.native.confirmResponse = 1;
    f.native.beforeConfirmation = async () => {
      await f.zip.writeZipArchive(late, [{ name: "previous.txt", data: Buffer.from("late unapproved backup sentinel") }]);
      lateHash = hash(late);
    };
    fs.writeFileSync(path.join(f.profilesDir, A, "sentinel.txt"), "approved replacement A");
    const result = await f.api.profile.exportArchives([A, B]);
    expect(result).toMatchObject({ success: false, outcome: "partial" });
    expect(result.report.exported).toHaveLength(1);
    expect(result.report.failed).toEqual([expect.objectContaining({ dirId: B, code: "ARCHIVE_DESTINATION_EXISTS" })]);
    expect(f.trace.native.map((item) => item.kind)).toEqual(["open", "confirmation"]);
    expect(f.trace.native[1].options.detail).toContain(approved);
    expect(f.trace.native[1].options.detail).not.toContain(late);
    expect(f.trace.services[0].args[2]).toEqual({ overwrite: false, confirmedOverwritePaths: [approved] });
    expect(f.readEntry(approved, "sentinel.txt").toString()).toBe("approved replacement A");
    expect(hash(late)).toBe(lateHash);
  });

  it.each(["ipc", "rest"])("returns a stable single-file conflict code without replacing unapproved bytes through %s", async (transport) => {
    const f = await fixture(); const old = await f.existing();
    const response = transport === "ipc" ? { body: await f.api.profile.exportArchive(A, old.file), status: undefined }
      : await f.request("POST", `/api/profiles/${A}/export`, { destPath: old.file });
    expect(response.body).toMatchObject({ success: false, outcome: "failed", code: "ARCHIVE_DESTINATION_EXISTS" });
    if (transport === "rest") expect(response.status).toBe(409);
    expect(hash(old.file)).toBe(old.hash);
  });

  it.each(["ipc", "rest"])("rejects truthy non-boolean overwrite through %s before any archive mutation", async (transport) => {
    const f = await fixture(); const old = await f.existing();
    const response = transport === "ipc" ? await f.api.profile.exportArchive(A, old.file, { overwrite: "true" })
      : (await f.request("POST", `/api/profiles/${A}/export`, { destPath: old.file, overwrite: "true" })).body;
    expect(response).toMatchObject({ success: false, code: "ARCHIVE_INVALID_INPUT" });
    expect(f.trace.services).toHaveLength(0);
    expect(hash(old.file)).toBe(old.hash);
  });

  it.each([{ values: [] }, { values: Array(1) }, { values: [""] }, { values: [null] }, { values: [A, 7] }])("rejects invalid explicit IPC arrays $values without opening native pickers", async ({ values }) => {
    const f = await fixture();
    const before = fs.readFileSync(f.configPath);
    const exported = await f.api.profile.exportArchives(values, f.out);
    const imported = await f.api.profile.importArchives(values);
    expect(exported).toMatchObject({ success: false, code: "ARCHIVE_INVALID_INPUT" });
    expect(imported).toMatchObject({ success: false, code: "ARCHIVE_INVALID_INPUT" });
    expect(f.trace.services).toHaveLength(0);
    expect(f.trace.native).toHaveLength(0);
    expect(fs.readFileSync(f.configPath)).toEqual(before);
    expect(fs.readdirSync(f.out)).toEqual([]);
  });

  it("dedupes the returned UI promise and completion toast while retaining exactly one slow notice", async () => {
    const f = await fixture(); f.native.saveDeferred = deferred<any>();
    const first = f.agent.exportProfileArchive(A);
    const second = f.agent.exportProfileArchive(A);
    expect(first).toBeTypeOf("object"); expect(first.then).toBeTypeOf("function");
    expect(second).toBe(first);
    await flush();
    expect(f.trace.invokes.filter((item) => item.channel === "profile:export-archive")).toHaveLength(1);
    expect(f.trace.native).toHaveLength(1);
    f.clock.advance(15_001); await flush();
    expect(f.toasts.filter((toast) => toast.level === "warning")).toHaveLength(1);
    expect(f.toasts[0].text).toMatch(/Still processing/);
    f.clock.advance(30_000); await flush();
    expect(f.toasts).toHaveLength(1);
    expect(f.agent.ipc.isBusy(f.trace.rendererKeys[0])).toBe(true);
    f.native.saveDeferred.resolve({ canceled: false, filePath: f.native.savePath });
    await f.settle();
    expect(await first).toMatchObject({ success: true });
    expect(f.toasts.filter((toast) => toast.level === "success")).toHaveLength(1);
    expect(f.toasts.filter((toast) => toast.level === "error")).toHaveLength(0);
    expect(f.agent.ipc.isBusy(f.trace.rendererKeys[0])).toBe(false);
  });

  it("retains the ordinary non-archive 15-second hard timeout", async () => {
    const f = await fixture(); const waiting = deferred<any>();
    const call = f.agent.ipc.call("ordinary-write", () => waiting.promise, { kind: "write", dedupe: true });
    const observed = call.catch((error: any) => error);
    await flush(); expect(f.agent.ipc.isBusy("ordinary-write")).toBe(true);
    f.clock.advance(15_001); await flush();
    expect(await observed).toMatchObject({ code: "IPC_TIMEOUT" });
    expect(f.agent.ipc.isBusy("ordinary-write")).toBe(false);
    waiting.resolve({ success: true }); await flush();
    expect(f.trace.invokes).toHaveLength(0);
  });

  it("shows a committed single-export warning rather than a pure green success", async () => {
    const f = await fixture(); f.faults.warnAfterPublication = true; f.faults.published = false;
    const result = await f.agent.exportProfileArchive(A);
    await f.settle();
    expect(result).toMatchObject({ success: true, outcome: "completed" });
    expect(result.warnings).toHaveLength(1);
    expect(f.readEntry(result.filePath, "sentinel.txt").toString()).toContain(A);
    expect(f.toasts).toEqual([expect.objectContaining({ level: "warning", text: expect.stringContaining("EIO") })]);
  });

  it.each(["en-US", "zh-CN"])("defines all native archive keys and uses the real %s dialog title", async (language) => {
    const f = await fixture(); f.mainI18n.setMainLanguage(language); f.native.saveCancelled = true;
    const keys = ["archive.export.title", "archive.export.batch-title", "archive.import.title", "archive.import.batch-title", "archive.filter.backup", "archive.replace.title", "archive.replace.message", "archive.replace.detail", "archive.replace.confirm", "archive.cancel"];
    for (const key of keys) expect(f.mainI18n.tMain(key, "__missing_archive_key__")).not.toBe("__missing_archive_key__");
    const result = await f.api.profile.exportArchive(A);
    expect(result.cancelled).toBe(true);
    expect(f.trace.native[0].options.title).toBe(language === "zh-CN" ? "导出配置备份" : "Export Profile Backup");
    expect(f.trace.native[0].options.properties).toContain("showOverwriteConfirmation");
  });

  it("has exactly ten native archive entries per language without duplicate-key shadowing", () => {
    const file = path.join(SOURCE, "services/main-i18n.ts");
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
    let dictionary: ts.ObjectLiteralExpression | undefined;
    function visit(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === "dict" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) dictionary = node.initializer;
      ts.forEachChild(node, visit);
    }
    visit(source); expect(dictionary).toBeDefined();
    for (const language of dictionary!.properties) {
      if (!ts.isPropertyAssignment(language) || !ts.isObjectLiteralExpression(language.initializer)) continue;
      const keys = language.initializer.properties.filter(ts.isPropertyAssignment).map((entry) => ts.isStringLiteral(entry.name) ? entry.name.text : entry.name.getText(source));
      expect(keys.length).toBe(new Set(keys).size);
      expect(keys.filter((key) => key.startsWith("archive."))).toHaveLength(10);
    }
  });

  it("keeps archive busy after 15 seconds while the real IPC/native dialog promise is still pending", async () => {
    const f = await fixture(); f.native.saveDeferred = deferred<any>();
    f.agent.exportProfileArchive(A); await flush();
    expect(f.trace.invokes).toHaveLength(1);
    expect(f.trace.native.map((item) => item.kind)).toEqual(["save"]);
    expect(f.agent.ipc.isBusy(f.trace.rendererKeys[0])).toBe(true);
    expect(f.trace.invokes[0].result).toBeUndefined();
    f.clock.advance(15_001); await flush();
    expect(f.trace.invokes[0].result, "main/native work has not settled or been cancelled").toBeUndefined();
    expect(f.agent.ipc.isBusy(f.trace.rendererKeys[0]), "renderer timeout must not release busy for non-cancelled archive work").toBe(true);
  });

  it("consumes a late committed archive completion exactly once rather than only showing a 15-second failure", async () => {
    const f = await fixture(); f.native.saveDeferred = deferred<any>();
    f.agent.exportProfileArchive(A); await flush();
    expect(f.trace.invokes).toHaveLength(1);
    f.clock.advance(15_001); await flush();
    f.native.saveDeferred.resolve({ canceled: false, filePath: f.native.savePath });
    await f.settle();
    expect(f.trace.invokes[0].result.success).toBe(true);
    expect(f.readEntry(f.native.savePath, "sentinel.txt").toString()).toContain(A);
    proof.lateCommittedReadbacks++;
    expect(f.agent.ipc.isBusy(f.trace.rendererKeys[0])).toBe(false);
    expect.soft(f.toasts.filter((toast) => toast.level === "success"), "real main committed and CRC readback passed, but the renderer discarded late completion").toHaveLength(1);
    expect.soft(f.toasts.filter((toast) => toast.level === "error"), "the 15-second waiting deadline must not claim the committed operation failed").toHaveLength(0);
    f.clock.advance(30_000); await flush();
    expect(f.toasts.filter((toast) => toast.level === "success"), "late completion must be consumed exactly once").toHaveLength(1);
  });
});
