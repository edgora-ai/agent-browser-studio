// Whole registered IPC and whole REST/MCP dispatchers with the production JSON
// store/local-agent aliases. No Electron IPC serialization, auth/socket server,
// MCP connection, browser, provider, Keychain or real-data acceptance is claimed.
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vm from "node:vm";
import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const SOURCE = path.resolve(__dirname, "../../src/main");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "title-transports-proof-"));
const files = ["ipc/agent.ts", "services/rest-api-server.ts", "services/mcp-server.ts",
  "services/local-agent.ts", "services/agent/conversation-store.ts", "services/http/body.ts"];
const sources = new Map(files.map(file => [file, fs.readFileSync(path.join(SOURCE, file), "utf8")]));
const compile = (source: string) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const forbidden: string[] = [];
const cases: string[] = [];
const reject = (name: string): never => { forbidden.push(name); throw new Error(`PROHIBITED ${name}`); };
// Imports may reference a facade; actually calling one always fails closed.
function opaque(name: string): any {
  return new Proxy({}, { get: (_target, key) => key === "__esModule" ? false
    : key === "then" ? undefined : (..._args: unknown[]) => reject(`${name}.${String(key)}`) });
}
const plain = (value: any): any => structuredClone(value);
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (id: string, title: string, marker?: unknown) => ({
  id, title, ...(marker === undefined ? {} : { titleKind: marker }),
  messages: [{ role: "assistant", content: "SYNTHETIC_MESSAGE", timestamp: 11 }],
  createdAt: 12, updatedAt: 13, extra: { preserved: [id, null] },
});

