// Node-only whole-module proofs. Native APIs, sockets and real clipboard are
// fail-on-call. HTTP below is an in-memory callback, NOT real HTTP acceptance.
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vm from "node:vm";
import * as crypto from "node:crypto";
import * as util from "node:util";
import * as net from "node:net";
import * as url from "node:url";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const SOURCE = path.resolve(__dirname, "../../src/main");
const PROJECT = path.resolve(SOURCE, "../..");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "account-transport-proof-")));
const prohibited: string[] = [];
const compiled = new Map<string, string>();
function fail(name: string): (...args: any[]) => never {
  return () => { prohibited.push(name); throw new Error(`PROHIBITED ${name}`); };
}
function opaque(name: string): any {
  return new Proxy({}, { get: (_t, key) => key === "__esModule" ? false : key === "then" ? undefined : fail(`${name}.${String(key)}`) });
}
function compile(file: string): string {
  if (!compiled.has(file)) compiled.set(file, ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText);
  return compiled.get(file)!;
}
function localFs(dir: string, faults = { rename: false }): typeof fs {
  return new Proxy(fs, { get(target, key) {
    const fn = (target as any)[key];
    if (typeof fn !== "function") return fn;
    return (...args: any[]) => {
      const operands = [args[0], ...(["renameSync", "linkSync", "symlinkSync", "copyFileSync"].includes(String(key)) ? [args[1]] : [])];
      for (const operand of operands) if (typeof operand === "string" && !path.resolve(operand).startsWith(dir + path.sep) && path.resolve(operand) !== dir) fail(`filesystem escape ${String(key)}`)();
      if (key === "renameSync" && faults.rename) throw new Error("synthetic rename rejected");
      return fn(...args);
    };
  } });
}
function realm(globals: any): vm.Context {
  const context = vm.createContext({ Buffer, URL, structuredClone, ...globals });
  // Keep structural comparison in the same realm while retaining undefined.
  (context as any).__clone = structuredClone;
  vm.runInContext(`structuredClone = value => {
    const convert = x => Array.isArray(x) ? Array.from(x, convert) : x && typeof x === 'object'
      ? Object.fromEntries(Object.entries(x).map(([k,v]) => [k,convert(v)])) : x;
    return convert(__clone(value));
  };`, context);
  return context;
}
function fixture(transport: "rest" | "mcp" = "rest") {
  const dir = fs.mkdtempSync(path.join(ROOT, "data-"));
  const faults = { rename: false };
  const modules = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const audits: any[] = [];
  const clipboardAttempts: string[] = [];
  const calls: any[] = [];
  // Controlled browser-manager boundary only; native/common-create behavior is
  // tested separately. Record creation options or inject refusals, never launch success.
  const createdProfileOpts: any[] = [];
  const browserLaunch = { error: undefined as Error | undefined, calls: [] as any[], activityCalls: [] as string[] };
  let callback: ((req: any, res: any) => Promise<void>) | undefined;
  const context = realm({
    process: { platform: process.platform, argv: ["node", "synthetic-entry"], execPath: process.execPath, env: {
      HOME: dir, NODE_ENV: "test", AGENT_BROWSER_SECRET_BACKEND: "file",
      AGENT_BROWSER_API_TOKEN: "synthetic-transport-token", AGENT_BROWSER_API_PORT: "0",
      AGENT_BROWSER_MCP_TOKEN: "synthetic-transport-token", AGENT_BROWSER_MCP_PORT: "0",
    }, uptime: () => 1 },
    console: { log() {}, error() {}, warn() {} },
    setTimeout: fail("unexpected timer"), clearTimeout: fail("unexpected timer"),
    fetch: fail("network"), TextDecoder: util.TextDecoder,
  });
  const allow = new Set([
    "services/config-manager.ts", "services/config/store.ts", "services/config/paths.ts", "services/config/limits.ts",
    "services/observability.ts", "services/data-export.ts", "services/event-bus.ts",
    "services/sync/operation-state.ts", "services/sync/operation-result.ts",
    "services/secrets.ts", "services/local-agent.ts", "services/team.ts", "services/browser-engine.ts",
    // Receipt classification is part of the real MCP dispatch, not an optional
    // capability. Compile the production classifier in this realm as well.
    "services/agent/tool-outcome.ts",
    "services/rest-api-server.ts", "services/mcp-server.ts", "services/http/auth.ts", "services/http/body.ts", "services/server-mode.ts", "branding.ts", "ipc/agent.ts",
  ]);
  function load(relative: string): any {
    const full = path.resolve(SOURCE, relative.replace(/\.js$/, ".ts"));
    if (modules.has(full)) return modules.get(full).exports;
    const module = { exports: {} as any }; modules.set(full, module);
    function req(name: string): any {
      if (name === "electron") return {
        app: { getPath: () => dir }, safeStorage: opaque("Keychain"),
        ipcMain: { handle: (channel: string, handler: any) => handlers.set(channel, handler) },
        clipboard: { writeText: (text: string) => { clipboardAttempts.push(text); throw new Error("synthetic clipboard blocked"); } },
        dialog: opaque("dialog"), BrowserWindow: opaque("window"),
      };
      if (name === "node:fs") return localFs(dir, faults);
      if (name === "node:path") return path;
      if (name === "node:crypto") return crypto;
      if (name === "node:util") return util;
      if (name === "node:os") return { homedir: () => dir, hostname: () => "transport-synthetic" };
      if (name === "node:net") return { isIP: net.isIP, isIPv4: net.isIPv4, isIPv6: net.isIPv6 };
      if (name === "node:http") return {
        createServer: (handler: any) => {
          callback = handler;
          const server: any = new EventEmitter();
          server.listen = (_port: any, _host: any, ready: any) => ready();
          server.address = () => ({ port: 1 });
          server.close = (finish: any) => finish();
          return server;
        },
      };
      if (name.startsWith("node:")) return opaque(name);
      // Normalize only logical module IDs; keep actual filesystem paths native.
      const relative = path.relative(SOURCE, path.resolve(path.dirname(full), name.replace(/\.js$/, ".ts"))).replace(/\\/g, "/");
      if (allow.has(relative)) return load(relative);
      if (relative === "services/browser-manager.ts") return new Proxy({
        listBrowserProfiles: () => createdProfileOpts.map((opts, index) => ({ ...opts, dirId: `synthetic_created_${index}` })),
        createBrowserProfile: (opts: any) => {
          const index = createdProfileOpts.push(structuredClone(opts)) - 1;
          return { dirId: `synthetic_created_${index}` };
        },
        launchBrowser: async (dirId: string, opts?: any) => {
          browserLaunch.calls.push({ dirId, opts: structuredClone(opts) });
          if (!browserLaunch.error) return fail("unconfigured browser launch")();
          throw browserLaunch.error;
        },
        touchProfileActivity: (dirId: string) => { browserLaunch.activityCalls.push(dirId); },
      } as Record<string, any>, { get: (target, key: string) => key in target ? target[key] : opaque(relative)[key] });
      if (relative === "services/utils.ts") return { validateDirId: (s: string) => { if (!/^[\w-]+$/.test(s)) throw new Error("bad dirId"); } };
      if (relative === "services/main-i18n.ts") return { tMain: (key: string) => key };
      if (relative === "services/browser-fingerprint-config.ts") return { validateBrowserHardwareProfile: (value: any) => value };
      if (relative === "services/fingerprint-baseline.ts") return { sanitizePortableFingerprintBaseline: () => undefined };
      if (relative === "services/native-chromium-manager.ts") return { normalizeManagedChromiumVersion: () => null };
      if (relative === "services/agent-run-retention.ts") return { isOwnedRun: () => false, retainAgentRuns: (rows: any[]) => ({ kept: rows, dropped: [] }), cleanupNormalizedRunEvictions() {} };
      if (relative === "services/audit-log.ts") return { recordAudit: (value: any) => audits.push(value) };
      if (relative === "services/skill-repository.ts") return { BUILTIN_SKILLS: [] };
      return opaque(relative);
    }
    vm.runInContext(`(function(require,module,exports,__filename,__dirname) { ${compile(full)}\n})`, context, { filename: full })(req, module, module.exports, full, path.dirname(full));
    return module.exports;
  }
  const vault = load("services/secrets.ts");
  vault.initializeSecretStorage(vault.planSecretStorage({ userDataDir: dir, environment: { AGENT_BROWSER_SECRET_BACKEND: "file" } }));
  const config = load("services/config-manager.ts");
  const store = load("services/config/store.ts");
  const agent = load("services/local-agent.ts");
  config.getConfig();
  agent.saveAccounts(["A", "B", "C"].map((name) => ({
    platformUrl: "https://account.synthetic.invalid", platformUserName: name,
    platformPassword: "synthetic-" + name, tags: [name], profileIds: ["profile_" + name], createdAt: 1, updatedAt: 1,
  })));
  load("ipc/agent.ts").registerAgentHandlers();
  let api: any;
  vm.runInContext(fs.readFileSync(path.join(SOURCE, "preload.cjs"), "utf8"), realm({ require: () => ({
    contextBridge: { exposeInMainWorld: (_key: string, value: any) => { api = value; } },
    ipcRenderer: { invoke: async (name: string, ...args: any[]) => {
      calls.push({ name, args: structuredClone(args) });
      try {
        if (!handlers.has(name)) throw new Error("unregistered handler " + name);
        return structuredClone(await handlers.get(name)!({ sender: {} }, ...args));
      } catch (error: any) {
        // Deliberately remove custom properties, as Electron's message-only
        // transport may do. Tests must not depend on code crossing IPC intact.
        throw new Error(`Error invoking remote method '${name}': Error: ${error.message}`);
      }
    } },
  }) }));
  const rest = transport === "rest" ? load("services/rest-api-server.ts") : undefined;
  const mcp = transport === "mcp" ? load("services/mcp-server.ts") : undefined;
  if (mcp) mcp.startMcpServer();
  else rest.startRestApiServer();
  function request(method: string, route: string, body?: any, headers: any = {}, queued = false) {
    const req: any = new EventEmitter();
    req.method = method; req.url = route; req.headers = { host: "127.0.0.1", authorization: "Bearer synthetic-transport-token", ...headers };
    req.socket = { remoteAddress: "127.0.0.1" }; req.destroy = () => {};
    const response = { status: 0, headers: {} as Record<string, any>, body: undefined as any };
    const res = {
      setHeader: (key: string, value: string) => { response.headers[key.toLowerCase()] = value; },
      writeHead: (status: number, values?: any) => { response.status = status; for (const [k, v] of Object.entries(values || {})) response.headers[k.toLowerCase()] = v; },
      end: (text?: string) => { response.body = text ? JSON.parse(text) : undefined; },
    };
    const finish = () => { if (body !== undefined) req.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body))); req.emit("end"); };
    const pending = callback!(req, res).then(() => response);
    if (!queued) finish();
    return { pending, finish, req, response };
  }
  const ref = (index: number) => agent.getRedactedAccounts()[index].ref;
  const bytes = () => fs.readFileSync(path.join(dir, "config.json"));
  const rows = () => JSON.parse(bytes().toString()).accounts;
  function role(value: string, enabled = true) {
    store.transact((draft: any) => { draft.team = {
      workspaceId: "synthetic-workspace", name: "synthetic-team", ownerDeviceId: "other", createdAt: 1, updatedAt: 1,
      enabled, members: [{ deviceId: draft.deviceId, name: "synthetic", role: value, addedAt: 1 }],
    }; });
  }
  return { dir, agent, config, store, vault, api: api.agent.accounts, rest, request, ref, bytes, rows, role, faults, audits, clipboardAttempts, calls, createdProfileOpts, browserLaunch,
    exportData: (scope: string) => load("services/data-export.ts").exportData(scope),
    syncState: () => load("services/sync/operation-state.ts").getSyncOperationState(), handlers };
}
async function rejection(pending: Promise<any>, code: string) {
  let error: any;
  try { await pending; } catch (value) { error = value; }
  expect(error, `expected rejection ${code}, never a truthy envelope`).toBeDefined();
  expect(error.code).toBe(code);
  expect(error.message).toContain(code + ":");
}
const match = (ref: any) => ({ "if-match": `"${ref.revision}"` });

