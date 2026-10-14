// Node-only F18 acceptance: whole production JSON store and AST-exact production
// message wrapper. All persistence and fresh-process proofs use synthetic scratch.
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vm from "node:vm";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { inspect } from "node:util";
import type * as StoreModule from "../../src/main/services/agent/conversation-store.js";
type ProductionStore = typeof StoreModule;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "title-provenance-proof-"));
const SOURCE = path.resolve(__dirname, "../../src/main/services");
const storeSource = fs.readFileSync(path.join(SOURCE, "agent/conversation-store.ts"), "utf8");
const agentSource = fs.readFileSync(path.join(SOURCE, "local-agent.ts"), "utf8");
const compile = (source: string) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const storeCode = compile(storeSource);
const ast = ts.createSourceFile("local-agent.ts", agentSource, ts.ScriptTarget.Latest, true);
const wrapperNames = new Set(["addMessage", "redactSensitive", "redactUrlForLog"]);
const functions = ast.statements.filter((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && !!n.name && wrapperNames.has(n.name.text));
if (functions.length !== wrapperNames.size) throw new Error("Production message functions not found");
// Keep the actual store import and exported aliases; this picks up production
// delegation changes without substituting a fixture implementation of the wrapper.
const imports = ast.statements.filter((n) => ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === "./agent/conversation-store.js");
const aliases = ast.statements.filter((n) => ts.isVariableStatement(n) && n.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && ["loadConversations", "getConversation", "saveConversations"].includes(d.name.text)));
const wrapperCode = compile([...imports, ...aliases, ...functions].map((n) => n.getText(ast)).join("\n"));
const forbidden: string[] = [];
const proofCases: string[] = [];