type Transport = "ipc" | "rest" | "mcp";
function fixture() {
  const dir = fs.mkdtempSync(path.join(ROOT, "case-")); cases.push(dir);
  const file = path.join(dir, "agent-conversations.json");
  const events: string[] = [];
  const audits: any[] = [];
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const modules = new Map<string, any>();
  const role = { ok: true };
  const context = vm.createContext({ Buffer, URL, console: {
    error: (..._args: unknown[]) => reject("unexpected diagnostic"),
    warn: (..._args: unknown[]) => reject("unexpected diagnostic"),
    log: (..._args: unknown[]) => reject("unexpected diagnostic"),
  }, process: { env: { HOME: dir, M1_AGENT_TEST_DATA: dir,
    AGENT_BROWSER_API_TOKEN: "synthetic-title-transport-token",
    AGENT_BROWSER_MCP_TOKEN: "synthetic-title-mcp-token" }, platform: process.platform },
    fetch: (..._args: unknown[]) => reject("fetch"),
    setTimeout: (..._args: unknown[]) => reject("timer"),
    setInterval: (..._args: unknown[]) => reject("timer"),
  });
  const scopedFs = new Proxy(fs, { get(target, key) {
    const fn = Reflect.get(target, key);
    if (typeof fn !== "function") return fn;
    return (...args: any[]) => {
      const operands = [args[0], ...(["renameSync", "copyFileSync", "linkSync", "symlinkSync"].includes(String(key)) ? [args[1]] : [])];
      for (const operand of operands) {
        if (typeof operand !== "string" || !path.resolve(operand).startsWith(dir + path.sep)) reject(`filesystem ${String(key)} escape`);
      }
      events.push(String(key));
      return fn(...args);
    };
  } });
  function load(relative: string): any {
    if (modules.has(relative)) return modules.get(relative).exports;
    const source = sources.get(relative);
    assert.notEqual(source, undefined, `unapproved production module ${relative}`);
    const module = { exports: {} as any }; modules.set(relative, module);
    // Test-only binding exposure, not extracted functions or replacement dispatch.
    const expose = relative === "services/rest-api-server.ts" ? "\nexports.__dispatch = handleRequest;"
      : relative === "services/mcp-server.ts" ? "\nexports.__dispatch = executeMcpTool; exports.__tools = MCP_EXPANDED_TOOLS;" : "";
    function req(name: string): any {
      if (name === "electron") return {
        ipcMain: { handle: (channel: string, handler: (...args: any[]) => Promise<any>) => {
          assert.equal(handlers.has(channel), false); handlers.set(channel, handler);
        } }, clipboard: opaque("clipboard"), BrowserWindow: opaque("BrowserWindow"), dialog: opaque("dialog"),
      };
      if (name === "node:fs") return scopedFs;
      if (name === "node:path") return path;
      if (name === "node:crypto") return crypto;
      if (name.startsWith("node:")) return opaque(name);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), name.replace(/\.js$/, ".ts")));
      if (sources.has(resolved)) return load(resolved);
      if (resolved === "services/config-manager.ts") return { ...opaque(resolved), getAppDataDir: () => dir };
      if (resolved === "services/team.ts") return { requireSettingsMutation: () => ({ ok: role.ok, error: "synthetic role denied" }) };
      if (resolved === "services/audit-log.ts") return { recordAudit: (event: any) => audits.push(plain(event)) };
      return opaque(resolved);
    }
    const full = path.join(SOURCE, relative);
    vm.runInContext(`(function(require,module,exports,__filename,__dirname){${compile(source! + expose)}\n})`, context, { filename: full })(req, module, module.exports, full, path.dirname(full));
    return module.exports;
  }
  const store = load("services/agent/conversation-store.ts");
  const agent = load("services/local-agent.ts");
  // Require actual re-exported producers, not raw loader facades.
  for (const key of ["listConversations", "createConversation", "getConversation", "renameConversation"]) assert.equal(agent[key], store[key]);
  load("ipc/agent.ts").registerAgentHandlers();
  const rest = load("services/rest-api-server.ts");
  const mcp = load("services/mcp-server.ts");
  const bytes = () => fs.readFileSync(file);
  const rows = (): any[] => JSON.parse(bytes().toString());
  const seed = (records: any[]) => fs.writeFileSync(file, JSON.stringify(records, null, 2), { mode: 0o600 });
  const writes = () => events.filter(event => ["writeFileSync", "renameSync", "copyFileSync", "chmodSync"].includes(event));
  const ipc = async (operation: string, ...args: any[]) => {
    const handler = handlers.get(`agent:conversations:${operation}`);
    assert.ok(handler, `registered ${operation}`);
    return plain(await handler({ sender: opaque("sender") }, ...args));
  };
  async function request(method: string, route: string, body?: any) {
    const req: any = new EventEmitter(); req.method = method; req.headers = {};
    req.destroy = () => reject("unexpected request destruction");
    const pending = rest.__dispatch(req, new URL(route, "https://title.synthetic.invalid"));
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
    return plain(await pending);
  }
  const call = async (name: string, args: any = {}) => {
    assert.ok(mcp.__tools.some((tool: any) => tool.name === name), `supported MCP tool ${name}`);
    return plain(await mcp.__dispatch(name, args));
  };
  async function list(transport: Transport): Promise<any[]> {
    if (transport === "ipc") return ipc("list");
    if (transport === "mcp") return (await call("agent_browser_conversations_list")).conversations;
    const result = await request("GET", "/api/agent/conversations"); assert.equal(result.status, 200);
    return result.body.conversations;
  }
  async function get(transport: Transport, id: string): Promise<any> {
    if (transport === "ipc") return ipc("get", id);
    if (transport === "mcp") return (await call("agent_browser_conversation_get", { conversationId: id })).conversation;
    const result = await request("GET", "/api/agent/conversations/" + encodeURIComponent(id)); assert.equal(result.status, 200);
    return result.body.conversation;
  }
  async function create(transport: Transport, title?: unknown): Promise<any> {
    if (transport === "ipc") return ipc("create", title);
    if (transport === "mcp") return (await call("agent_browser_conversation_create", { title })).conversation;
    const result = await request("POST", "/api/agent/conversations", { title });
    assert.equal(result.status, 201); assert.equal(result.body.success, true);
    return result.body.conversation;
  }
  async function rename(transport: "ipc" | "rest", id: string, title: unknown): Promise<any> {
    if (transport === "ipc") return ipc("rename", { id, title });
    const result = await request("PATCH", "/api/agent/conversations/" + encodeURIComponent(id), { title });
    assert.equal(result.status, 200); assert.equal(result.body.success, true);
    return result.body.conversation;
  }
  // Fresh process executes the same full production store with a path guard.
  function fresh(id: string, title: string) {
    const script = path.join(dir, "fresh.cjs");
    fs.writeFileSync(script, `const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const dir=__dirname,m={exports:{}};
const scopedFs=new Proxy(fs,{get(t,k){const fn=t[k];if(typeof fn!=='function')return fn;return (...a)=>{for(const p of [a[0],...(['copyFileSync','renameSync'].includes(k)?[a[1]]:[])])if(typeof p!=='string'||!path.resolve(p).startsWith(dir+path.sep))throw Error('Filesystem escape');return fn(...a)}}});
vm.runInNewContext('(function(require,module,exports){'+${JSON.stringify(compile(sources.get("services/agent/conversation-store.ts")!))}+'\\n})',{console:{error(){throw Error('Unexpected diagnostic')}}})(n=>{if(n==='node:fs')return scopedFs;if(n==='node:path')return path;if(n==='node:crypto')return crypto;if(n==='../config-manager.js')return {getAppDataDir:()=>dir};throw Error('Forbidden dependency')},m,m.exports);
const list=m.exports.listConversations();process.stdout.write(JSON.stringify({get:m.exports.getConversation(${JSON.stringify(id)}),list,byId:list.filter(c=>c.id===${JSON.stringify(id)}),search:list.filter(c=>c.title===${JSON.stringify(title)})}));`);
    const env: NodeJS.ProcessEnv = { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir, M1_AGENT_TEST_DATA: dir, NODE_COMPILE_CACHE: dir, NODE_ENV: "test" };
    const result = spawnSync(process.execPath, [script], { env, cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    fs.writeFileSync(path.join(dir, `reload-${id}.json`), JSON.stringify(value, null, 2));
    return value;
  }
  return { dir, file, store, events, audits, role, ipc, request, call, list, get, create, rename, bytes, rows, seed, writes, fresh, mcp };
}

function metadata(row: any, expected: "default" | "literal" | null | undefined) {
  assert.equal(owns(row, "titleKind"), expected !== undefined, "preserve marker presence, including null vs absence");
  assert.equal(row.titleKind, expected, "preserve allowlisted marker exactly");
  assert.equal(JSON.stringify(row).includes("SYNTHETIC_OPAQUE_PRIVATE"), false);
}
function committed(f: ReturnType<typeof fixture>, id: string, title: string, marker: "default" | "literal") {
  const before = f.bytes(), direct = f.rows().find(row => row.id === id);
  assert.ok(direct); assert.equal(direct.title, title); metadata(direct, marker);
  const reloaded = f.fresh(id, title);
  assert.equal(reloaded.get.title, title); metadata(reloaded.get, marker);
  assert.deepEqual(reloaded.byId, [reloaded.get]);
  assert.ok(reloaded.search.some((row: any) => row.id === id));
  assert.deepEqual(f.bytes(), before);
  return direct;
}

afterAll(() => {
  assert.deepEqual(forbidden, []);
  if (process.env.TITLE_TRANSPORT_RETAIN) fs.writeFileSync(path.join(ROOT, "manifest.json"), JSON.stringify({
    sources: Object.fromEntries([...sources].map(([file, source]) => [path.join(SOURCE, file), crypto.createHash("sha256").update(source).digest("hex")])),
    cases, forbidden, notRun: ["Electron IPC serialization", "HTTP auth/socket", "MCP connection", "native", "provider", "real data"],
  }, null, 2));
  else fs.rmSync(ROOT, { recursive: true, force: true });
});

for (const transport of ["ipc", "rest", "mcp"] as const) describe(`${transport} whole production conversation dispatch`, () => {
  const matrix = [
    ["default", "New Chat", "default", "default"],
    ["literal", "New Chat", "literal", "literal"],
    ["translated", "新对话", "literal", "literal"],
    ["null", "New Chat", null, null],
    ["absent", "New Chat", undefined, undefined],
    ["unknown-object", "New Chat", { private: "SYNTHETIC_OPAQUE_PRIVATE" }, undefined],
    ["unknown-string", "New Chat", "future", undefined],
    ["inconsistent", "SYNTHETIC_CHANGED_TITLE", "default", undefined],
    ["legacy-empty", "", undefined, undefined],
    ["literal-space", "   ", "literal", "literal"],
  ] as const;
  for (const [id, title, storedMarker, dtoMarker] of matrix) it(`list/get preserve exact text and sanitized provenance: ${id}`, async () => {
    const f = fixture(); f.seed([record(id, title, storedMarker), record("other", "New Chat", "literal")]);
    const before = f.bytes(); f.events.length = 0;
    const list = await f.list(transport), selected = list.find(row => row.id === id);
    assert.ok(selected); metadata(selected, dtoMarker); assert.equal(selected.title, title);
    assert.equal(selected.messageCount, 1); assert.equal(owns(selected, "messages"), false); assert.equal(owns(selected, "extra"), false);
    const full = await f.get(transport, id);
    assert.equal(full.id, id); assert.equal(full.title, title); metadata(full, dtoMarker);
    assert.deepEqual(full.messages, f.rows().find(row => row.id === id).messages);
    assert.deepEqual(full.extra, { preserved: [id, null] });
    assert.ok(list.filter(row => row.title === title).some(row => row.id === id));
    assert.deepEqual(f.bytes(), before); assert.deepEqual(f.writes(), []);
    const fresh = f.fresh(id, title); metadata(fresh.get, dtoMarker); assert.equal(fresh.get.title, title);
    assert.deepEqual(f.bytes(), before);
  });
  it("duplicate titles retain separate IDs, newest order, get target and raw search results", async () => {
    const f = fixture(); const older = record("older", "New Chat", "literal"), newer = { ...record("newer", "New Chat", "default"), updatedAt: 99 };
    f.seed([older, newer]); const before = f.bytes(); f.events.length = 0;
    const list = await f.list(transport); assert.deepEqual(list.map(row => row.id), ["newer", "older"]);
    metadata(list[0], "default"); metadata(list[1], "literal");
    assert.equal((await f.get(transport, "older")).id, "older");
    assert.deepEqual(list.filter(row => row.title.includes("New Chat")).map(row => row.id), ["newer", "older"]);
    assert.deepEqual(f.bytes(), before); assert.deepEqual(f.writes(), []);
  });
  for (const input of [undefined, "", " \n\t", "New Chat", "新对话", "  exact nonblank  ", "x".repeat(230)]) it(`create response/committed JSON/readback/search: ${JSON.stringify(input)?.slice(0, 30)}`, async () => {
    const f = fixture(); const untouched = record("untouched", "New Chat", { private: "SYNTHETIC_OPAQUE_PRIVATE" }); f.seed([untouched]);
    const normalized = transport === "ipc" ? input : input?.trim().slice(0, 200);
    const defaulted = !normalized?.trim(), title = defaulted ? "New Chat" : normalized!;
    f.events.length = 0;
    const result = await f.create(transport, input), marker = defaulted ? "default" : "literal";
    metadata(result, marker); assert.equal(result.title, title); assert.equal(result.messageCount, 0); assert.equal(owns(result, "messages"), false);
    assert.equal(f.events.filter(event => event === "writeFileSync").length, 1);
    assert.equal(f.events.filter(event => event === "renameSync").length, 1);
    committed(f, result.id, title, marker);
    assert.deepEqual(f.rows().find(row => row.id === "untouched"), untouched);
    const before = f.bytes(); f.events.length = 0;
    for (const reader of ["ipc", "rest", "mcp"] as const) {
      metadata(await f.get(reader, result.id), marker);
      metadata((await f.list(reader)).find(row => row.id === result.id), marker);
    }
    assert.deepEqual(f.bytes(), before); assert.deepEqual(f.writes(), []);
  });
});

for (const transport of ["ipc", "rest"] as const) describe(`${transport} existing rename contract`, () => {
  for (const input of ["New Chat", "新对话", "  exact rename  ", "r".repeat(230)]) it(`rename returns conversation, preserves target and writes literal: ${input.slice(0, 30)}`, async () => {
    const f = fixture(), target = record("target", "New Chat", "default"), other = record("other", "New Chat", null);
    f.seed([target, other]); f.events.length = 0;
    const title = transport === "ipc" ? input : input.trim().slice(0, 200);
    const result = await f.rename(transport, "target", input);
    assert.equal(result.id, "target"); assert.equal(result.title, title); metadata(result, "literal");
    if (transport === "ipc") assert.deepEqual(result.messages, target.messages);
    else { assert.equal(result.messageCount, 1); assert.equal(owns(result, "messages"), false); }
    assert.equal(f.events.filter(event => event === "writeFileSync").length, 1);
    assert.equal(f.events.filter(event => event === "renameSync").length, 1);
    committed(f, "target", title, "literal"); assert.deepEqual(f.rows().find(row => row.id === "other"), other);
    const before = f.bytes(); f.events.length = 0;
    for (const reader of ["ipc", "rest", "mcp"] as const) metadata((await f.list(reader)).find(row => row.id === "target"), "literal");
    assert.deepEqual(f.bytes(), before); assert.deepEqual(f.writes(), []);
  });
  it("blank rename stays rejected without writes or content disclosure", async () => {
    const f = fixture(); f.seed([record("target", "SYNTHETIC_PRIVATE_TITLE", "literal")]);
    const before = f.bytes(); f.events.length = 0;
    if (transport === "ipc") await assert.rejects(f.rename(transport, "target", " \n\t"), error => {
      assert.equal((error as Error).message, "Conversation title must be nonblank text."); return true;
    });
    else assert.deepEqual(await f.request("PATCH", "/api/agent/conversations/target", { title: " \n\t" }), { status: 400, body: { error: "title is required" } });
    assert.deepEqual(f.bytes(), before); assert.deepEqual(f.writes(), []);
  });
});

describe("existing envelopes, supported surface and docs", () => {
  it("not found remains IPC null / REST 404 / MCP error; no MCP rename exists", async () => {
    const f = fixture(); f.seed([]); const before = f.bytes(); f.events.length = 0;
    assert.equal(await f.ipc("get", "missing"), null);
    assert.equal(await f.ipc("rename", { id: "missing", title: "New Chat" }), null);
    assert.deepEqual(await f.request("GET", "/api/agent/conversations/missing"), { status: 404, body: { error: "Conversation not found" } });
    assert.deepEqual(await f.request("PATCH", "/api/agent/conversations/missing", { title: "New Chat" }), { status: 404, body: { error: "Conversation not found" } });
    assert.deepEqual(await f.call("agent_browser_conversation_get", { conversationId: "missing" }), { error: "Conversation not found" });
    assert.equal(f.mcp.__tools.some((tool: any) => /conversation.*rename/.test(tool.name)), false);
    assert.deepEqual(f.bytes(), before); assert.deepEqual(f.writes(), []);
  });
  it("REST synthetic denied role still gates create/rename before persistence", async () => {
    const f = fixture(); f.seed([record("target", "New Chat", "default")]); f.role.ok = false;
    const before = f.bytes(); f.events.length = 0;
    for (const [method, route] of [["POST", "/api/agent/conversations"], ["PATCH", "/api/agent/conversations/target"]]) {
      assert.deepEqual(await f.request(method, route, { title: "New Chat" }), { status: 403, body: { error: "synthetic role denied" } });
    }
    assert.deepEqual(f.bytes(), before); assert.deepEqual(f.writes(), []); assert.deepEqual(f.audits, []);
  });
  it("OpenAPI documents optional allowlisted nullable response metadata, not an input marker", async () => {
    const f = fixture(), response = await f.request("GET", "/openapi.json"); assert.equal(response.status, 200);
    const paths = response.body.paths;
    for (const [route, method, status, list] of [
      ["/api/agent/conversations", "get", "200", true], ["/api/agent/conversations", "post", "201", false],
      ["/api/agent/conversations/{id}", "get", "200", false], ["/api/agent/conversations/{id}", "patch", "200", false],
    ] as const) {
      const schema = paths[route][method].responses[status].content["application/json"].schema;
      const conversation = list ? schema.properties.conversations.items : schema.properties.conversation;
      assert.deepEqual(conversation.properties.titleKind.enum, ["default", "literal", null]);
      assert.equal(conversation.properties.titleKind.nullable, true);
      assert.equal((conversation.required || []).includes("titleKind"), false);
    }
    for (const method of ["post", "patch"]) {
      const route = method === "post" ? "/api/agent/conversations" : "/api/agent/conversations/{id}";
      assert.equal(owns(paths[route][method].requestBody.content["application/json"].schema.properties, "titleKind"), false);
    }
  });
});
