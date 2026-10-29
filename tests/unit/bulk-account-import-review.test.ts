// Whole local-agent module in a closed VM: no Electron, sockets, subprocesses,
// config files or browser processes. All state-changing collaborators are mocks.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import ts from "typescript";

type Row = { url: string; username: string; password?: string; tags?: string[] };
const SOURCE = path.resolve(__dirname, "../../src/main/services/local-agent.ts");
const BASELINE = path.resolve(__dirname, "../../.tmp-build/review-multirole-20261029/implementation/accounts-round2/local-agent.r1-before.ts");
const baseline = process.env.ACCOUNT_IMPORT_REVIEW_BASELINE;
if (baseline !== undefined && baseline !== "0" && baseline !== "r1-finite") throw new Error("R2 regressions allow only the saved finite R1 baseline");
const sourceFile = baseline === "r1-finite" ? BASELINE : SOURCE;
const compiled = ts.transpileModule(fs.readFileSync(sourceFile, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  reportDiagnostics: true,
});
if (compiled.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error("Fixture source must transpile");
const violations: string[] = [];
const row = (username = "alice"): Row => ({ url: "https://example.invalid", username, password: "synthetic-only" });

function fixture(count = 0) {
  const config = { accounts: Array.from({ length: count }, (_, i) => ({ platformUrl: "https://seed.invalid", platformUserName: `seed-${i}` })) as any[] };
  const state = {
    creates: [] as any[], profiles: [] as { name: string; dirId: string }[], writes: 0, commits: 0, lists: 0,
    timeline: [] as string[], failCreates: new Set<number>(), failAppend: false,
    onCreate: undefined as (() => void) | undefined,
  };
  const forbidden = (name: string) => (..._args: any[]): never => {
    violations.push(name); throw new Error(`Forbidden account fixture capability: ${name}`);
  };
  const denied = (name: string) => new Proxy({ __esModule: true }, {
    get: (_target, key) => key === "__esModule" ? true : forbidden(`${name}.${String(key)}`),
  });
  class AccountOperationError extends Error {
    constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); }
  }
  // A large sentinel prevents a broken production synchronous loop from hanging
  // this proof. It does not alter successful Set behavior below the budget.
  class GuardedSet<T> extends Set<T> {
    private checks = 0;
    override has(value: T): boolean {
      if (++this.checks > 100_000) throw new Error("Name allocation did not make progress");
      return super.has(value);
    }
  }
  const mocks: Record<string, any> = {
    "./config-manager.js": { MERGE_CAPS: { accounts: 1000 }, getConfig: () => config },
    "./config/store.js": {
      AccountOperationError,
      readAccountSnapshot: () => ({ accounts: structuredClone(config.accounts), revision: "synthetic-revision" }),
      transactAccounts: (mutate: (draft: any) => void) => {
        state.writes++; state.timeline.push("account-write");
        if (state.failAppend) throw new Error("synthetic account write failure");
        const draft = structuredClone(config);
        mutate(draft);
        config.accounts = structuredClone(draft.accounts);
        state.commits++; state.timeline.push("account-commit");
      },
    },
    "./secrets.js": { isEncrypted: () => false, encryptSecret: forbidden("secret encryption") },
    "./skill-repository.js": { BUILTIN_SKILLS: [] },
    "./browser-manager.js": {
      listBrowserProfiles: () => { state.lists++; return structuredClone(state.profiles); },
      createBrowserProfile: (options: any) => {
        state.creates.push(structuredClone(options)); state.timeline.push("profile-create");
        if (state.failCreates.has(state.creates.length)) throw new Error("synthetic profile create failure");
        const dirId = `synthetic_profile_${state.creates.length}`;
        state.profiles.push({ name: options.name, dirId });
        state.onCreate?.();
        return { dirId };
      },
    },
  };
  const blockedModules = new Set([
    "node:path", "node:fs", "node:os", "node:net", "node:http", "node:https", "node:dns/promises",
    "./audit-log.js", "./interaction-policy.js", "./agent/cdp-transport.js", "./agent/dispatch-guard.js",
    "./agent/cdp-navigation-errors.js", "./agent/cdp-navigation-budget.js", "./agent/tool-outcome.js",
    "./agent/run-scope.js", "./agent/conversation-store.js", "./profile-manager.js", "./agent-run-trace.js",
    "./agent-db.js", "./approval-gate.js", "./task-templates.js", "./platform-adapters.js", "./firefox-agent-tools.js",
  ]);
  const module = { exports: {} as any };
  const context = vm.createContext({
    // Mock collaborators throw host-realm errors; use the same Error identity
    // so production instanceof checks match normal single-realm execution.
    module, exports: module.exports, URL, Error, structuredClone, Set: GuardedSet,
    require: (name: string) => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (blockedModules.has(name)) return denied(name);
      return forbidden(`undeclared module ${name}`)();
    },
    process: { env: { NODE_ENV: "test" }, platform: "darwin" },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: forbidden("timer"), setInterval: forbidden("interval"), clearTimeout: forbidden("clear timer"),
    fetch: forbidden("fetch"),
  });
  vm.runInContext(compiled.outputText, context, { filename: sourceFile, timeout: 2000 });
  return { agent: module.exports, state, config };
}