// No cleanup in retained evidence runs; regular unit runs own and remove only
// this new synthetic tree, never any original data or old proof artifacts.
afterAll(() => {
  const stored = fs.readdirSync(ROOT).filter(name => name.startsWith("data-")).map(name => {
    const file = path.join(ROOT, name, "config.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    return { file, accountCount: config.accounts?.length || 0,
      usernames: (config.accounts || []).map((a: any) => a.platformUserName),
      encryptedNonemptyPasswords: (config.accounts || []).every((a: any) => !a.platformPassword || a.platformPassword.startsWith("v2:")) };
  });
  fs.writeFileSync(path.join(ROOT, "proof-storage-manifest.json"), JSON.stringify({ root: ROOT, prohibitedCalls: prohibited, stored }, null, 2));
  expect(prohibited).toEqual([]);
  if (!process.env.ACCOUNT_TRANSPORT_RETAIN) fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("migration passphrase stays outside generic account/export surfaces", () => {
  it.each(["rest", "mcp"] as const)("isolates local sync ciphertext from %s account replies and structured exports", async transport => {
    const f = fixture(transport), phrase = "synthetic migration isolation phrase";
    const generation = f.syncState().generation;
    f.config.setSyncConfig({ fullProfilePassphrase: phrase });
    expect(f.syncState().generation).toBeGreaterThan(generation); expect(f.syncState().active).toBeNull();
    const cipher = JSON.parse(f.bytes().toString("utf8")).sync.fullProfilePassphrase;
    expect(cipher).toMatch(/^v2:/); expect(f.vault.decryptSecret(cipher) === phrase).toBe(true);
    // A foreign account row must not smuggle configuration secrets through a
    // metadata response; the real config normalizer drops non-account fields.
    f.store.transact((draft: any) => { draft.accounts[0].fullProfilePassphrase = phrase; draft.accounts[0].localVault = cipher; });
    expect(f.rows()[0]).not.toHaveProperty("fullProfilePassphrase"); expect(f.rows()[0]).not.toHaveProperty("localVault");
    const ipc = await f.api.list(), exported = f.exportData("accounts");
    const response = transport === "rest"
      ? await f.request("GET", "/api/accounts").pending
      : await f.request("POST", "/mcp", { jsonrpc: "2.0", id: "migration-isolation", method: "tools/call", params: { name: "agent_browser_list_accounts", arguments: {} } }).pending;
    expect(response.status).toBe(200);
    const publicData = JSON.stringify({ ipc, exported, reply: response.body });
    expect(publicData.includes(phrase)).toBe(false); expect(publicData.includes(cipher)).toBe(false);
    expect(publicData).not.toContain("fullProfilePassphrase"); expect(publicData).not.toContain("localVault");
    expect(f.handlers.has("config:get")).toBe(false); expect(f.handlers.has("config:export")).toBe(false);
    f.config.reloadConfig(); expect(f.vault.decryptSecret(f.config.getSyncConfig().fullProfilePassphrase) === phrase).toBe(true);
  });
});

describe("whole preload/IPC account targeting", () => {
  it("publishes detached redacted list/add/update/bind results and global profile refs", async () => {
    const f = fixture();
    const list = await f.api.list();
    expect(list).toHaveLength(3);
    expect(list.every((row: any) => row.hasPassword && !('platformPassword' in row))).toBe(true);
    const selected = (await f.api.forProfile("profile_B"))[0];
    expect(selected.ref.index).toBe(1); expect(selected.ref).toEqual(list[1].ref);
    expect(await f.api.get(1, selected.ref)).toEqual(selected);
    const added = await f.api.add({ platformUrl: " https://new.synthetic.invalid ", platformUserName: " new ", platformPassword: "synthetic-new" });
    expect(added.hasPassword).toBe(true); expect(added.ref.index).toBe(3); expect(added.platformUserName).toBe("new");
    expect(added).not.toHaveProperty("platformPassword");
    const updated = await f.api.update(1, { platformUserName: " B-updated ", platformPassword: "" }, f.ref(1));
    expect(updated.hasPassword).toBe(true); expect(updated.platformUserName).toBe("B-updated");
    expect(f.rows()[1].platformUserName).toBe("B-updated");
    expect(f.agent.getAccountPassword(1, updated.ref)).toBe("synthetic-B");
    const bound = await f.api.bind(1, [], updated.ref);
    expect(bound.hasPassword).toBe(true); expect(bound.profileIds).toBeUndefined();
    const disk = f.rows(); f.config.reloadConfig();
    expect(f.rows()).toEqual(disk);
    expect(f.agent.getProfileAccounts("unrelated").map((x: any) => x.platformUserName)).toContain("B-updated");
    expect(f.agent.getRedactedAccounts().filter((x: any) => x.platformUserName.includes("updated"))).toHaveLength(1);
  });
  for (const operation of ["update", "bind", "delete", "get", "copyUsername", "copyPassword"]) {
    it(`rejects stale displayed B ${operation} after A deletion, with unchanged disk/audit/clipboard`, async () => {
      const f = fixture(); const ref = (await f.api.list())[1].ref;
      await f.api.delete(0, f.ref(0));
      const before = f.bytes(), revision = f.ref(1), audits = f.audits.length;
      const calls: Record<string, () => Promise<any>> = {
        update: () => f.api.update(1, { platformUserName: "wrong-C" }, ref),
        bind: () => f.api.bind(1, ["wrong_C"], ref), delete: () => f.api.delete(1, ref),
        get: () => f.api.get(1, ref), copyUsername: () => f.api.copyUsername(1, ref), copyPassword: () => f.api.copyPassword(1, ref),
      };
      await rejection(calls[operation](), "ACCOUNT_REFERENCE_CONFLICT");
      expect(f.bytes()).toEqual(before); expect(f.ref(1)).toEqual(revision); expect(f.audits).toHaveLength(audits);
      expect(f.clipboardAttempts).toEqual([]);
      expect(f.rows().map((r: any) => r.platformUserName)).toEqual(["B", "C"]);
    });
  }
  it("repeated deletion rejects instead of deleting the successor", async () => {
    const f = fixture(), ref = f.ref(0);
    expect(await f.api.delete(0, ref)).toBe(true); const before = f.bytes();
    await rejection(f.api.delete(0, ref), "ACCOUNT_REFERENCE_CONFLICT"); expect(f.bytes()).toEqual(before);
  });
  for (const op of ["update", "bind", "delete", "get", "copyUsername", "copyPassword"]) {
    it(`unguarded legacy ${op} rejects, rather than truthy success`, async () => {
      const f = fixture(), before = f.bytes();
      const calls: any = { update: () => f.api.update(0, {}), bind: () => f.api.bind(0, []), delete: () => f.api.delete(0), get: () => f.api.get(0), copyUsername: () => f.api.copyUsername(0), copyPassword: () => f.api.copyPassword(0) };
      await rejection(calls[op](), "ACCOUNT_REFERENCE_REQUIRED"); expect(f.bytes()).toEqual(before); expect(f.clipboardAttempts).toEqual([]);
    });
  }
  it("malformed/current-valid missing refs remain distinguishable after message-only serialization", async () => {
    const f = fixture(), before = f.bytes();
    await rejection(f.api.delete(0.5, { ...f.ref(0), index: 0.5 }), "ACCOUNT_REFERENCE_INVALID");
    await rejection(f.api.get(90, { ...f.ref(0), index: 90 }), "ACCOUNT_NOT_FOUND");
    expect(f.bytes()).toEqual(before);
  });
  it("enabled viewer gates mutations/secrets before reference or clipboard; disabled team retains policy", async () => {
    const f = fixture(); f.role("viewer"); const before = f.bytes();
    for (const action of [() => f.api.add({}), () => f.api.update(0, {}), () => f.api.delete(0), () => f.api.bind(0, []), () => f.api.copyPassword(0), () => f.api.bulkAdd("x,y")]) await expect(action()).rejects.toThrow("requires member role");
    expect(f.bytes()).toEqual(before); expect(f.clipboardAttempts).toEqual([]);
    f.role("viewer", false);
    await rejection(f.api.delete(0), "ACCOUNT_REFERENCE_REQUIRED");
    expect(await f.api.delete(0, f.ref(0))).toBe(true);
  });
  for (const op of ["copyUsername", "copyPassword"]) it(`current-valid ${op} reaches only blocked synthetic clipboard and never audits success`, async () => {
    const f = fixture(), before = f.bytes();
    await expect(f.api[op](1, f.ref(1))).rejects.toThrow("synthetic clipboard blocked");
    expect(f.clipboardAttempts).toEqual([op === "copyUsername" ? "B" : "synthetic-B"]);
    expect(f.bytes()).toEqual(before); expect(f.audits).toEqual([]);
  });
  it("validation and persistence failures reject and never publish a successful bind audit", async () => {
    const f = fixture(), before = f.bytes(), ref = f.ref(1);
    await rejection(f.api.update(1, { platformUrl: "" }, ref), "ACCOUNT_VALIDATION_FAILED");
    await rejection(f.api.update(1, { ref }, ref), "ACCOUNT_VALIDATION_FAILED");
    f.faults.rename = true;
    await expect(f.api.bind(1, ["other"], ref)).rejects.toThrow("synthetic rename rejected");
    expect(f.bytes()).toEqual(before); expect(f.ref(1)).toEqual(ref); expect(f.audits).toEqual([]);
  });
});

describe("stable launch refusals through whole REST/MCP modules", () => {
  it.each(["host-platform-mismatch", "restart-required"])("REST launch retains structured %s and the original error detail", async code => {
    const f = fixture();
    const error = "Synthetic launch recovery detail";
    f.browserLaunch.error = Object.assign(new Error(error), { code });
    const response = await f.request("POST", "/api/profiles/ab_synthetic_launch/launch", { headless: true }).pending;
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error, code });
    expect(f.browserLaunch.calls).toEqual([{ dirId: "ab_synthetic_launch", opts: { headless: true } }]);
    expect(f.audits).toEqual([]);
  });

  it.each(["host-platform-mismatch", "restart-required"])("MCP launch tool retains structured %s and error inside its text result", async code => {
    const f = fixture("mcp");
    const error = "Synthetic launch recovery detail";
    f.browserLaunch.error = Object.assign(new Error(error), { code });
    const response = await f.request("POST", "/mcp", {
      jsonrpc: "2.0", id: "synthetic-launch-refusal", method: "tools/call",
      params: { name: "agent_browser_launch_profile", arguments: { dirId: "ab_synthetic_launch" } },
    }).pending;
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ jsonrpc: "2.0", id: "synthetic-launch-refusal", result: { isError: true } });
    expect(response.body.error).toBeUndefined();
    expect(response.body.result.content).toHaveLength(1);
    expect(response.body.result.content[0].type).toBe("text");
    expect(JSON.parse(response.body.result.content[0].text)).toEqual({ success: false, error, code });
    expect(f.browserLaunch.calls).toEqual([{ dirId: "ab_synthetic_launch", opts: undefined }]);
    expect(f.browserLaunch.activityCalls).toEqual([]);
  });
});

