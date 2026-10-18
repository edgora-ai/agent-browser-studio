// Actual shipped SDK generic request methods, with synthetic fetch/urllib
// boundaries only. No server, socket, credentials, GUI or automatic retries.
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "../..");
const JS_FILE = path.join(ROOT, "sdk/js/agent-browser.mjs");
const PY_FILE = path.join(ROOT, "sdk/python/agent_browser_client.py");
const DECL_FILE = path.join(ROOT, "sdk/js/agent-browser.d.mts");
const CODE = ts.transpileModule(fs.readFileSync(JS_FILE, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const LIMIT = 2 * 1024 * 1024;
const TOKEN = { targetId: "a".repeat(64), localHash: "b".repeat(64), remoteHash: "c".repeat(64) };
const RESULT = { success: false, message: "Synthetic service message " + "x".repeat(800), code: "SYNC_PREVIEW_STALE", outcome: "partial", localCommit: "partial", remoteCommit: "none", operationId: "synthetic-sdk-operation", items: [{ scope: "preferences", id: "synthetic-profile", state: "failed" }], warnings: ["synthetic warning"], recovery: [{ resource: "profiles", id: "synthetic-profile", paths: ["/synthetic/recovery-tail"], receiptPath: "/synthetic/receipt.json" }] };
function sdk(fetch: (...args: any[]) => Promise<any>) {
  const module = { exports: {} as any };
  const context = vm.createContext({ Error, Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, fetch });
  vm.runInContext(`(function(require,module,exports){${CODE}\n})`, context, { filename: JS_FILE })(() => { throw new Error("Optional browser drivers are forbidden"); }, module, module.exports);
  return { client: new module.exports.AgentBrowserClient("https://sdk.synthetic.invalid", { token: "synthetic-sdk-token" }), ErrorClass: module.exports.AgentBrowserError };
}
async function rejected(promise: Promise<any>) {
  try { await promise; } catch (error: any) { return error; }
  throw new Error("Expected the original SDK request to reject");
}

describe("JavaScript SDK full bounded error receipts", () => {
  for (const status of [409, 403, 412]) it(`retains HTTP ${status} body/status while preserving Error/message and not retrying`, async () => {
    const body = status === 409 ? RESULT : { error: status === 403 ? "requires member role" : "ACCOUNT_REFERENCE_CONFLICT: reselect", code: status === 403 ? "TEAM_ROLE_DENIED" : "ACCOUNT_REFERENCE_CONFLICT", outcome: "failed", localCommit: "none", remoteCommit: "none" };
    const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    const f = sdk(fetch), error = await rejected(f.client.post("/api/sync/pull", { comparisonToken: TOKEN }));
    expect(error).toBeInstanceOf(Error); expect(error).toBeInstanceOf(f.ErrorClass);
    expect(error.status).toBe(status); expect(error.body).toEqual(body); expect(error.bodyTruncated).toBe(false);
    const detail = "error" in body ? body.error : JSON.stringify(body).slice(0, 500);
    expect(error.message).toBe(`POST /api/sync/pull -> ${status}: ${detail}`);
    expect(fetch).toHaveBeenCalledTimes(1); expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ comparisonToken: TOKEN });
  });
  it("keeps the existing text-only fetch boundary compatible without dropping structured body", async () => {
    const f = sdk(async () => ({ ok: false, status: 409, text: async () => JSON.stringify(RESULT) }));
    const error = await rejected(f.client.get("/api/sync/status"));
    expect(error.status).toBe(409); expect(error.body).toEqual(RESULT); expect(error.bodyTruncated).toBe(false);
  });
  it("marks oversized streaming error JSON as truncated, never a complete/partial success body", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...RESULT, message: "s".repeat(LIMIT + 500) }));
    let offset = 0;
    const reader = { read: vi.fn(async () => {
      if (offset === bytes.length) return { done: true };
      const value = bytes.subarray(offset, Math.min(offset + 65536, bytes.length)); offset += value.length;
      return { done: false, value };
    }), cancel: vi.fn(async () => undefined), releaseLock: vi.fn() };
    const fetch = vi.fn(async () => ({ ok: false, status: 409, body: { getReader: () => reader }, text: async () => new TextDecoder().decode(bytes) }));
    const f = sdk(fetch), error = await rejected(f.client.post("/api/sync/pull", { comparisonToken: TOKEN }));
    expect(error.status).toBe(409); expect(error.body).toBeUndefined(); expect(error.bodyTruncated).toBe(true);
    expect(error.message).toMatch(/truncat/i); expect(reader.cancel).toHaveBeenCalledTimes(1); expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(offset).toBeLessThanOrEqual(LIMIT + 65536); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["", "<not-json>"])("preserves bounded empty/non-JSON error body %j without inventing sync proof", async text => {
    const f = sdk(async () => new Response(text, { status: 500 }));
    const error = await rejected(f.client.get("/api/sync/status"));
    expect(error.status).toBe(500); expect(error.body).toEqual(text ? { raw: text } : {}); expect(error.bodyTruncated).toBe(false);
    expect(error.body.outcome).toBeUndefined();
  });
  it("preserves profile sync fields/status results and opaque tokens on successful generic paths", async () => {
    const profile = { dirId: "synthetic-profile", syncedAt: 0, syncStatus: "unknown", syncScope: "portable-profile+preferences", syncReason: "legacy-marker" };
    const status = { operation: { generation: 2, active: null, last: RESULT } };
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/api/profiles") ? { profiles: [profile] } : url.endsWith("/api/sync/status") ? status : url.endsWith("/api/sync/push") ? { ...RESULT, success: true } : profile)));
    const f = sdk(fetch);
    expect(await f.client.listProfiles()).toEqual([profile]); expect(await f.client.getProfile(profile.dirId)).toEqual(profile);
    expect(await f.client.get("/api/sync/status")).toEqual(status);
    expect(await f.client.post("/api/sync/push", { force: true, comparisonToken: TOKEN })).toEqual({ ...RESULT, success: true });
    expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({ force: true, comparisonToken: TOKEN });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it("keeps the old standalone Error constructor compatible", () => {
    const f = sdk(async () => { throw new Error("unplanned fetch"); });
    const error = new f.ErrorClass("old caller message");
    expect(error).toBeInstanceOf(Error); expect(error.message).toBe("old caller message");
  });
});

