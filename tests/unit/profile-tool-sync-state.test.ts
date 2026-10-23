// Original MCP dispatcher + original local tool with REAL list/get/classifier
// services and real owned config/Preferences bytes. Only OS process discovery,
// Electron/native DB, and unrelated MCP dependencies are controlled boundaries.
// Direct in-memory dispatch is not a real MCP socket/Electron acceptance run.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vm from "node:vm";
import ts from "typescript";

const h = vi.hoisted(() => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), "profile-tool-state-")), prohibited: [] as string[], discover: vi.fn(async () => []), find: vi.fn(() => null) };
});
const deny = (name: string) => (..._args: any[]): never => { h.prohibited.push(name); throw new Error("Forbidden profile projection fixture operation: " + name); };
vi.mock("electron", () => ({ app: { getPath: () => h.root }, BrowserWindow: { getAllWindows: () => [] }, screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) }, safeStorage: { isEncryptionAvailable: () => { throw new Error("Native storage unavailable in this fixture"); } } }));
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), homedir: () => h.root, hostname: () => "synthetic-profile-tools-host" }));
vi.mock("../../src/main/services/process-discovery.js", async importOriginal => ({ ...await importOriginal<typeof import("../../src/main/services/process-discovery.js")>(), getRunningProcessesAsync: h.discover, findBrowserByProfileSync: h.find }));
vi.mock("../../src/main/services/agent-db.js", async importOriginal => ({ ...await importOriginal<typeof import("../../src/main/services/agent-db.js")>(), agentDbTables: () => { throw new Error("DB is outside profile projection fixture"); }, agentDbQuery: () => { throw new Error("DB is outside profile projection fixture"); }, agentDbExec: () => { throw new Error("DB is outside profile projection fixture"); } }));

import * as config from "../../src/main/services/config-manager.js";
import * as store from "../../src/main/services/config/store.js";
import * as browser from "../../src/main/services/browser-manager.js";
import * as profiles from "../../src/main/services/profile-manager.js";
import * as local from "../../src/main/services/local-agent.js";
import * as proof from "../../src/main/services/sync/profile-state.js";
import * as utils from "../../src/main/services/utils.js";

