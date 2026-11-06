import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import vm from "node:vm";
import ts from "typescript";

// Read only repository source. The complete entry executes in a VM with
// explicit module facades: no real fs writes, Electron, network or processes.
const source = readFileSync(new URL("../../src/main/index.ts", import.meta.url), "utf8");
const transformer: ts.TransformerFactory<ts.SourceFile> = context => file => {
  const visit: ts.Visitor = node => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      return context.factory.createCallExpression(context.factory.createIdentifier("__importFixture"), undefined, node.arguments);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.name.text === "url") {
      return context.factory.createStringLiteral("file:///review-fixture/dist/main/index.js");
    }
    return ts.visitEachChild(node, visit, context);
  };
  return ts.visitNode(file, visit) as ts.SourceFile;
};
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  transformers: { before: [transformer] },
}).outputText;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
const forbidden = (name: string) => () => { throw new Error(`Forbidden capability: ${name}`); };

async function fixture(options: { stopThrows?: boolean } = {}) {
  const events: string[] = [];
  const callbacks = new Map<string, ((...args: any[]) => any)[]>();
  const readyCallbacks: (() => Promise<void>)[] = [];
  const chat = deferred<{ unfinished: number }>();
  const browsers = deferred<{ unfinished: unknown[]; elapsedMs: number }>();
  const migration = deferred<void>();
  const record = (name: string) => () => { events.push(name); };
  const recordAsync = (name: string) => async () => { events.push(name); };
  const app = {
    isPackaged: false,
    setPath: vi.fn(),
    requestSingleInstanceLock: () => true,
    exit: forbidden("app.exit"),
    quit: vi.fn(record("app.quit")),
    getPath: () => "/review-fixture/user-data",
    commandLine: { appendSwitch: forbidden("app.commandLine") },
    whenReady: () => ({ then: (fn: () => Promise<void>) => { readyCallbacks.push(fn); } }),
    on: (name: string, fn: (...args: any[]) => any) => {
      const list = callbacks.get(name) || [];
      list.push(fn); callbacks.set(name, list);
    },
  };
  const modules: Record<string, any> = {
    "node:path": path, "node:url": url, "node:os": { homedir: forbidden("os.homedir") },
    "node:fs": {
      mkdirSync: vi.fn(), realpathSync: (p: string) => p,
      lstatSync: () => { throw Object.assign(new Error("synthetic absent config"), { code: "ENOENT" }); },
    },
    electron: { app, BrowserWindow: forbidden("BrowserWindow"), dialog: { showErrorBox: forbidden("dialog") },
      powerMonitor: { on: vi.fn() }, session: { fromPartition: forbidden("session") }, shell: { openExternal: forbidden("shell") } },
    "./branding.js": { PRODUCT_NAME: "Review Fixture", LEGACY_PRODUCT_NAME: "Old Fixture", APP_DATA_DIR_NAME: "FixtureData",
      CHROMIUM_CACHE_DIR_NAME: "FixtureChromium", LEGACY_CHROMIUM_CACHE_DIR_NAME: "OldChromium",
      configureProductIdentity: () => ({ canonical: false, userDataDir: "/review-fixture/user-data" }) },
    "./services/agent/chat-runs.js": { desktopChatRuns: { shutdown: vi.fn(() => { events.push("chat.shutdown"); return chat.promise; }) } },
    "./services/automation.js": { startScheduler: record("scheduler.start"), reloadSchedule: forbidden("reloadSchedule"),
      refreshScheduleTimers: forbidden("refreshScheduleTimers"), stopScheduler: vi.fn(() => {
        events.push("scheduler.stop"); if (options.stopThrows) throw new Error("synthetic scheduler stop failure");
      }) },
    "./services/browser/launch-admission.js": { closeBrowserLaunchAdmission: vi.fn(record("launch.close")) },
    "./services/browser-manager.js": {
      shutdownAllBrowserProfiles: vi.fn(() => { events.push("browser.snapshot"); return browsers.promise; }),
      setIdlePolicyTimeoutMs: vi.fn(), sweepIdleProfiles: forbidden("idle.sweep"), getIdlePolicyTimeoutMs: () => 0, purgeExpiredTrash: () => [],
    },
    "./services/agent-db.js": { closeAgentDb: vi.fn(record("agent-db.close")) },
    "./services/job-store.js": { closeJobDb: vi.fn(record("job-db.close")) },
    "./services/config-manager.js": { getConfig: () => ({}), migrateSecrets: () => 0, getAppDataDir: () => "/review-fixture/user-data" },
    "./services/secrets.js": { planSecretStorage: () => ({ backend: "file", reason: "fixture" }), initializeSecretStorage: () => ({ backend: "file", reason: "fixture" }) },
    "./services/legacy-data-migration.js": { migrateLegacyUserData: forbidden("legacy data migration"), migrateLegacyChromiumCache: forbidden("legacy cache migration") },
    "./services/renderer-storage.js": { UI_STORAGE_PARTITION: "fixture:ui", migrateLegacyRendererStorage: () => { events.push("migration.start"); return migration.promise; } },
    "./services/observability.js": { configureObservability: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() },
    "./services/automation-reconcile.js": { reconcileAutomationState: () => ({}), handleSystemResume: vi.fn(), setRefreshScheduleTimers: vi.fn() },
    "./services/automation-notify.js": { configureNotifier: vi.fn() },
    "./services/agent-run-trace.js": { reconcileRunResults: () => ({}) },
    "./services/server-mode.js": { isHeadlessMode: () => true },
    "./services/mcp-server.js": { startMcpServer: () => { events.push("mcp.start"); return { ready: Promise.resolve() }; }, stopMcpServer: recordAsync("mcp.stop") },
    "./services/rest-api-server.js": { startRestApiServer: () => { events.push("rest.start"); return { ready: Promise.resolve() }; }, stopRestApiServer: recordAsync("rest.stop") },
    "./services/update-manager.js": { noteAppStarted: () => ({ history: [] }), markAppHealthy: vi.fn(), noteAppCrashed: vi.fn() },
    "./services/tray-manager.js": { createTray: forbidden("tray.create"), destroyTray: vi.fn(record("tray.destroy")), refreshTrayMenu: forbidden("tray.refresh") },
  };
  const ipcExports: Record<string, string> = {
    profile: "registerProfileHandlers", proxy: "registerProxyHandlers", drm: "registerDrmHandlers", storage: "registerStorageHandlers",
    sync: "registerSyncHandlers", app: "registerAppHandlers", detect: "registerDetectHandlers", settings: "registerSettingsHandlers",
    agent: "registerAgentHandlers", mcp: "registerMcpHandlers", api: "registerApiHandlers", browser: "registerBrowserHandlers",
    webrtc: "registerWebRtcHandlers", team: "registerTeamHandlers", automation: "registerAutomationHandlers", audit: "registerAuditHandlers",
    data: "registerDataHandlers", updates: "registerUpdateHandlers", observability: "registerObservabilityHandlers", license: "registerLicenseHandlers",
  };
  for (const [name, exported] of Object.entries(ipcExports)) modules[`./ipc/${name}.js`] = { [exported]: vi.fn() };
  function requireFixture(name: string) {
    if (!Object.hasOwn(modules, name)) throw new Error(`Forbidden import: ${name}`);
    return modules[name];
  }
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const context = vm.createContext({ console: log, setTimeout, clearTimeout,
    setInterval: vi.fn(() => ({ unref() {} })),
    process: { platform: "linux", arch: "fixture", execPath: "/review-fixture/node", argv: [],
      env: { AGENT_BROWSER_DISABLE_LEGACY_MIGRATION: "1" }, on: vi.fn(), exit: forbidden("process.exit") },
    __importFixture: async (name: string) => requireFixture(name),
  });
  await vm.runInContext(`(async function(require,module,exports){${compiled}\n})`, context)(requireFixture, { exports: {} }, {});
  const beforeQuit = callbacks.get("before-quit")?.[0];
  if (!beforeQuit) throw new Error("Actual before-quit listener was not registered");
  return { events, modules, app, log, chat, browsers, migration, beforeQuit, ready: readyCallbacks[0] };
}

