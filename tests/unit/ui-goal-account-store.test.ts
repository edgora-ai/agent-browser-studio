// Synthetic Node/VM acceptance only: whole production modules, file vault and
// atomic scratch config writes. No Electron, native storage, network or clipboard.
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vm from "node:vm";
import * as crypto from "node:crypto";
import * as util from "node:util";
import * as net from "node:net";
import * as zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "account-snapshot-proof-"));
const SOURCE = path.resolve(__dirname, "../../src/main");
const paths: string[] = [];
const forbidden: string[] = [];
export function fixture(reuse?: string) {
  const dir = reuse || fs.mkdtempSync(path.join(ROOT, "case-"));
  paths.push(dir);
  const modules = new Map<string, any>();
  const faults = { rename: false, write: false, cleanup: false, creates: 0, nonce: false, renameAccountOnly: false, fetches: 0, syncPayload: null as any, failFetch: false };
  const fail = (name: string) => (..._args: any[]) => {
    forbidden.push(name); throw new Error(`Forbidden fixture operation: ${name}`);
  };
  const denied = (name: string) => new Proxy({}, { get: (_t, key) => key === "__esModule" ? false : fail(`${name}.${String(key)}`) });
  // FS access is permitted only below this fixture. Production sources are read
  // separately by the loader, not through this facade.
  const scratchFs = new Proxy(fs, { get(target, key) {
    const value = (target as any)[key];
    if (typeof value !== "function") return value;
    return (...args: any[]) => {
      for (const arg of [args[0], ...(["renameSync", "copyFileSync"].includes(String(key)) ? [args[1]] : [])]) {
        if (typeof arg === "string" && !(path.resolve(arg) === dir || path.resolve(arg).startsWith(dir + path.sep))) fail(`fs outside fixture: ${key.toString()}`)();
      }
      if (key === "renameSync" && (faults.rename || (faults.renameAccountOnly && JSON.parse(fs.readFileSync(args[0], "utf8")).accounts?.length > 3))) throw new Error("synthetic rename failure");
      if (key === "writeFileSync" && faults.write) throw new Error("synthetic write failure");
      return value(...args);
    };
  } });
  const context = vm.createContext({ Buffer, structuredClone, URL, TextDecoder: util.TextDecoder,
    process: { platform: process.platform, execPath: process.execPath, env: { NODE_ENV: "test", HOME: dir, AGENT_BROWSER_SECRET_BACKEND: "file" } },
    console: { ...console, error: () => {}, warn: () => {} }, setTimeout: fail("timer"), clearTimeout: fail("timer"),
    AbortSignal: { timeout: () => ({ aborted: false }) },
    fetch: async (_url: string, init: any) => {
      if (!faults.syncPayload || init.method !== "GET") return fail("unplanned fetch")();
      faults.fetches++;
      if (faults.failFetch) throw new Error("synthetic fetch failure");
      let read = false;
      const data = Buffer.from(JSON.stringify(faults.syncPayload));
      return { ok: true, status: 200, headers: { get: () => String(data.length) }, body: { getReader: () => ({ read: async () => read ? { done: true } : (read = true, { done: false, value: data }), releaseLock: () => {} }) } };
    },
  });
  // Node's structuredClone runs in its caller's realm; convert its clone into
  // this VM realm, preserving undefined keys. Otherwise prototype differences
  // would falsely invalidate isDeepStrictEqual's committed witness.
  (context as any).__clone = structuredClone;
  vm.runInContext(`globalThis.structuredClone = function(value) {
    function inRealm(x) {
      if (Array.isArray(x)) return Array.from(x, inRealm);
      if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k,v]) => [k,inRealm(v)]));
      return x;
    }
    return inRealm(__clone(value));
  };`, context);
  function load(file: string): any {
    const full = path.resolve(SOURCE, file.replace(/\.js$/, ".ts"));
    if (modules.has(full)) return modules.get(full).exports;
    const module = { exports: {} as any }; modules.set(full, module);
    const source = fs.readFileSync(full, "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    function requireFixture(name: string): any {
      if (name === "node:fs" || name === "fs") return scratchFs;
      if (name === "node:path" || name === "path") return path;
      if (name === "node:crypto") return { ...crypto, randomUUID: () => { if (faults.nonce) throw new Error("synthetic nonce preparation failure"); return crypto.randomUUID(); } };
      if (name === "node:zlib") return zlib;
      if (name === "node:util") return util;
      if (name === "node:os") return { homedir: () => dir, hostname: () => "synthetic-host", platform: () => process.platform, tmpdir: () => dir };
      if (name === "node:net") return { isIP: net.isIP, isIPv4: net.isIPv4, isIPv6: net.isIPv6 };
      // Real SQLite helper code is loaded, but these account-only paths must
      // never start its native checker. Construction records a forbidden call.
      if (name === "node:worker_threads") return { Worker: class {
        constructor(...args: any[]) { fail("native SQLite worker")(...args); }
      } };
      if (name.startsWith("node:")) return denied(name);
      if (name === "electron") return { app: { getPath: () => dir }, safeStorage: denied("native storage"), clipboard: denied("clipboard") };
      const resolved = path.resolve(path.dirname(full), name.replace(/\.js$/, ".ts"));
      // Module IDs are logical slash-delimited names, not native file paths.
      const rel = path.relative(SOURCE, resolved).replace(/\\/g, "/");
      if (["services/config-manager.ts", "services/config/store.ts", "services/config/paths.ts", "services/config/limits.ts", "services/secrets.ts", "services/local-agent.ts", "services/sync-service.ts", "services/sync/limits.ts", "branding.ts", "services/browser-engine.ts",
        "services/profile-portability.ts", "services/sync/profile-state.ts", "services/sync/operation-state.ts", "services/sync/operation-result.ts", "services/event-bus.ts", "services/team.ts",
        "services/sync/sqlite-local-storage.ts", "services/zip-writer.ts",
      ].includes(rel)) return load(rel);
      if (rel === "services/utils.ts") return { validateDirId: (s: string) => { if (!/^[\w-]+$/.test(s)) throw new Error("invalid synthetic dirId"); } };
      if (rel === "services/main-i18n.ts") return { tMain: (key: string) => key };
      if (rel === "services/browser-fingerprint-config.ts") return { validateBrowserHardwareProfile: (x: any) => x };
      if (rel === "services/fingerprint-baseline.ts") return { sanitizePortableFingerprintBaseline: () => undefined };
      if (rel === "services/native-chromium-manager.ts") return { normalizeManagedChromiumVersion: () => null };
      if (rel === "services/agent-run-retention.ts") return {
        isOwnedRun: () => false, retainAgentRuns: (runs: any[]) => ({ kept: runs, dropped: [] }),
        cleanupNormalizedRunEvictions: () => { if (faults.cleanup) throw new Error("synthetic cleanup failure"); },
      };
      if (rel === "services/skill-repository.ts") return { BUILTIN_SKILLS: [], getEnabledSkillPrompts: fail("skills") };
      if (rel === "services/extension-repository.ts") return { listExtensionRepository: () => [] };
      if (rel === "services/browser-manager.ts") return {
        listBrowserProfiles: () => [],
        createBrowserProfile: () => {
          faults.creates++;
          const dirId = `synthetic_profile_${faults.creates}`;
          const cfg = load("services/config-manager.ts");
          const store = load("services/config/store.ts");
          store.transact((draft: any) => { draft.deviceName = dirId; });
          return { dirId };
        },
      };
      return denied(rel);
    }
    vm.runInContext(`(function(require,module,exports,__dirname,__filename){${compiled}\n})`, context, { filename: full })(requireFixture, module, module.exports, path.dirname(full), full);
    return module.exports;
  }
  const secrets = load("services/secrets.ts");
  secrets.initializeSecretStorage(secrets.planSecretStorage({ userDataDir: dir, environment: { AGENT_BROWSER_SECRET_BACKEND: "file" } }));
  const cfg = load("services/config-manager.ts"), store = load("services/config/store.ts"), agent = load("services/local-agent.ts");
  cfg.getConfig();
  const bytes = () => fs.readFileSync(path.join(dir, "config.json"));
  const rows = () => JSON.parse(bytes().toString()).accounts || [];
  const ref = (index: number) => agent.getRedactedAccounts()[index]?.ref || { index, revision: "before-reference-design" };
  const seed = () => {
    agent.saveAccounts(["A", "B", "C"].map((name) => ({ platformUrl: "https://synthetic.invalid", platformUserName: name, platformPassword: `synthetic-${name}`, tags: [name], profileIds: [`profile_${name}`], createdAt: 1, updatedAt: 1 })));
  };
  return { dir, agent, cfg, store, secrets, faults, bytes, rows, ref, seed,
    loadedModules: () => [...modules.keys()].map(file => path.relative(SOURCE, file).replace(/\\/g, "/")),
    events: load("services/event-bus.ts"), sync: () => load("services/sync-service.ts").syncService };
}
function rejected(fn: () => any, code: string) {
  let error: any;
  try { fn(); } catch (e) { error = e; }
  expect(error, `must reject ${code}`).toBeDefined();
  expect(error.code).toBe(code);
  expect(error.message).toContain(code);
}
const row = { platformUrl: "https://synthetic.invalid", platformUserName: "duplicate", platformPassword: "synthetic-one", createdAt: 1, updatedAt: 1 };
afterAll(() => {
  expect(forbidden).toEqual([]);
  // Leave the synthetic files as evidence for an externally owned proof session.
  if (!process.env.ACCOUNT_PROOF_RETAIN) fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("snapshot-reference desired target, rollback and read isolation", () => {
  for (const action of ["update", "bind", "delete", "password", "username"]) it(`rejects stale B ${action} after A deletion without touching C`, () => {
    const f = fixture(); f.seed(); const old = f.ref(1);
    f.agent.deleteAccount(0, f.ref(0));
    const before = f.bytes(), cached = f.agent.getAccounts(), current = f.ref(1);
    const act: Record<string, () => any> = {
      update: () => f.agent.updateAccount(1, { platformUserName: "wrong-C" }, old),
      bind: () => f.agent.setAccountProfileIds(1, ["wrong_profile"], old),
      delete: () => f.agent.deleteAccount(1, old),
      password: () => f.agent.getAccountPassword(1, old),
      username: () => f.agent.getAccount(1, old),
    };
    rejected(act[action], "ACCOUNT_REFERENCE_CONFLICT");
    expect(f.bytes()).toEqual(before); expect(f.agent.getAccounts()).toEqual(cached); expect(f.ref(1)).toEqual(current);
    f.cfg.reloadConfig(); expect(f.rows().map((a: any) => a.platformUserName)).toEqual(["B", "C"]);
  });
  it("rejects repeated first-row deletion", () => {
    const f = fixture(); f.seed(); const ref = f.ref(0); f.agent.deleteAccount(0, ref); const before = f.bytes();
    rejected(() => f.agent.deleteAccount(0, ref), "ACCOUNT_REFERENCE_CONFLICT"); expect(f.bytes()).toEqual(before);
  });
  for (const writer of ["add", "update", "bind", "delete", "bulk", "bulkProfiles", "replace"]) it(`pre-rename failure preserves ${writer} disk/cache/revision`, () => {
    const f = fixture(); f.seed(); const before = f.bytes(), cached = f.agent.getAccounts(), ref = f.ref(0);
    f.faults.rename = true;
    const calls: Record<string, () => any> = {
      add: () => f.agent.addAccount(row), update: () => f.agent.updateAccount(0, { platformUserName: "changed" }, ref),
      bind: () => f.agent.setAccountProfileIds(0, ["changed"], ref), delete: () => f.agent.deleteAccount(0, ref),
      bulk: () => f.agent.bulkAddAccounts([{ url: row.platformUrl, username: row.platformUserName }]),
      bulkProfiles: () => f.agent.bulkCreateProfilesWithAccounts([{ url: row.platformUrl, username: row.platformUserName }]),
      replace: () => f.agent.saveAccounts([row]),
    };
    if (writer === "bulkProfiles") { // Synthetic profile commit fails first; no successful account result.
      expect(calls[writer]().added).toBe(0);
    } else expect(calls[writer]).toThrow("synthetic rename failure");
    expect(f.bytes()).toEqual(before); expect(f.agent.getAccounts()).toEqual(cached); expect(f.ref(0)).toEqual(ref);
  });
  it("all read projections and mutation results are detached nested DTOs", () => {
    const f = fixture(); f.seed(); const before = f.agent.getAccounts();
    for (const list of [f.agent.getAccounts(), f.agent.getRedactedAccounts(), f.agent.getProfileAccounts("profile_A")]) {
      list[0].tags.push("alias"); list[0].profileIds.push("alias"); list[0].platformUserName = "alias"; list.splice(0, 1);
    }
    expect(f.agent.getAccounts()).toEqual(before);
    const added = f.agent.addAccount({ ...row, tags: ["before"], profileIds: ["before"] });
    added.tags.push("alias"); added.profileIds.push("alias");
    expect(f.agent.getAccounts()[3].tags).toEqual(["before"]);
  });
  for (const patch of [{ platformUrl: "" }, { platformUserName: " " }, { platformUrl: null }, { platformUserName: 3 }, { platformUrl: "x\ny" }]) it(`normalization cannot silently drop a successful update ${JSON.stringify(patch)}`, () => {
    const f = fixture(); f.seed(); const before = f.bytes(), ref = f.ref(1);
    rejected(() => f.agent.updateAccount(1, patch, ref), "ACCOUNT_VALIDATION_FAILED");
    expect(f.bytes()).toEqual(before); expect(f.ref(1)).toEqual(ref);
  });
});

describe("reference syntax, explicit errors and committed data flow", () => {
  for (const index of [NaN, 0.5, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) it(`rejects malformed index ${index}`, () => {
    const f = fixture(); f.seed(); const before = f.bytes();
    rejected(() => f.agent.deleteAccount(index, { ...f.ref(0), index }), "ACCOUNT_REFERENCE_INVALID"); expect(f.bytes()).toEqual(before);
  });
  for (const method of ["update", "bind", "delete", "password", "read"]) it(`missing reference fails closed for ${method}`, () => {
    const f = fixture(); f.seed(); const before = f.bytes();
    const calls: Record<string, () => any> = { update: () => f.agent.updateAccount(0, {}), bind: () => f.agent.setAccountProfileIds(0, []), delete: () => f.agent.deleteAccount(0), password: () => f.agent.getAccountPassword(0), read: () => f.agent.getAccount(0) };
    rejected(calls[method], "ACCOUNT_REFERENCE_REQUIRED"); expect(f.bytes()).toEqual(before);
  });
  for (const bad of [{}, { index: 0, revision: "*" }, { index: 0, revision: "" }, { index: 1 }, { index: 1, revision: 3 }]) it(`malformed reference ${JSON.stringify(bad)}`, () => {
    const f = fixture(); f.seed(); rejected(() => f.agent.deleteAccount(0, bad), "ACCOUNT_REFERENCE_INVALID");
  });
  it("index/ref mismatch is malformed, current valid out-of-range is not found", () => {
    const f = fixture(); f.seed(); const ref = f.ref(0);
    rejected(() => f.agent.deleteAccount(1, ref), "ACCOUNT_REFERENCE_INVALID");
    rejected(() => f.agent.deleteAccount(99, { index: 99, revision: ref.revision }), "ACCOUNT_NOT_FOUND");
  });
  for (const patch of [{ id: "caller-id" }, { ref: {} }, { createdAt: 20 }, { hasPassword: true }, { platformPassword: 3 }]) it(`rejects unknown/server-owned or malformed patch ${JSON.stringify(patch)}`, () => {
    const f = fixture(); f.seed(); const before = f.bytes();
    rejected(() => f.agent.updateAccount(0, patch, f.ref(0)), "ACCOUNT_VALIDATION_FAILED"); expect(f.bytes()).toEqual(before);
  });
  it("committed metadata/password/bindings survive bytes, fresh loader, profile and search lookup", () => {
    const f = fixture(); f.seed();
    const originalSecret = f.rows()[1].platformPassword;
    const changed = f.agent.updateAccount(1, { platformUrl: "  https://new.synthetic.invalid  ", platformUserName: "  chosen-B  ", platformPassword: "", tags: ["  searchable  "] }, f.ref(1));
    expect(changed.platformUrl).toBe("https://new.synthetic.invalid"); expect(changed.platformUserName).toBe("chosen-B"); expect(changed.tags).toEqual(["searchable"]);
    expect(changed).not.toHaveProperty("platformPassword"); expect(changed.hasPassword).toBe(true); expect(changed.ref).toEqual(f.ref(1));
    expect(f.rows()[1].platformPassword).toBe(originalSecret);
    f.agent.setAccountProfileIds(1, ["bound_profile", "bound_profile", "bad id!"], f.ref(1));
    f.agent.updateAccount(1, { platformPassword: "synthetic-new-secret" }, f.ref(1));
    const bytes = f.bytes(); expect(bytes.toString()).not.toContain("synthetic-new-secret");
    expect(f.rows()[1].profileIds).toEqual(["bound_profile"]);
    expect(f.agent.getAccountPassword(1, f.ref(1))).toBe("synthetic-new-secret");
    const fresh = fixture(f.dir); fresh.cfg.reloadConfig();
    expect(fresh.rows()).toEqual(f.rows());
    const found = fresh.agent.getProfileAccounts("bound_profile").find((a: any) => a.platformUserName === "chosen-B");
    expect(found?.ref.index).toBe(1); expect(found?.tags).toEqual(["searchable"]);
    expect(fresh.agent.getRedactedAccounts().filter((a: any) => a.tags?.includes("searchable"))).toHaveLength(1);
    expect(fresh.agent.getAccountPassword(1, found.ref)).toBe("synthetic-new-secret");
    expect(fresh.ref(1).revision).not.toBe(f.ref(1).revision); expect(fresh.bytes()).toEqual(bytes);
  });
  it("profile filtering keeps global indices and both [] binding meanings", () => {
    const f = fixture(); f.seed();
    expect(f.agent.getProfileAccounts("profile_B")[0].ref.index).toBe(1);
    f.agent.setAccountProfileIds(1, [], f.ref(1)); expect(f.rows()[1].profileIds).toBeUndefined();
    expect(f.agent.getProfileAccounts("any_profile").map((a: any) => a.ref.index)).toEqual([1]);
    f.agent.updateAccount(1, { profileIds: [] }, f.ref(1)); expect(f.rows()[1].profileIds).toBeUndefined();
    f.agent.saveAccounts([{ ...row, profileIds: [] }]); expect(f.rows()[0].profileIds).toEqual([]);
    expect(f.agent.getProfileAccounts("any_profile")).toEqual([]);
  });
  it("synchronous guarded read/reveal performs no write or rotation", () => {
    const f = fixture(); f.seed(); const ref = f.ref(0), before = f.bytes();
    f.faults.write = true; f.faults.rename = true;
    expect(f.agent.getAccount(0, ref).platformUserName).toBe("A"); expect(f.agent.getAccountPassword(0, ref)).toBe("synthetic-A");
    expect(f.bytes()).toEqual(before); expect(f.ref(0)).toEqual(ref);
  });
});

describe("additional lifecycle / process and Sync acceptance", () => {
  it("real fresh Node process reloads bytes and independently resolves profile/list/search/secret", () => {
    const f = fixture(); f.seed();
    f.agent.updateAccount(1, { platformUserName: "fresh-process-B", tags: ["fresh-search"] }, f.ref(1));
    const before = f.bytes(), previous = f.ref(1);
    const entry = path.join(ROOT, "fresh-process.cjs");
    const testPath = path.join(__dirname, "ui-goal-account-store.test.ts");
    fs.writeFileSync(entry, `
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const file = process.argv[2], originalRequire = require('node:module').createRequire(file);
const ts = originalRequire('typescript');
const compiled = ts.transpileModule(fs.readFileSync(file,'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const m = {exports:{}};
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){'+compiled+'\\n})')(
  name => name === 'vitest' ? { describe:()=>{}, it:()=>{}, afterAll:()=>{} } : originalRequire(name), m, m.exports, path.dirname(file), file);
const f = m.exports.fixture(process.argv[3]); f.cfg.reloadConfig();
const old = JSON.parse(process.argv[4]); let conflict;
try { f.agent.getAccountPassword(1,old); } catch(e) { conflict=e.code; }
const row = f.agent.getProfileAccounts('profile_B').find(a=>a.platformUserName==='fresh-process-B');
console.log(JSON.stringify({pid:process.pid, ref:row.ref, conflict, user:row.platformUserName, tags:row.tags,
secret:f.agent.getAccountPassword(1,row.ref), matches:f.agent.getRedactedAccounts().filter(a=>a.tags?.includes('fresh-search')).length,
accounts:f.rows(), deviceId:f.cfg.getConfig().deviceId }));
`);
    const result = spawnSync(process.execPath, [entry, testPath, f.dir, JSON.stringify(previous)], { encoding: "utf8", timeout: 15000, env: { PATH: process.env.PATH, HOME: ROOT, TMPDIR: ROOT, XDG_CONFIG_HOME: ROOT, XDG_CACHE_HOME: ROOT, XDG_DATA_HOME: ROOT, M1_HOME: ROOT, M1_DATA_DIR: ROOT, ACCOUNT_PROOF_RETAIN: "1" } });
    expect(result.status, result.stderr).toBe(0);
    const read = JSON.parse(result.stdout); expect(read.pid).not.toBe(process.pid); expect(read.conflict).toBe("ACCOUNT_REFERENCE_CONFLICT");
    expect(read.ref.index).toBe(1); expect(read.ref.revision).not.toBe(previous.revision); expect(read.user).toBe("fresh-process-B");
    expect(read.tags).toEqual(["fresh-search"]); expect(read.matches).toBe(1); expect(read.secret).toBe("synthetic-B");
    expect(read.accounts).toEqual(f.rows()); expect(read.deviceId).toBe(f.cfg.getConfig().deviceId); expect(f.bytes()).toEqual(before);
    fs.writeFileSync(path.join(ROOT, "fresh-process-results.json"), result.stdout);
  });
  it("nonce preparation failure preserves bytes, cache and current reference before any write", () => {
    const f = fixture(); f.seed(); const before = f.bytes(), ref = f.ref(0), cached = f.agent.getAccounts(); f.faults.nonce = true;
    expect(() => f.agent.updateAccount(0, {}, ref)).toThrow("synthetic nonce preparation failure");
    expect(f.bytes()).toEqual(before); expect(f.agent.getAccounts()).toEqual(cached); expect(f.ref(0)).toEqual(ref);
  });
  it("bulk profile account persistence failure never mutates live account aliases", () => {
    const f = fixture(); f.seed(); const cached = f.agent.getAccounts(), ref = f.ref(0); f.faults.renameAccountOnly = true;
    expect(() => f.agent.bulkCreateProfilesWithAccounts([{ url: row.platformUrl, username: "append-fails" }])).toThrow("synthetic rename failure");
    expect(f.rows().map((a: any) => a.platformUserName)).toEqual(["A", "B", "C"]); expect(f.agent.getAccounts()).toEqual(cached); expect(f.ref(0)).toEqual(ref);
    // Existing separate profile creation may already have committed unrelated
    // settings. This proof does not claim cross-resource profile rollback.
    expect(f.cfg.getConfig().deviceName).toBe("synthetic_profile_1");
  });
  it("large valid committed ciphertext remains usable during equal replacement", () => {
    const f = fixture(); const password = "s".repeat(4096); f.agent.addAccount({ ...row, platformPassword: password });
    const { ref: _ref, ...stored } = f.agent.getAccounts()[0]; expect(stored.platformPassword.length).toBeGreaterThan(4096);
    f.agent.saveAccounts([stored]); expect(f.agent.getAccountPassword(0, f.ref(0))).toBe(password);
  });
  for (const outcome of ["success", "fetch-failure", "rename-failure"]) it(`whole Sync account-assignment ${outcome} uses committed invalidation only`, async () => {
    const f = fixture(); f.agent.saveAccounts([{ ...row, profileIds: ["profile"], tags: ["sync"] }]);
    const events: Array<{ payload: any; bytes: Buffer }> = [];
    // Real operation-state emits onto the same real bus that the UI transport
    // subscribes to. Observe actual disk bytes at publication, not a fake event.
    const unsubscribe = f.events.onEvent("sync:state-changed", (payload: any) => {
      events.push({ payload: structuredClone(payload), bytes: f.bytes() });
    });
    try {
      f.cfg.setSyncConfig({ enabled: true, endpoint: "https://synthetic.invalid", bucket: "synthetic-bucket", accessKey: "synthetic", secretKey: "synthetic", custodyConsent: true });
      const ref = f.ref(0), cached = f.agent.getAccounts(), before = f.bytes();
      expect(JSON.parse(before.toString()).sync).toMatchObject({ enabled: true, endpoint: "https://synthetic.invalid", bucket: "synthetic-bucket" });
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ kind: "configure", phase: "completed", scopes: ["profiles", "accounts", "sync", "team"] });
      expect(events[0].bytes).toEqual(before);
      f.faults.syncPayload = { timestamp: 1, data: zlib.gzipSync(Buffer.from(JSON.stringify(f.cfg.getConfig()))).toString("base64") };
      f.faults.failFetch = outcome === "fetch-failure"; f.faults.rename = outcome === "rename-failure";
      const result = await f.sync().pull(undefined, { strategy: "local" });
      expect(f.loadedModules()).toEqual(expect.arrayContaining(["services/sync/sqlite-local-storage.ts", "services/zip-writer.ts"]));
      expect(result.success, result.message).toBe(outcome === "success"); expect(f.faults.fetches).toBe(1);
      const pullEvents = events.filter(event => event.payload.kind === "pull");
      expect(pullEvents.map(event => event.payload.phase)).toEqual(["started", "completed"]);
      const started = pullEvents[0].payload, completed = pullEvents[1].payload;
      expect(started.scopes).toContain("accounts");
      expect(started.generation).toBeGreaterThan(events[0].payload.generation);
      expect(completed.generation).toBeGreaterThan(started.generation);
      expect(completed.operationId).toBe(started.operationId);
      expect(completed.operationId).toBe(result.operationId);
      expect(completed.result).toMatchObject({ success: result.success, outcome: result.outcome, localCommit: result.localCommit, remoteCommit: result.remoteCommit });
      if (outcome === "success") {
        expect(f.rows()).toEqual(JSON.parse(before.toString()).accounts);
        expect(f.ref(0).revision).not.toBe(ref.revision);
        rejected(() => f.agent.getAccountPassword(0, ref), "ACCOUNT_REFERENCE_CONFLICT");
        expect(completed.scopes).toContain("accounts");
        expect(result.localCommit).toBe("committed");
      } else {
        expect(f.bytes()).toEqual(before); expect(f.agent.getAccounts()).toEqual(cached); expect(f.ref(0)).toEqual(ref);
        expect(completed.scopes).toEqual(["sync"]); expect(result.localCommit).toBe("none");
      }
      const committed = f.bytes(), stored = JSON.parse(committed.toString()).accounts;
      expect(pullEvents[1].bytes).toEqual(committed);
      f.cfg.reloadConfig();
      expect(f.bytes()).toEqual(committed); expect(f.rows()).toEqual(stored);
      const found = f.agent.getProfileAccounts("profile").find((account: any) => account.platformUserName === row.platformUserName && account.platformUrl === row.platformUrl);
      expect(found?.ref.index).toBe(0); expect(found?.profileIds).toEqual(["profile"]); expect(found?.tags).toEqual(["sync"]);
      expect(f.agent.getRedactedAccounts().filter((account: any) => account.tags?.includes("sync"))).toHaveLength(1);
      expect(f.agent.getAccountPassword(0, found.ref)).toBe(row.platformPassword);
    } finally { unsubscribe(); }
  });
});

describe("committed witness / nonce lifecycle and all writers", () => {
  it("duplicates, identical timestamps and secret-only changes invalidate old references", () => {
    const f = fixture(); f.agent.saveAccounts([row, { ...row, platformPassword: "synthetic-two" }]);
    const old = f.ref(1); expect(f.ref(0).index).toBe(0); expect(old.index).toBe(1);
    f.agent.updateAccount(0, { platformPassword: "synthetic-secret-only" }, f.ref(0));
    rejected(() => f.agent.getAccountPassword(1, old), "ACCOUNT_REFERENCE_CONFLICT");
    expect(f.agent.getAccountPassword(1, f.ref(1))).toBe("synthetic-two");
  });
  it("unrelated commits preserve references; detached witness catches direct-cache secret changes", () => {
    const f = fixture(); f.seed(); const ref = f.ref(1);
    f.store.transact((draft: any) => { draft.deviceName = "unrelated"; }); expect(f.ref(1)).toEqual(ref);
    f.cfg.getConfig().accounts[0].platformPassword = f.secrets.encryptSecret("synthetic-live-change");
    f.cfg.saveConfig(f.cfg.getConfig()); expect(f.ref(1).revision).not.toBe(ref.revision);
  });
  it("equal replacement, equal explicit write, reload, restart and delete/re-add rotate", () => {
    const f = fixture(); f.seed(); let ref = f.ref(0);
    f.agent.saveAccounts(f.agent.getAccounts().map(({ ref: _ref, ...a }: any) => a)); expect(f.ref(0).revision).not.toBe(ref.revision); ref = f.ref(0);
    f.agent.updateAccount(0, {}, ref); expect(f.ref(0).revision).not.toBe(ref.revision); ref = f.ref(0);
    f.cfg.reloadConfig(); expect(f.ref(0).revision).not.toBe(ref.revision); ref = f.ref(0);
    const { ref: _transportRef, ...original } = f.agent.getAccounts()[0]; f.agent.deleteAccount(0, ref); f.agent.addAccount(original);
    rejected(() => f.agent.getAccount(0, ref), "ACCOUNT_REFERENCE_CONFLICT");
  });
  it("committed config and new revision publish before failing cleanup", () => {
    const f = fixture(); f.seed(); const old = f.ref(0); f.faults.cleanup = true;
    const result = f.agent.updateAccount(0, { platformUserName: "committed" }, old);
    expect(result.platformUserName).toBe("committed"); expect(f.rows()[0].platformUserName).toBe("committed");
    expect(f.agent.getAccounts()[0].platformUserName).toBe("committed"); expect(result.ref.revision).not.toBe(old.revision);
    rejected(() => f.agent.deleteAccount(0, old), "ACCOUNT_REFERENCE_CONFLICT");
  });
  it("failed reload and pre-write failure keep revision and bytes", () => {
    const f = fixture(); f.seed(); const before = f.bytes(), ref = f.ref(0);
    f.faults.write = true; expect(() => f.agent.addAccount(row)).toThrow("synthetic write failure"); expect(f.bytes()).toEqual(before); expect(f.ref(0)).toEqual(ref);
    fs.writeFileSync(path.join(f.dir, "config.json"), "invalid synthetic JSON"); expect(() => f.cfg.reloadConfig()).toThrow("corrupt");
    expect(f.ref(0)).toEqual(ref); fs.writeFileSync(path.join(f.dir, "config.json"), before);
  });
  it("add/bulk/replacement capacity errors cannot claim truncated rows as successes", () => {
    const f = fixture(); f.agent.saveAccounts(Array.from({ length: 1000 }, () => row)); const before = f.bytes(), ref = f.ref(0);
    rejected(() => f.agent.addAccount(row), "ACCOUNT_VALIDATION_FAILED");
    rejected(() => f.agent.bulkAddAccounts([{ url: row.platformUrl, username: row.platformUserName }]), "ACCOUNT_VALIDATION_FAILED");
    rejected(() => f.agent.saveAccounts(Array.from({ length: 1001 }, () => row)), "ACCOUNT_VALIDATION_FAILED");
    expect(f.bytes()).toEqual(before); expect(f.ref(0)).toEqual(ref);
  });
  it("invalid additions/replacements and whitespace bulk entries never get success", () => {
    const f = fixture(); f.seed(); const before = f.bytes();
    rejected(() => f.agent.addAccount({ ...row, platformUrl: " " }), "ACCOUNT_VALIDATION_FAILED");
    rejected(() => f.agent.saveAccounts([{ ...row, platformUserName: "" }]), "ACCOUNT_VALIDATION_FAILED");
    const result = f.agent.bulkAddAccounts([{ url: " ", username: " " }]); expect(result.added).toBe(0); expect(result.errors).toHaveLength(1);
    expect(f.bytes()).toEqual(before);
  });
  it("bulk profile creation drafts against latest base, retaining interleaved profiles/settings", () => {
    const f = fixture(); f.seed();
    const result = f.agent.bulkCreateProfilesWithAccounts([{ url: row.platformUrl, username: "bulk-one" }, { url: row.platformUrl, username: "bulk-two" }]);
    expect(result).toMatchObject({ added: 2, created: 2, skipped: 0 }); expect(f.rows()).toHaveLength(5);
    expect(f.cfg.getConfig().deviceName).toBe("synthetic_profile_2");
    expect(f.agent.getProfileAccounts("synthetic_profile_2")[0].ref.index).toBe(4);
  });
  it("live-base guarded transaction cannot accept an optional stale base", () => {
    const f = fixture(); f.seed(); const old = f.cfg.getConfig();
    f.store.transact((draft: any) => { draft.deviceName = "latest"; });
    f.store.transactAccounts((draft: any) => { draft.accounts[0].tags = ["live"]; }, old);
    expect(f.cfg.getConfig().deviceName).toBe("latest");
  });
});
