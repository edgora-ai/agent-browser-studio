// Task47: actual registered select-binary callback + actual config/store functions.
// Source reads are fixed below. All application I/O is an in-memory fixture;
// no application import, Electron runtime, real config path, process or network.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

// No environment-selected source/baseline, directory traversal or application
// filesystem read: these are the only repository files read by this harness.
const sources = {
  browser: readFileSync(new URL("../../src/main/ipc/browser.ts", import.meta.url), "utf8"),
  store: readFileSync(new URL("../../src/main/services/config/store.ts", import.meta.url), "utf8"),
  limits: readFileSync(new URL("../../src/main/services/config/limits.ts", import.meta.url), "utf8"),
  manager: readFileSync(new URL("../../src/main/services/config-manager.ts", import.meta.url), "utf8"),
};

// Use the real wrapper bodies, not a handwritten approximation of saveConfig.
// Only these declarations are evaluated from config-manager; its module-level
// normalizer/cleanup hooks and lazy disk loading are deliberately NOT evaluated.
function managerDeclarations(): string {
  const source = ts.createSourceFile("config-manager.ts", sources.manager, ts.ScriptTarget.Latest, true);
  return ["getConfig", "saveConfig", "ensureDeviceIdentity"].map(name => {
    const matches = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (matches.length !== 1) throw new Error(`Expected exactly one production declaration: ${name}`);
    return matches[0].getText(source);
  }).join("\n");
}

function compile(source: string, filename: string, electronImport = false): string {
  let transformedImports = 0;
  const importFixture: ts.TransformerFactory<ts.SourceFile> = context => sourceFile => {
    const visit: ts.Visitor = node => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (!electronImport || node.arguments.length !== 1 || !argument || !ts.isStringLiteral(argument) || argument.text !== "electron") {
          throw new Error(`Undeclared dynamic import in ${filename}`);
        }
        transformedImports++;
        // This changes ONLY import("electron")'s loader boundary. No handler,
        // resolver, transaction, assignment or error-handling body is rewritten.
        return context.factory.createCallExpression(
          context.factory.createIdentifier("__engineSelectionImportFixture"), undefined,
          [context.factory.createStringLiteral("electron")],
        );
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(sourceFile, visit) as ts.SourceFile;
  };
  const result = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: false,
    },
    transformers: { before: [importFixture] },
    reportDiagnostics: true,
  });
  const errors = result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) || [];
  if (errors.length) throw new Error(`Source fixture must transpile: ${filename}: ${errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n")).join("; ")}`);
  if (transformedImports !== (electronImport ? 1 : 0)) throw new Error(`Unexpected dynamic-import count in ${filename}`);
  return result.outputText;
}

const compiled = {
  browser: compile(sources.browser, "src/main/ipc/browser.ts", true),
  store: compile(sources.store, "src/main/services/config/store.ts"),
  limits: compile(sources.limits, "src/main/services/config/limits.ts"),
  manager: compile(managerDeclarations(), "config-manager.production-wrapper-fixture.ts"),
};
const CONFIG_DIR = "/engine-selection-review";
const CONFIG_PATH = CONFIG_DIR + "/config.json";
const OLD_EXE = "/selection/old-chromium";
const NEW_EXE = "/selection/chosen-chromium";
const INVALID_BUNDLE = "/selection/NotChromium.app";
const violations: string[] = [];
type Failure = "" | "write" | "rename";
type Pick = { canceled: boolean; filePaths: string[] };
type Config = { chromiumBin: string; automationNotify: { system: boolean; sound: boolean }; [key: string]: any };
type Handler = (...args: any[]) => Promise<any>;