describe("bulk account profile creation-default forwarding (whole entrypoints)", () => {
  it.each([undefined, "windows", "macos", "android"])("local-agent preserves %s, including omission, at the common-create boundary", platform => {
    const f = fixture();
    const items = [{ url: "https://defaults.synthetic.invalid", username: "local-default", tags: ["keep-region"] }];
    const result = f.agent.bulkCreateProfilesWithAccounts(items, platform === undefined ? undefined : { platform });
    expect(result).toEqual({ added: 1, skipped: 0, created: 1, errors: [] });
    expect(f.createdProfileOpts).toHaveLength(1);
    expect(f.createdProfileOpts[0]).toEqual({ name: "defaults.synthetic.invalid · local-default", platform, tags: ["keep-region"] });
    const stored = f.rows().find((row: any) => row.platformUserName === "local-default");
    expect(stored.profileIds).toEqual(["synthetic_created_0"]);
    f.config.reloadConfig();
    expect(f.agent.getProfileAccounts("synthetic_created_0").find((row: any) => row.platformUserName === "local-default").profileIds).toEqual(stored.profileIds);
  });

  it.each([undefined, "windows", "macos", "android"])("REST account bulk preserves %s, including omission, through the real dispatcher", async platform => {
    const f = fixture();
    const body = { text: "https://defaults.synthetic.invalid,rest-default,,keep-region", createProfiles: true, ...(platform === undefined ? {} : { platform }) };
    const denied = await f.request("POST", "/api/accounts/bulk", body, { authorization: undefined }).pending;
    expect(denied.status).toBe(401);
    expect(f.createdProfileOpts).toEqual([]);
    const result = await f.request("POST", "/api/accounts/bulk", body).pending;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true, report: { added: 1, skipped: 0, created: 1, errors: [] } });
    expect(f.createdProfileOpts).toEqual([{ name: "defaults.synthetic.invalid · rest-default", platform, tags: ["keep-region"] }]);
    const disk = f.rows();
    expect(disk.find((row: any) => row.platformUserName === "rest-default").profileIds).toEqual(["synthetic_created_0"]);
    f.config.reloadConfig();
    expect(f.rows()).toEqual(disk);
    const list = await f.request("GET", "/api/accounts").pending;
    expect(list.body.accounts.filter((row: any) => row.username.includes("rest-default"))).toHaveLength(1);
  });
});