function fixture() {
  const dir = fs.mkdtempSync(path.join(ROOT, "case-")); proofCases.push(dir);
  const file = path.join(dir, "agent-conversations.json");
  const faults = { read: false, write: false, rename: false, backup: false, collision: false, code: "EIO" as unknown };
  let freshSequence = 0;
  const events: Array<{ op: string; rows?: any[] }> = [];
  const logs: string[] = [];
  const reject = (name: string): never => { forbidden.push(name); throw new Error("Forbidden fixture operation"); };
  const scratchFs = new Proxy(fs, { get(target, key) {
    const value = (target as any)[key];
    if (typeof value !== "function") return value;
    return (...args: any[]) => {
      for (const arg of [args[0], ...(["copyFileSync", "renameSync"].includes(String(key)) ? [args[1]] : [])]) {
        if (typeof arg === "string" && !path.resolve(arg).startsWith(dir + path.sep)) reject("filesystem outside case");
      }
      const injected = (key === "readFileSync" && faults.read) || (key === "writeFileSync" && faults.write) || (key === "renameSync" && faults.rename) || (key === "copyFileSync" && faults.backup);
      if (injected) throw Object.assign(new Error("SYNTHETIC_PRIVATE_VALUE"), { code: faults.code });
      if (["readFileSync", "writeFileSync", "renameSync"].includes(String(key))) {
        events.push({ op: String(key), ...(key === "writeFileSync" ? { rows: JSON.parse(args[1]) } : {}) });
      }
      return value(...args);
    };
  } });
  const context = vm.createContext({ URL, console: { error: (...a: any[]) => logs.push(a.map(String).join(" ")), warn: (...a: any[]) => logs.push(a.map(String).join(" ")) },
    Date: class extends Date { static now() { return faults.collision ? 42 : Date.now(); } },
    Math: Object.assign(Object.create(Math), { random: () => faults.collision ? 0.5 : Math.random() }),
  });
  function evaluate(code: string, require: (s: string) => any) {
    const module = { exports: {} as any };
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context)(require, module, module.exports);
    return module.exports;
  }
  const store = evaluate(storeCode, (name) => {
    if (name === "node:fs") return scratchFs;
    if (name === "node:path") return path;
    if (name === "node:crypto") return crypto;
    if (name === "../config-manager.js") return { getAppDataDir: () => dir };
    return reject("store dependency");
  });
  const agent = evaluate(wrapperCode, (name) => name === "./agent/conversation-store.js" ? store : reject("wrapper dependency"));
  const bytes = () => fs.readFileSync(file);
  const rows = () => JSON.parse(bytes().toString());
  const seed = (records: any[]) => fs.writeFileSync(file, JSON.stringify(records, null, 2), { mode: 0o600 });
  // Fresh Node process executes the same whole production store, with no app
  // imports, sockets, Electron, host configuration or inherited credentials.
  function fresh(id: string, title: string) {
    const script = path.join(dir, "fresh.cjs");
    fs.writeFileSync(script, `const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const dir=__dirname;const moduleResult={exports:{}};
const scopedFs=new Proxy(fs,{get(t,k){const v=t[k];if(typeof v!=='function')return v;return (...a)=>{for(const p of [a[0],...(['copyFileSync','renameSync'].includes(k)?[a[1]]:[])])if(typeof p==='string'&&!path.resolve(p).startsWith(dir+path.sep))throw Error('Outside fixture');return v(...a)}}});
vm.runInNewContext('(function(require,module,exports){'+${JSON.stringify(storeCode)}+'\\n})',{console:{error(){throw Error('Unexpected diagnostic')}},Date,Math})(n=>{if(n==='node:fs')return scopedFs;if(n==='node:path')return path;if(n==='node:crypto')return crypto;if(n==='../config-manager.js')return {getAppDataDir:()=>dir};throw Error('Unexpected dependency')},moduleResult,moduleResult.exports);
const s=moduleResult.exports;const list=s.listConversations();process.stdout.write(JSON.stringify({get:s.getConversation(${JSON.stringify(id)}),list,byId:list.filter(c=>c.id===${JSON.stringify(id)}),byTitle:list.filter(c=>c.title===${JSON.stringify(title)}),byTitleFragment:list.filter(c=>c.title.includes(${JSON.stringify(title.slice(0, 8))}))}));`);
    const env: NodeJS.ProcessEnv = { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, XDG_DATA_HOME: dir, NODE_COMPILE_CACHE: dir, NODE_ENV: "test", M1_AGENT_TEST_DATA: dir };
    const result = spawnSync(process.execPath, [script], { env, cwd: dir, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout); freshSequence++;
    fs.writeFileSync(path.join(dir, `fresh-${freshSequence}-result.json`), JSON.stringify(output, null, 2));
    fs.writeFileSync(path.join(dir, `fresh-${freshSequence}-committed.json`), bytes());
    return output;
  }
  return { dir, file, store, agent, faults, events, logs, bytes, rows, seed, fresh };
}
const record = (id: string, title: string, marker: any = undefined) => ({
  id, title, messages: [{ role: "assistant", content: "SYNTHETIC_EXISTING_MESSAGE", timestamp: 11, extra: { nested: [1, null] } }],
  createdAt: 12, updatedAt: 13, extra: { nested: ["unchanged", null] },
  ...(marker !== undefined ? { titleKind: marker } : {}),
});
const caught = (fn: () => any) => { try { fn(); } catch (e) { return e as Error; } throw new Error("Expected rejection"); };
function proof(f: ReturnType<typeof fixture>, id: string, title: string) {
  const before = f.bytes(), direct = f.rows().find((c: any) => c.id === id);
  expect(direct.title).toBe(title);
  const reloaded = f.fresh(id, title);
  expect(reloaded.get).toEqual(f.store.getConversation(id));
  expect(reloaded.byId).toEqual([reloaded.get]);
  expect(reloaded.byTitle.some((c: any) => c.id === id)).toBe(true);
  expect(f.bytes()).toEqual(before);
  return direct;
}
afterAll(() => {
  expect(forbidden).toEqual([]);
  if (process.env.TITLE_PROOF_RETAIN) fs.writeFileSync(path.join(ROOT, "manifest.json"), JSON.stringify({
    storeSource: path.join(SOURCE, "agent/conversation-store.ts"),
    storeSha256: crypto.createHash("sha256").update(storeSource).digest("hex"),
    productionMessageSectionSha256: crypto.createHash("sha256").update(functions.map((n) => n.getText(ast)).join("\n")).digest("hex"),
    cases: proofCases, forbidden,
  }, null, 2));
  else fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("F18 creation and explicit rename provenance", () => {
  for (const input of [undefined, "", " ", "\n\t"]) it(`canonical positive default only for omitted/blank creation ${JSON.stringify(input)}`, () => {
    const f = fixture(), c = f.store.createConversation(input);
    expect(c).toMatchObject({ title: "New Chat", titleKind: "default" });
    expect(proof(f, c.id, "New Chat").titleKind).toBe("default");
  });
  for (const title of ["New Chat", "新对话", "SYNTHETIC ORDINARY", "  preserve nonblank spacing  ", "x".repeat(230)]) it(`explicit nonblank creation stays literal ${title.slice(0, 30)}`, () => {
    const f = fixture(), c = f.store.createConversation(title);
    expect(c).toMatchObject({ title, titleKind: "literal" });
    f.agent.addMessage(c.id, "user", "different message");
    expect(proof(f, c.id, title).titleKind).toBe("literal");
  });
  for (const title of ["New Chat", "  exact rename  ", "新对话"]) it(`every explicit rename, including same text, is literal ${title}`, () => {
    const f = fixture(), c = f.store.createConversation();
    expect(f.store.renameConversation(c.id, title)).toMatchObject({ title, titleKind: "literal" });
    f.agent.addMessage(c.id, "user", "not an authorized title");
    expect(proof(f, c.id, title).titleKind).toBe("literal");
  });
  for (const title of ["", " \n\t"]) it("blank rename rejects without a save or private diagnostic", () => {
    const f = fixture(), c = f.store.createConversation("SYNTHETIC_PRIVATE_TITLE"), before = f.bytes();
    const error = caught(() => f.store.renameConversation(c.id, title));
    expect(error.message).not.toContain("SYNTHETIC_PRIVATE_TITLE");
    expect(f.bytes()).toEqual(before);
  });
});

describe("F18 one synchronous message/title transition and conservative legacy policy", () => {
  it("message-derived New Chat becomes literal once and metadata survives exact committed readback", () => {
    const f = fixture(); const untouched = record("other", "New Chat", { private: "SYNTHETIC_PRIVATE_VALUE" });
    f.seed([record("target", "New Chat", "default"), untouched]); f.events.length = 0;
    const metadata = { runId: "run_f18", requestId: "request_f18", endReason: "completed", verification: { status: "unverified" } };
    const first = f.agent.addMessage("target", "user", "New Chat", [{ tool: "browser_type", text: "SYNTHETIC_PRIVATE_VALUE", token: "SYNTHETIC_PRIVATE_VALUE" }], metadata);
    expect(first.conv).toMatchObject({ title: "New Chat", titleKind: "literal" });
    expect(first.msgId).toMatch(/^msg_/);
    const writes = f.events.filter((e) => e.op === "writeFileSync");
    expect(writes).toHaveLength(1);
    expect(f.events.filter((e) => e.op === "renameSync")).toHaveLength(1);
    expect(writes[0].rows![0]).toMatchObject({ title: "New Chat", titleKind: "literal" });
    // One mutation load and the established committed readback, not a second
    // load/mutate/save for auto-title.
    expect(f.events.filter((e) => e.op === "readFileSync")).toHaveLength(2);
    expect(first.conv.messages.at(-1)).toMatchObject({ role: "user", content: "New Chat", ...metadata,
      toolResults: [{ tool: "browser_type", text: "[redacted]", token: "[redacted]" }] });
    expect(f.rows()[0].messages[0]).toEqual(record("target", "New Chat").messages[0]);
    expect(f.rows()[1]).toEqual(untouched);
    proof(f, "target", "New Chat");
    f.agent.addMessage("target", "user", "different second message");
    const raw = proof(f, "target", "New Chat");
    expect(raw.titleKind).toBe("literal"); expect(raw.messages).toHaveLength(3);
    expect(raw.extra).toEqual(record("target", "New Chat").extra); expect(raw.createdAt).toBe(12);
  });
  it("generates with the existing slice/ellipsis rule without normalizing nonblank input", () => {
    const f = fixture(), c = f.store.createConversation(), content = "  " + "x".repeat(55);
    f.agent.addMessage(c.id, "user", content);
    expect(proof(f, c.id, content.slice(0, 40) + "...").titleKind).toBe("literal");
  });
  for (const [role, content] of [["assistant", "assistant title"], ["tool", "tool title"], ["user", ""], ["user", " \n\t"]]) it(`does not authorize default transition for ${role}/${JSON.stringify(content)}`, () => {
    const f = fixture(), c = f.store.createConversation(); f.agent.addMessage(c.id, role, content);
    expect(proof(f, c.id, "New Chat").titleKind).toBe("default");
  });
  for (const marker of [undefined, null, "literal", "future", { private: "SYNTHETIC_PRIVATE_VALUE" }, ["default"], true, 7]) {
    for (const title of ["New Chat", "", " \t", "新对话"]) it(`preserves legacy text and opaque metadata ${JSON.stringify(marker)}/${JSON.stringify(title)}`, () => {
      const f = fixture(), original = record("target", title, marker); f.seed([original]);
      const readBefore = f.bytes(); f.store.getConversation("target"); f.store.listConversations(); expect(f.bytes()).toEqual(readBefore);
      f.agent.addMessage("target", "user", "not permitted to replace");
      const raw = proof(f, "target", title);
      expect(raw.titleKind).toEqual(marker); expect(Object.hasOwn(raw, "titleKind")).toBe(marker !== undefined);
      expect(raw.messages[0]).toEqual(original.messages[0]); expect(raw.extra).toEqual(original.extra);
      const dto = f.store.getConversation("target");
      if (marker === null || marker === "literal") expect(dto.titleKind).toBe(marker);
      else expect(dto).not.toHaveProperty("titleKind");
    });
  }
  for (const title of ["SYNTHETIC DOWNGRADE TITLE", "", " \t", "New Chat ", "新对话"]) it(`inconsistent default preserves exact noncanonical text ${JSON.stringify(title)} without read repair`, () => {
    const f = fixture(), original = record("target", title, "default"); f.seed([original]); const before = f.bytes();
    expect(f.store.getConversation("target")).not.toHaveProperty("titleKind");
    expect(f.store.listConversations()[0]).not.toHaveProperty("titleKind"); expect(f.bytes()).toEqual(before);
    f.agent.addMessage("target", "user", "different text");
    expect(proof(f, "target", original.title).titleKind).toBe("default");
  });
  it("unrelated store mutations preserve unknown object markers but no returned DTO carries the object", () => {
    const f = fixture(), original = record("target", "same title", { private: "SYNTHETIC_PRIVATE_VALUE" });
    const other = record("other", "same title", null); f.seed([original, other]);
    expect(f.store.addMessage("target", { role: "assistant", content: "new" })).not.toHaveProperty("titleKind");
    expect(f.store.updateConversationMessages("target", original.messages)).not.toHaveProperty("titleKind");
    const { updatedAt, ...stored } = f.rows()[0];
    const { updatedAt: originalUpdatedAt, ...preserved } = original;
    expect(stored).toEqual(preserved); expect(updatedAt).toBeGreaterThan(originalUpdatedAt);
    expect(f.rows()[1]).toEqual(other);
    expect(f.store.listConversations().filter((c: any) => c.title === "same title")).toHaveLength(2);
    expect(f.store.listConversations().find((c: any) => c.id === "target")).not.toHaveProperty("titleKind");
    proof(f, "target", "same title");
  });
});

describe("F18 identity ambiguity and content-free non-destructive faults", () => {
  for (const action of ["get", "list", "rename", "delete", "append", "replace", "serviceAppend", "create", "rawSave"]) it(`duplicate IDs fail closed before ${action}, never dedup or repair`, () => {
    const f = fixture(), rows = [record("duplicate", "SYNTHETIC_PRIVATE_TITLE", "literal"), { ...record("duplicate", "newest", "default"), updatedAt: 100 }];
    f.seed(rows); const before = f.bytes(); f.events.length = 0;
    const calls: Record<string, () => any> = { get: () => f.store.getConversation("duplicate"), list: () => f.store.listConversations(),
      rename: () => f.store.renameConversation("duplicate", "replacement"), delete: () => f.store.deleteConversation("duplicate"),
      append: () => f.store.addMessage("duplicate", { role: "user", content: "private" }), replace: () => f.store.updateConversationMessages("duplicate", []),
      serviceAppend: () => f.agent.addMessage("duplicate", "user", "private"), create: () => f.store.createConversation(), rawSave: () => f.store.saveConversations(rows) };
    const error = caught(calls[action]); expect(error.message).toMatch(/ambiguous|duplicate/i); expect(error.message).not.toContain("SYNTHETIC_PRIVATE_TITLE");
    expect(f.bytes()).toEqual(before); expect(f.events.filter((e) => e.op !== "readFileSync")).toEqual([]);
    expect(fs.readdirSync(f.dir)).toEqual(["agent-conversations.json"]);
  });
  it("new creation cannot introduce an existing ID even on generator collision", () => {
    const f = fixture(); f.faults.collision = true; f.store.createConversation("first"); const before = f.bytes();
    const error = caught(() => f.store.createConversation("second")); expect(error.message).toMatch(/duplicate|collision|unique/i); expect(f.bytes()).toEqual(before);
  });
  for (const fault of ["read", "write", "rename"] as const) it(`injected ${fault} failure preserves committed bytes and reports no private content`, () => {
    const f = fixture(); f.seed([record("target", "New Chat", "default")]); const before = f.bytes(); f.faults[fault] = true;
    const error = caught(() => f.agent.addMessage("target", "user", "SYNTHETIC_PRIVATE_VALUE"));
    expect(error.message).not.toContain("SYNTHETIC_PRIVATE_VALUE");
    expect(error.cause && String(error.cause)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
    expect(f.logs.join("\n")).not.toContain("SYNTHETIC_PRIVATE_VALUE"); expect(f.bytes()).toEqual(before);
    f.faults[fault] = false; proof(f, "target", "New Chat");
    if (fs.existsSync(f.file + ".tmp")) expect(fs.statSync(f.file + ".tmp").mode & 0o777).toBe(0o600);
  });
  for (const fault of ["read", "write", "rename"] as const) it(`arbitrary injected ${fault} error code cannot disclose private values`, () => {
    const f = fixture(); f.seed([record("target", "New Chat", "default")]); const before = f.bytes();
    f.faults[fault] = true; f.faults.code = "SYNTHETIC_PRIVATE_VALUE";
    const error = caught(() => f.agent.addMessage("target", "user", "message"));
    expect(error.message).not.toContain("SYNTHETIC_PRIVATE_VALUE");
    expect(JSON.stringify(error.cause)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
    expect(f.bytes()).toEqual(before);
  });
  for (const backup of [false, true]) it(`corrupt JSON retains exact original bytes and content-free diagnostic, backup failure=${backup}`, () => {
    const f = fixture(); fs.writeFileSync(f.file, '{"private":"SYNTHETIC_PRIVATE_VALUE"', { mode: 0o600 }); const before = f.bytes(); f.faults.backup = backup;
    const error = caught(() => f.store.createConversation()); expect(error.message).not.toContain("SYNTHETIC_PRIVATE_VALUE"); expect(f.bytes()).toEqual(before);
    const backups = fs.readdirSync(f.dir).filter((s) => s.endsWith(".corrupt")); expect(backups).toHaveLength(backup ? 0 : 1);
    for (const name of backups) { expect(fs.readFileSync(path.join(f.dir, name))).toEqual(before); expect(fs.statSync(path.join(f.dir, name)).mode & 0o777).toBe(0o600); }
  });
  it("ordinary default commits and detached reads keep restricted store permissions", () => {
    const f = fixture(), c = f.store.createConversation(); expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
    const dto = f.store.getConversation(c.id); dto.title = "alias"; dto.messages.push({ role: "user", content: "alias" });
    expect(proof(f, c.id, "New Chat").messages).toEqual([]);
  });
});

// Adversarial JS error objects are intentionally distinct from ordinary Node
// errno faults. The whole current store reads the getter/proxy, not a classifier
// reimplementation. A muted injection cannot pass these UNKNOWN/counter checks.
function codeAccessFixture(f: ReturnType<typeof fixture>, operation: "readFileSync" | "writeFileSync" | "renameSync" | "copyFileSync", shape: "getter" | "proxy") {
  const secret = "SYNTHETIC_PRIVATE_DIAGNOSTIC_NEVER_ECHO";
  const counters = { injected: 0, codeReads: 0 };
  const privateError = new Error(secret, { cause: { private: secret } });
  const throwCode = () => { counters.codeReads++; throw new Error(secret, { cause: { private: secret } }); };
  const hostile = shape === "getter"
    ? Object.defineProperty(privateError, "code", { get: throwCode })
    : new Proxy(privateError, { get(target, key, receiver) { return key === "code" ? throwCode() : Reflect.get(target, key, receiver); } });
  const scopedFs = new Proxy(fs, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== "function") return value;
    return (...args: any[]) => {
      for (const arg of [args[0], ...(["copyFileSync", "renameSync"].includes(String(key)) ? [args[1]] : [])]) {
        if (typeof arg === "string" && !path.resolve(arg).startsWith(f.dir + path.sep)) {
          forbidden.push("adversarial filesystem outside case"); throw new Error("Forbidden fixture operation");
        }
      }
      if (key === operation) { counters.injected++; throw hostile; }
      return value(...args);
    };
  } });
  const logs: string[] = [];
  const module = { exports: {} as ProductionStore };
  vm.runInNewContext(`(function(require,module,exports){${storeCode}\n})`, {
    Date, Math, console: { error: (...args: unknown[]) => logs.push(args.map(String).join(" ")) },
  })((name: string) => {
    if (name === "node:fs") return scopedFs;
    if (name === "node:path") return path;
    if (name === "node:crypto") return crypto;
    if (name === "../config-manager.js") return { getAppDataDir: () => f.dir };
    forbidden.push("adversarial store dependency"); throw new Error("Unexpected dependency");
  }, module, module.exports);
  return { store: module.exports, counters, logs, secret };
}

function freshRejection(f: ReturnType<typeof fixture>, id: unknown) {
  const script = path.join(f.dir, "fresh-rejected.cjs");
  fs.writeFileSync(script, `const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const result={exports:{}};const dir=__dirname;
const scopedFs=new Proxy(fs,{get(t,k){const v=t[k];if(typeof v!=='function')return v;return (...a)=>{for(const p of [a[0],...(['copyFileSync','renameSync'].includes(k)?[a[1]]:[])])if(typeof p==='string'&&!path.resolve(p).startsWith(dir+path.sep))throw Error('Outside fixture');return v(...a)}}});
vm.runInNewContext('(function(require,module,exports){'+${JSON.stringify(storeCode)}+'\\n})',{Date,Math,console:{error(){throw Error('Unexpected diagnostic')}}})(n=>{if(n==='node:fs')return scopedFs;if(n==='node:path')return path;if(n==='node:crypto')return crypto;if(n==='../config-manager.js')return {getAppDataDir:()=>dir};throw Error('Unexpected dependency')},result,result.exports);
const s=result.exports, rejection={};for(const [name,fn] of [['get',()=>s.getConversation(${JSON.stringify(id) ?? "undefined"})],['list',()=>s.listConversations()],['clearAll',()=>s.saveConversations([])]]){try{fn();rejection[name]={rejected:false}}catch(e){rejection[name]={rejected:true,message:e.message}}}
process.stdout.write(JSON.stringify(rejection));`);
  const result = spawnSync(process.execPath, [script], { cwd: f.dir, encoding: "utf8", env: {
    HOME: f.dir, TMPDIR: f.dir, TMP: f.dir, TEMP: f.dir, XDG_CONFIG_HOME: f.dir, XDG_CACHE_HOME: f.dir,
    XDG_DATA_HOME: f.dir, M1_AGENT_TEST_DATA: f.dir, NODE_COMPILE_CACHE: f.dir, NODE_ENV: "test",
  } });
  expect(result.status, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout);
  fs.writeFileSync(path.join(f.dir, "fresh-rejection-result.json"), JSON.stringify(output, null, 2));
  fs.writeFileSync(path.join(f.dir, "fresh-rejection-committed.json"), f.bytes());
  for (const name of ["get", "list", "clearAll"]) expect(output[name]).toMatchObject({ rejected: true });
}

function identityCalls(f: ReturnType<typeof fixture>, id: unknown, rows: any[]): Array<[string, () => unknown]> {
  const store = f.store as ProductionStore, requested = id as string;
  return [
    ["rename", () => store.renameConversation(requested, "unauthorized replacement")],
    ["append", () => store.addMessage(requested, { role: "user", content: "unauthorized message" }, true)],
    ["get", () => store.getConversation(requested)], ["delete", () => store.deleteConversation(requested)],
    ["clear", () => store.updateConversationMessages(requested, [])],
    ["serviceAppend", () => f.agent.addMessage(requested, "user", "unauthorized message")],
    ["list", () => store.listConversations()], ["create", () => store.createConversation()],
    ["saveMalformed", () => store.saveConversations(rows)],
    ["clearAll", () => store.saveConversations([])],
    ["replaceAll", () => store.saveConversations([record("replacement", "New Chat", "default")])],
  ];
}

const reviewedMalformedIds: Array<[string, unknown]> = [["missing", undefined], ["null", null], ["number", 7], ["empty", ""]];
describe("F18 twelve independent reviewed counterexamples (desired rejection)", () => {
  for (const [label, id] of reviewedMalformedIds) it(`reviewed malformed ${label} ID cannot authorize persisted rename or any other operation`, () => {
    const f = fixture(), bad: Record<string, unknown> = { ...record("unused", "SYNTHETIC_PRIVATE_TITLE", { opaque: "preserve" }), id };
    if (id === undefined) delete bad.id;
    const rows = [bad, record("valid legacy id", "valid title", "literal")]; f.seed(rows);
    const before = f.bytes(); f.events.length = 0;
    for (const [action, call] of [...identityCalls(f, id, rows), ...identityCalls(f, "valid legacy id", rows)]) {
      const error = caught(call); expect(error.message, action).toMatch(/invalid|malformed|identity|ID/i);
      expect(inspect(error)).not.toContain("SYNTHETIC_PRIVATE_TITLE"); expect(f.bytes(), action).toEqual(before);
    }
    expect(f.events.filter((event) => event.op !== "readFileSync")).toEqual([]);
    expect(fs.readdirSync(f.dir)).toEqual(["agent-conversations.json"]);
    freshRejection(f, id); expect(f.bytes()).toEqual(before);
  });
  it("reviewed duplicate numeric 7 IDs cannot authorize first-record append, repair or clear", () => {
    const f = fixture(), rows = [{ ...record("unused", "first", "default"), id: 7 }, { ...record("unused", "second", null), id: 7 }];
    f.seed(rows); const before = f.bytes(); f.events.length = 0;
    const error = caught(() => f.store.addMessage(7, { role: "user", content: "unauthorized" }, true));
    expect(error.message).toMatch(/invalid|malformed|ambiguous|ID/i);
    for (const [action, call] of identityCalls(f, 7, rows)) { caught(call); expect(f.bytes(), action).toEqual(before); }
    expect(f.events.filter((event) => event.op !== "readFileSync")).toEqual([]);
    freshRejection(f, 7); expect(f.bytes()).toEqual(before);
  });
  for (const operation of ["readFileSync", "writeFileSync", "renameSync"] as const) {
    for (const shape of ["getter", "proxy"] as const) it(`reviewed ${operation} throwing code ${shape} is UNKNOWN without disclosure`, () => {
      const f = fixture(); f.seed([record("target", "New Chat", "default"), record("other", "legacy", { opaque: "preserve" })]);
      const before = f.bytes(), adversarial = codeAccessFixture(f, operation, shape);
      const error = caught(() => adversarial.store.addMessage("target", { role: "user", content: "must not commit" }, true));
      expect(error.message).toMatch(/Failed to (read|save).*\(UNKNOWN\)/);
      expect(inspect(error)).not.toContain(adversarial.secret);
      expect(error.cause).toMatchObject({ code: "UNKNOWN", message: "Conversation history filesystem failure" });
      expect(adversarial.counters.injected).toBe(1); expect(adversarial.counters.codeReads).toBeGreaterThan(0);
      expect(adversarial.logs).toEqual([]); expect(f.bytes()).toEqual(before);
      const direct = proof(f, "target", "New Chat"); expect(direct.titleKind).toBe("default");
      expect(f.fresh("other", "legacy").get).not.toHaveProperty("titleKind"); expect(f.rows()[1].titleKind).toEqual({ opaque: "preserve" });
      fs.writeFileSync(path.join(f.dir, "adversarial-injection.json"), JSON.stringify({ category: "injected getter/proxy, not ordinary production FS errno", operation, shape, counters: adversarial.counters, message: error.message }));
    });
  }
  it("reviewed salvage-copy throwing code getter remains content-free and leaves corrupt original intact", () => {
    const f = fixture(); fs.writeFileSync(f.file, '{"private":"SYNTHETIC_PRIVATE_DIAGNOSTIC_NEVER_ECHO"', { mode: 0o600 });
    const before = f.bytes(), adversarial = codeAccessFixture(f, "copyFileSync", "getter");
    const error = caught(() => adversarial.store.createConversation());
    expect(error.message).toMatch(/salvage backup failed \(UNKNOWN\)/); expect(inspect(error)).not.toContain(adversarial.secret);
    expect(adversarial.counters).toEqual({ injected: 1, codeReads: 1 }); expect(f.bytes()).toEqual(before);
    expect(fs.readdirSync(f.dir)).toEqual(["agent-conversations.json"]);
    freshRejection(f, "target"); expect(f.bytes()).toEqual(before);
    fs.writeFileSync(path.join(f.dir, "adversarial-injection.json"), JSON.stringify({ category: "injected getter, not ordinary production FS errno", operation: "copyFileSync", counters: adversarial.counters, message: error.message }));
  });
});

describe("F18 identity boundaries and ordinary filesystem positive controls", () => {
  it("salvage-copy throwing code proxy also preserves corrupt bytes with UNKNOWN classification", () => {
    const f = fixture(); fs.writeFileSync(f.file, "{invalid synthetic", { mode: 0o600 });
    const before = f.bytes(), adversarial = codeAccessFixture(f, "copyFileSync", "proxy");
    const error = caught(() => adversarial.store.loadConversations());
    expect(error.message).toMatch(/salvage backup failed \(UNKNOWN\)/); expect(inspect(error)).not.toContain(adversarial.secret);
    expect(adversarial.counters).toEqual({ injected: 1, codeReads: 1 }); expect(f.bytes()).toEqual(before);
    expect(fs.readdirSync(f.dir)).toEqual(["agent-conversations.json"]);
    freshRejection(f, "target"); expect(f.bytes()).toEqual(before);
  });
  it("valid legacy deletion really removes only the exact requested row and is durable", () => {
    const f = fixture(), preserved = record("legacy / kept", "exact kept title", { opaque: ["preserve", null] });
    f.seed([record("7", "deleted title", "literal"), preserved]);
    expect(f.store.deleteConversation("7")).toBe(true); expect(f.rows()).toEqual([preserved]);
    expect(f.store.deleteConversation("7")).toBe(false);
    const result = f.fresh("7", "deleted title"); expect(result.get).toBeNull(); expect(result.byId).toEqual([]);
    expect(result.byTitle).toEqual([]); expect(result.byTitleFragment).toEqual([]);
    expect(proof(f, preserved.id, preserved.title).titleKind).toEqual(preserved.titleKind);
  });
  for (const id of [undefined, null, 7, "", " \n\t", {}, [], true]) it(`unusable requested ID ${JSON.stringify(id)} rejects even against valid history`, () => {
    const f = fixture(), c = f.store.createConversation("valid title"), before = f.bytes(); f.events.length = 0;
    for (const [, call] of identityCalls(f, id, []).slice(0, 6)) {
      const error = caught(call); expect(error.message).toMatch(/ID|identity/i); expect(f.bytes()).toEqual(before);
    }
    expect(f.events).toEqual([]); proof(f, c.id, "valid title");
  });
  for (const bad of [null, 7, {}, { id: " \n\t" }]) it(`any malformed stored row ${JSON.stringify(bad)} blocks valid-target operations and public clear/save`, () => {
    const f = fixture(), rows = [record("valid", "title", null), bad]; f.seed(rows); const before = f.bytes();
    for (const [, call] of identityCalls(f, "valid", rows)) { caught(call); expect(f.bytes()).toEqual(before); }
    freshRejection(f, "valid"); expect(f.bytes()).toEqual(before);
  });
  it("duplicate valid IDs also block public save of a replacement or empty array", () => {
    const f = fixture(); f.seed([record("same", "first"), record("same", "second")]); const before = f.bytes();
    for (const rows of [[], [record("replacement", "replacement")]]) { expect(caught(() => f.store.saveConversations(rows)).message).toMatch(/duplicate|ambiguous/i); expect(f.bytes()).toEqual(before); }
    freshRejection(f, "same"); expect(f.bytes()).toEqual(before);
  });
  it("save of malformed requested rows rejects before any filesystem effect on a valid history", () => {
    const f = fixture(); f.seed([record("legacy", "legacy")]); const before = f.bytes(); f.events.length = 0;
    for (const id of [undefined, null, 7, "", " \t"]) {
      expect(caught(() => f.store.saveConversations([{ ...record("unused", "private"), id }])).message).toMatch(/ID|identity/i);
      expect(f.bytes()).toEqual(before);
    }
    expect(f.events).toEqual([]); proof(f, "legacy", "legacy");
  });
  it("valid non-UUID IDs remain byte-exact, title-exact and distinct; unknown markers survive unrelated and own writes", () => {
    const f = fixture(), id = "  legacy ID / 中文  ", opaque = { nested: ["future", null, { private: "synthetic" }] };
    const legacy = record(id, " legacy exact title ", opaque), other = record("7", " legacy exact title ", "literal");
    f.seed([legacy, other]); const initial = f.bytes(); f.store.getConversation(id); f.store.listConversations(); expect(f.bytes()).toEqual(initial);
    f.store.addMessage("7", { role: "assistant", content: "unrelated" }); expect(f.rows()[0]).toEqual(legacy);
    f.agent.addMessage(id, "user", "not an authorized replacement");
    f.store.updateConversationMessages(id, legacy.messages);
    f.store.saveConversations(f.store.loadConversations());
    expect(proof(f, id, legacy.title).titleKind).toEqual(opaque);
    const fresh = f.fresh(id, legacy.title); expect(fresh.byId).toHaveLength(1); expect(fresh.byTitle).toHaveLength(2);
    expect(fresh.byTitleFragment).toHaveLength(2); expect(fresh.get).not.toHaveProperty("titleKind");
    expect(fresh.list.every((row: any) => !row.titleKind || typeof row.titleKind === "string")).toBe(true);
    expect(f.store.renameConversation(id, legacy.title)).toMatchObject({ id, title: legacy.title, titleKind: "literal" });
    expect(proof(f, id, legacy.title).titleKind).toBe("literal");
  });
  it("genuine initial ENOENT is empty history and permits first creation", () => {
    const f = fixture(); expect(f.store.loadConversations()).toEqual([]); expect(f.store.listConversations()).toEqual([]);
    expect(f.store.getConversation("valid missing ID")).toBeNull(); expect(fs.readdirSync(f.dir)).toEqual([]);
    const c = f.store.createConversation(); expect(proof(f, c.id, "New Chat").titleKind).toBe("default");
  });
  it("public save and clear remain usable for valid history and genuinely absent initial history", () => {
    const f = fixture(); f.store.saveConversations([record("legacy", "exact", null)]); proof(f, "legacy", "exact");
    f.store.saveConversations([]); expect(f.rows()).toEqual([]); expect(f.fresh("legacy", "exact").get).toBeNull();
  });
  for (const fault of ["read", "write", "rename", "backup"] as const) it(`ordinary ${fault} errno remains allowlisted, not an adversarial getter plant`, () => {
    const f = fixture();
    if (fault === "backup") fs.writeFileSync(f.file, "{invalid synthetic", { mode: 0o600 });
    else f.seed([record("target", "New Chat", "default")]);
    const before = f.bytes(); f.faults[fault] = true;
    for (const code of ["EACCES", "EBADF", "EBUSY", "EEXIST", "EFBIG", "EINTR", "EINVAL", "EIO", "EISDIR", "ELOOP", "EMFILE", "ENAMETOOLONG", "ENFILE", "ENOMEM", "ENOSPC", "ENOTDIR", "ENOTEMPTY", "EPERM", "EROFS", "EXDEV", ...(fault === "read" ? [] : ["ENOENT"])]) {
      f.faults.code = code;
      const error = caught(() => f.store.createConversation()); expect(error.message).toContain(`(${code})`);
      expect(inspect(error)).not.toContain("SYNTHETIC_PRIVATE_VALUE"); expect(f.bytes()).toEqual(before);
    }
    f.faults[fault] = false;
    if (fault === "backup") freshRejection(f, "target"); else proof(f, "target", "New Chat");
    expect(f.bytes()).toEqual(before);
  });
  for (const code of [{ private: "SYNTHETIC_PRIVATE_VALUE" }, Symbol("SYNTHETIC_PRIVATE_VALUE"), () => "SYNTHETIC_PRIVATE_VALUE", null]) it(`arbitrary non-string code type ${typeof code} stays content-free UNKNOWN`, () => {
    const f = fixture(); f.seed([record("target", "title")]); const before = f.bytes(); f.faults.read = true; f.faults.code = code;
    const error = caught(() => f.store.loadConversations()); expect(error.message).toContain("(UNKNOWN)"); expect(inspect(error)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
    expect(f.bytes()).toEqual(before); f.faults.read = false; proof(f, "target", "title");
  });
});