function fixture() {
  const forbidden = (capability: string) => (..._args: any[]): never => {
    violations.push(capability);
    throw new Error(`Forbidden engine-selection fixture capability: ${capability}`);
  };
  const members = (label: string, values: Record<string, any>): any => new Proxy(Object.freeze(values), {
    get(target, key) {
      if (Object.hasOwn(target, key)) return Reflect.get(target, key);
      return forbidden(`${label}.${String(key)}`)();
    },
  });
  const state = {
    failure: "" as Failure,
    picked: { canceled: false, filePaths: [NEW_EXE] } as Pick,
    writeAttempts: 0, renameAttempts: 0, commits: 0, dynamicImports: 0,
    verifyFailure: false,
    timeline: [] as string[],
    probes: [] as string[],
    verificationReads: [] as Array<{ memory: string; persisted: string }>,
  };
  let nonce = 0;
  const cryptoFixture = members("crypto", {
    randomUUID: () => `00000000-0000-4000-8000-${(++nonce).toString(16).padStart(12, "0")}`,
  });
  const pathFixture = members("path", {
    dirname: (value: string) => posix.dirname(value),
    join: (...values: string[]) => posix.join(...values),
  });
  const utilFixture = members("util", { isDeepStrictEqual });
  const bufferFixture = members("Buffer", {
    byteLength: (text: string, encoding: "utf8") => {
      if (encoding !== "utf8" || typeof text !== "string") return forbidden("non-UTF8 config byte count")();
      return Buffer.byteLength(text, encoding);
    },
  });
  function evaluate(code: string, filename: string, modules: Record<string, any>, globals: Record<string, any> = {}): any {
    const module = { exports: {} as any };
    const context = createContext({
      module, exports: module.exports, Error, structuredClone, Buffer: bufferFixture,
      // This is a closed fixture dispatcher, NEVER Node's require/createRequire.
      require: (name: string) => Object.hasOwn(modules, name) ? modules[name] : forbidden(`undeclared module ${name}`)(),
      process: undefined,
      fetch: forbidden("fetch"), WebSocket: forbidden("WebSocket"),
      setTimeout: forbidden("timer"), setInterval: forbidden("interval"),
      setImmediate: forbidden("immediate"), clearTimeout: forbidden("clear timer"),
      console: members("console", { error: forbidden("console.error"), warn: forbidden("console.warn"), log: forbidden("console.log") }),
      ...globals,
    }, { codeGeneration: { strings: false, wasm: false } });
    runInContext(code, context, { filename, timeout: 1000 });
    return module.exports;
  }

  const seed: Config = {
    version: 4, deviceId: "fixture-device", deviceName: "Fixture",
    chromiumBin: OLD_EXE, defaultProxy: "", proxies: {}, accounts: [], browserProfiles: {},
    automationNotify: { system: false, sound: false },
  };
  const files = new Map<string, string>([[CONFIG_PATH, JSON.stringify(seed, null, 2)]]);
  const fds = new Map<number, { path: string; kind: "file" | "directory" }>();
  let nextFd = 700;
  function descriptor(fd: number) {
    const value = fds.get(fd);
    if (!value) return forbidden("unknown memory descriptor")();
    return value;
  }
  function isTemporary(file: string): boolean {
    return typeof file === "string" && file.startsWith(CONFIG_PATH + ".tmp-") &&
      /^00000000-0000-4000-8000-[0-9a-f]{12}$/.test(file.slice((CONFIG_PATH + ".tmp-").length));
  }
  const storeFs = members("store fs", {
    mkdirSync: (dir: string, options: any) => {
      if (dir !== CONFIG_DIR || options?.recursive !== true || options?.mode !== 0o700) return forbidden("unexpected memory mkdir")();
    },
    openSync: (file: string, flags: string, mode?: number) => {
      if (file === CONFIG_DIR && flags === "r") {
        const fd = ++nextFd; fds.set(fd, { path: file, kind: "directory" }); return fd;
      }
      if (!isTemporary(file) || flags !== "w" || mode !== 0o600) return forbidden("unexpected memory open")();
      files.set(file, "");
      const fd = ++nextFd; fds.set(fd, { path: file, kind: "file" }); return fd;
    },
    writeFileSync: (fd: number, text: string, encoding: string) => {
      const opened = descriptor(fd);
      if (opened.kind !== "file" || typeof text !== "string" || encoding !== "utf-8") return forbidden("unexpected memory write")();
      state.writeAttempts++; state.timeline.push("write");
      if (state.failure === "write") throw new Error("synthetic ENOSPC write failure");
      files.set(opened.path, text);
    },
    fsyncSync: (fd: number) => { descriptor(fd); },
    closeSync: (fd: number) => { descriptor(fd); fds.delete(fd); },
    renameSync: (from: string, to: string) => {
      if (!isTemporary(from) || to !== CONFIG_PATH || !files.has(from)) return forbidden("unexpected memory rename")();
      state.renameAttempts++; state.timeline.push("rename-attempt");
      if (state.failure === "rename") throw new Error("synthetic EACCES rename failure");
      files.set(to, files.get(from)!); files.delete(from);
      state.commits++; state.timeline.push("rename");
    },
    chmodSync: (file: string, mode: number) => {
      if (file !== CONFIG_PATH || mode !== 0o600) return forbidden("unexpected memory chmod")();
    },
  });
  const limits = evaluate(compiled.limits, "src/main/services/config/limits.ts", {});
  const store = evaluate(compiled.store, "src/main/services/config/store.ts", {
    "node:fs": storeFs, "node:path": pathFixture, "node:crypto": cryptoFixture, "node:util": utilFixture,
    "./paths.js": members("config paths", { getConfigPath: () => CONFIG_PATH }),
    "./limits.js": members("config limits", { assertConfigSize: limits.assertConfigSize }),
    // Empty proxies are intentional: no credential witness or network-observation
    // implementation is loaded. Reaching either seam fails, even if caught.
    "../proxy-observation.js": members("proxy observation", {
      createProxyWitness: forbidden("proxy witness"),
      isAuthenticatedProxyObservation: forbidden("proxy observation authentication"),
    }),
  });
  store.adoptLoadedConfig(structuredClone(seed));
  const wrapper = evaluate(compiled.manager, "config-manager.production-wrapper-fixture.ts", {}, {
    getCommittedConfig: store.getCommittedConfig,
    adoptLoadedConfig: store.adoptLoadedConfig,
    storeTransact: store.transact,
    loadConfig: forbidden("lazy config disk loading"),
    randomUUID: cryptoFixture.randomUUID,
    os: members("os", { hostname: forbidden("hostname") }),
  });
  const config = {
    getConfig: vi.fn((): Config => wrapper.getConfig()),
    saveConfig: vi.fn((value: Config): void => wrapper.saveConfig(value)),
  };
  const persisted = (): Config => JSON.parse(files.get(CONFIG_PATH)!);
  const status = { available: true, verified: true, binary: NEW_EXE, version: "fixture-only" };
  const verify = vi.fn(async () => {
    state.timeline.push("verify");
    state.verificationReads.push({ memory: store.getCommittedConfig().chromiumBin, persisted: persisted().chromiumBin });
    if (state.verifyFailure) throw new Error("synthetic verification failure after commit");
    return status;
  });
  const audit = vi.fn((_entry: any) => { state.timeline.push("audit"); });
  const handlers = new Map<string, Handler>();
  const focusedWindow = Object.freeze({ fixtureWindow: true });
  const showOpenDialog = vi.fn(async () => structuredClone(state.picked));
  const electron = members("electron fixture", {
    ipcMain: members("ipcMain", {
      handle: (name: string, callback: Handler) => {
        if (handlers.has(name)) return forbidden(`duplicate IPC handler ${name}`)();
        handlers.set(name, callback);
      },
    }),
    BrowserWindow: members("BrowserWindow", { getFocusedWindow: () => focusedWindow }),
    dialog: members("dialog", { showOpenDialog }),
    // Promise resolution of the explicit dynamic-import fixture probes `then`.
    then: undefined,
  });

  type SelectedEntry = { kind: "file" | "directory" | "missing"; mode?: number; entries?: string[] };
  const selectedEntries = new Map<string, SelectedEntry>([
    [NEW_EXE, { kind: "file", mode: 0o755 }],
    [INVALID_BUNDLE, { kind: "directory" }],
    [INVALID_BUNDLE + "/Contents/MacOS", { kind: "directory", entries: ["README.txt", "missing-link"] }],
    [INVALID_BUNDLE + "/Contents/MacOS/README.txt", { kind: "file", mode: 0o644 }],
    [INVALID_BUNDLE + "/Contents/MacOS/missing-link", { kind: "missing" }],
    [INVALID_BUNDLE + "/Contents", { kind: "directory", entries: ["MacOS"] }],
  ]);
  function selectedEntry(file: string): SelectedEntry {
    state.probes.push(file);
    const entry = selectedEntries.get(file);
    if (!entry) return forbidden("undeclared selection path")();
    if (entry.kind === "missing") throw new Error("synthetic ENOENT selection entry");
    return entry;
  }
  const browserFs = members("browser fs", {
    statSync: (file: string) => {
      const entry = selectedEntry(file);
      return { isFile: () => entry.kind === "file", mode: entry.mode || 0 };
    },
    readdirSync: (dir: string) => {
      const entry = selectedEntry(dir);
      if (entry.kind !== "directory" || !entry.entries) return forbidden("unexpected selection readdir")();
      return [...entry.entries];
    },
  });
  const unusedBrowserModules = [
    "../services/consistency-check.js", "../services/fingerprint-baseline.js",
    "../services/fingerprint-drift-policy.js", "../services/fingerprint-drift-reports.js",
    "../services/profile-data-revision.js", "../services/profile-health.js",
    "../services/profile-network-diagnostics.js", "../services/bulk-import.js",
    "../services/business-presets.js", "../services/utils.js", "../services/browser-engine.js",
    "../services/page-eval.js", "../services/local-agent.js", "../services/browser/runtime-table.js",
    "../services/browser/launch-guards.js", "../services/profile-restore-lock.js",
    "../services/agent/run-scope.js", "../services/batch-queue.js", "../services/observability.js",
    "../services/license.js", "../services/team.js",
  ];
  const browserModules: Record<string, any> = Object.fromEntries(unusedBrowserModules.map(name => [name, members(name, {})]));
  Object.assign(browserModules, {
    electron, "node:fs": browserFs, "node:path": pathFixture, "node:crypto": cryptoFixture, "node:util": utilFixture,
    "../services/config-manager.js": members("config-manager facade", config),
    "../services/browser-manager.js": members("browser-manager facade", { verifyRuntimeChromiumAsync: verify }),
    "../services/audit-log.js": members("audit-log facade", { recordAudit: audit }),
  });
  const browser = evaluate(compiled.browser, "src/main/ipc/browser.ts", browserModules, {
    __engineSelectionImportFixture: (name: string) => {
      if (name !== "electron") return forbidden(`dynamic import ${name}`)();
      state.dynamicImports++;
      return Promise.resolve(electron);
    },
  });
  browser.registerBrowserHandlers();
  const selected = handlers.get("browser:select-binary");
  if (!selected || handlers.get("cloak:select-binary") !== selected) throw new Error("Actual select-binary callback/compatibility alias was not registered");
  return {
    state, config, store, status, verify, audit, showOpenDialog, focusedWindow, persisted,
    bytes: () => files.get(CONFIG_PATH)!,
    openDescriptors: () => fds.size,
    invoke: () => selected({}),
  };
}