describe("whole REST dispatcher/wrapper without sockets", () => {
  it("exposes usable body revision/ETag and no-store with existing row fields", async () => {
    const f = fixture(), response = await f.request("GET", "/api/accounts").pending;
    expect(response.status).toBe(200);
    expect(response.body.accounts[1]).toMatchObject({ index: 1, url: "https://account.synthetic.invalid", username: "B", hasPassword: true, tags: ["B"], profileIds: ["profile_B"] });
    expect(response.body.revision).toBe(f.ref(1).revision);
    expect(response.body.accounts[1].ref).toEqual(f.ref(1));
    expect(response.headers.etag).toBe(`"${response.body.revision}"`);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(response.body)).not.toContain("synthetic-B");
    expect(response.headers["access-control-allow-headers"]).toContain("If-Match");
    expect(response.headers["access-control-expose-headers"]).toContain("ETag");
  });
  for (const [method, route, body] of [["PATCH", "/api/accounts/1", { username: "changed" }], ["DELETE", "/api/accounts/1", undefined], ["GET", "/api/accounts/1/password", undefined]] as const) {
    it(`${method} selected target requires If-Match then returns stale 412, not 400/200`, async () => {
      const f = fixture(); const ref = f.ref(1);
      const absent = await f.request(method, route, body).pending;
      expect(absent.status).toBe(428); expect(absent.body.code).toBe("ACCOUNT_REFERENCE_REQUIRED");
      await f.api.delete(0, f.ref(0)); const before = f.bytes(), audits = f.audits.length;
      const stale = await f.request(method, route, body, match(ref)).pending;
      expect(stale.status).toBe(412); expect(stale.body.code).toBe("ACCOUNT_REFERENCE_CONFLICT");
      expect(stale.headers["cache-control"]).toBe("no-store"); expect(f.bytes()).toEqual(before); expect(f.audits).toHaveLength(audits);
    });
  }
  for (const value of ["*", "", 'W/"550e8400-e29b-41d4-a716-446655440000"', "550e8400-e29b-41d4-a716-446655440000", '"bad"', '"550e8400-e29b-41d4-a716-446655440000", "550e8400-e29b-41d4-a716-446655440000"', ['"550e8400-e29b-41d4-a716-446655440000"'], ' "550e8400-e29b-41d4-a716-446655440000"']) {
    it(`rejects non-exact strong If-Match ${JSON.stringify(value)}`, async () => {
      const f = fixture(), before = f.bytes();
      const r = await f.request("DELETE", "/api/accounts/1", undefined, { "if-match": value }).pending;
      expect(r.status).toBe(400); expect(r.body.code).toBe("ACCOUNT_REFERENCE_INVALID"); expect(f.bytes()).toEqual(before);
    });
  }
  it("awaits queued body then performs live synchronous validation; no destructive retry", async () => {
    const f = fixture(), ref = f.ref(1);
    const queued = f.request("PATCH", "/api/accounts/1", { username: "wrong-C" }, match(ref), true);
    await f.api.delete(0, f.ref(0)); const before = f.bytes(); queued.finish();
    const result = await queued.pending;
    expect(result.status).toBe(412); expect(f.bytes()).toEqual(before);
    expect(f.rows().map((r: any) => r.platformUserName)).toEqual(["B", "C"]);
    expect(f.audits.filter(a => a.action === "update")).toEqual([]);
  });
  it("repeat DELETE and current-valid missing/unsafe numeric targets have exact status", async () => {
    const f = fixture(), ref = f.ref(0);
    expect((await f.request("DELETE", "/api/accounts/0", undefined, match(ref)).pending).status).toBe(200);
    const before = f.bytes();
    expect((await f.request("DELETE", "/api/accounts/0", undefined, match(ref)).pending).status).toBe(412);
    expect((await f.request("DELETE", "/api/accounts/90", undefined, match(f.ref(0))).pending).status).toBe(404);
    expect((await f.request("DELETE", "/api/accounts/9007199254740992", undefined, match(f.ref(0))).pending).status).toBe(400);
    expect(f.bytes()).toEqual(before);
  });
  it("valid writes use committed redaction/normalization, retain ciphertext and binding semantics", async () => {
    const f = fixture(), ciphertext = f.rows()[1].platformPassword;
    const result = await f.request("PATCH", "/api/accounts/1", { username: " B-rest ", password: "", tags: [" x ", "x"], profileIds: [] }, match(f.ref(1))).pending;
    expect(result.status).toBe(200); expect(result.body.account.hasPassword).toBe(true);
    expect(result.body.account.username).toBe("B-rest"); expect(result.body.account.tags).toEqual(["x"]);
    expect(result.body.account.ref).toEqual(f.ref(1)); expect(f.rows()[1].profileIds).toBeUndefined();
    expect(f.rows()[1].platformPassword).toBe(ciphertext);
    const reveal = await f.request("GET", "/api/accounts/1/password", undefined, match(f.ref(1))).pending;
    expect(reveal.status).toBe(200); expect(reveal.body.password).toBe("synthetic-B"); expect(reveal.headers["cache-control"]).toBe("no-store");
    const changed = await f.request("PATCH", "/api/accounts/1", { password: "synthetic-changed" }, match(f.ref(1))).pending;
    expect(changed.status).toBe(200); expect(f.rows()[1].platformPassword).not.toBe(ciphertext);
    const disk = f.rows(); f.config.reloadConfig(); expect(f.rows()).toEqual(disk);
    expect(f.agent.getAccountPassword(1, f.ref(1))).toBe("synthetic-changed");
    expect(f.agent.getProfileAccounts("unbound_lookup").map((r: any) => r.platformUserName)).toContain("B-rest");
  });
  for (const body of [{ url: "" }, { username: null }, { password: 3 }, { profileIds: null }, { tags: [3] }, { ref: "client" }, { index: 0 }, { revision: "client" }, [], null]) it(`rejects malformed/server-owned PATCH fields ${JSON.stringify(body)} without write`, async () => {
    const f = fixture(), before = f.bytes(), ref = f.ref(1);
    const r = await f.request("PATCH", "/api/accounts/1", body, match(ref)).pending;
    expect(r.status).toBe(400); expect(r.body.code).toBe("ACCOUNT_VALIDATION_FAILED"); expect(f.bytes()).toEqual(before); expect(f.ref(1)).toEqual(ref); expect(f.audits).toEqual([]);
  });
  it("valid-current missing credential is 404, never a successful credential envelope", async () => {
    const f = fixture();
    f.agent.saveAccounts([{ platformUrl: "https://empty.synthetic.invalid", platformUserName: "empty", platformPassword: "" }]);
    const r = await f.request("GET", "/api/accounts/0/password", undefined, match(f.ref(0))).pending;
    expect(r.status).toBe(404); expect(r.headers["cache-control"]).toBe("no-store"); expect(f.audits).toEqual([]);
  });
  it("synthetic wrapper authenticates before any protected store access and preserves public policy", async () => {
    const f = fixture();
    for (const route of ["/health", "/openapi.json"]) expect((await f.request("GET", route, undefined, { authorization: undefined }).pending).status).toBe(200);
    // Break private read integrity: authorized access throws, unauthenticated
    // access must still return 401, proving it never reached account reads.
    f.config.getConfig().accounts[0].platformUserName = "uncommitted";
    expect((await f.request("GET", "/api/accounts", undefined, { authorization: undefined }).pending).status).toBe(401);
    expect((await f.request("GET", "/api/accounts").pending).status).toBe(500);
    expect((await f.request("DELETE", "/api/accounts/0", undefined, { authorization: undefined }).pending).status).toBe(401);
    expect(f.audits).toEqual([]);
  });
  it("enabled team viewer is 403 before header/body/access validation, including queued bodies", async () => {
    const f = fixture(); f.role("viewer"); const before = f.bytes();
    for (const [method, route] of [["PATCH", "/api/accounts/1"], ["DELETE", "/api/accounts/1"], ["GET", "/api/accounts/1/password"], ["POST", "/api/accounts"], ["POST", "/api/accounts/bulk"]]) {
      const queued = f.request(method, route, undefined, {}, true);
      expect((await queued.pending).status).toBe(403); expect(queued.req.listenerCount("data")).toBe(0);
    }
    expect(f.bytes()).toEqual(before); expect(f.audits).toEqual([]);
    f.role("viewer", false);
    expect((await f.request("DELETE", "/api/accounts/1", undefined, match(f.ref(1))).pending).status).toBe(200);
  });
  it("POST/add and bulk preserve success shapes while returning redacted normalized data", async () => {
    const f = fixture();
    const added = await f.request("POST", "/api/accounts", { url: " https://new.synthetic.invalid ", username: " new ", password: "synthetic-new", tags: [" x ", "x"] }).pending;
    expect(added.status).toBe(201); expect(added.body.success).toBe(true);
    expect(added.body.account).toMatchObject({ index: 3, username: "new", hasPassword: true, tags: ["x"] });
    expect(added.body.account.ref).toEqual(f.ref(3)); expect(added.body.account).not.toHaveProperty("platformPassword");
    expect(f.rows()[3].platformPassword).toMatch(/^v2:/);
    const bulk = await f.request("POST", "/api/accounts/bulk", { text: "https://bulk.synthetic.invalid,bulk,synthetic-bulk" }).pending;
    expect(bulk.status).toBe(200); expect(bulk.body).toEqual({ success: true, report: { added: 1, skipped: 0, errors: [] } });
    expect(f.rows()[4].platformUserName).toBe("bulk"); expect(f.agent.getAccountPassword(4, f.ref(4))).toBe("synthetic-bulk");
  });
  it("role demotion during a queued body denies writes before committing or auditing", async () => {
    const f = fixture(); f.role("member");
    const queued = f.request("PATCH", "/api/accounts/1", { username: "wrong-B" }, match(f.ref(1)), true);
    f.role("viewer"); const before = f.bytes(); queued.finish();
    expect((await queued.pending).status).toBe(403); expect(f.bytes()).toEqual(before); expect(f.audits).toEqual([]);
  });
  it("REST persistence failures retain disk/cache/revision and publish no audit", async () => {
    const f = fixture(), before = f.bytes(), ref = f.ref(1); f.faults.rename = true;
    const r = await f.request("PATCH", "/api/accounts/1", { username: "not-committed" }, match(ref)).pending;
    expect(r.status).toBe(400); expect(r.body.error).toContain("synthetic rename rejected");
    expect(f.bytes()).toEqual(before); expect(f.ref(1)).toEqual(ref); expect(f.audits).toEqual([]);
    expect(f.agent.getRedactedAccounts()[1].platformUserName).toBe("B");
  });
  it("account-unchanged background saves retain displayed targets; explicit equal replacement/reload invalidate them", async () => {
    const f = fixture(), ref = f.ref(1);
    f.store.transact((draft: any) => { draft.deviceName = "unrelated-background"; });
    expect(await f.api.get(1, ref)).toMatchObject({ platformUserName: "B", ref });
    f.agent.saveAccounts(f.rows());
    await rejection(f.api.get(1, ref), "ACCOUNT_REFERENCE_CONFLICT");
    const current = f.ref(1); f.config.reloadConfig();
    expect((await f.request("GET", "/api/accounts/1/password", undefined, match(current)).pending).status).toBe(412);
  });
  it("OpenAPI documents quoted preconditions, body revision and all failure statuses", async () => {
    const f = fixture(), doc = (await f.request("GET", "/openapi.json").pending).body;
    expect(doc.paths["/api/accounts"].get.description).toContain("revision");
    for (const route of ["/api/accounts/{index}", "/api/accounts/{index}/password"]) {
      expect(doc.paths[route].parameters.find((p: any) => p.name === "If-Match")).toMatchObject({ in: "header", required: true });
    }
    for (const op of [doc.paths["/api/accounts/{index}"].patch, doc.paths["/api/accounts/{index}"].delete, doc.paths["/api/accounts/{index}/password"].get]) for (const code of [200, 400, 401, 403, 404, 412, 428]) expect(op.responses[code]).toBeDefined();
  });
});