describe("real application entry closes admission before async shutdown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("seals launch and scheduler synchronously, survives repeated quit, then closes resources once", async () => {
    const f = await fixture();
    const first = { preventDefault: vi.fn() };
    const running = f.beforeQuit(first);
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(["launch.close", "scheduler.stop", "chat.shutdown"]);
    const second = { preventDefault: vi.fn() };
    await f.beforeQuit(second);
    expect(second.preventDefault).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(["launch.close", "scheduler.stop", "chat.shutdown"]);
    f.chat.resolve({ unfinished: 0 });
    await flush();
    expect(f.events).toEqual(["launch.close", "scheduler.stop", "chat.shutdown", "browser.snapshot"]);
    f.browsers.resolve({ unfinished: [], elapsedMs: 0 });
    await running;
    expect(f.events).toEqual(["launch.close", "scheduler.stop", "chat.shutdown", "browser.snapshot", "agent-db.close", "job-db.close", "tray.destroy", "mcp.stop", "rest.stop"]);
    expect(f.app.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(f.app.quit).toHaveBeenCalledTimes(1);
    const finished = { preventDefault: vi.fn() };
    await f.beforeQuit(finished);
    expect(finished.preventDefault).not.toHaveBeenCalled();
    expect(f.events.filter(x => x === "scheduler.stop")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the launch gate closed and continues cleanup if scheduler stop throws", async () => {
    const f = await fixture({ stopThrows: true });
    const running = f.beforeQuit({ preventDefault: vi.fn() });
    expect(f.events).toEqual(["launch.close", "scheduler.stop", "chat.shutdown"]);
    expect(f.log.error).toHaveBeenCalledWith("[shutdown] failed to stop automation scheduler:", expect.objectContaining({ message: "synthetic scheduler stop failure" }));
    f.chat.resolve({ unfinished: 0 });
    f.browsers.resolve({ unfinished: [], elapsedMs: 0 });
    await running;
    expect(f.events).toContain("rest.stop");
    await vi.advanceTimersByTimeAsync(50);
    expect(f.app.quit).toHaveBeenCalledTimes(1);
  });

  it("does not restart scheduler/servers when quit occurs during the awaited startup migration", async () => {
    const f = await fixture();
    const startup = f.ready();
    await flush();
    expect(f.events).toEqual(["migration.start"]);
    const shutdown = f.beforeQuit({ preventDefault: vi.fn() });
    f.migration.resolve(undefined);
    await startup;
    expect(f.events).not.toContain("scheduler.start");
    expect(f.events).not.toContain("mcp.start");
    expect(f.events).not.toContain("rest.start");
    f.chat.resolve({ unfinished: 0 });
    f.browsers.resolve({ unfinished: [], elapsedMs: 0 });
    await shutdown;
  });

  it("does not begin late ready bootstrap after quit already closed admission", async () => {
    const f = await fixture();
    const shutdown = f.beforeQuit({ preventDefault: vi.fn() });
    await f.ready();
    expect(f.events).not.toContain("migration.start");
    expect(f.events).not.toContain("scheduler.start");
    expect(f.events).not.toContain("rest.start");
    f.chat.resolve({ unfinished: 0 });
    f.browsers.resolve({ unfinished: [], elapsedMs: 0 });
    await shutdown;
  });
});