describe("SDK public profile/error declarations", () => {
  it("declares sync fields on ProfileSummary with self-contained literal contracts", () => {
    const ast = ts.createSourceFile(DECL_FILE, fs.readFileSync(DECL_FILE, "utf8"), ts.ScriptTarget.Latest, true);
    const profile = ast.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === "ProfileSummary") as ts.InterfaceDeclaration;
    const fields = new Map(profile.members.map(member => [member.name!.getText(ast), (member as ts.PropertySignature).type?.getText(ast)]));
    expect(fields.get("syncedAt")).toMatch(/number.*null/);
    expect(fields.get("syncStatus")).toMatch(/synced.*dirty.*never.*unknown/);
    expect(fields.get("syncScope")).toContain("portable-profile+preferences");
    expect(fields.get("syncReason")).toContain("legacy-marker"); expect(fields.get("syncReason")).toContain("preferences-unavailable");
  });
});

it("Python SDK retains bounded HTTP receipts, RuntimeError/message compatibility and no retries", () => {
  const script = String.raw`import io,json,socket,sys,urllib.error,urllib.request
prohibited=[]
def no_socket(*a,**k): prohibited.append('socket'); raise AssertionError('socket forbidden')
socket.socket=no_socket
ns={}; exec(compile(open(sys.argv[1]).read(),sys.argv[1],'exec'),ns)
c=ns['AgentBrowserClient']('https://sdk.synthetic.invalid','synthetic-token')
limit=2*1024*1024; requests=[]; mode={'status':200,'body':None}; reads=[]
class Bounded(io.BytesIO):
 def read(self,n=-1):
  reads.append(n)
  if n<0 or n>limit+1: raise AssertionError('unbounded HTTP error read')
  return super().read(n)
class Response(io.BytesIO):
 def __enter__(self): return self
 def __exit__(self,*a): self.close()
def call(req,timeout):
 requests.append(req)
 body=mode['body']; raw=(body if isinstance(body,str) else json.dumps(body)).encode()
 if mode['status']>=400: raise urllib.error.HTTPError(req.full_url,mode['status'],'synthetic',{},Bounded(raw))
 return Response(raw)
urllib.request.urlopen=call
token={'targetId':'a','localHash':'b','remoteHash':'c'}
result={'success':False,'message':'x'*800,'code':'SYNC_PREVIEW_STALE','outcome':'partial','localCommit':'partial','remoteCommit':'none','recovery':[{'resource':'profiles','id':'synthetic-profile','paths':['/synthetic/receipt-tail']} ]}
for status in [409,403,412]:
 body=result if status==409 else {'error':'requires member role' if status==403 else 'ACCOUNT_REFERENCE_CONFLICT','code':'TEAM_ROLE_DENIED' if status==403 else 'ACCOUNT_REFERENCE_CONFLICT'}
 mode.update(status=status,body=body); previous=len(requests)
 try: c.post('/api/sync/pull',{'comparisonToken':token})
 except ns['AgentBrowserError'] as e:
  assert isinstance(e,RuntimeError); assert e.status==status; assert e.body==body; assert e.body_truncated is False
  assert str(e)=='POST /api/sync/pull -> '+str(status)+': '+json.dumps(body)[:500]
 else: raise AssertionError('HTTP error did not reject')
 assert len(requests)==previous+1; assert json.loads(requests[-1].data)=={'comparisonToken':token}
mode.update(status=409,body={**result,'message':'s'*(limit+500)}); previous=len(requests)
try: c.get('/api/sync/status')
except ns['AgentBrowserError'] as e:
 assert e.status==409; assert e.body is None; assert e.body_truncated is True; assert 'truncat' in str(e).lower()
else: raise AssertionError('oversized HTTP error did not reject')
assert len(requests)==previous+1
for raw,expected in [('',{}),('<not-json>',{'raw':'<not-json>'})]:
 mode.update(status=500,body=raw)
 try: c.get('/api/sync/status')
 except ns['AgentBrowserError'] as e: assert e.body==expected; assert e.status==500; assert e.body_truncated is False
 else: raise AssertionError('non-json HTTP error did not reject')
profile={'dirId':'synthetic-profile','syncedAt':0,'syncStatus':'unknown','syncScope':'portable-profile+preferences','syncReason':'legacy-marker'}
mode.update(status=200,body={'profiles':[profile]}); assert c.list_profiles()==[profile]
mode.update(body=profile); assert c.get_profile('synthetic-profile')==profile
mode.update(body={'operation':{'generation':1,'active':None,'last':result}}); assert c.get('/api/sync/status')['operation']['last']==result
assert str(ns['AgentBrowserError']('old caller message'))=='old caller message'; assert not prohibited
print(json.dumps({'requests':len(requests),'boundedErrorReads':reads,'prohibited':prohibited,'completeTypedReceipt':True,'noRetry':True}))`;
  const result = spawnSync("python3", ["-I", "-B", "-c", script, PY_FILE], { encoding: "utf8", timeout: 15000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.status, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout); expect(output.completeTypedReceipt).toBe(true); expect(output.noRetry).toBe(true); expect(output.prohibited).toEqual([]);
});