afterEach(() => {
  // Fail closed even when production catches an unexpected capability error.
  expect(violations.splice(0)).toEqual([]);
});

describe("selected Chromium binary publishes only after the real store rename", () => {
  it.each(["write", "rename"] as const)("%s fault preserves the committed executable and a later unrelated save", async failure => {
    const f = fixture();
    const live = f.config.getConfig(), before = structuredClone(live), bytes = f.bytes();
    f.state.failure = failure;
    expect(await f.invoke()).toEqual({ success: false, error: `synthetic ${failure === "write" ? "ENOSPC write" : "EACCES rename"} failure` });
    expect(f.config.saveConfig).toHaveBeenCalledOnce();
    expect(f.state.writeAttempts).toBe(1);
    expect(f.state.renameAttempts).toBe(failure === "rename" ? 1 : 0);
    expect(f.state.commits).toBe(0);
    expect(f.store.getCommittedConfig()).toBe(live);
    expect(f.config.getConfig()).toEqual(before);
    expect(f.config.getConfig().chromiumBin).toBe(OLD_EXE);
    expect(f.bytes()).toBe(bytes);
    expect(f.audit).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.openDescriptors()).toBe(0);

    f.state.failure = "";
    const unrelated = structuredClone(f.config.getConfig());
    unrelated.automationNotify.system = true;
    f.config.saveConfig(unrelated);
    expect(f.state.commits).toBe(1);
    expect(f.persisted()).toEqual({ ...before, automationNotify: { system: true, sound: false } });
    expect(f.config.getConfig().chromiumBin).toBe(OLD_EXE);
    // Reload the memory-only serialized bytes through the real store adoption API.
    f.store.adoptLoadedConfig(f.persisted());
    expect(f.config.getConfig().chromiumBin).toBe(OLD_EXE);
    expect(f.config.getConfig().automationNotify.system).toBe(true);
    expect(f.openDescriptors()).toBe(0);
  });

  it("persists a selected executable once before audit/verification and returns the exact verify status", async () => {
    const f = fixture(), live = f.config.getConfig();
    const before = structuredClone(live);
    expect(await f.invoke()).toEqual({ success: true, path: NEW_EXE, status: f.status });
    expect(f.showOpenDialog).toHaveBeenCalledExactlyOnceWith(f.focusedWindow, {
      title: "Select the Chromium app or executable", properties: ["openDirectory", "openFile"],
    });
    expect(f.state.dynamicImports).toBe(1);
    expect(f.config.saveConfig).toHaveBeenCalledOnce();
    expect(f.config.saveConfig.mock.calls[0][0]).not.toBe(live);
    expect(live).toEqual(before);
    expect(f.state.writeAttempts).toBe(1); expect(f.state.renameAttempts).toBe(1); expect(f.state.commits).toBe(1);
    expect(f.persisted()).toEqual({ ...before, chromiumBin: NEW_EXE });
    expect(f.config.getConfig()).not.toBe(live);
    expect(f.config.getConfig().chromiumBin).toBe(NEW_EXE);
    expect(f.audit).toHaveBeenCalledExactlyOnceWith({
      category: "profile", action: "engine-binary-selected", target: NEW_EXE,
      actor: "user", detail: "chromium binary configured from the UI",
    });
    expect(f.verify).toHaveBeenCalledOnce();
    expect(f.state.verificationReads).toEqual([{ memory: NEW_EXE, persisted: NEW_EXE }]);
    expect(f.state.timeline).toEqual(["write", "rename-attempt", "rename", "audit", "verify"]);
    expect(f.openDescriptors()).toBe(0);
  });

  it.each([
    { label: "canceled dialog", picked: { canceled: true, filePaths: [NEW_EXE] } },
    { label: "empty file list", picked: { canceled: false, filePaths: [] } },
  ])("$label does not probe or save configuration", async ({ picked }) => {
    const f = fixture(), live = f.config.getConfig(), bytes = f.bytes();
    f.config.getConfig.mockClear(); f.state.picked = picked;
    expect(await f.invoke()).toEqual({ success: false, cancelled: true });
    expect(f.state.probes).toEqual([]);
    expect(f.config.getConfig).not.toHaveBeenCalled(); expect(f.config.saveConfig).not.toHaveBeenCalled();
    expect(f.store.getCommittedConfig()).toBe(live); expect(f.bytes()).toBe(bytes);
    expect(f.state.writeAttempts).toBe(0); expect(f.state.renameAttempts).toBe(0); expect(f.state.commits).toBe(0);
    expect(f.audit).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
    expect(f.openDescriptors()).toBe(0);
  });

  it("rejects a bundle without an executable, including unreadable/non-executable entries, without writing", async () => {
    const f = fixture(), live = f.config.getConfig(), before = structuredClone(live), bytes = f.bytes();
    f.config.getConfig.mockClear();
    f.state.picked = { canceled: false, filePaths: [INVALID_BUNDLE] };
    expect(await f.invoke()).toEqual({ success: false, error: "No Chromium executable found inside that selection" });
    expect(f.state.probes).toEqual([
      INVALID_BUNDLE, INVALID_BUNDLE + "/Contents/MacOS",
      INVALID_BUNDLE + "/Contents/MacOS/README.txt", INVALID_BUNDLE + "/Contents/MacOS/missing-link",
      INVALID_BUNDLE + "/Contents", INVALID_BUNDLE + "/Contents/MacOS",
    ]);
    expect(f.config.getConfig).not.toHaveBeenCalled(); expect(f.config.saveConfig).not.toHaveBeenCalled();
    expect(f.store.getCommittedConfig()).toBe(live); expect(live).toEqual(before); expect(f.bytes()).toBe(bytes);
    expect(f.state.writeAttempts).toBe(0); expect(f.state.renameAttempts).toBe(0); expect(f.state.commits).toBe(0);
    expect(f.audit).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
    expect(f.openDescriptors()).toBe(0);
  });

  it("reports verification failure AFTER a successful save without inventing config rollback", async () => {
    const f = fixture(); f.state.verifyFailure = true;
    expect(await f.invoke()).toEqual({ success: false, error: "synthetic verification failure after commit" });
    expect(f.config.saveConfig).toHaveBeenCalledOnce();
    expect(f.state.writeAttempts).toBe(1); expect(f.state.renameAttempts).toBe(1); expect(f.state.commits).toBe(1);
    expect(f.persisted().chromiumBin).toBe(NEW_EXE); expect(f.config.getConfig().chromiumBin).toBe(NEW_EXE);
    expect(f.audit).toHaveBeenCalledOnce(); expect(f.verify).toHaveBeenCalledOnce();
    expect(f.state.verificationReads).toEqual([{ memory: NEW_EXE, persisted: NEW_EXE }]);
    expect(f.state.timeline).toEqual(["write", "rename-attempt", "rename", "audit", "verify"]);
    f.store.adoptLoadedConfig(f.persisted());
    expect(f.config.getConfig().chromiumBin).toBe(NEW_EXE);
    expect(f.openDescriptors()).toBe(0);
  });
});