const ROOT_IDENTITY = fs.lstatSync(h.root);
const ID = "synthetic_profile_tool_state";
const PREFS = Buffer.from('{"owned":"profile-tool-sync-state"}\n');
const MAIN = path.resolve(__dirname, "../../src/main");
const MCP_FILE = path.join(MAIN, "services/mcp-server.ts");
const MCP_CODE = ts.transpileModule(fs.readFileSync(MCP_FILE, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
function mcpDispatcher() {
  const module = { exports: {} as any };
  const dependencies: Record<string, any> = {
    "services/config-manager.ts": config, "services/browser-manager.ts": browser,
    "services/profile-manager.ts": profiles, "services/local-agent.ts": local,
    "services/sync/profile-state.ts": proof, "services/utils.ts": utils,
  };
  const requireFixture = (name: string) => {
    const rel = path.relative(MAIN, path.resolve(path.dirname(MCP_FILE), name.replace(/\.js$/, ".ts"))).replace(/\\/g, "/");
    if (dependencies[rel]) return dependencies[rel];
    return new Proxy({ __esModule: true }, { get: (_target, key) => key === "__esModule" ? true : key === "then" || typeof key === "symbol" ? undefined : deny(name + "." + String(key)) });
  };
  // Existing production function, exposed only in this private VM. Its body,
  // the public tool definitions and actual getter implementations are unchanged.
  vm.runInNewContext(`(function(require,module,exports){${MCP_CODE}\nexports.dispatch=executeMcpTool; exports.tools=MCP_EXPANDED_TOOLS;})`, {
    Buffer, URL, structuredClone, process: { env: { AGENT_BROWSER_MCP_TOKEN: "synthetic-mcp-profile-token", AGENT_BROWSER_MCP_PORT: "0" } }, console,
  }, { filename: MCP_FILE })(requireFixture, module, module.exports);
  return module.exports;
}
const facts = (value: any) => ({ syncStatus: value.syncStatus, syncScope: value.syncScope, syncReason: value.syncReason, syncedAt: value.syncedAt });
function baseline() {
  const value = proof.createProfileSyncBaseline(config.getConfig().browserProfiles[ID], proof.profilePreferencesSnapshot(PREFS), proof.getProfileSyncTarget(config.getConfig().sync), "synthetic-profile-snapshot", 0);
  store.transact(draft => { draft.browserProfiles[ID].syncBaseline = value; });
}
function ownedRoot() {
  const current = fs.lstatSync(h.root);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== ROOT_IDENTITY.dev || current.ino !== ROOT_IDENTITY.ino) throw new Error("Lost owned profile projection root");
}
beforeEach(() => {
  ownedRoot();
  for (const name of fs.readdirSync(h.root)) fs.rmSync(path.join(h.root, name), { recursive: true, force: true });
  config.reloadConfig(); config.getConfig();
  fs.mkdirSync(path.join(config.getProfilesDir(), ID, "Default"), { recursive: true });
  fs.writeFileSync(path.join(config.getProfilesDir(), ID, "Default", "Preferences"), PREFS);
  store.transact(draft => {
    draft.sync = { enabled: true, endpoint: "https://profile-tools.synthetic.invalid", bucket: "synthetic-profiles", accessKey: "", secretKey: "" };
    draft.browserProfiles[ID] = { name: "Synthetic state profile", fingerprintMode: "managed", fingerprintSeed: 12345, platform: "windows", engine: "chromium", proxyMode: "none", note: "Original note", tags: ["synthetic"] };
  });
  vi.stubGlobal("fetch", deny("network"));
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(() => { expect(h.prohibited).toEqual([]); ownedRoot(); fs.rmSync(h.root, { recursive: true, force: true }); });

describe("profile tool shared sync projection through real service getters", () => {
  const cases = [
    { kind: "never", status: "never", reason: "no-baseline", timestamp: null },
    { kind: "synced", status: "synced", reason: "baseline-match", timestamp: 0 },
    { kind: "dirty", status: "dirty", reason: "content-changed", timestamp: 0 },
    { kind: "legacy", status: "unknown", reason: "legacy-marker", timestamp: 0 },
    { kind: "target", status: "unknown", reason: "target-mismatch", timestamp: 0 },
    { kind: "invalid", status: "unknown", reason: "invalid-baseline", timestamp: 0 },
  ];
  it.each(cases)("retains $kind facts across MCP list/info and local list without mtime guesses", async entry => {
    if (["synced", "dirty", "target", "invalid"].includes(entry.kind)) baseline();
    if (entry.kind === "dirty") config.setProfileMeta(ID, { note: "Actually saved local change" });
    if (entry.kind === "legacy") store.transact(draft => { draft.browserProfiles[ID].syncedAt = 0; draft.browserProfiles[ID].syncedHash = "a".repeat(64); });
    if (entry.kind === "target") store.transact(draft => { draft.sync.bucket = "other-synthetic-target"; });
    if (entry.kind === "invalid") store.transact(draft => { draft.browserProfiles[ID].syncBaseline!.preferences = { state: "absent" }; });
    const bytes = fs.readFileSync(config.getConfigPath());
    const stored = JSON.parse(bytes.toString()).browserProfiles[ID];
    expect(stored.name).toBe("Synthetic state profile");
    config.reloadConfig();
    const expected = { syncStatus: entry.status, syncScope: "portable-profile+preferences", syncReason: entry.reason, syncedAt: entry.timestamp };
    const shared = proof.readProfileSyncState(ID, config.getConfig().browserProfiles[ID]);
    expect(facts(shared)).toEqual(expected);
    expect(facts(browser.listBrowserProfiles().find(p => p.dirId === ID))).toEqual(expected);
    expect(facts(await profiles.getProfileInfo(ID, []))).toEqual(expected);
    const mcp = mcpDispatcher();
    const listed = (await mcp.dispatch("agent_browser_list_profiles", {})).profiles.find((p: any) => p.dirId === ID);
    const info = await mcp.dispatch("agent_browser_profile_info", { dirId: ID });
    const tool = (await local.executeToolCall("list_profiles", {})).profiles.find((p: any) => p.dirId === ID);
    expect.soft(facts(listed)).toEqual(expected); expect.soft(facts(info)).toEqual(expected); expect.soft(facts(tool)).toEqual(expected);
    expect(listed).toMatchObject({ dirId: ID, name: stored.name, browser: "chromium", running: false, proxyMode: "none", proxy: "(no proxy)", sizeMB: "0" });
    expect(info).toMatchObject({ name: stored.name, dirId: ID, running: false, pid: null, proxyMode: "none", proxyName: null, proxy: null });
    expect(tool).toMatchObject({ dirId: ID, name: stored.name, running: false, proxy: "(default)" });
    expect(fs.readFileSync(config.getConfigPath())).toEqual(bytes);
    expect(config.getProfileMeta(ID)?.note).toBe(stored.note);
  });
});