// A real Set with a per-allocation bound: suffix candidates are mutually
// distinct, but the unsuffixed spelling may equal one of them. S+2 total
// probes therefore guarantee S+1 distinct candidates, not S+1 total probes.
function derive(agent: any, url: string, username: string, existing: Set<string>): string {
  const guarded = new Set(existing);
  const probes: string[] = [];
  guarded.has = (name: string) => {
    probes.push(name);
    if (probes.length > existing.size + 2) throw new Error("Name allocation exceeded finite candidate budget");
    return Set.prototype.has.call(guarded, name);
  };
  const value = agent.deriveProfileName(url, username, guarded);
  expect(probes.length).toBeLessThanOrEqual(existing.size + 2);
  expect(probes.length - new Set(probes).size).toBeLessThanOrEqual(1);
  expect([...guarded]).toEqual([...existing]);
  return value;
}

afterEach(() => { expect(violations).toEqual([]); });

describe("bulk import profile naming regressions", () => {
  it("keeps readable names and short collision suffixes without mutating the input set", () => {
    const { agent } = fixture(); const names = new Set(["example.invalid · alice", "example.invalid · alice #2"]);
    expect(derive(agent, row().url, "alice", names)).toBe("example.invalid · alice #3");
    expect([...names]).toEqual(["example.invalid · alice", "example.invalid · alice #2"]);
    expect(derive(agent, "https://www.example.invalid", "bob", names)).toBe("example.invalid · bob");
  });
  it("reserves suffix space when the unsuffixed base is exactly 80 characters", () => {
    const { agent } = fixture(); const username = "a".repeat(80 - "example.invalid · ".length);
    const base = "example.invalid · " + username;
    expect(base).toHaveLength(80);
    expect(derive(agent, row().url, username, new Set([base]))).toBe(base.slice(0, 77) + " #2");
  });
  it.each([2, 9, 10, 99, 100, 999])("does not exhaust the budget when an 80-character base already ends in #%i", (lastOccupied) => {
    const { agent } = fixture(); const prefix = "example.invalid · "; const originalSuffix = ` #${lastOccupied}`;
    const username = "a".repeat(80 - prefix.length - originalSuffix.length) + originalSuffix;
    const base = prefix + username; const names = new Set([base]);
    expect(base).toHaveLength(80);
    // The raw spelling is itself one occupied member of the suffix sequence.
    expect(base.slice(0, 80 - originalSuffix.length) + originalSuffix).toBe(base);
    for (let n = 2; n <= lastOccupied; n++) {
      const suffix = ` #${n}`; names.add(base.slice(0, 80 - suffix.length) + suffix);
    }
    expect(names.size).toBe(lastOccupied - 1);
    const nextSuffix = ` #${lastOccupied + 1}`;
    const name = derive(agent, row().url, username, names);
    expect(name).toBe(base.slice(0, 80 - nextSuffix.length) + nextSuffix);
    expect(name).toHaveLength(80); expect(names.has(name)).toBe(false);
  });
  it("allocates 35 distinct long duplicates including two-digit suffixes within 80 characters", () => {
    const { agent } = fixture(); const names = new Set<string>(); const username = "x".repeat(200);
    const base = "example.invalid · " + username;
    for (let n = 1; n <= 35; n++) {
      const name = derive(agent, row().url, username, names);
      const suffix = ` #${n}`;
      expect(name).toBe(n === 1 ? base.slice(0, 80) : base.slice(0, 80 - suffix.length) + suffix);
      expect(name.length).toBeLessThanOrEqual(80); expect(names.has(name)).toBe(false); names.add(name);
    }
    expect(names.size).toBe(35);
  });
  it("skips dense pre-existing suffixes through #13 and retains unrelated names", () => {
    const { agent } = fixture(); const base = "example.invalid · " + "y".repeat(150);
    const names = new Set([base.slice(0, 80), "unrelated"]);
    for (let n = 2; n <= 12; n++) { const suffix = ` #${n}`; names.add(base.slice(0, 80 - suffix.length) + suffix); }
    expect(derive(agent, row().url, "y".repeat(150), names)).toBe(base.slice(0, 76) + " #13");
  });
  it("bounds allocation even if a caller supplies an inconsistent Set membership implementation", () => {
    const { agent } = fixture(); const names = new Set(["occupied"]); let probes = 0;
    names.has = () => { if (++probes > 3) throw new Error("unbounded sentinel"); return true; };
    expect(() => agent.deriveProfileName(row().url, "alice", names)).toThrow("Unable to allocate a unique profile name");
    expect(probes).toBeGreaterThan(0); expect(probes).toBeLessThanOrEqual(names.size + 2);
  });
});