function jsSdk() {
  const requests: any[] = [];
  let status = 200;
  const context = realm({ setTimeout, clearTimeout, AbortController,
    fetch: async (endpoint: string, init: any) => { requests.push({ endpoint, init }); return { ok: status === 200, status, text: async () => JSON.stringify(status === 200 ? { success: true } : { error: "ACCOUNT_REFERENCE_CONFLICT: explicitly reselect", code: "ACCOUNT_REFERENCE_CONFLICT" }) }; },
  });
  const module = { exports: {} as any };
  const file = path.join(PROJECT, "sdk/js/agent-browser.mjs");
  vm.runInContext(`(function(require,module,exports){${compile(file)}\n})`, context)(fail("SDK dynamic import"), module, module.exports);
  return { client: new module.exports.AgentBrowserClient("https://sdk.synthetic.invalid", { token: "synthetic-sdk-token" }), requests, status: (s: number) => { status = s; } };
}
describe("actual shipped SDK header compatibility without network", () => {
  it("JavaScript generic request and all verbs accept additive If-Match, preserve old body slots and auth", async () => {
    const f = jsSdk(), h = { "If-Match": '"550e8400-e29b-41d4-a716-446655440000"' };
    await f.client.request("PATCH", "/api/accounts/1", { username: "changed" }, h);
    await f.client.patch("/api/accounts/1", { username: "changed" }, h);
    await f.client.delete("/api/accounts/1", h); await f.client.get("/api/accounts/1/password", h);
    await f.client.put("/x", { old: true }, h); await f.client.post("/x", { old: true }, h);
    expect(f.requests).toHaveLength(6);
    for (const r of f.requests) { expect(r.init.headers["if-match"]).toBe(h["If-Match"]); expect(r.init.headers.authorization).toBe("Bearer synthetic-sdk-token"); }
    expect(JSON.parse(f.requests[0].init.body)).toEqual({ username: "changed" });
    await f.client.post("/old", { old: "positional" }); expect(JSON.parse(f.requests[6].init.body)).toEqual({ old: "positional" });
  });
  it("JavaScript case-insensitive auth overrides reject before fetch and 412 never auto-retries", async () => {
    const f = jsSdk();
    for (const header of ["Authorization", "AUTHORIZATION", "X-Agent-Browser-Token", "x-cloak-token"]) await expect(f.client.delete("/x", { [header]: "wrong" })).rejects.toThrow("cannot override authentication");
    expect(f.requests).toEqual([]); f.status(412);
    await expect(f.client.delete("/api/accounts/1", { "If-Match": '"550e8400-e29b-41d4-a716-446655440000"' })).rejects.toThrow("412: ACCOUNT_REFERENCE_CONFLICT");
    expect(f.requests).toHaveLength(1);
  });
  it("Python optional headers preserve positional auth/body and expose 412 without retry", () => {
    const script = `import json,sys,urllib.request,urllib.error,socket,io
socket.socket=lambda *a,**k: (_ for _ in ()).throw(AssertionError('network forbidden'))
ns={}; exec(compile(open(sys.argv[1]).read(),sys.argv[1],'exec'),ns)
c=ns['AgentBrowserClient']('https://sdk.synthetic.invalid','synthetic-python-token')
requests=[]
class Response:
 def __enter__(self): return self
 def __exit__(self,*a): pass
 def read(self): return b'{"success":true}'
def fake(req,timeout): requests.append(req); return Response()
urllib.request.urlopen=fake
h={'If-Match':'"550e8400-e29b-41d4-a716-446655440000"'}
for fn,args in [(c.request,('PATCH','/api/accounts/1',{'username':'changed'},True,h)),(c.patch,('/api/accounts/1',{'username':'changed'},True,h)),(c.delete,('/api/accounts/1',True,h)),(c.get,('/api/accounts/1/password',True,h)),(c.put,('/x',{'old':True},True,h)),(c.post,('/x',{'old':True},True,h))]:
 assert fn(*args)=={'success':True}
for r in requests:
 assert r.get_header('If-match')==h['If-Match']; assert r.get_header('Authorization')=='Bearer synthetic-python-token'
assert json.loads(requests[0].data)=={'username':'changed'}
c.get('/old',False); assert requests[-1].get_header('Authorization') is None
c.post('/old',{'old':'positional'},False); assert json.loads(requests[-1].data)=={'old':'positional'}; assert requests[-1].get_header('Authorization') is None
count=len(requests)
for name in ['AUTHORIZATION','X-Agent-Browser-Token','x-cloak-token']:
 try: c.delete('/x',headers={name:'wrong'})
 except ns['AgentBrowserError'] as e: assert 'cannot override authentication' in str(e)
 else: raise AssertionError('auth override accepted')
assert len(requests)==count
def conflict(req,timeout):
 requests.append(req); raise urllib.error.HTTPError(req.full_url,412,'conflict',{},io.BytesIO(b'{"error":"ACCOUNT_REFERENCE_CONFLICT: explicitly reselect"}'))
urllib.request.urlopen=conflict
try: c.delete('/api/accounts/1',headers=h)
except ns['AgentBrowserError'] as e: assert '412' in str(e) and 'ACCOUNT_REFERENCE_CONFLICT' in str(e)
else: raise AssertionError('conflict did not reject')
assert len(requests)==count+1
print(json.dumps({'requests':len(requests),'prohibited':0,'positionalAuthPreserved':True,'conflictNoRetry':True}))`;
    const result = spawnSync("python3", ["-I", "-c", script, path.join(PROJECT, "sdk/python/agent_browser_client.py")], { timeout: 10000, encoding: "utf8", env: { ...process.env, HOME: ROOT, TMPDIR: ROOT, PYTHONDONTWRITEBYTECODE: "1" } });
    fs.writeFileSync(path.join(ROOT, "python-proof.json"), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
    expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).conflictNoRetry).toBe(true);
  });
});

