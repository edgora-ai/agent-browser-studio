// Offline whole-module dispatcher proof. Only synthetic scratch config/vault I/O
// is allowed; browser, provider, socket, clipboard and native operations fail closed.
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vm from "node:vm";
import * as crypto from "node:crypto";
import * as util from "node:util";
import * as net from "node:net";
import ts from "typescript";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "account-list-projections-"));
const SOURCE = path.resolve(__dirname, "../../src/main");
const forbidden: string[] = [];
const loaded = new Set<string>();
function fixture(reuse?: string) {
  const dir = reuse || fs.mkdtempSync(path.join(ROOT, "case-"));
  const modules = new Map<string, any>();
  const fail = (name: string) => (..._args: any[]): never => {
    forbidden.push(name);
    throw new Error(`Forbidden account-list fixture operation: ${name}`);
  };
  const denied = (name: string) => new Proxy({}, {
    get: (_target, key) => key === "__esModule" ? false : fail(`${name}.${String(key)}`),
  });
  const scratchFs = new Proxy(fs, { get(target, key) {
    const value = (target as any)[key];
    if (typeof value !== "function") return value;
    return (...args: any[]) => {
      const paths = [args[0], ...(["renameSync", "copyFileSync"].includes(String(key)) ? [args[1]] : [])];
      for (const candidate of paths) {
        if (typeof candidate === "string" && path.resolve(candidate) !== dir && !path.resolve(candidate).startsWith(dir + path.sep)) {
          return fail(`fs outside scratch: ${String(key)}`)();
        }
      }
      return value(...args);
    };
  } });
  const context = vm.createContext({
    Buffer, URL, TextDecoder: util.TextDecoder, __clone: structuredClone,
    process: {
      platform: process.platform, execPath: process.execPath, pid: 246,
      env: { NODE_ENV: "test", HOME: dir, AGENT_BROWSER_SECRET_BACKEND: "file", AGENT_BROWSER_MCP_TOKEN: "synthetic-mcp-token" },
      // A synthetic runtime entry is not a launched browser or OS process.
      kill: (pid: number, signal: number) => {
        if (pid !== 246 || signal !== 0) fail("process.kill")();
      },
    },
    console, setTimeout: fail("timer"), clearTimeout: fail("timer"),
    fetch: fail("provider/network"), WebSocket: fail("websocket"),
  });
  // Preserve same-realm prototypes for the store's isDeepStrictEqual witness.
  vm.runInContext(`globalThis.structuredClone = value => {
    function inRealm(x) {
      if (Array.isArray(x)) return Array.from(x, inRealm);
      if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k,v]) => [k,inRealm(v)]));
      return x;
    }
    return inRealm(__clone(value));
  };`, context);
  const real = new Set([
    "services/local-agent.ts", "services/mcp-server.ts", "services/config-manager.ts",
    "services/config/store.ts", "services/config/paths.ts", "services/config/limits.ts",
    "services/secrets.ts", "services/browser-engine.ts", "branding.ts",
    "services/agent/run-scope.ts", "services/browser/runtime-table.ts",
  ]);
  function load(file: string): any {
    const full = path.resolve(SOURCE, file.replace(/\.js$/, ".ts"));
    const cached = modules.get(full);
    if (cached) return cached.exports;
    const module = { exports: {} as any };
    modules.set(full, module);
    loaded.add(path.relative(SOURCE, full));
    const source = fs.readFileSync(full, "utf8");
    // Test-only exposure of existing private dispatcher/schema, not a replacement
    // implementation, server startup or production export/API modification.
    const facade = file === "services/mcp-server.ts"
      ? "\nexports.__dispatch = executeMcpTool; exports.__tools = MCP_EXPANDED_TOOLS;" : "";
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    function requireFixture(name: string): any {
      if (name === "node:fs") return scratchFs;
      if (name === "node:path") return path;
      if (name === "node:crypto") return crypto;
      if (name === "node:util") return util;
      if (name === "node:os") return { homedir: () => dir, hostname: () => "synthetic-host", platform: () => process.platform };
      if (name === "node:net") return { isIP: net.isIP, isIPv4: net.isIPv4, isIPv6: net.isIPv6 };
      if (name.startsWith("node:")) return denied(name);
      if (name === "electron") return { app: { getPath: () => dir }, safeStorage: denied("native storage"), clipboard: denied("clipboard") };
      const rel = path.relative(SOURCE, path.resolve(path.dirname(full), name.replace(/\.js$/, ".ts")));
      if (real.has(rel)) return load(rel);
      if (rel === "services/utils.ts") return { validateDirId: (value: string) => {
        if (!/^[\w-]+$/.test(value)) throw new Error("Invalid synthetic dirId");
      } };
      if (rel === "services/main-i18n.ts") return { tMain: (key: string) => key };
      if (rel === "services/browser-fingerprint-config.ts") return { validateBrowserHardwareProfile: (value: any) => value };
      if (rel === "services/fingerprint-baseline.ts") return { sanitizePortableFingerprintBaseline: () => undefined };
      if (rel === "services/native-chromium-manager.ts") return { normalizeManagedChromiumVersion: () => null };
      if (rel === "services/agent-run-retention.ts") return {
        isOwnedRun: () => false, retainAgentRuns: (runs: any[]) => ({ kept: runs, dropped: [] }), cleanupNormalizedRunEvictions: () => {},
      };
      if (rel === "services/skill-repository.ts") return { BUILTIN_SKILLS: [], getEnabledSkillPrompts: fail("skills") };
      return denied(rel);
    }
    vm.runInContext(`(function(require,module,exports,__dirname,__filename){${compiled}\n${facade}\n})`, context, { filename: full })
      (requireFixture, module, module.exports, path.dirname(full), full);
    return module.exports;
  }
  const secrets = load("services/secrets.ts");
  secrets.initializeSecretStorage(secrets.planSecretStorage({ userDataDir: dir, environment: { AGENT_BROWSER_SECRET_BACKEND: "file" } }));
  const cfg = load("services/config-manager.ts");
  const agent = load("services/local-agent.ts");
  const mcp = load("services/mcp-server.ts");
  const runtime = load("services/browser/runtime-table.ts");
  runtime.runningProcesses.set("chosen", { pid: 246, process: null, port: 42001, lastActivityAt: 1 });
  const scope = load("services/agent/run-scope.ts").captureChatBrowserScope("chosen");
  cfg.getConfig();
  const bytes = () => fs.readFileSync(path.join(dir, "config.json"));
  const seed = () => agent.saveAccounts([
    { platformUserName: "hidden", platformPassword: "synthetic-hidden-secret", profileIds: ["other"] },
    { platformUserName: "shared", platformPassword: "synthetic-shared-secret" },
    { platformUserName: "selected", platformPassword: "synthetic-selected-secret", profileIds: ["chosen"], tags: ["selected-tag"] },
    { platformUserName: "empty", platformPassword: "", profileIds: ["chosen"] },
    { platformUserName: "omitted", profileIds: ["chosen"] },
    { platformUserName: "bound-nowhere", platformPassword: "synthetic-nowhere-secret", profileIds: [] },
  ].map(row => ({ platformUrl: "https://synthetic.invalid/" + row.platformUserName, createdAt: 1, updatedAt: 1, ...row })));
  return { dir, cfg, agent, mcp, scope, bytes, seed };
}
function plain<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function expectedRows(rows: any[]) {
  return rows.map(row => ({
    url: row.platformUrl, username: row.platformUserName, tags: row.tags,
    ref: row.ref, hasPassword: Boolean(row.platformPassword),
  }));
}
function noSecrets(output: any, stored: any[]) {
  for (const row of output.accounts) {
    expect(row).not.toHaveProperty("platformPassword");
    expect(row).not.toHaveProperty("password");
  }
  const text = JSON.stringify(output);
  for (const row of stored) if (row.platformPassword) expect(text).not.toContain(row.platformPassword);
  for (const name of ["hidden", "shared", "selected", "nowhere"]) expect(text).not.toContain(`synthetic-${name}-secret`);
}
afterAll(() => {
  expect(forbidden).toEqual([]);
  expect([...loaded]).toEqual(expect.arrayContaining([
    "services/local-agent.ts", "services/mcp-server.ts", "services/config/store.ts", "services/config-manager.ts", "services/secrets.ts",
  ]));
  if (!process.env.ACCOUNT_PROJECTION_RETAIN) fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("account list reference and secret-presence projections", () => {
  for (const tool of ["local", "mcp"] as const) {
    it(`${tool} retains each original global ref (missing-reference regression)`, async () => {
      const f = fixture(); f.seed();
      const snapshot = f.agent.getAccounts();
      const output = tool === "local" ? await f.agent.executeToolCall("list_accounts", {})
        : await f.mcp.__dispatch("agent_browser_list_accounts", {});
      expect(output.accounts.map((row: any) => row.ref)).toEqual(snapshot.map((row: any) => row.ref));
      expect(output.accounts.map((row: any) => row.ref.index)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(output.accounts.every((row: any) => /^[0-9a-f-]{36}$/.test(row.ref.revision))).toBe(true);
    });
    it(`${tool} computes hasPassword from stored bytes before redaction`, async () => {
      const f = fixture(); f.seed();
      const output = tool === "local" ? await f.agent.executeToolCall("list_accounts", {})
        : await f.mcp.__dispatch("agent_browser_list_accounts", {});
      expect(output.accounts.map((row: any) => row.hasPassword)).toEqual([true, true, true, false, false, true]);
      noSecrets(output, f.agent.getAccounts());
      expect(plain(output.accounts)).toEqual(plain(expectedRows(f.agent.getAccounts())));
    });
    it(`${tool} reports stored encrypted-empty presence without revealing a password`, async () => {
      const f = fixture(); f.seed();
      f.agent.addAccount({ platformUrl: "https://synthetic.invalid/encrypted-empty", platformUserName: "encrypted-empty", platformPassword: "" });
      const snapshot = f.agent.getAccounts();
      const stored = snapshot[6];
      expect(stored.platformPassword).toMatch(/^v2:/);
      expect(f.agent.getAccountPassword(6, stored.ref)).toBeNull();
      const output = tool === "local" ? await f.agent.executeToolCall("list_accounts", {})
        : await f.mcp.__dispatch("agent_browser_list_accounts", {});
      expect(output.accounts[6].hasPassword).toBe(true);
      expect(output.accounts[6].ref).toEqual(stored.ref);
      noSecrets(output, snapshot);
    });
    it(`${tool} returns detached refs/tags and cannot mutate disk or cached accounts`, async () => {
      const f = fixture(); f.seed();
      const before = f.bytes(), snapshot = plain(f.agent.getAccounts());
      const output = tool === "local" ? await f.agent.executeToolCall("list_accounts", {})
        : await f.mcp.__dispatch("agent_browser_list_accounts", {});
      output.accounts[2].tags.push("poison");
      output.accounts[2].ref.index = 999;
      output.accounts[2].ref.revision = "poison";
      output.accounts[2].username = "poison";
      output.accounts.splice(0, 1);
      expect(f.bytes()).toEqual(before);
      expect(plain(f.agent.getAccounts())).toEqual(snapshot);
    });
  }
  it("filters after assigning global refs and preserves null-scope empty results", async () => {
    const f = fixture(); f.seed();
    const snapshot = f.agent.getAccounts();
    const filtered = await f.agent.executeToolCall("list_accounts", {}, undefined, { browserScope: f.scope });
    expect(filtered.accounts.map((row: any) => row.username)).toEqual(["shared", "selected", "empty", "omitted"]);
    expect(filtered.accounts.map((row: any) => row.ref.index)).toEqual([1, 2, 3, 4]);
    expect(plain(filtered.accounts)).toEqual(plain(expectedRows(snapshot.filter((row: any) => !row.profileIds || row.profileIds.includes("chosen")))));
    noSecrets(filtered, snapshot);
    expect(await f.agent.executeToolCall("list_accounts", {}, undefined, { browserScope: null })).toEqual({ accounts: [] });
  });
  it("keeps existing names/empty-args schemas, allowlist and scope gates", async () => {
    const f = fixture(); f.seed();
    const local = f.agent.AGENT_TOOLS.filter((tool: any) => tool.function.name === "list_accounts");
    const mcp = f.mcp.__tools.filter((tool: any) => tool.name === "agent_browser_list_accounts");
    expect(local).toHaveLength(1); expect(mcp).toHaveLength(1);
    expect(plain(local[0].function.parameters)).toEqual({ type: "object", properties: {}, required: [] });
    expect(plain(mcp[0].inputSchema)).toEqual({ type: "object", properties: {} });
    expect(f.mcp.__tools.filter((tool: any) => /account/.test(tool.name)).map((tool: any) => tool.name)).toEqual(["agent_browser_list_accounts"]);
    await expect(f.agent.executeToolCall("list_accounts", {}, new Set())).rejects.toThrow(/not enabled/);
    await expect(f.agent.executeToolCall("list_accounts", {}, undefined, { browserScope: { ...f.scope } })).rejects.toThrow(/forged/);
  });
  it("the exact F02 synthetic helper forwards the selected row's captured ref", async () => {
    const f = fixture(); f.seed();
    const file = path.resolve(__dirname, "../e2e/f02-sync-credentials.test.ts");
    const source = fs.readFileSync(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const helpers: ts.FunctionDeclaration[] = [];
    function visit(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "assertAccount") helpers.push(node);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    expect(helpers).toHaveLength(1);
    const publicRows = plain(f.agent.getRedactedAccounts());
    const selectedRef = publicRows[2].ref;
    const reads: any[] = [];
    const bridge = { getAccountPassword: (index: number, ref: any) => {
      reads.push({ index, ref });
      return f.agent.getAccountPassword(index, ref);
    } };
    const helperContext = vm.createContext({
      exports: {}, expect,
      readConfig: () => JSON.parse(f.bytes().toString("utf8")), LOCAL_AGENT_URL: "synthetic-local-agent-module",
      h: {
        page: { evaluate: async () => publicRows },
        app: { evaluate: async (callback: any, args: any) => callback({}, args) },
      },
      process: { getBuiltinModule: (name: string) => {
        expect(name).toBe("node:vm");
        return {
          constants: { USE_MAIN_CONTEXT_DEFAULT_LOADER: "synthetic-loader" },
          runInThisContext: async (code: string) => {
            expect(code).toBe('import("synthetic-local-agent-module")');
            return bridge;
          },
        };
      } },
    });
    const compiled = ts.transpileModule(helpers[0].getText(ast) + "\nexports.assertAccount = assertAccount;", {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    vm.runInContext(compiled, helperContext);
    const run = (helperContext as any).exports.assertAccount;
    await run("selected", "synthetic-selected-secret", f.agent.getAccounts()[2].platformPassword, "https://synthetic.invalid/selected");
    expect(reads).toHaveLength(1);
    expect(reads[0].index).toBe(2);
    expect(reads[0].ref).toBe(selectedRef); // exact selected DTO reference, not a latest-index replacement
    await run("empty", null, "", "https://synthetic.invalid/empty");
    expect(reads[1].ref).toBe(publicRows[3].ref);
  });
  it("a listed ref targets only its snapshot and cannot silently select a shifted row", async () => {
    const f = fixture(); f.seed();
    const listed = await f.agent.executeToolCall("list_accounts", {}, undefined, { browserScope: f.scope });
    const selected = listed.accounts.find((row: any) => row.username === "selected");
    expect(selected.ref.index).toBe(2);
    f.agent.deleteAccount(0, f.agent.getAccounts()[0].ref);
    const before = f.bytes();
    expect(() => f.agent.getAccountPassword(selected.ref.index, selected.ref)).toThrow(/ACCOUNT_REFERENCE_CONFLICT/);
    expect(f.bytes()).toEqual(before);
    const freshList = await f.mcp.__dispatch("agent_browser_list_accounts", {});
    const reselected = freshList.accounts.find((row: any) => row.username === "selected");
    expect(reselected.ref.index).toBe(1);
    expect(reselected.ref.revision).not.toBe(selected.ref.revision);
    expect(f.agent.getAccountPassword(reselected.ref.index, reselected.ref)).toBe("synthetic-selected-secret");
    expect(f.bytes()).toEqual(before);
  });
  it("writes real encrypted bytes then reloads and searches global/profile/tool projections", async () => {
    const f = fixture(); f.seed();
    const before = f.bytes();
    const disk = JSON.parse(before.toString("utf8"));
    expect(disk.accounts.map((row: any) => row.platformUserName)).toEqual(["hidden", "shared", "selected", "empty", "omitted", "bound-nowhere"]);
    for (const index of [0, 1, 2, 5]) expect(disk.accounts[index].platformPassword).toMatch(/^v2:/);
    expect(before.toString()).not.toContain("synthetic-selected-secret");
    const old = f.agent.getAccounts()[2].ref;
    const fresh = fixture(f.dir); // new whole modules, physical disk read, not a reused cache
    const rows = fresh.agent.getAccounts();
    expect(plain(rows.map(({ ref: _ref, ...row }: any) => row))).toEqual(disk.accounts);
    expect(rows[2].ref.index).toBe(2);
    expect(rows[2].ref.revision).not.toBe(old.revision);
    expect(() => fresh.agent.getAccountPassword(2, old)).toThrow(/ACCOUNT_REFERENCE_CONFLICT/);
    expect(() => fresh.agent.getAccountPassword(2)).toThrow(/ACCOUNT_REFERENCE_REQUIRED/);
    expect(fresh.agent.getAccountPassword(2, rows[2].ref)).toBe("synthetic-selected-secret");
    const profile = fresh.agent.getProfileAccounts("chosen");
    expect(profile.map((row: any) => row.ref.index)).toEqual([1, 2, 3, 4]);
    expect(profile[1].platformPassword).toBe(disk.accounts[2].platformPassword); // ciphertext internal only
    const redacted = fresh.agent.getRedactedAccounts();
    expect(redacted[2]).not.toHaveProperty("platformPassword");
    expect(redacted[2].hasPassword).toBe(true);
    const local = await fresh.agent.executeToolCall("list_accounts", {}, undefined, { browserScope: fresh.scope });
    const mcp = await fresh.mcp.__dispatch("agent_browser_list_accounts", {});
    for (const output of [local, mcp]) {
      noSecrets(output, rows);
      const matches = output.accounts.filter((row: any) => row.username === "selected" && row.url === "https://synthetic.invalid/selected");
      expect(matches).toHaveLength(1);
      expect(plain(matches[0].ref)).toEqual(plain(rows[2].ref));
      expect(matches[0].hasPassword).toBe(true);
    }
    expect(fresh.bytes()).toEqual(before);
    fresh.cfg.reloadConfig();
    expect(fresh.bytes()).toEqual(before);
    expect(fresh.agent.getAccounts().filter((row: any) => row.platformUserName.includes("selected"))).toHaveLength(1);
  });
});