describe("bulk import capacity planning and existing partial-create semantics", () => {
  it("creates profiles then writes all successful accounts once, preserving options, tags and input rows", () => {
    const { agent, state, config } = fixture(); const items = [{ ...row("alice"), tags: ["tag"] }, row("bob")];
    const before = structuredClone(items);
    expect(agent.bulkCreateProfilesWithAccounts(items, { platform: "macos" })).toEqual({ added: 2, created: 2, skipped: 0, errors: [] });
    expect(state.creates[0]).toEqual({ name: "example.invalid · alice", platform: "macos", tags: ["tag"] });
    expect(state.timeline).toEqual(["profile-create", "profile-create", "account-write", "account-commit"]);
    expect(state.writes).toBe(1); expect(state.commits).toBe(1); expect(config.accounts).toHaveLength(2);
    expect(config.accounts[0]).toMatchObject({ platformPassword: "synthetic-only", profileIds: ["synthetic_profile_1"] });
    expect(items).toEqual(before);
  });
  it("creates 15 repeated long identities without truncating away #10 through #15", () => {
    const { agent, state } = fixture(); const items = Array.from({ length: 15 }, () => row("z".repeat(200)));
    expect(agent.bulkCreateProfilesWithAccounts(items)).toEqual({ added: 15, created: 15, skipped: 0, errors: [] });
    expect(new Set(state.creates.map(p => p.name)).size).toBe(15);
    expect(state.creates[9].name).toMatch(/ #10$/); expect(state.creates[14].name).toMatch(/ #15$/);
    expect(state.creates.every(p => p.name.length <= 80)).toBe(true);
  });
  it("imports instead of skipping a valid row when its 80-character base already ends in #2", () => {
    const { agent, state, config } = fixture(); const prefix = "example.invalid · ";
    const username = "a".repeat(77 - prefix.length) + " #2"; const base = prefix + username;
    expect(base).toHaveLength(80); state.profiles.push({ name: base, dirId: "synthetic_existing" });
    expect(agent.bulkCreateProfilesWithAccounts([row(username)])).toEqual({ added: 1, created: 1, skipped: 0, errors: [] });
    expect(state.creates.map(p => p.name)).toEqual([base.slice(0, 77) + " #3"]);
    expect(state.profiles.map(p => p.name)).toEqual([base, base.slice(0, 77) + " #3"]);
    expect(state.writes).toBe(1); expect(state.commits).toBe(1);
    expect(config.accounts).toHaveLength(1); expect(config.accounts[0].profileIds).toEqual(["synthetic_profile_1"]);
  });
  it("rejects a predictable two-row overflow before any profile creation or account write", () => {
    const { agent, state, config } = fixture(999); const before = JSON.stringify(config);
    expect(() => agent.bulkCreateProfilesWithAccounts([row("one"), row("two")])).toThrow("Account capacity is 1000");
    expect(state.creates).toHaveLength(0); expect(state.writes).toBe(0); expect(state.commits).toBe(0);
    expect(state.lists).toBe(0); expect(JSON.stringify(config)).toBe(before);
  });
  it("rejects one valid row at full capacity with zero creates and zero writes", () => {
    const { agent, state, config } = fixture(1000);
    expect(() => agent.bulkCreateProfilesWithAccounts([row()])).toThrow("ACCOUNT_VALIDATION_FAILED");
    expect(state.creates).toHaveLength(0); expect(state.writes).toBe(0); expect(config.accounts).toHaveLength(1000);
  });
  it("does not charge invalid rows against the remaining capacity and preserves original row numbers", () => {
    const { agent, state, config } = fixture(999);
    const result = agent.bulkCreateProfilesWithAccounts([row(" "), row("valid"), { ...row("bad"), tags: ["bad\ninner"] }, null]);
    expect(result).toMatchObject({ added: 1, created: 1, skipped: 3 });
    expect(result.errors.map((e: any) => e.line)).toEqual([1, 3, 4]);
    expect(state.creates).toHaveLength(1); expect(state.writes).toBe(1); expect(config.accounts).toHaveLength(1000);
  });
  it("makes no writes or profile calls for empty input or an all-invalid batch at capacity", () => {
    const { agent, state } = fixture(1000);
    expect(agent.bulkCreateProfilesWithAccounts([])).toEqual({ added: 0, created: 0, skipped: 0, errors: [] });
    const result = agent.bulkCreateProfilesWithAccounts([row(" "), null]);
    expect(result).toMatchObject({ added: 0, created: 0, skipped: 2 }); expect(result.errors).toHaveLength(2);
    expect(state.creates).toHaveLength(0); expect(state.writes).toBe(0);
  });
  it("skips failed creates, reuses their uncommitted name and binds only successful profiles", () => {
    const { agent, state, config } = fixture(); state.failCreates.add(2);
    const result = agent.bulkCreateProfilesWithAccounts([row(), row(), row()]);
    expect(result).toMatchObject({ added: 2, created: 2, skipped: 1 });
    expect(result.errors).toEqual([{ line: 2, error: "synthetic profile create failure" }]);
    expect(state.creates.map(p => p.name)).toEqual(["example.invalid · alice", "example.invalid · alice #2", "example.invalid · alice #2"]);
    expect(config.accounts.map(a => a.profileIds)).toEqual([["synthetic_profile_1"], ["synthetic_profile_3"]]);
    expect(state.writes).toBe(1);
  });
  it("reports validation and profile failures in original input order after two-pass validation", () => {
    const { agent, state } = fixture(); state.failCreates.add(1); state.failCreates.add(2);
    const result = agent.bulkCreateProfilesWithAccounts([row("one"), row(" "), row("three"), null]);
    expect(result).toMatchObject({ added: 0, created: 0, skipped: 4 });
    expect(result.errors.map((e: any) => e.line)).toEqual([1, 2, 3, 4]); expect(state.writes).toBe(0);
  });
  it("preflights the full valid plan even if a later create could have failed", () => {
    const { agent, state } = fixture(999); state.failCreates.add(1);
    expect(() => agent.bulkCreateProfilesWithAccounts([row("one"), row("two")])).toThrow("Account capacity is 1000");
    expect(state.creates).toHaveLength(0); expect(state.writes).toBe(0);
  });
  it("keeps the final live-base capacity check for state changes during profile creation", () => {
    const { agent, state, config } = fixture(999);
    state.onCreate = () => config.accounts.push({ platformUrl: "https://interleaved.invalid", platformUserName: "other-writer" });
    expect(() => agent.bulkCreateProfilesWithAccounts([row()])).toThrow("Account capacity is 1000");
    expect(state.creates).toHaveLength(1); expect(state.writes).toBe(1); expect(state.commits).toBe(0);
    expect(config.accounts).toHaveLength(1000); expect(state.profiles).toHaveLength(1);
  });
  it("does not claim cross-resource rollback if the final account write fails", () => {
    const { agent, state, config } = fixture(); state.failAppend = true;
    expect(() => agent.bulkCreateProfilesWithAccounts([row()])).toThrow("synthetic account write failure");
    expect(state.profiles).toHaveLength(1); expect(config.accounts).toHaveLength(0);
    expect(state.writes).toBe(1); expect(state.commits).toBe(0);
  });
});