// Evaluate the actual complete entry module, only rewriting import mechanics
// for VM evaluation. All service facades record import order; native/window/
// readiness calls are controlled, with no Electron process or GUI launch.
async function entry(dir: string, argv: string[], env: any, locks: Set<string>) {
  const imports: string[] = [], events: string[] = [], exits: number[] = [];
  let userData = dir, ready: any, admitted = false;
  const app: any = {
    name: "old-name", isPackaged: false, setName: (n: string) => { app.name = n; },
    getPath: (which: string) => which === "userData" ? userData : dir,
    setPath: (_which: string, value: string) => { userData = value; events.push("identity:" + value); },
    requestSingleInstanceLock: () => { events.push("lock:" + userData); if (locks.has(userData)) return false; locks.add(userData); admitted = true; return true; },
    exit: (code: number) => { exits.push(code); }, quit: fail("quit-and-continue"),
    commandLine: { appendSwitch: () => events.push("mock-keychain-switch") },
    whenReady: () => ({ then: (fn: any) => { ready = fn; events.push("whenReady"); } }),
    on: () => {},
  };
  const context = realm({
    process: { argv, env, platform: process.platform, execPath: process.execPath, on() {} },
    console: { log() {}, error() {} }, setInterval: fail("bootstrap interval"), setTimeout: fail("bootstrap timer"),
  });
  const brandingModule = { exports: {} as any };
  vm.runInContext(`(function(require,module,exports){${compile(path.join(SOURCE, "branding.ts"))}})`, context)((name: string) => name === "node:path" ? path : opaque(name), brandingModule, brandingModule.exports);
  function requireEntry(name: string): any {
    if (name === "electron") return { app, BrowserWindow: opaque("bootstrap window"), dialog: opaque("bootstrap dialog"), powerMonitor: opaque("powerMonitor"), session: opaque("session"), shell: opaque("shell") };
    if (name === "node:fs") return localFs(ROOT);
    if (name === "node:path") return path;
    if (name === "node:url") return url;
    if (name === "node:os") return { homedir: () => dir };
    if (name === "./branding.js") return brandingModule.exports;
    imports.push(name);
    if (!admitted) throw new Error("entry import before writer admission: " + name);
    if (name === "./services/secrets.js") return {
      planSecretStorage: (options: any) => { events.push("vault-plan:" + options.userDataDir); return { backend: "file", userDataDir: options.userDataDir }; },
      initializeSecretStorage: fail("unexpected vault init"),
    };
    if (name === "./services/legacy-data-migration.js") return {
      migrateLegacyUserData: () => { events.push("migration"); return { migrated: false }; },
      migrateLegacyChromiumCache: () => ({ migratedVersions: [] }),
    };
    return opaque(name);
  }
  (context as any).__importFixture = async (name: string) => requireEntry(name);
  const source = fs.readFileSync(path.join(SOURCE, "index.ts"), "utf8");
  const transformer: ts.TransformerFactory<ts.SourceFile> = context => file => {
    const visit: ts.Visitor = node => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return ts.factory.createCallExpression(ts.factory.createIdentifier("__importFixture"), undefined, node.arguments);
      if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) return ts.factory.createStringLiteral(url.pathToFileURL(path.join(SOURCE, "index.ts")).toString());
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(file, visit) as ts.SourceFile;
  };
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, transformers: { before: [transformer] } }).outputText;
  let error: any;
  try { await vm.runInContext(`(async function(require,module,exports){${code}\n})`, context)(requireEntry, { exports: {} }, {}); } catch (e) { error = e; }
  return { imports, events, exits, error, userData, ready, admitted };
}
describe("controlled whole-entry writer admission before any side-effect imports", () => {
  for (const mode of [[], ["--headless"], ["--server"], ["--user-data-dir=owned"], ["--user-data-dir", "owned", "--headless"]]) it(`denied entry really stops all bootstrap for ${JSON.stringify(mode)}`, async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, "entry-"));
    const canonical = mode.some(x => x.startsWith("--user-data-dir")) ? dir : path.join(dir, "AgentBrowserStudio");
    const result = await entry(dir, ["node", "entry", ...mode], { AGENT_BROWSER_DISABLE_LEGACY_MIGRATION: "1" }, new Set([canonical]));
    expect(result.error?.message).toContain("WRITER_ADMISSION_REJECTED"); expect(result.exits).toEqual([0]);
    expect(result.imports).toEqual([]); expect(result.ready).toBeUndefined();
    expect(result.events.some(x => x.startsWith("vault-plan") || x === "migration")).toBe(false);
    expect(fs.existsSync(path.join(canonical, "config.json"))).toBe(false); expect(fs.existsSync(path.join(canonical, ".secret-vault-key"))).toBe(false);
  });
  for (const flags of [["--user-data-dir=owned"], ["--user-data-dir", "owned", "--headless"], ["--server"], []]) it(`admitted entry establishes actual identity before imports and retains isolation ${JSON.stringify(flags)}`, async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, "admitted-"));
    const result = await entry(dir, ["node", "entry", ...flags], { AGENT_BROWSER_DISABLE_LEGACY_MIGRATION: "1", M1_DIR: path.join(dir, "m1"), HOME: dir }, new Set());
    expect(result.error).toBeUndefined(); expect(result.admitted).toBe(true); expect(result.exits).toEqual([]);
    expect(result.events.find(x => x.startsWith("lock:"))).toBe("lock:" + result.userData);
    expect(result.events.indexOf("lock:" + result.userData)).toBeLessThan(result.events.findIndex(x => x.startsWith("vault-plan:")));
    expect(result.imports).toContain("./services/config-manager.js"); expect(result.ready).toBeTypeOf("function");
    expect(result.events).not.toContain("migration");
    expect(result.userData).toBe(flags.some(x => x.startsWith("--user-data-dir")) ? dir : path.join(dir, "AgentBrowserStudio"));
  });
  it("canonicalizes symlink directory aliases to the same controlled lock before service imports", async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, "alias-")), actual = path.join(dir, "actual"), alias = path.join(dir, "alias");
    fs.mkdirSync(actual); fs.symlinkSync(actual, alias);
    const locks = new Set<string>();
    const one = await entry(actual, ["node", "entry", "--user-data-dir=actual", "--headless"], {}, locks);
    expect(one.error).toBeUndefined();
    const two = await entry(alias, ["node", "entry", "--user-data-dir=alias"], {}, locks);
    expect(two.userData).toBe(actual); expect(two.error?.message).toContain("WRITER_ADMISSION_REJECTED"); expect(two.imports).toEqual([]);
  });
  it("refuses shared config-file aliases instead of admitting independent directory writers", async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, "config-alias-")), config = path.join(dir, "source.json");
    fs.writeFileSync(config, "{}"); fs.symlinkSync(config, path.join(dir, "config.json"));
    const result = await entry(dir, ["node", "entry", "--user-data-dir=owned"], {}, new Set());
    expect(result.error?.message).toContain("Shared or non-regular config identity"); expect(result.exits).toEqual([1]); expect(result.imports).toEqual([]); expect(result.admitted).toBe(false);
  });
});
