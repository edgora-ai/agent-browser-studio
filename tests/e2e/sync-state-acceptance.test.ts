// Opt-in, SERIAL COORDINATOR ONLY. This launches the real built Electron app.
// Run only after the coordinator explicitly confirms the CURRENT dist is built:
// ABS_SYNC_ACCEPTANCE=1 ABS_SYNC_ACCEPTANCE_DIST_READY=1 \
// ABS_SYNC_ACCEPTANCE_ROOT=<fresh absolute empty test-owned directory> \
// ./node_modules/.bin/vitest run -c vitest.config.e2e.ts tests/e2e/sync-state-acceptance.test.ts
// No API/renderer/transport mocks: only native dialog selection is controlled.
// The caller's root is never removed; exclusive mkdtemp children hold all data.
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as zlib from "node:zlib";
import { execFile, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { closeApp, resolveManagedChromiumPath, setupTestApp, type TestAppHandle } from "./helpers/app.js";
import { selectTestChromiumFixtureEnv } from "./helpers/launch-env.js";
import { readZipEntries, extractZipEntry } from "../../src/main/services/zip-writer.js";
import { AgentBrowserClient, AgentBrowserError } from "../../sdk/js/agent-browser.mjs";

const REPO = path.resolve(__dirname, "..", "..");
const CONFIG_KEY = "agent-browser-studio-config.json";
const BUCKET = "sync-acceptance";
const PROFILE_NAME = "Acceptance portable state";
const PROFILE_NOTE = "Synthetic acceptance note\nPortable metadata, not an account secret";
const PROXY_NAME = "acceptance-loopback-proxy";
const ACCOUNT_NAME = "acceptance-synthetic-user";
const COOKIE_NAME = "acceptance_session";
const COOKIE_VALUE = "synthetic-cookie-business-value";
const STORAGE_KEY = "acceptance_order";
const STORAGE_VALUE = "synthetic-localStorage-business-value";
const IMMEDIATE_STORAGE_KEY = "acceptance_immediate_stop";
const IMMEDIATE_STORAGE_VALUE = "synthetic-immediate-stop-business-value";
const EXTENSION_JS = "globalThis.acceptanceExtensionMarker = 'synthetic-extension-business-value';\n";
const SQLITE_NAME = "acceptance-orders.sqlite";
const SQL_ROWS = [
  { id: 1, label: "checkpointed", payload: "synthetic-base-payload" },
  { id: 2, label: "wal-only", payload: "synthetic-committed-wal-payload-7f321" },
];
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const OPTED_IN = process.env.ABS_SYNC_ACCEPTANCE === "1";

function sha256(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
function readJson(file: string): any { return JSON.parse(fs.readFileSync(file, "utf8")); }
function configOf(h: TestAppHandle): any { return readJson(path.join(h.userDataDir, "config.json")); }
function profilePath(h: TestAppHandle, id: string, ...parts: string[]): string {
  expect(id).toMatch(/^ab_[A-Za-z0-9_-]+$/);
  return path.join(h.userDataDir, "profiles", id, ...parts);
}
function assertInside(root: string, candidate: string): void {
  const rel = path.relative(root, candidate);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Acceptance path is not an owned child");
}
function regularBytes(root: string, file: string): Buffer {
  assertInside(root, file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Acceptance evidence must be a regular file");
  assertInside(fs.realpathSync(root), fs.realpathSync(file));
  return fs.readFileSync(file);
}
function assertSuccess(result: any): void {
  expect(result?.success, JSON.stringify(result)).toBe(true);
}
function storageFileInventory(root: string, directory: string): Array<{ path: string; kind: string; bytes: number }> {
  const files: Array<{ path: string; kind: string; bytes: number }> = [];
  const visit = (dir: string, depth: number): void => {
    assertInside(root, dir);
    if (!fs.existsSync(dir)) return;
    const parent = fs.lstatSync(dir);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Owned storage inventory parent is not a real directory");
    for (const name of fs.readdirSync(dir).sort()) {
      if (files.length >= 40) throw new Error("Owned storage inventory exceeded its bounded file budget");
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      files.push({ path: path.relative(directory, file), kind: stat.isSymbolicLink() ? "symlink-not-followed" : stat.isDirectory() ? "directory" : "file", bytes: stat.size });
      if (depth && stat.isDirectory() && !stat.isSymbolicLink()) visit(file, depth - 1);
    }
  };
  visit(directory, 1);
  return files;
}

type LocalStorageFormat = "sqlite" | "leveldb";
type StorageFile = { path: string; sha256: string; bytes: number };
type StorageGroup = { format: LocalStorageFormat; files: StorageFile[]; sha256: string };

function detectLocalStorageFormat(root: string, defaultDir: string): LocalStorageFormat | null {
  for (const [format, file] of [["sqlite", path.join(defaultDir, "LocalStorage")], ["leveldb", path.join(defaultDir, "Local Storage", "leveldb", "CURRENT")]] as const) {
    assertInside(root, file);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Browser storage format marker is not a regular owned file");
    return format;
  }
  return null;
}
function captureStorageGroup(root: string, defaultDir: string): StorageGroup {
  const format = detectLocalStorageFormat(root, defaultDir);
  if (!format) throw new Error("Real browser LocalStorage has no supported on-disk SQLite or LevelDB format");
  let relativeFiles: string[];
  if (format === "sqlite") {
    relativeFiles = ["LocalStorage"];
    const wal = path.join(defaultDir, "LocalStorage-wal");
    if (fs.existsSync(wal) && fs.lstatSync(wal).size > 0) relativeFiles.push("LocalStorage-wal");
    expect(regularBytes(root, path.join(defaultDir, "LocalStorage")).subarray(0, 15).toString()).toBe("SQLite format 3");
  } else {
    const dbDir = path.join(defaultDir, "Local Storage", "leveldb");
    const manifest = regularBytes(root, path.join(dbDir, "CURRENT")).toString("utf8").trim();
    expect(manifest).toMatch(/^MANIFEST-[0-9]+$/);
    expect(regularBytes(root, path.join(dbDir, manifest)).length).toBeGreaterThan(0);
    // Diagnostic LOG/LOCK are not database state. Numbered *.log journals are.
    relativeFiles = fs.readdirSync(dbDir).filter((name) => !/^(?:LOCK|LOG(?:\.old)?)$/.test(name))
      .map((name) => path.join("Local Storage", "leveldb", name));
  }
  if (relativeFiles.length > 40) throw new Error("LocalStorage file-group budget exceeded");
  const files = relativeFiles.map((relative): StorageFile => {
    const bytes = regularBytes(root, path.join(defaultDir, relative));
    return { path: relative.split(path.sep).join("/"), bytes: bytes.length, sha256: sha256(bytes) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (files.reduce((sum, file) => sum + file.bytes, 0) > MAX_OBJECT_BYTES) throw new Error("LocalStorage file-group byte budget exceeded");
  return { format, files, sha256: sha256(JSON.stringify({ format, files })) };
}
function sqliteTextCandidates(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!(value instanceof Uint8Array)) return [];
  const bytes = Buffer.from(value);
  if (bytes.length > 64 * 1024) throw new Error("Owned SQLite analysis value exceeds its bounded decode budget");
  const candidates = [bytes.toString("utf8"), bytes.toString("utf16le")];
  // Chromium storage strings may carry the Latin-1/UTF-16 encoding byte.
  if (bytes[0] === 0 || bytes[0] === 1) {
    candidates.push(bytes.subarray(1).toString("utf8"), bytes.subarray(1).toString("latin1"), bytes.subarray(1).toString("utf16le"));
  }
  return [...new Set(candidates)];
}
function inspectOwnedSqliteStorage(root: string, defaultDir: string, group: StorageGroup, origin: string, observation: Record<string, any>, expected = { key: STORAGE_KEY, value: STORAGE_VALUE, required: true }): void {
  expect(group.format).toBe("sqlite");
  const analysisDir = fs.mkdtempSync(path.join(root, "sqlite-storage-analysis-"));
  observation.analysisDirectory = analysisDir;
  observation.copiedOnly = group.files.map((file) => file.path);
  for (const file of group.files) {
    if (file.path !== "LocalStorage" && file.path !== "LocalStorage-wal") throw new Error("SQLite analysis may copy only its owned main/WAL pair");
    const raw = regularBytes(root, path.join(defaultDir, file.path));
    expect(sha256(raw)).toBe(file.sha256);
    const copy = path.join(analysisDir, file.path);
    fs.writeFileSync(copy, raw, { flag: "wx" });
    expect(regularBytes(root, copy)).toEqual(raw);
  }
  // Never open/checkpoint the browser's source DB or copy -shm. SQLite may
  // create a small analysis-only -shm alongside this exclusively owned copy.
  const database = new DatabaseSync(path.join(analysisDir, "LocalStorage"), { readOnly: true });
  const quote = (name: string) => '"' + name.replace(/"/g, '""') + '"';
  try {
    observation.integrity = database.prepare("PRAGMA integrity_check").all();
    expect(observation.integrity).toEqual([{ integrity_check: "ok" }]);
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    if (tables.length > 16) throw new Error("Owned SQLite analysis table budget exceeded");
    observation.schema = [];
    observation.businessReads = [];
    observation.rowSelectionLimitPerTable = 64;
    for (const table of tables) {
      const tableName = String(table.name);
      const columns = database.prepare(`PRAGMA table_info(${quote(tableName)})`).all();
      if (columns.length > 32) throw new Error("Owned SQLite analysis column budget exceeded");
      observation.schema.push({ table: tableName, columns: columns.map((column) => ({ name: String(column.name), type: String(column.type), notNull: Number(column.notnull), primaryKey: Number(column.pk) })) });
      const statement = database.prepare(`SELECT * FROM ${quote(tableName)} LIMIT 64`);
      statement.setReadBigInts(true);
      for (const row of statement.all()) {
        const decoded = Object.entries(row).map(([column, value]) => ({ column, candidates: sqliteTextCandidates(value) }));
        const key = decoded.find((field) => field.candidates.includes(expected.key));
        const value = decoded.find((field) => field.candidates.includes(expected.value));
        if (key && value) observation.businessReads.push({ table: tableName, keyColumn: key.column, valueColumn: value.column, key: expected.key, value: expected.value,
          matchingOriginColumns: decoded.filter((field) => field.candidates.some((candidate) => candidate === origin || candidate === origin + "/")).map((field) => field.column) });
      }
    }
    observation.queriedKey = expected.key;
    observation.queriedValue = expected.value;
    observation.expectedRowFound = observation.businessReads.length > 0;
    if (expected.required) expect(observation.businessReads.length, "The real owned SQLite copy must contain the exact synthetic key/value in an actual schema row").toBeGreaterThan(0);
  } finally { database.close(); }
  for (const file of group.files) expect(sha256(regularBytes(root, path.join(defaultDir, file.path)))).toBe(file.sha256);
  observation.sourceUnchangedAfterReadOnlyAnalysis = true;
  observation.fileGroupSha256 = group.sha256;
}

async function waitForOwnedCondition(label: string, condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  throw new Error(`Owned condition deadline: ${label}`);
}

async function request(port: number, token: string | null, method: string, route: string, body?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
    const req = http.request({ hostname: "127.0.0.1", port, path: route, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OBJECT_BYTES) req.destroy(new Error("REST fixture reply exceeded budget"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode || 0, body: JSON.parse(text) }); }
        catch { reject(new Error(`REST ${method} ${route} returned non-JSON (${res.statusCode})`)); }
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`REST ${method} ${route} deadline`)));
    req.on("error", reject);
    req.end(payload);
  });
}

// The local business page writes browser storage ONLY in its real click handler.
// The receiver's Read button is read-only; it must not recreate the expected data.
const BUSINESS_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Sync acceptance business page</title><style>
body{font:18px system-ui;background:#f4f6fa;color:#152137;margin:48px;max-width:1000px}
button{font:inherit;padding:12px 18px;margin:8px 12px 16px 0}pre{white-space:pre-wrap;background:white;padding:24px;border:1px solid #bcc7d8;border-radius:8px}
</style><h1>Synthetic business state</h1><p>Loopback fixture only. No network, account password, or external service.</p>
<button id="write-state">Write synthetic state</button><button id="read-state">Read existing state</button><label>Immediate-stop value <input id="immediate-input" value="${IMMEDIATE_STORAGE_VALUE}"></label><button id="write-immediate-state">Write immediate-stop marker</button><pre id="business-values"></pre><pre id="immediate-value"></pre>
<script>
function readBusinessState(){document.getElementById('business-values').textContent=JSON.stringify({cookie:document.cookie,localStorage:localStorage.getItem(${JSON.stringify(STORAGE_KEY)})},null,2)}
document.getElementById('write-state').addEventListener('click',function(){document.cookie=${JSON.stringify(`${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; SameSite=Lax; Max-Age=86400`)};localStorage.setItem(${JSON.stringify(STORAGE_KEY)},${JSON.stringify(STORAGE_VALUE)});readBusinessState()});
document.getElementById('write-immediate-state').addEventListener('click',function(){localStorage.setItem(${JSON.stringify(IMMEDIATE_STORAGE_KEY)},document.getElementById('immediate-input').value);document.getElementById('immediate-value').textContent=localStorage.getItem(${JSON.stringify(IMMEDIATE_STORAGE_KEY)})});
document.getElementById('read-state').addEventListener('click',readBusinessState);readBusinessState();
</script></html>`;

async function loopbackFixture() {
  const objects = new Map<string, Buffer>();
  const journal: Array<{ method: string; key: string; bytes: number; sha256: string }> = [];
  const failures: string[] = [];
  type BusinessCookieRequest = { host: string | null; path: string; syntheticCookieMatches: boolean };
  // Constant-space receiver-only evidence; never retain a Cookie header/value.
  const businessCookieRequests = { observing: false, count: 0, first: null as BusinessCookieRequest | null, last: null as BusinessCookieRequest | null };
  const blockedTunnels = new Set<Duplex>();
  const rejectedTunnelErrors = { ECONNRESET: 0, EPIPE: 0 };
  let origin = "";
  let gate: {
    reached: Promise<void>;
    markReached: () => void;
    pending?: { response: http.ServerResponse; key: string; bytes: Buffer };
  } | null = null;
  function publish(res: http.ServerResponse, key: string, bytes: Buffer): void {
    const total = [...objects.entries()].reduce((n, [otherKey, data]) => n + (otherKey === key ? 0 : data.length), bytes.length);
    if (total > MAX_OBJECT_BYTES) throw new Error("S3 fixture aggregate byte budget exceeded");
    objects.set(key, Buffer.from(bytes));
    journal.push({ method: "PUT", key, bytes: bytes.length, sha256: sha256(bytes) });
    res.writeHead(200, { etag: `"${sha256(bytes)}"`, "content-length": "0" });
    res.end();
  }
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || "/", origin);
      // Absolute proxy requests may only address this exact fixture origin.
      if (url.origin !== origin) { res.writeHead(403); res.end("External requests are disabled"); return; }
      if (url.pathname === "/" || url.pathname === "/business") {
        if (url.pathname === "/business" && businessCookieRequests.observing) {
          const observed = { host: req.headers.host ?? null, path: url.pathname,
            syntheticCookieMatches: typeof req.headers.cookie === "string" && req.headers.cookie.split(";").some((entry) => entry.trim() === `${COOKIE_NAME}=${COOKIE_VALUE}`) };
          businessCookieRequests.count++;
          businessCookieRequests.first ??= observed;
          businessCookieRequests.last = observed;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(BUSINESS_PAGE);
        return;
      }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      const prefix = `/${BUCKET}/`;
      const key = url.pathname.startsWith(prefix) ? decodeURIComponent(url.pathname.slice(prefix.length)) : "";
      if (!/^[A-Za-z0-9_.-]+$/.test(key)) { res.writeHead(404); res.end("No such fixture route"); return; }
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        let count = 0;
        for await (const chunk of req) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          count += bytes.length;
          if (count > MAX_OBJECT_BYTES) throw new Error("S3 fixture object exceeded byte budget");
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks);
        if (key === CONFIG_KEY && gate && !gate.pending) {
          gate.pending = { response: res, key, bytes };
          gate.markReached();
        } else publish(res, key, bytes);
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        const bytes = objects.get(key);
        if (!bytes) { res.writeHead(404); res.end("NoSuchKey"); return; }
        journal.push({ method: req.method, key, bytes: bytes.length, sha256: sha256(bytes) });
        if (journal.length > 180) throw new Error("S3 fixture request budget exceeded");
        res.writeHead(200, { "content-length": String(bytes.length), etag: `"${sha256(bytes)}"` });
        res.end(req.method === "HEAD" ? undefined : bytes);
        return;
      }
      res.writeHead(405); res.end();
    })().catch((error) => {
      failures.push(String(error));
      if (!res.headersSent) res.writeHead(500);
      res.end("Owned fixture failed");
    });
  });
  server.on("connect", (_req, socket) => {
    // CONNECT sockets leave the HTTP server's normal request error handling.
    // A browser can reset one after our deliberate denial; scope accounting to
    // these denied sockets only, never suppress S3/REST or global process errors.
    blockedTunnels.add(socket);
    socket.once("close", () => blockedTunnels.delete(socket));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET" || error.code === "EPIPE") rejectedTunnelErrors[error.code]++;
      else failures.push("Denied CONNECT socket failed: " + String(error.code || error.message));
    });
    if (blockedTunnels.size > 128) { failures.push("Denied CONNECT socket budget exceeded"); socket.destroy(); return; }
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback fixture did not bind a dynamic port");
  origin = `http://127.0.0.1:${address.port}`;
  async function closeFixture(): Promise<void> {
    if (gate?.pending) { gate.pending.response.writeHead(503); gate.pending.response.end("Fixture teardown"); }
    gate = null;
    server.closeAllConnections();
    for (const socket of blockedTunnels) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  try {
    // Deliberately reproduce the former unhandled ECONNRESET using a native,
    // fixture-owned client; a missing scoped handler must still fail the run.
    await new Promise<void>((resolve, reject) => {
      let denied = false;
      const client = net.createConnection({ host: "127.0.0.1", port: address.port });
      const timer = setTimeout(() => client.destroy(new Error("Owned denied-tunnel probe deadline")), 5_000);
      client.once("connect", () => client.write("CONNECT blocked.synthetic.invalid:443 HTTP/1.1\r\nHost: blocked.synthetic.invalid:443\r\n\r\n"));
      client.once("data", (data) => {
        if (!data.toString("ascii").startsWith("HTTP/1.1 403")) { client.destroy(new Error("Owned tunnel was not rejected")); return; }
        denied = true; client.resetAndDestroy();
      });
      client.on("error", reject);
      client.once("close", () => { clearTimeout(timer); if (denied) resolve(); else reject(new Error("Owned tunnel probe closed without rejection")); });
    });
    await waitForOwnedCondition("Declined CONNECT reset accounted", () => rejectedTunnelErrors.ECONNRESET + rejectedTunnelErrors.EPIPE > 0, 5_000);
  } catch (error) { await closeFixture(); throw error; }
  return {
    origin, port: address.port, objects, journal, failures, rejectedTunnelErrors,
    beginBusinessCookieObservation() { businessCookieRequests.observing = true; return businessCookieRequests; },
    endBusinessCookieObservation() { businessCookieRequests.observing = false; },
    holdConfigPut() {
      if (gate) throw new Error("A fixture PUT gate is already owned");
      let markReached!: () => void;
      const reached = new Promise<void>((resolve) => { markReached = resolve; });
      gate = { reached, markReached };
      return reached;
    },
    releaseConfigPut() {
      const pending = gate?.pending;
      if (!pending) throw new Error("No real S3 PUT is waiting");
      gate = null;
      publish(pending.response, pending.key, pending.bytes);
    },
    config() {
      const bytes = objects.get(CONFIG_KEY);
      if (!bytes) throw new Error("No actual publisher snapshot exists");
      return JSON.parse(bytes.toString("utf8"));
    },
    close: closeFixture,
  };
}

async function pythonSdkRequest(port: number, token: string, method: string, route: string, body?: unknown): Promise<any> {
  const file = path.join(REPO, "sdk/python/agent_browser_client.py");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Python SDK must be the selected regular source file");
  // Real urllib socket → the owned Electron REST server. Credentials travel only
  // on stdin and are never included in argv, stdout, screenshots or the receipt.
  const script = String.raw`import json,sys
ns={}; exec(compile(open(sys.argv[1]).read(),sys.argv[1],'exec'),ns)
p=json.load(sys.stdin)
c=ns['AgentBrowserClient']('http://127.0.0.1:'+str(p['port']),p['token'],timeout=10)
try:
 result=c.request(p['method'],p['route'],p.get('body'))
 print(json.dumps({'status':200,'body':result}))
except ns['AgentBrowserError'] as error:
 assert isinstance(error,RuntimeError)
 print(json.dumps({'status':error.status,'body':error.body,'bodyTruncated':error.body_truncated}))
`;
  // Do not block the test's event loop: stale-token checks in the real service
  // must be able to GET from this same process's controlled S3 fixture.
  return new Promise((resolve, reject) => {
    const child = execFile("python3", ["-B", "-c", script, file], { timeout: 30_000, maxBuffer: 64 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`Python SDK ${method} ${route} failed: ${stderr.slice(0, 4000) || error.message}`)); return; }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error("Actual Python SDK returned invalid JSON")); }
    });
    child.stdin?.on("error", reject);
    child.stdin?.end(JSON.stringify({ port, token, method, route, body }));
  });
}

async function jsSdkError(port: number, token: string, route: string, body: unknown): Promise<any> {
  const client = new AgentBrowserClient(`http://127.0.0.1:${port}`, { token, timeout: 10_000 });
  try { await client.post(route, body); }
  catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AgentBrowserError);
    expect((error as AgentBrowserError).bodyTruncated).toBe(false);
    return { status: (error as AgentBrowserError).status, body: (error as AgentBrowserError).body };
  }
  throw new Error("Actual SDK request did not reject the protected/conflicting operation");
}

function recoveryTree(root: string, directory: string): Array<{ path: string; kind: string; bytes: number; sha256?: string }> {
  const entries: Array<{ path: string; kind: string; bytes: number; sha256?: string }> = [];
  let bytes = 0;
  const visit = (current: string, depth: number) => {
    assertInside(root, current);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || depth > 8) throw new Error("Unsafe owned recovery tree");
    for (const name of fs.readdirSync(current).sort()) {
      if (entries.length >= 128) throw new Error("Recovery-tree evidence entry budget exceeded");
      const file = path.join(current, name), item = fs.lstatSync(file);
      const relative = path.relative(directory, file).split(path.sep).join("/");
      if (item.isSymbolicLink()) throw new Error("Recovery evidence must not follow symlinks");
      if (item.isDirectory()) { entries.push({ path: relative + "/", kind: "directory", bytes: 0 }); visit(file, depth + 1); }
      else {
        if (!item.isFile() || item.size > MAX_OBJECT_BYTES) throw new Error("Recovery evidence file exceeds budget");
        bytes += item.size;
        if (bytes > MAX_OBJECT_BYTES) throw new Error("Recovery-tree evidence byte budget exceeded");
        const value = regularBytes(root, file);
        entries.push({ path: relative, kind: "file", bytes: value.length, sha256: sha256(value) });
      }
    }
  };
  visit(directory, 0);
  return entries;
}

type LiveBrowser = { browser: Browser; page: Page; handle: TestAppHandle; id: string; pid: number; port: number };
type Receipt = {
  schema: string; status: string; phase: string; startedAt: string; finishedAt?: string;
  observations: Record<string, any>; screenshots: string[]; cleanup: string[]; limitations: string[]; error?: string;
};

// No files, discovery, fixture server, or app are created on a normal E2E run.
describe.skipIf(!OPTED_IN)("real-app sync/state/backup acceptance (explicit coordinator opt-in)", () => {
  let root = "";
  let owned = "";
  let h: TestAppHandle | undefined;
  let live: LiveBrowser | undefined;
  let sqlite: DatabaseSync | undefined;
  let fixture: Awaited<ReturnType<typeof loopbackFixture>> | undefined;
  let receipt: Receipt | undefined;
  let dialogsInstalled = false;
  let mcpPort = 0;
  let mcpToken = "";
  const ownedUserData = new Set<string>();
  const retainedStorageArtifacts = new Set<string>();

  function nativeStopEvidence(): Record<string, any> {
    return receipt!.observations.nativeStopEvidence ||= {
      registrations: [], collections: [], mainLogs: { attachments: [], samples: [], dropped: 0 }, pageTeardowns: { samples: [], dropped: 0 },
      interpretation: "Missing logs are not success; native-close acknowledgement, signal dispatch, process exit and storage durability are separate facts.",
    };
  }
  function observeOwnedMainStopLines(handle: TestAppHandle, label: "source" | "receiver"): void {
    const logs = nativeStopEvidence().mainLogs;
    try {
      const child = handle.app.process();
      logs.attachments.push({ app: label, mainPid: child.pid ?? null, stdout: !!child.stdout, stderr: !!child.stderr });
      for (const [stream, readable] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
        if (!readable) continue;
        let tail = "";
        const record = (line: string): void => {
          if (line.startsWith("[browser-stop-pages] ")) {
            let event: any;
            try { event = JSON.parse(line.slice("[browser-stop-pages] ".length)); } catch { return; }
            const request = [...logs.samples].reverse().find((sample: any) => sample.app === label && sample.mainPid === child.pid &&
              sample.payload.event === "requested" && sample.payload.port === event?.port);
            const counts = [event?.discoveredTargets, event?.requestedTargets, event?.acknowledgedTargets, event?.destroyedTargets];
            if (!request || !counts.every((count) => Number.isSafeInteger(count) && count >= 0 && count <= 128) ||
                event.acknowledgedTargets > event.requestedTargets || event.requestedTargets > event.discoveredTargets ||
                event.destroyedTargets > event.discoveredTargets || typeof event.discoveryCompleted !== "boolean" ||
                typeof event.browserCloseDispatched !== "boolean" || !["acknowledged", "disconnected", "unavailable", "failed", "timeout", "stale"].includes(event.result)) return;
            const pages = nativeStopEvidence().pageTeardowns;
            if (pages.samples.length >= 32) { pages.dropped++; return; }
            pages.samples.push({ app: label, mainPid: child.pid ?? null, stream, observedAt: Date.now(), payload: {
              dirId: request.payload.dirId, pid: request.payload.pid, port: event.port, result: event.result,
              discoveryCompleted: event.discoveryCompleted, browserCloseDispatched: event.browserCloseDispatched,
              discoveredTargets: event.discoveredTargets, requestedTargets: event.requestedTargets,
              acknowledgedTargets: event.acknowledgedTargets, destroyedTargets: event.destroyedTargets,
            } });
            return;
          }
          if (!line.startsWith("[browser-stop] ")) return;
          let event: any;
          try { event = JSON.parse(line.slice("[browser-stop] ".length)); } catch { return; }
          if (!event || event.dirId !== receipt!.observations.profileId || !Number.isSafeInteger(event.pid) || event.pid < 1) return;
          let payload: Record<string, any>;
          if (event.event === "requested" && Number.isInteger(event.port) && event.port >= 0 && event.port <= 65535 &&
              ["chromium", "firefox", "unknown"].includes(event.engine)) {
            payload = { event: event.event, dirId: event.dirId, pid: event.pid, port: event.port, engine: event.engine };
          } else if (event.event === "native-close-result" && ["acknowledged", "disconnected", "unavailable", "failed", "timeout", "stale"].includes(event.result)) {
            payload = { event: event.event, dirId: event.dirId, pid: event.pid, result: event.result };
          } else if (event.event === "signal-sent" && ["SIGTERM", "SIGKILL"].includes(event.signal)) {
            payload = { event: event.event, dirId: event.dirId, pid: event.pid, signal: event.signal };
          } else return;
          if (logs.samples.length >= 64) { logs.dropped++; return; }
          logs.samples.push({ app: label, mainPid: child.pid ?? null, stream, observedAt: Date.now(), payload });
        };
        // Passive, constant-bounded line framing only. No forwarding or disk I/O.
        readable.on("data", (chunk: Buffer | string) => {
          const lines = (tail + chunk.toString()).split(/\r?\n/);
          tail = (lines.pop() || "").slice(-512);
          for (const line of lines) record(line);
        });
        readable.once("end", () => { if (tail) record(tail); tail = ""; });
      }
    } catch {
      logs.attachments.push({ app: label, state: "unavailable", reason: "OWNED_MAIN_LOG_OBSERVER_UNAVAILABLE" });
    }
  }
  function nativeObserverFailure(error: unknown, stage: "ownership" | "evaluate" | "append"): Record<string, string> {
    const detail = error instanceof Error ? error : undefined;
    const errorName = detail && ["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "TimeoutError"].includes(detail.name) ? detail.name : "unknown";
    const code = (detail as NodeJS.ErrnoException | undefined)?.code;
    const allowedCodes = ["ERR_REQUIRE_ESM", "ERR_REQUIRE_ASYNC_MODULE", "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"];
    let errorCode = typeof code === "string" && allowedCodes.includes(code) ? code : "unclassified";
    // Classify known transport/transform failures, never retain raw paths/stack.
    if (/__vite_ssr_dynamic_import__|dynamic import callback/i.test(detail?.message || "")) errorCode = "EVALUATED_IMPORT_UNAVAILABLE";
    else if (/Execution context was destroyed/i.test(detail?.message || "")) errorCode = "EVALUATION_CONTEXT_DESTROYED";
    else if (/Target.*closed|Session.*closed/i.test(detail?.message || "")) errorCode = "OWNED_EVALUATION_TARGET_CLOSED";
    else if (/timeout|timed out/i.test(detail?.message || "")) errorCode = "OWNED_EVALUATION_TIMEOUT";
    return { stage, errorName, errorCode };
  }
  async function armOwnedNativeExit(target: LiveBrowser, cycle: number): Promise<void> {
    const evidence = nativeStopEvidence();
    let stage: "ownership" | "evaluate" | "append" = "ownership";
    try {
      if (!ownedUserData.has(target.handle.userDataDir)) throw new Error("Unowned observer target");
      stage = "evaluate";
      const registration = await target.handle.app.evaluate(({ app }, expected) => {
        if (app.getPath("userData") !== expected.userDataDir || !/^ab_[A-Za-z0-9_-]+$/.test(expected.id) ||
            !Number.isSafeInteger(expected.pid) || expected.pid < 1) return { state: "unavailable", reason: "OWNED_NATIVE_IDENTITY_MISMATCH" };
        // Use Electron's native loader: Vite rewrites import() in serialized callbacks.
        const filename = process.getBuiltinModule("url").fileURLToPath(expected.runtimeTableUrl);
        const runtime = process.getBuiltinModule("module").createRequire(filename)(filename);
        const entry = typeof runtime.getEntry === "function" ? runtime.getEntry(expected.id) : undefined;
        const child = entry?.process;
        if (!child || entry.pid !== expected.pid || child.pid !== expected.pid || entry.port !== expected.port || entry.engine !== "chromium" || entry.stopping ||
            child.exitCode !== null || child.signalCode !== null || child.killed === true || typeof child.once !== "function") {
          return { state: "unavailable", reason: "OWNED_NATIVE_ENTRY_NOT_LIVE" };
        }
        const state = globalThis as any;
        if (state.__syncAcceptanceNativeExitLedger === undefined) state.__syncAcceptanceNativeExitLedger = new Map();
        const ledger = state.__syncAcceptanceNativeExitLedger;
        if (!(ledger instanceof Map) || ledger.size >= 16) return { state: "unavailable", reason: "OWNED_NATIVE_LEDGER_UNAVAILABLE" };
        const existing = ledger.get(child);
        if (existing) return { state: "already-armed", profileId: existing.profileId, pid: existing.pid, engine: existing.engine };
        const observed = { profileId: expected.id, pid: expected.pid, engine: entry.engine,
          exitObserved: false, exitCode: null as number | null, signal: null as string | null };
        // This listener only updates our separate memory ledger. It never logs,
        // signals, changes the runtime table, or performs IPC/I/O at native exit.
        child.once("exit", (code: number | null, signal: string | null) => {
          observed.exitObserved = true;
          observed.exitCode = Number.isInteger(code) ? code : null;
          observed.signal = typeof signal === "string" && /^SIG[A-Z0-9]+$/.test(signal) ? signal : null;
        });
        ledger.set(child, observed);
        return { state: "armed", profileId: observed.profileId, pid: observed.pid, engine: observed.engine };
      }, { userDataDir: target.handle.userDataDir, id: target.id, pid: target.pid, port: target.port,
        runtimeTableUrl: pathToFileURL(path.join(REPO, "dist", "main", "services", "browser", "runtime-table.js")).href });
      stage = "append";
      evidence.registrations.push({ cycle, ...registration });
    } catch (error) {
      evidence.registrations.push({ cycle, state: "unavailable", reason: "OWNED_NATIVE_EXIT_OBSERVER_UNAVAILABLE", failure: nativeObserverFailure(error, stage) });
    }
  }
  async function collectOwnedNativeExits(stage: "after-relaunch" | "failure", cycle?: number): Promise<void> {
    const evidence = nativeStopEvidence();
    let operationStage: "ownership" | "evaluate" | "append" = "ownership";
    try {
      if (!h || !ownedUserData.has(h.userDataDir)) throw new Error("No owned app for observer readback");
      operationStage = "evaluate";
      const snapshot = await h.app.evaluate(({ app }, expected) => {
        if (app.getPath("userData") !== expected.userDataDir) return { state: "unavailable", reason: "OWNED_NATIVE_IDENTITY_MISMATCH" };
        const ledger = (globalThis as any).__syncAcceptanceNativeExitLedger;
        if (!(ledger instanceof Map)) return { state: "not-armed", entries: [] };
        return { state: "available", entries: Array.from(ledger.values()).filter((entry: any) => entry.profileId === expected.id).map((entry: any) => ({
          profileId: entry.profileId, pid: entry.pid, engine: entry.engine, exitObserved: entry.exitObserved, exitCode: entry.exitCode, signal: entry.signal,
        })) };
      }, { userDataDir: h.userDataDir, id: receipt!.observations.profileId });
      operationStage = "append";
      evidence.collections.push({ stage, ...(cycle !== undefined ? { cycle } : {}), ...snapshot });
    } catch (error) {
      evidence.collections.push({ stage, ...(cycle !== undefined ? { cycle } : {}), state: "unavailable", reason: "OWNED_NATIVE_EXIT_READBACK_UNAVAILABLE", failure: nativeObserverFailure(error, operationStage) });
    }
  }

  function retainStoppedNativeStorage(kind: "failure" | "final" = "failure"): void {
    const cycles = receipt!.observations.immediateStop?.cycles;
    if (!Array.isArray(cycles) || !cycles.length) return;
    if (kind === "failure" && !cycles.some((cycle: any) => cycle.actual !== cycle.expected)) return;
    if (kind === "final" && (receipt!.status !== "passed" || cycles.length !== 4 || cycles.some((cycle: any) => cycle.actual !== cycle.expected))) return;
    const observationKey = kind === "final" ? "finalNativeStorageCopies" : "failedNativeStorageCopies";
    try {
      // Keep at most two stopped failure copies, or one final successful copy
      // after the entire chain, never userData/Cookie DBs or a timing-window copy.
      const selected = cycles.slice(kind === "final" ? -1 : -2).filter((cycle: any) => cycle.afterRelaunch?.storageGroup?.format === "sqlite");
      const copies = selected.map((cycle: any) => {
        const analysis = cycle.afterRelaunch.analysisDirectory;
        if (typeof analysis !== "string" || path.dirname(analysis) !== owned || !path.basename(analysis).startsWith("sqlite-storage-analysis-") || fs.lstatSync(analysis).isSymbolicLink()) throw new Error("Unsafe analysis directory");
        const files = cycle.afterRelaunch.storageGroup.files;
        if (!Array.isArray(files) || files.length < 1 || files.length > 2 || files.some((file: any) => !["LocalStorage", "LocalStorage-wal"].includes(file.path))) throw new Error("Unexpected SQLite analysis files");
        const retained = files.map((file: any) => {
          if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_OBJECT_BYTES) throw new Error("SQLite evidence exceeds budget");
          const source = path.join(analysis, file.path);
          if (fs.lstatSync(source).size !== file.bytes) throw new Error("SQLite analysis size changed");
          const bytes = regularBytes(owned, source);
          if (sha256(bytes) !== file.sha256) throw new Error("SQLite analysis digest changed");
          return { name: file.path, bytes, sha256: file.sha256 };
        });
        if (retained.reduce((sum: number, file: any) => sum + file.bytes.length, 0) > MAX_OBJECT_BYTES) throw new Error("SQLite evidence group exceeds budget");
        return { cycle: cycle.cycle, files: retained };
      });
      if (!copies.length) return;
      const name = kind === "final" ? "final-native-storage" : "failure-native-storage";
      const directory = path.join(owned, name);
      fs.mkdirSync(directory, { mode: 0o700 });
      const groups = copies.map((copy) => {
        if (!Number.isSafeInteger(copy.cycle) || copy.cycle < 1 || copy.cycle > 4) throw new Error("Unexpected storage cycle");
        const destination = path.join(directory, `cycle-${copy.cycle}`);
        fs.mkdirSync(destination, { mode: 0o700 });
        return { cycle: copy.cycle, files: copy.files.map((file: any) => {
          const output = path.join(destination, file.name);
          fs.writeFileSync(output, file.bytes, { flag: "wx", mode: 0o600 });
          if (!regularBytes(owned, output).equals(file.bytes)) throw new Error("SQLite evidence readback mismatch");
          return { path: path.relative(owned, output), bytes: file.bytes.length, sha256: file.sha256 };
        }) };
      });
      retainedStorageArtifacts.add(name);
      receipt!.observations[observationKey] = { state: "retained", groups, scope: "Synthetic stopped LocalStorage main/WAL copies only; no checkpoint or source write" };
    } catch {
      receipt!.observations[observationKey] = { state: "unavailable", reason: "BOUNDED_NATIVE_STORAGE_RETENTION_FAILED" };
    }
  }

  function ownedProcessesRemain(userDataDir: string): boolean {
    assertInside(owned, userDataDir);
    // Match only our unpredictable mkdtemp child, never a browser name or ID.
    const pattern = userDataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try { return execFileSync("pgrep", ["-f", pattern], { stdio: "pipe" }).length > 0; }
    catch (error: any) { if (error.status === 1) return false; throw new Error("Could not verify owned process cleanup"); }
  }

  async function phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
    receipt!.phase = name;
    return fn();
  }
  async function screenshot(page: Page, name: string): Promise<void> {
    if (receipt!.screenshots.length >= 8) throw new Error("Acceptance screenshot budget exceeded");
    const file = path.join(owned, name + ".png");
    await page.screenshot({ path: file, fullPage: false, animations: "disabled", timeout: 10_000 });
    if (regularBytes(owned, file).length > 2 * 1024 * 1024) throw new Error("Acceptance screenshot exceeds bounded evidence budget");
    receipt!.screenshots.push(file);
  }
  async function observeRenderer(handle: TestAppHandle): Promise<void> {
    await handle.page.evaluate(() => {
      const w = window as any;
      const observed = { events: [] as any[], toasts: [] as Array<{ className: string; text: string }> };
      w.__syncAcceptanceObserved = observed;
      w.agentBrowserAPI.on("sync:state-changed", (event: any) => {
        if (observed.events.length >= 40) throw new Error("Acceptance event budget exceeded");
        observed.events.push(event);
      });
      const seen = new WeakSet<Element>();
      const observer = new MutationObserver(() => {
        document.querySelectorAll(".toast").forEach((toast) => {
          if (seen.has(toast)) return;
          seen.add(toast);
          if (observed.toasts.length < 50) observed.toasts.push({ className: toast.className, text: toast.textContent || "" });
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
      w.__syncAcceptanceObserver = observer;
      w.i18n.set("en-US");
    });
  }
  async function launchOwnedApp(label: "source" | "receiver", binary: string, previousUserDataDir?: string): Promise<{ port: number; token: string }> {
    const userDataDir = previousUserDataDir || fs.mkdtempSync(path.join(owned, label + "-userdata-"));
    assertInside(owned, userDataDir);
    if (!fs.lstatSync(userDataDir).isDirectory() || fs.lstatSync(userDataDir).isSymbolicLink()) throw new Error("Owned userData must remain a real directory");
    ownedUserData.add(userDataDir); // includes setup failures before a handle is returned
    const token = `sync-acceptance-${label}-fixture-token`;
    h = await setupTestApp({
      userDataDir, resetUserData: previousUserDataDir ? false : true,
      env: { AGENT_BROWSER_CHROMIUM_BINARY_PATH: binary, AGENT_BROWSER_API_PORT: "0", AGENT_BROWSER_MCP_PORT: "0", AGENT_BROWSER_API_TOKEN: token },
    });
    const runtime = await h.app.evaluate(({ app }) => ({
      home: process.getBuiltinModule("os").homedir(), envHome: process.env.HOME,
      userData: app.getPath("userData"), noSandbox: app.commandLine.hasSwitch("no-sandbox"), nodeVersion: process.versions.node,
      providerKeys: Object.keys(process.env).filter((key) => /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|DEEPSEEK|COHERE|MISTRAL)_/.test(key)),
    }));
    expect(fs.realpathSync(runtime.userData)).toBe(fs.realpathSync(userDataDir));
    expect(fs.realpathSync(runtime.home)).toBe(fs.realpathSync(path.join(userDataDir, "test-home")));
    expect(fs.realpathSync(runtime.envHome!)).toBe(fs.realpathSync(runtime.home));
    expect(runtime.noSandbox).toBe(false);
    expect(runtime.providerKeys).toEqual([]);
    observeOwnedMainStopLines(h, label);
    await observeRenderer(h);
    const status = await h.page.evaluate(() => (window as any).agentBrowserAPI.apiRpc.status());
    expect(status.running).toBe(true);
    expect(status.port).toBeGreaterThan(0);
    await waitForOwnedCondition("Owned MCP server started", async () => (await h!.page.evaluate(() => (window as any).agentBrowserAPI.mcp.status())).running, 15_000);
    mcpPort = (await h.page.evaluate(() => (window as any).agentBrowserAPI.mcp.status())).port;
    mcpToken = (await h.page.evaluate(() => (window as any).agentBrowserAPI.mcp.revealToken())).token;
    expect(mcpPort).toBeGreaterThan(0);
    expect(mcpToken).toBeTruthy();
    const mcpAuth = [];
    for (const auth of [null, "wrong-synthetic-mcp-token", mcpToken]) mcpAuth.push((await request(mcpPort, auth, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).status);
    expect(mcpAuth).toEqual([401, 401, 200]);
    receipt!.observations[label + "Isolation"] = { userData: userDataDir, isolatedHome: runtime.home, sandboxEnabled: true, nodeVersion: runtime.nodeVersion, restPort: status.port, mcpPort, mcpAuth };
    return { port: status.port, token };
  }
  async function configureSync(): Promise<void> {
    const result = await h!.page.evaluate(({ endpoint, bucket }) => (window as any).agentBrowserAPI.sync.configure({
      enabled: true, endpoint, bucket, accessKey: "synthetic-acceptance-access", secretKey: "synthetic-acceptance-secret", custodyConsent: true,
    }), { endpoint: fixture!.origin, bucket: BUCKET });
    assertSuccess(result);
    expect(configOf(h!).sync.custodyConsentAt).toBeGreaterThan(0);
    const status = await h!.page.evaluate(() => (window as any).agentBrowserAPI.sync.status());
    expect(status).toMatchObject({ enabled: true, configured: true, endpoint: fixture!.origin, bucket: BUCKET, operation: { active: null } });
    await h!.page.locator('.nav-item[data-tab="sync"]').click();
    await h!.page.waitForFunction(() => (document.getElementById("sync-endpoint-input") as HTMLInputElement)?.value.startsWith("http://127.0.0.1:"));
  }
  async function assertLocalizedSyncStatusHint(): Promise<void> {
    const hint = h!.page.locator('#tab-sync [data-i18n="sync.synced-scope"]');
    const custody = h!.page.locator('#tab-sync [data-i18n="sync.custody"]');
    const observed: Record<string, string> = {};
    const observedCustody: Record<string, string> = {};
    for (const fixture of [
      { language: "en-US", label: /^Supported sync data\b/i, result: /result/i },
      { language: "zh-CN", label: /^支持同步/, result: /结果/ },
    ]) {
      // Exercise the real locale setter and its DOM hydration, not injected copy.
      await h!.page.evaluate((language) => (window as any).i18n.set(language), fixture.language);
      await expect.poll(() => hint.innerText(), { timeout: 10_000 }).toMatch(fixture.label);
      const text = (await hint.innerText()).trim();
      expect(text).not.toMatch(/^(?:Synced|已同步)\s*[:：]/i);
      expect(text).toMatch(fixture.result);
      observed[fixture.language] = text;
      const consent = await custody.innerText();
      expect(consent).toContain("Preferences");
      expect(consent).toContain("LocalStorage");
      expect(consent).not.toMatch(/bookmarks|书签/);
      expect(consent).toMatch(fixture.language === "zh-CN" ? /本次采集可用/ : /available for this capture/);
      observedCustody[fixture.language] = consent;
    }
    receipt!.observations.localizedDataCustody = observedCustody;
    await h!.page.evaluate(() => (window as any).i18n.set("en-US"));
    await expect.poll(() => hint.innerText(), { timeout: 10_000 }).toMatch(/^Supported sync data\b/i);
    receipt!.observations.localizedSyncStatusHint = observed;
  }
  async function syncStatus(): Promise<any> {
    return h!.page.evaluate(() => (window as any).agentBrowserAPI.sync.status());
  }
  async function clickSync(kind: "push" | "pull"): Promise<any> {
    const before = (await syncStatus()).operation.generation;
    await h!.page.locator(`#tab-sync [data-cmd="${kind === "push" ? "syncPush" : "syncPull"}"]`).click();
    await expect.poll(async () => {
      const status = await syncStatus();
      return status.operation.generation > before && status.operation.active === null && status.operation.last?.operationId;
    }, { timeout: 60_000 }).toBeTruthy();
    await expect.poll(() => h!.page.locator("#tab-sync").getAttribute("aria-busy"), { timeout: 15_000 }).toBe("false");
    const result = (await syncStatus()).operation.last;
    assertSuccess(result);
    expect(result).toMatchObject({ outcome: "complete", localCommit: "committed" });
    expect(result.operationId).toBeTruthy();
    await h!.page.locator("#sync-operation-result").waitFor({ state: "visible" });
    return result;
  }
  async function compare(): Promise<any> {
    await h!.page.locator('#tab-sync [data-cmd="loadSyncDiff"]').click();
    await expect.poll(() => h!.page.locator("#sync-diff-message").innerText(), { timeout: 20_000 }).toMatch(/^Supported scope compared\b/);
    const diff = await h!.page.evaluate(() => (window as any).agentBrowserAPI.sync.previewDiff());
    expect(diff.ok, JSON.stringify(diff)).toBe(true);
    expect(diff.comparisonToken).toMatchObject({ targetId: expect.any(String), localHash: expect.any(String), remoteHash: expect.any(String) });
    expect(diff.coverage.notCompared).toEqual(expect.arrayContaining(["live-cookies", "localStorage-database", "full-profile-files"]));
    expect(diff.coverage.unverified).toEqual([]);
    return diff;
  }
  async function assertCleanReadback(id: string, port: number, token: string): Promise<void> {
    const raw = configOf(h!).browserProfiles[id];
    expect(raw.syncBaseline).toMatchObject({ version: 1, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), targetId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const preferences = regularBytes(owned, profilePath(h!, id, "Default", "Preferences"));
    expect(raw.syncBaseline.preferences).toEqual({ state: "present", sha256: sha256(preferences), bytes: preferences.length });
    expect(raw.syncBaseline.snapshotId).toBe(fixture!.config().snapshotId);
    assertSuccess(await h!.page.evaluate(() => (window as any).agentBrowserAPI.app.reloadConfig()));
    const readback = await h!.page.evaluate(async (profileId) => {
      const api = (window as any).agentBrowserAPI;
      return { get: await api.profile.get(profileId), list: await api.profile.list(), browserList: await api.browser.list() };
    }, id);
    for (const entry of [readback.get, ...readback.list.filter((p: any) => p.dirId === id), ...readback.browserList.filter((p: any) => p.dirId === id)]) {
      expect(entry).toMatchObject({ dirId: id, name: PROFILE_NAME, syncStatus: "synced", syncReason: "baseline-match", syncScope: "portable-profile+preferences" });
      expect(entry.syncedAt).toBe(raw.syncBaseline.timestamp);
    }
    expect(readback.list.filter((p: any) => p.dirId === id)).toHaveLength(1);
    expect(readback.browserList.filter((p: any) => p.dirId === id)).toHaveLength(1);
    const rest = await request(port, token, "GET", "/api/profiles");
    expect(rest.status).toBe(200);
    expect(rest.body.profiles.filter((p: any) => p.dirId === id)).toHaveLength(1);
    expect(rest.body.profiles.find((p: any) => p.dirId === id)).toMatchObject({ syncStatus: "synced", syncReason: "baseline-match", syncScope: "portable-profile+preferences" });
    const byId = await request(port, token, "GET", `/api/profiles/${id}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ dirId: id, name: PROFILE_NAME, note: PROFILE_NOTE, syncStatus: "synced", syncScope: "portable-profile+preferences" });
    const projected = { syncedAt: raw.syncBaseline.timestamp, syncStatus: "synced", syncReason: "baseline-match", syncScope: "portable-profile+preferences" };
    for (const name of ["agent_browser_list_profiles", "agent_browser_profile_info"]) {
      const response = await request(mcpPort, mcpToken, "POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: { dirId: id } } });
      expect(response.status).toBe(200);
      expect(response.body.error).toBeUndefined();
      expect(response.body.result.isError).toBeFalsy();
      const data = JSON.parse(response.body.result.content[0].text);
      const profile = name === "agent_browser_list_profiles" ? data.profiles.find((entry: any) => entry.dirId === id) : data;
      expect(profile).toMatchObject(projected);
    }
    const sdk = new AgentBrowserClient(`http://127.0.0.1:${port}`, { token, timeout: 10_000 });
    expect((await sdk.listProfiles()).find((entry: any) => entry.dirId === id)).toMatchObject(projected);
    expect(await sdk.getProfile(id)).toMatchObject(projected);
    for (const route of ["/api/profiles", `/api/profiles/${id}`]) {
      const response = await pythonSdkRequest(port, token, "GET", route);
      expect(response.status).toBe(200);
      expect(route === "/api/profiles" ? response.body.profiles.find((entry: any) => entry.dirId === id) : response.body).toMatchObject(projected);
    }
    (receipt!.observations.profileTransportReadbacks ||= []).push({ profileId: id, restPort: port, mcpPort, mcpListAndInfo: true, javascriptSdkListAndInfo: true, pythonSdkListAndInfo: true, ...projected });
    await h!.page.locator('.nav-item[data-tab="profiles"]').click();
    await h!.page.evaluate(() => (window as any).agentBrowser.loadProfiles());
    const badge = h!.page.locator(`#profile-list .profile-card[data-dir-id="${id}"] .sync-synced`);
    await badge.waitFor({ state: "visible" });
    const title = await badge.getAttribute("title");
    expect(title).toMatch(/portable profile metadata and Preferences only/);
    expect(title).toMatch(/Cookies, localStorage.*not verified/);
    const backupHint = h!.page.locator('#backup-hint [data-i18n="backup.hint.title"]');
    await backupHint.waitFor({ state: "visible" });
    expect(await backupHint.innerText()).toMatch(/independent backup/);
    expect(await backupHint.innerText()).not.toMatch(/lives only|only on this machine|Backup completed/i);
    expect(await h!.page.locator(`#profile-list .profile-card[data-dir-id="${id}"]`).innerText()).toContain(PROFILE_NAME);
  }
  function observeOwnedCookieQueue(id: string): Record<string, any> {
    const observed: Record<string, any> = { exists: null, count: null, sha256: null };
    try {
      const file = path.join(h!.userDataDir, "pending-cookie-imports", `${id}.json`);
      assertInside(owned, file);
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      observed.exists = !!stat;
      if (!stat) { observed.count = 0; return observed; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_OBJECT_BYTES) {
        observed.unavailable = "unsafe-or-oversized-owned-queue"; return observed;
      }
      const bytes = regularBytes(owned, file);
      observed.sha256 = sha256(bytes);
      const pending = JSON.parse(bytes.toString("utf8"));
      if (!Array.isArray(pending)) { observed.unavailable = "invalid-owned-queue"; return observed; }
      observed.count = pending.length;
      const cookie = pending.find((entry: any) => entry?.name === COOKIE_NAME && entry.domain === "127.0.0.1" && entry.path === "/");
      // Queue attributes are expected import metadata, not runtime attestation.
      // Never copy any cookie value (including the known synthetic value).
      observed.syntheticCookie = cookie ? { source: "owned-pending-queue", secure: typeof cookie.secure === "boolean" ? cookie.secure : null,
        httpOnly: typeof cookie.httpOnly === "boolean" ? cookie.httpOnly : null,
        expiresEpochSeconds: Number.isFinite(cookie.expires) ? cookie.expires : null,
        sameSite: [-1, 0, 1, 2].includes(cookie.sameSite) ? cookie.sameSite : null } : null;
    } catch {
      observed.unavailable = "owned-queue-observation-failed";
    }
    return observed;
  }
  async function launchStudioBrowser(id: string, cookieObservation?: Record<string, any>): Promise<LiveBrowser> {
    if (cookieObservation) cookieObservation.queueBefore = observeOwnedCookieQueue(id);
    let result: any;
    try {
      result = await h!.page.evaluate((profileId) => (window as any).agentBrowserAPI.browser.launch(profileId), id);
    } finally {
      if (cookieObservation) {
        cookieObservation.launch = { cookieCheck: result?.cookieCheck ?? null, pid: result?.pid ?? null, cdpPort: result?.cdpPort ?? null };
        cookieObservation.queueAfter = observeOwnedCookieQueue(id);
      }
    }
    assertSuccess(result);
    expect(result.pid).toBeGreaterThan(0);
    expect(result.cdpPort).toBeGreaterThan(0);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${result.cdpPort}`, { timeout: 30_000 });
    const context = browser.contexts()[0];
    expect(context).toBeDefined();
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === fixture!.origin || ["data:", "about:", "chrome:"].includes(url.protocol)) await route.continue();
      else await route.abort("blockedbyclient");
    });
    const page = context.pages().find((entry) => !entry.url().startsWith("chrome-extension:")) || await context.newPage();
    await page.goto(fixture!.origin + "/business", { waitUntil: "load", timeout: 15_000 });
    await page.locator("#read-state").waitFor({ state: "visible" });
    const launchLog = regularBytes(owned, path.join(h!.userDataDir, "logs", `browser-${id}.log`)).toString("utf8");
    expect(launchLog).not.toContain("--no-sandbox");
    live = { browser, page, handle: h!, id, pid: result.pid, port: result.cdpPort };
    return live;
  }
  async function stopStudioBrowser(): Promise<void> {
    if (!live) return;
    const target = live;
    const requestedAt = Date.now();
    const result = await target.handle.page.evaluate((id) => (window as any).agentBrowserAPI.browser.stop(id), target.id);
    assertSuccess(result);
    const timing = { id: target.id, pid: target.pid, requestedAt, requestReturnedAt: Date.now(), observedExitAt: null as number | null, elapsedMs: null as number | null, apiSuccess: result.success, pidConfirmedExited: false, cdpDisconnected: false, terminationSignal: "not observed; no graceful-flush claim" };
    (receipt!.observations.browserStopTimings ||= []).push(timing);
    // Ordinary bounded polling also works from afterAll; expect.poll is
    // test-context-only and must not prevent cleanup after an earlier failure.
    await waitForOwnedCondition("Studio browser status stopped", async () => !(await target.handle.page.evaluate((id) => (window as any).agentBrowserAPI.browser.status(id), target.id)).running, 15_000);
    await waitForOwnedCondition("Studio browser PID exited", () => {
      try { process.kill(target.pid, 0); return false; }
      catch (error: any) { if (error.code === "ESRCH") return true; throw error; }
    }, 15_000);
    timing.pidConfirmedExited = true;
    timing.observedExitAt = Date.now(); timing.elapsedMs = timing.observedExitAt - requestedAt;
    // Never use Playwright browser.close() as a substitute for Studio stop.
    await waitForOwnedCondition("Owned CDP disconnected after Studio stop", () => !target.browser.isConnected(), 5_000);
    timing.cdpDisconnected = true;
    receipt!.observations.normalBrowserStops = (receipt!.observations.normalBrowserStops || 0) + 1;
    live = undefined;
  }
  async function browserBusinessValues(page: Page, cookieObservation?: Record<string, any>) {
    await page.locator("#read-state").click();
    const values = await page.evaluate((key) => ({ cookie: document.cookie, localStorage: localStorage.getItem(key) }), STORAGE_KEY);
    if (cookieObservation) {
      // Freeze the original business read BEFORE any metadata query. A late
      // Cookie cannot turn that original empty read into a passing assertion.
      cookieObservation.business = { origin: new URL(page.url()).origin,
        syntheticCookieMatches: values.cookie.split("; ").includes(`${COOKIE_NAME}=${COOKIE_VALUE}`), runtimeAttributes: { state: "not-observed" } };
      try {
        const metadata = await page.evaluate(async (name) => {
          const scope = { origin: location.origin, httpOnly: "not-exposed-by-page-cookie-store" };
          const store = (window as any).cookieStore;
          if (!store || typeof store.get !== "function") return { ...scope, state: "unavailable", reason: "named-cookie-store-unavailable" };
          try {
            // A name-scoped read only; never enumerate other cookies or return
            // the CookieListItem/value. HttpOnly is not exposed by this API.
            const cookie = await store.get({ name });
            if (!cookie) return { ...scope, state: "not-visible" };
            if (cookie.name !== name || cookie.path !== "/" ||
                (cookie.domain && cookie.domain !== location.hostname && cookie.domain !== "." + location.hostname)) {
              return { ...scope, state: "unavailable", reason: "expected-cookie-scope-not-returned" };
            }
            return { ...scope, state: "visible", secure: typeof cookie.secure === "boolean" ? cookie.secure : null,
              expiresEpochMilliseconds: Number.isFinite(cookie.expires) ? cookie.expires : null,
              sameSite: ["lax", "strict", "none"].includes(cookie.sameSite) ? cookie.sameSite : null };
          } catch { return { ...scope, state: "unavailable", reason: "named-cookie-store-read-failed" }; }
        }, COOKIE_NAME);
        cookieObservation.business.origin = metadata.origin;
        cookieObservation.business.runtimeAttributes = metadata;
      } catch {
        cookieObservation.business.runtimeAttributes = { state: "unavailable", reason: "page-cookie-observation-failed" };
      } finally {
        fixture!.endBusinessCookieObservation();
      }
    }
    expect(values.cookie.split("; ")).toContain(`${COOKIE_NAME}=${COOKIE_VALUE}`);
    expect(values.localStorage).toBe(STORAGE_VALUE);
    expect(JSON.parse(await page.locator("#business-values").innerText())).toEqual(values);
    return values;
  }
  async function clickProfileAction(id: string, action: string): Promise<void> {
    const card = h!.page.locator(`#profile-list .profile-card[data-dir-id="${id}"]`);
    const summary = card.locator("details.card-menu > summary");
    // Open through the real UI after scrolling the trigger into view. Merely
    // assigning details.open before Playwright scrolls dismisses the popover.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await summary.scrollIntoViewIfNeeded();
        if (!(await card.locator("details.card-menu").evaluate((element: HTMLDetailsElement) => element.open))) await summary.click();
        await card.locator(`[data-action="${action}"]`).click({ timeout: 5_000 });
        return;
      } catch (error) {
        // A just-finished browser stop can replace the card before scrolling or
        // dispatch. Retry only this detached-element case, never a backend error.
        if (attempt === 2 || !/detached from the DOM|not attached to the DOM/.test(String(error))) throw error;
        await h!.page.waitForTimeout(100);
      }
    }
  }
  async function installDialogFixture(): Promise<void> {
    await h!.app.evaluate(({ dialog }) => {
      const state = {
        originalSave: dialog.showSaveDialog, originalOpen: dialog.showOpenDialog,
        calls: [] as Array<{ kind: string; startedAt: number }>, pending: null as null | ((value: any) => void),
      };
      (globalThis as any).__syncAcceptanceDialogs = state;
      (dialog as any).showSaveDialog = async () => {
        if (state.pending) throw new Error("An owned native dialog is already pending");
        state.calls.push({ kind: "save", startedAt: Date.now() });
        return new Promise((resolve) => { state.pending = resolve; });
      };
      (dialog as any).showOpenDialog = async () => {
        if (state.pending) throw new Error("An owned native dialog is already pending");
        state.calls.push({ kind: "open", startedAt: Date.now() });
        return new Promise((resolve) => { state.pending = resolve; });
      };
    });
    dialogsInstalled = true;
  }
  async function finishDialog(value: { canceled: boolean; filePath?: string; filePaths?: string[] }): Promise<void> {
    await h!.app.evaluate((_electron, result) => {
      const state = (globalThis as any).__syncAcceptanceDialogs;
      if (!state?.pending) throw new Error("No owned native dialog is pending");
      const resolve = state.pending; state.pending = null; resolve(result);
    }, value);
  }
  async function dialogCalls(): Promise<Array<{ kind: string; startedAt: number }>> {
    return h!.app.evaluate(() => (globalThis as any).__syncAcceptanceDialogs.calls);
  }
  async function restoreDialogs(): Promise<void> {
    if (!dialogsInstalled || !h) return;
    await h.app.evaluate(({ dialog }) => {
      const state = (globalThis as any).__syncAcceptanceDialogs;
      if (!state) throw new Error("Owned native dialog fixture disappeared");
      if (state.pending) { const resolve = state.pending; state.pending = null; resolve({ canceled: true, filePaths: [] }); }
      (dialog as any).showSaveDialog = state.originalSave;
      (dialog as any).showOpenDialog = state.originalOpen;
      delete (globalThis as any).__syncAcceptanceDialogs;
    });
    dialogsInstalled = false;
  }

  it("publishes, restores and queries real isolated state through original preload IPC, UI, HTTP and Chromium", async () => {
    expect(process.env.ABS_SYNC_ACCEPTANCE_DIST_READY, "Coordinator must explicitly confirm current dist before launch").toBe("1");
    expect(process.platform, "This acceptance asserts the macOS host identity").toBe("darwin");
    expect(process.env.AGENT_BROWSER_E2E_UNSANDBOXED, "The original helper must keep its sandbox on").not.toBe("1");
    const supplied = process.env.ABS_SYNC_ACCEPTANCE_ROOT;
    if (!supplied || !path.isAbsolute(supplied)) throw new Error("ABS_SYNC_ACCEPTANCE_ROOT must be a fresh absolute empty test-owned directory");
    const stat = fs.lstatSync(supplied);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(supplied).length) throw new Error("Acceptance root must exist, be empty, and not be a symlink");
    root = fs.realpathSync(supplied);
    if (root.startsWith("/Volumes/")) {
      // The caller selects storage; never create a mount or fall back elsewhere.
      try { execFileSync("python3", ["/Users/ahoo/.local/share/agent-storage/move_verified_storage.py", "check-mount"], { stdio: "pipe" }); }
      catch { throw new Error("Private storage mount validation failed; no acceptance fixture writes were started"); }
    }
    owned = fs.mkdtempSync(path.join(root, "sync-state-"));
    receipt = {
      schema: "actual-app-sync-state-acceptance/v1", status: "running", phase: "preflight", startedAt: new Date().toISOString(),
      observations: {}, screenshots: [], cleanup: [], limitations: [
        "Fresh isolated HOME is a fixture, not proof of the real user's license or default credential vault.",
        "The clean badge and Compare cover portable metadata plus raw Preferences, not Cookie/LevelDB semantics or all browser files.",
        "Cookie/native LocalStorage business values are separately queried on the same loopback origin after plaintext runtime Cookie export/import; encrypted cross-device Cookie portability is not claimed.",
        "The ZIP verifies this profile's SQLite main/WAL data and portable metadata, not full application or agent-store backup.",
        "Only native dialog wait/selection/cancellation is controlled; archive publication/import and all sync/browser APIs are real.",
        "Primary capture permits a measured first-write settle; the separate mandatory immediate-stop branch has no intentional settle/flush wait and must pass before complete acceptance.",
        "Legacy LevelDB structure assertions run only when that native format actually exists; SQLite is never forced into legacy mode. SQLite inspection opens only an owned main/WAL analysis copy read-only, never checkpoints the source.",
      ],
    };
    try {
      const binary = resolveManagedChromiumPath(selectTestChromiumFixtureEnv());
      expect(binary, "An installed managed Chromium binary is required; no download/install fallback").toBeTruthy();
      const distMain = path.join(REPO, "dist", "main", "index.js");
      expect(fs.statSync(distMain).isFile()).toBe(true);
      for (const relative of ["main/preload.cjs", "renderer/js/app/sync.js", "renderer/js/app/profiles.js", "renderer/js/app/ipc.js"]) {
        const source = path.join(REPO, "src", relative);
        expect(sha256(fs.readFileSync(path.join(REPO, "dist", relative))), `Current dist copy is stale: ${relative}`).toBe(sha256(fs.readFileSync(source)));
      }
      const distRoot = path.join(REPO, "dist");
      const artifactHashes: Record<string, { sha256: string; bytes: number }> = {};
      let artifactBytes = 0;
      const syncModules = fs.readdirSync(path.join(distRoot, "main", "services", "sync")).filter((name) => name.endsWith(".js")).sort();
      if (syncModules.length > 16) throw new Error("Sync module identity inventory exceeds budget");
      for (const relative of ["main/index.js", "main/services/rest-api-server.js", "main/services/sync-service.js", "main/services/profile-archive.js", "main/services/mcp-server.js", "main/services/local-agent.js", ...syncModules.map((name) => "main/services/sync/" + name), "renderer/index.html", "renderer/js/i18n.js", "renderer/js/app/sync.js"]) {
        const file = path.join(distRoot, relative);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error("Dist identity input is not a bounded regular file");
        const bytes = regularBytes(distRoot, file);
        artifactBytes += bytes.length;
        if (artifactBytes > MAX_OBJECT_BYTES) throw new Error("Dist identity aggregate byte budget exceeded");
        artifactHashes[relative] = { sha256: sha256(bytes), bytes: bytes.length };
      }
      receipt.observations.dist = { mainSha256: artifactHashes["main/index.js"].sha256, artifacts: artifactHashes, binary };
      receipt.observations.sdkImplementation = Object.fromEntries(["sdk/js/agent-browser.mjs", "sdk/python/agent_browser_client.py"].map((relative) => {
        const bytes = regularBytes(REPO, path.join(REPO, relative));
        return [relative, { sha256: sha256(bytes), bytes: bytes.length }];
      }));
      fixture = await loopbackFixture();
      // Learn B's genuine isolated device identity before A publishes a roster.
      // Only this exclusively owned child is relaunched with resetUserData:false.
      await launchOwnedApp("receiver", binary!);
      const receiverUserData = h!.userDataDir;
      const receiverIdentity = await h!.page.evaluate(() => (window as any).agentBrowserAPI.team.status());
      expect(receiverIdentity.team).toBeNull();
      expect(receiverIdentity.local.deviceId).toBeTruthy();
      await closeApp(h!); h = undefined;
      const source = await launchOwnedApp("source", binary!);
      const sourceUserData = h!.userDataDir;
      await configureSync();
      assertSuccess(await h!.page.evaluate(() => (window as any).agentBrowserAPI.team.init("Acceptance source-owned workspace")));
      assertSuccess(await h!.page.evaluate((deviceId) => (window as any).agentBrowserAPI.team.addMember(deviceId, "Synthetic receiver B", "member"), receiverIdentity.local.deviceId));
      receipt.observations.receiverRoster = { sourceOwnerApi: "team.init", receiverAddedVia: "team.addMember", receiverDeviceId: receiverIdentity.local.deviceId, initialRole: "member" };
      let id = "";
      let extensionId = "";
      let stoppedPayload: any;
      let stoppedPreferences: Buffer;
      let stoppedStorageGroup: StorageGroup;

      await phase("source fixtures via original IPC", async () => {
        const extensionDir = fs.mkdtempSync(path.join(owned, "extension-input-"));
        fs.writeFileSync(path.join(extensionDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Acceptance local extension", version: "1.0.0", description: "Synthetic offline repository fixture", background: { service_worker: "background.js" } }));
        fs.writeFileSync(path.join(extensionDir, "background.js"), EXTENSION_JS);
        const installed = await h!.page.evaluate((inputPath) => (window as any).agentBrowserAPI.settings.installLocalExtension(inputPath, { shared: true, tags: ["acceptance"] }), extensionDir);
        assertSuccess(installed);
        extensionId = installed.entry.id;
        expect(extensionId).toMatch(/^local_[a-z0-9]+$/);
        assertInside(h!.userDataDir, installed.entry.unpackedPath);
        expect(regularBytes(owned, path.join(installed.entry.unpackedPath, "background.js")).toString()).toBe(EXTENSION_JS);
        assertSuccess(await h!.page.evaluate(({ name, port }) => (window as any).agentBrowserAPI.proxy.add(name, { type: "http", host: "127.0.0.1", port }), { name: PROXY_NAME, port: fixture!.port }));
        const created = await h!.page.evaluate(({ name, proxyName }) => (window as any).agentBrowserAPI.browser.create({
          name, engine: "chromium", fingerprintMode: "managed", platform: "macos", fingerprintSeed: 730147,
          locale: "en-US", timezone: "UTC", webrtcMode: "disable", proxyMode: "named", proxyName, tags: ["acceptance", "portable"],
        }), { name: PROFILE_NAME, proxyName: PROXY_NAME });
        id = created.dirId;
        expect(id, JSON.stringify(created)).toMatch(/^ab_/);
        assertSuccess(await h!.page.evaluate(({ profileId, note }) => (window as any).agentBrowserAPI.browser.setMeta(profileId, { note }), { profileId: id, note: PROFILE_NOTE }));
        assertSuccess(await h!.page.evaluate(({ profileId, extId }) => (window as any).agentBrowserAPI.settings.setProfileExtensions(profileId, { [extId]: false }), { profileId: id, extId: extensionId }));
        const account = await h!.page.evaluate(({ profileId, origin, username }) => (window as any).agentBrowserAPI.agent.accounts.add({ platformUrl: origin, platformUserName: username, platformPassword: "", profileIds: [profileId], tags: ["acceptance"] }), { profileId: id, origin: fixture!.origin, username: ACCOUNT_NAME });
        expect(account.platformUserName).toBe(ACCOUNT_NAME);
        const preferences = { profile: { name: PROFILE_NAME }, session: { restore_on_startup: 4, startup_urls: [fixture!.origin + "/business"] }, homepage: fixture!.origin + "/business" };
        assertSuccess(await h!.page.evaluate(({ profileId, prefs }) => (window as any).agentBrowserAPI.settings.updatePreferences(profileId, prefs), { profileId: id, prefs: preferences }));
        expect(readJson(profilePath(h!, id, "Default", "Preferences"))).toEqual(preferences);
        const disk = configOf(h!);
        expect(disk.browserProfiles[id]).toMatchObject({ name: PROFILE_NAME, note: PROFILE_NOTE, platform: "macos", engine: "chromium", fingerprintMode: "managed", proxyMode: "named", proxyName: PROXY_NAME, extensions: { [extensionId]: false } });
        expect(disk.proxies[PROXY_NAME]).toMatchObject({ host: "127.0.0.1", port: fixture!.port });
        expect(disk.accounts.find((entry: any) => entry.platformUserName === ACCOUNT_NAME)).toMatchObject({ profileIds: [id], platformUrl: fixture!.origin });
        const accounts = await h!.page.evaluate(() => (window as any).agentBrowserAPI.agent.accounts.list());
        expect(accounts.filter((entry: any) => entry.platformUserName === ACCOUNT_NAME)).toHaveLength(1);
        receipt!.observations.profileId = id;
        receipt!.observations.extensionId = extensionId;
      });

      await phase("public/protected REST auth and owned in-flight UI Push", async () => {
        expect((await request(source.port, null, "GET", "/health")).status).toBe(200);
        const auth: Record<string, number[]> = {};
        for (const route of ["/api/sync/status", "/api/sync/preview", "/api/sync/preview-diff", "/api/profiles"]) {
          const statuses = [];
          for (const token of [null, "deliberately-wrong-acceptance-token", source.token]) statuses.push((await request(source.port, token, "GET", route)).status);
          expect(statuses, route).toEqual([401, 401, 200]); auth[route] = statuses;
        }
        const initialDiff = (await request(source.port, source.token, "GET", "/api/sync/preview-diff")).body;
        expect(initialDiff).toMatchObject({ ok: true, firstPush: true });
        const gateReached = fixture!.holdConfigPut();
        const before = (await syncStatus()).operation.generation;
        await h!.page.locator('#tab-sync [data-cmd="syncPush"]').click();
        await Promise.race([gateReached, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Real S3 PUT never reached the gate")), 30_000))]);
        const running = await request(source.port, source.token, "GET", "/api/sync/status");
        expect(running.body.operation).toMatchObject({ generation: before + 1, active: { kind: "push", stage: "publishing", operationId: expect.any(String), startedAt: expect.any(Number) } });
        expect(fixture!.objects.has(CONFIG_KEY)).toBe(false);
        await expect.poll(() => h!.page.locator("#tab-sync").getAttribute("aria-busy")).toBe("true");
        for (const command of ["syncPush", "syncPull", "syncSave"]) expect(await h!.page.locator(`#tab-sync [data-cmd="${command}"]`).isDisabled()).toBe(true);
        for (const route of ["/api/sync/push", "/api/sync/pull"]) {
          const busy = await request(source.port, source.token, "POST", route, {});
          expect(busy).toMatchObject({ status: 409, body: { success: false, code: "SYNC_BUSY", outcome: "failed", localCommit: "none", remoteCommit: "none" } });
          const expected = { status: 409, body: expect.objectContaining({ success: false, code: "SYNC_BUSY", outcome: "failed", localCommit: "none", remoteCommit: "none" }) };
          expect(await jsSdkError(source.port, source.token, route, {})).toMatchObject(expected);
          expect(await pythonSdkRequest(source.port, source.token, "POST", route, {})).toMatchObject({ ...expected, bodyTruncated: false });
        }
        fixture!.releaseConfigPut();
        await expect.poll(async () => (await syncStatus()).operation.active, { timeout: 60_000 }).toBeNull();
        await expect.poll(() => h!.page.locator("#tab-sync").getAttribute("aria-busy"), { timeout: 15_000 }).toBe("false");
        const result = (await syncStatus()).operation.last;
        expect(result).toMatchObject({ success: true, outcome: "complete", localCommit: "committed", remoteCommit: "committed", operationId: running.body.operation.active.operationId });
        await assertLocalizedSyncStatusHint();
        expect(await h!.page.locator("#sync-operation-result").innerText()).toMatch(/Last synchronization result/);
        const payload = fixture!.config();
        expect(payload).toMatchObject({ artifactVersion: 2, snapshotId: result.operationId });
        const publishedConfig = JSON.parse(zlib.gunzipSync(Buffer.from(payload.data, "base64")).toString());
        expect(publishedConfig.browserProfiles[id].syncBaseline).toMatchObject({ version: 1, snapshotId: payload.snapshotId });
        expect(fixture!.journal.filter((entry) => entry.method === "PUT" && entry.key === CONFIG_KEY)).toHaveLength(1);
        await assertCleanReadback(id, source.port, source.token);
        await screenshot(h!.page, "01-source-clean-badge");
        await h!.page.locator('.nav-item[data-tab="sync"]').click();
        const diff = await compare();
        expect(diff.profiles.changed).toEqual([]);
        await screenshot(h!.page, "02-source-compare-scope");
        const pair = await h!.page.evaluate((operationId) => (window as any).__syncAcceptanceObserved.events.filter((event: any) => event.operationId === operationId), result.operationId);
        expect(pair.map((event: any) => event.phase)).toEqual(["started", "completed"]);
        expect(pair[1].generation).toBeGreaterThan(pair[0].generation);
        for (const route of ["/api/sync/push", "/api/sync/pull"]) {
          const stale = await request(source.port, source.token, "POST", route, { comparisonToken: initialDiff.comparisonToken });
          expect(stale).toMatchObject({ status: 409, body: { success: false, code: "SYNC_PREVIEW_STALE", localCommit: "none", remoteCommit: "none" } });
          const expected = { status: 409, body: expect.objectContaining({ success: false, code: "SYNC_PREVIEW_STALE", outcome: "failed", localCommit: "none", remoteCommit: "none" }) };
          const selection = { comparisonToken: initialDiff.comparisonToken };
          expect(await jsSdkError(source.port, source.token, route, selection)).toMatchObject(expected);
          expect(await pythonSdkRequest(source.port, source.token, "POST", route, selection)).toMatchObject({ ...expected, bodyTruncated: false });
        }
        receipt!.observations.sdkConflictReceipts = { busy: { javascript: 409, python: 409 }, stale: { javascript: 409, python: 409 }, structuredBodyVerified: true };
        expect(fixture!.journal.filter((entry) => entry.method === "PUT" && entry.key === CONFIG_KEY)).toHaveLength(1);
        receipt!.observations.auth = auth;
        receipt!.observations.firstPush = { result, events: pair, coverage: diff.coverage, actualConfigSha256: sha256(fixture!.objects.get(CONFIG_KEY)!) };
      });

      await phase("real Chromium click, runtime Cookie push, quiescent native LocalStorage push", async () => {
        const browser = await launchStudioBrowser(id);
        expect(await browser.page.evaluate(() => document.cookie)).not.toContain(COOKIE_VALUE);
        expect(await browser.page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
        await browser.page.locator("#write-state").click();
        const values = await browserBusinessValues(browser.page);
        await h!.page.locator('.nav-item[data-tab="sync"]').click();
        const runtimePush = await clickSync("push");
        const runtimePayload = fixture!.config();
        expect(runtimePayload.artifactSources.cookies[id]).toBe("captured");
        const runtimeCookies = JSON.parse(zlib.gunzipSync(Buffer.from(runtimePayload.cookies[id], "base64")).toString());
        expect(runtimeCookies.find((entry: any) => entry.name === COOKIE_NAME)).toMatchObject({ value: COOKIE_VALUE, domain: "127.0.0.1", path: "/" });
        expect(runtimePush.items).toEqual(expect.arrayContaining([expect.objectContaining({ scope: "localStorage", id, state: "skipped", code: "PROFILE_RUNNING" })]));
        const waitStartedAt = Date.now();
        const defaultDir = profilePath(h!, id, "Default");
        receipt!.observations.browserSourceProgress = { values, runtimePush, firstDiskWaitStartedAt: waitStartedAt, firstWriteSettleMs: 6_000, storageFormatObserved: null };
        // Observe the browser's REAL backend, without switching feature flags.
        // This ordinary first-write fixture settles before quiescent analysis;
        // a separate mandatory branch below tests an immediate post-write stop.
        await expect.poll(() => {
          const progress = receipt!.observations.browserSourceProgress;
          progress.storageFormatObserved = detectLocalStorageFormat(owned, defaultDir);
          progress.storageFiles = progress.storageFormatObserved === "sqlite"
            ? ["LocalStorage", "LocalStorage-wal"].filter((name) => fs.existsSync(path.join(defaultDir, name))).map((name) => ({ path: name, bytes: fs.lstatSync(path.join(defaultDir, name)).size }))
            : storageFileInventory(owned, path.join(defaultDir, "Local Storage"));
          progress.firstDiskWaitElapsedMs = Date.now() - waitStartedAt;
          return progress.storageFormatObserved !== null && progress.firstDiskWaitElapsedMs >= progress.firstWriteSettleMs;
        }, { timeout: 20_000, interval: 250 }).toBe(true);
        await stopStudioBrowser();
        receipt!.observations.browserSourceProgress.sourceQuiescentAfterVerifiedPidExit = true;
        const cookiesFile = [path.join(defaultDir, "Network", "Cookies"), path.join(defaultDir, "Cookies")].find((file) => fs.existsSync(file));
        expect(cookiesFile, "The launched browser must have produced its own Cookie DB").toBeTruthy();
        expect(regularBytes(owned, cookiesFile!).subarray(0, 15).toString()).toBe("SQLite format 3");
        expect(regularBytes(owned, cookiesFile!)[15]).toBe(0);
        stoppedStorageGroup = captureStorageGroup(owned, defaultDir);
        receipt!.observations.browserSourceProgress.storageGroup = stoppedStorageGroup;
        if (stoppedStorageGroup.format === "sqlite") {
          const analysis = {};
          receipt!.observations.browserSourceProgress.sqliteAnalysis = analysis;
          inspectOwnedSqliteStorage(owned, defaultDir, stoppedStorageGroup, fixture!.origin, analysis);
        }
        const stoppedPush = await clickSync("push");
        stoppedPayload = fixture!.config();
        receipt!.observations.browserSourceProgress.stoppedPush = stoppedPush;
        receipt!.observations.browserSourceProgress.stoppedArtifactSource = stoppedPayload.artifactSources?.localStorage?.[id] ?? "missing";
        receipt!.observations.browserSourceProgress.stoppedSnapshotId = stoppedPayload.snapshotId;
        expect(stoppedPayload.artifactSources.cookies[id]).toBe("preserved");
        expect(stoppedPayload.cookies[id]).toBe(runtimePayload.cookies[id]);
        expect(stoppedPayload.artifactSources.localStorage[id], `PRODUCTION_LOCAL_STORAGE_ARTIFACT_MISSING: quiescent real ${stoppedStorageGroup.format} group exists and SQLite business value (when applicable) was verified; stopped Push must not report absent`).toBe("captured");
        expect(stoppedPayload.localStorage[id]).toBeTruthy();
        expect(stoppedPush.items).toEqual(expect.arrayContaining([expect.objectContaining({ side: "remote", scope: "cookies", id, state: "preserved", code: "COOKIE_SOURCE_UNAVAILABLE" })]));
        expect(stoppedPush.warnings.join("\n")).toMatch(/Cookies.*not freshly verified.*previous remote data retained/);
        stoppedPreferences = regularBytes(owned, path.join(defaultDir, "Preferences"));
        expect(zlib.gunzipSync(Buffer.from(stoppedPayload.preferences[id], "base64"))).toEqual(stoppedPreferences);
        await assertCleanReadback(id, source.port, source.token);
        receipt!.observations.browserSource = { values, runtimePush, stoppedPush, storageGroup: stoppedStorageGroup, preferencesSha256: sha256(stoppedPreferences), cookieDatabaseSha256: sha256(regularBytes(owned, cookiesFile!)) };
      });

      await phase("quiescent WAL backup with real late native-dialog completion and cancel", async () => {
        const sqlitePath = profilePath(h!, id, "Default", SQLITE_NAME);
        sqlite = new DatabaseSync(sqlitePath);
        sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE orders(id INTEGER PRIMARY KEY, label TEXT NOT NULL, payload TEXT NOT NULL)");
        const insert = sqlite.prepare("INSERT INTO orders(id,label,payload) VALUES(?,?,?)");
        insert.run(SQL_ROWS[0].id, SQL_ROWS[0].label, SQL_ROWS[0].payload);
        sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        insert.run(SQL_ROWS[1].id, SQL_ROWS[1].label, SQL_ROWS[1].payload);
        expect(sqlite.prepare("PRAGMA wal_autocheckpoint").get()).toMatchObject({ wal_autocheckpoint: 0 });
        const sourceMain = regularBytes(owned, sqlitePath);
        const sourceWal = regularBytes(owned, sqlitePath + "-wal");
        expect(sourceWal.length).toBeGreaterThan(32);
        expect([0x377f0682, 0x377f0683]).toContain(sourceWal.readUInt32BE(0));
        expect(sourceWal.includes(Buffer.from(SQL_ROWS[1].payload))).toBe(true);
        expect(sourceMain.includes(Buffer.from(SQL_ROWS[1].payload))).toBe(false);
        const baseCopy = path.join(owned, "main-only.sqlite");
        fs.writeFileSync(baseCopy, sourceMain);
        const mainOnly = new DatabaseSync(baseCopy, { readOnly: true });
        try { expect(mainOnly.prepare("SELECT id,label,payload FROM orders ORDER BY id").all()).toEqual([SQL_ROWS[0]]); }
        finally { mainOnly.close(); }
        expect(sqlite.prepare("SELECT id,label,payload FROM orders ORDER BY id").all()).toEqual(SQL_ROWS);
        await installDialogFixture();
        // Use an exclusively owned child of the app's existing allowed export
        // root. Selecting a native dialog path does not bypass the path guard.
        const backupDir = fs.mkdtempSync(path.join(h!.userDataDir, "acceptance-backups-"));
        const zipPath = path.join(backupDir, "real-profile-backup.zip");
        await clickProfileAction(id, "export-archive");
        await expect.poll(async () => (await dialogCalls()).length).toBe(1);
        await clickProfileAction(id, "export-archive");
        await h!.page.waitForTimeout(15_600);
        expect((await dialogCalls()).length).toBe(1);
        expect(Date.now() - (await dialogCalls())[0].startedAt).toBeGreaterThan(15_000);
        expect(await h!.page.evaluate((key) => (window as any).agentBrowser.ipc.isBusy(key), `profile.exportArchive:${id}`)).toBe(true);
        expect(fs.existsSync(zipPath)).toBe(false);
        const waitingToasts = await h!.page.evaluate(() => (window as any).__syncAcceptanceObserved.toasts);
        expect(waitingToasts.some((toast: any) => /Still processing the backup operation/.test(toast.text))).toBe(true);
        expect(waitingToasts.some((toast: any) => /Export failed|timed out/.test(toast.text))).toBe(false);
        await screenshot(h!.page, "03-source-native-dialog-wait");
        await finishDialog({ canceled: false, filePath: zipPath });
        await expect.poll(() => fs.existsSync(zipPath), { timeout: 30_000 }).toBe(true);
        await expect.poll(() => h!.page.evaluate((key) => (window as any).agentBrowser.ipc.isBusy(key), `profile.exportArchive:${id}`), { timeout: 15_000 }).toBe(false);
        const successToasts = await h!.page.evaluate(() => (window as any).__syncAcceptanceObserved.toasts.filter((toast: any) => /Exported backup:/.test(toast.text)));
        expect(successToasts).toHaveLength(1);
        const zip = regularBytes(owned, zipPath);
        const entries = readZipEntries(zip);
        receipt!.observations.archiveSize = { bytes: zip.length, entries: entries.length, largest: [...entries].sort((left, right) => right.compressedSize - left.compressedSize).slice(0, 12).map((entry) => ({ name: entry.name, compressedBytes: entry.compressedSize, uncompressedBytes: entry.uncompressedSize })) };
        expect(zip.length).toBeLessThan(16 * 1024 * 1024);
        const zipFile = (name: string) => {
          const entry = entries.find((entry) => entry.name === name); expect(entry, name).toBeDefined(); return extractZipEntry(zip, entry!);
        };
        expect(zipFile(`Default/${SQLITE_NAME}`)).toEqual(sourceMain);
        expect(zipFile(`Default/${SQLITE_NAME}-wal`)).toEqual(sourceWal);
        expect(regularBytes(owned, sqlitePath + "-wal")).toEqual(sourceWal);
        const meta = JSON.parse(zipFile("meta.json").toString());
        expect(meta.profile).toMatchObject({ name: PROFILE_NAME, note: PROFILE_NOTE, platform: "macos" });
        expect(meta.profile).not.toHaveProperty("syncBaseline");
        const imported = await h!.page.evaluate((archivePath) => (window as any).agentBrowserAPI.profile.importArchive(archivePath), zipPath);
        assertSuccess(imported);
        expect(imported.outcome).toBe("completed");
        expect(imported.dirId).not.toBe(id);
        const restoredPath = profilePath(h!, imported.dirId, "Default", SQLITE_NAME);
        expect(regularBytes(owned, restoredPath)).toEqual(sourceMain);
        expect(regularBytes(owned, restoredPath + "-wal")).toEqual(sourceWal);
        const restored = new DatabaseSync(restoredPath, { readOnly: true });
        let integrity: any;
        try {
          integrity = restored.prepare("PRAGMA integrity_check").all();
          expect(integrity).toEqual([{ integrity_check: "ok" }]);
          expect(restored.prepare("SELECT id,label,payload FROM orders ORDER BY id").all()).toEqual(SQL_ROWS);
          expect(restored.prepare("SELECT id,label,payload FROM orders WHERE payload = ?").get(SQL_ROWS[1].payload)).toEqual(SQL_ROWS[1]);
        } finally { restored.close(); }
        assertSuccess(await h!.page.evaluate(() => (window as any).agentBrowserAPI.app.reloadConfig()));
        const reread = await h!.page.evaluate(async (profileId) => ({ get: await (window as any).agentBrowserAPI.profile.get(profileId), list: await (window as any).agentBrowserAPI.profile.list() }), imported.dirId);
        // The source still exists: production import intentionally resolves the
        // name collision, without changing archived metadata or source identity.
        expect(imported.name).toBe(PROFILE_NAME + " (2)");
        expect(reread.get).toMatchObject({ name: imported.name, syncStatus: "never", syncReason: "no-baseline" });
        expect(reread.list.filter((entry: any) => entry.dirId === imported.dirId)).toHaveLength(1);
        // profile.get returns ProfileInfo, not the full metadata record. Query
        // the actual metadata surface as well as stored bytes for note fidelity.
        const importedDetail = await request(source.port, source.token, "GET", `/api/profiles/${imported.dirId}`);
        expect(importedDetail).toMatchObject({ status: 200, body: { dirId: imported.dirId, name: imported.name, note: PROFILE_NOTE, syncStatus: "never", syncReason: "no-baseline" } });
        expect(configOf(h!).browserProfiles[imported.dirId]).toMatchObject({ name: imported.name, note: PROFILE_NOTE });
        expect(configOf(h!).browserProfiles[imported.dirId]).not.toHaveProperty("syncBaseline");
        receipt!.observations.backupProgress = { phase: "published-imported-queried", sourceId: id, importedId: imported.dirId, importedName: imported.name, mainSha256: sha256(sourceMain), walSha256: sha256(sourceWal), walBytes: sourceWal.length, zipSha256: sha256(zip), zipBytes: zip.length, integrity, exactRows: SQL_ROWS };
        const errorCount = (await h!.page.evaluate(() => (window as any).__syncAcceptanceObserved.toasts.filter((toast: any) => /toast-error/.test(toast.className)))).length;
        const zipNamesBefore = fs.readdirSync(backupDir).filter((name) => name.endsWith(".zip"));
        await clickProfileAction(id, "export-archive");
        await expect.poll(async () => (await dialogCalls()).length).toBe(2);
        const cancelledPath = path.join(backupDir, "cancelled-must-not-publish.zip");
        await finishDialog({ canceled: true, filePath: cancelledPath });
        await expect.poll(() => h!.page.evaluate((key) => (window as any).agentBrowser.ipc.isBusy(key), `profile.exportArchive:${id}`)).toBe(false);
        expect(fs.existsSync(cancelledPath)).toBe(false);
        expect(sha256(regularBytes(owned, zipPath))).toBe(sha256(zip));
        expect(fs.readdirSync(backupDir).filter((name) => name.endsWith(".zip"))).toEqual(zipNamesBefore);
        expect((await h!.page.evaluate(() => (window as any).__syncAcceptanceObserved.toasts.filter((toast: any) => /toast-error/.test(toast.className)))).length).toBe(errorCount);
        expect(await h!.page.evaluate(() => (window as any).__syncAcceptanceObserved.toasts.filter((toast: any) => /Exported backup:/.test(toast.text)).length)).toBe(1);
        receipt!.observations.backup = { sourceId: id, importedId: imported.dirId, mainSha256: sha256(sourceMain), walSha256: sha256(sourceWal), walBytes: sourceWal.length, zipSha256: sha256(zip), zipBytes: zip.length, integrity, exactRows: SQL_ROWS, dialogCalls: await dialogCalls(), lateCompletionCount: successToasts.length, cancelledAdditionalArchives: 0 };
        await restoreDialogs();
        sqlite.close(); sqlite = undefined;
      });

      // Run repeated launches after the bounded ZIP fixture, so unrelated
      // browser caches from these durability cycles do not inflate that archive.
      await phase("immediate write then real Studio stop and same-profile relaunch", async () => {
        const cycles: Array<Record<string, any>> = [];
        receipt!.observations.immediateStop = { cycles, noIntentionalSettleWait: true };
        for (let cycle = 1; cycle <= 4; cycle++) {
          const expected = cycle === 1 ? IMMEDIATE_STORAGE_VALUE : `${IMMEDIATE_STORAGE_VALUE}-${cycle}`;
          const previous = cycle === 1 ? null : cycles[cycle - 2].expected;
          const first = await launchStudioBrowser(id);
          await browserBusinessValues(first.page);
          expect(await first.page.evaluate((key) => localStorage.getItem(key), IMMEDIATE_STORAGE_KEY)).toBe(previous);
          // Arm before this round's write, never inside write/stop/restart.
          await armOwnedNativeExit(first, cycle);
          await first.page.locator("#immediate-input").fill(expected);
          await first.page.locator("#write-immediate-state").click();
          expect(await first.page.evaluate((key) => localStorage.getItem(key), IMMEDIATE_STORAGE_KEY)).toBe(expected);
          const readAt = Date.now();
          // No fixed settle wait, file wait, CDP flush, or feature switch here.
          await stopStudioBrowser();
          const stopReturnedAt = Date.now();
          const observation: Record<string, any> = { cycle, key: IMMEDIATE_STORAGE_KEY, previous, expected, pageReadAt: readAt, stopReturnedAt, noIntentionalSettleWait: true };
          cycles.push(observation);
          const defaultDir = profilePath(h!, id, "Default");
          if (cycle === 4) {
            // Separate observation arm: only AFTER stop/verified PID exit, copy
            // the bounded DB/WAL. Never open/checkpoint the browser's source DB.
            const group = captureStorageGroup(owned, defaultDir);
            const beforeRelaunch: Record<string, any> = { storageGroup: group };
            if (group.format === "sqlite") inspectOwnedSqliteStorage(owned, defaultDir, group, fixture!.origin, beforeRelaunch, { key: IMMEDIATE_STORAGE_KEY, value: expected, required: false });
            observation.beforeRelaunch = beforeRelaunch;
          } else {
            observation.beforeRelaunch = { state: "not-captured", reason: "Preserve the original immediate restart path: no disk sampling between stop and restart" };
          }
          const relaunched = await launchStudioBrowser(id);
          const actual = await relaunched.page.evaluate((key) => localStorage.getItem(key), IMMEDIATE_STORAGE_KEY);
          observation.actual = actual;
          await browserBusinessValues(relaunched.page);
          await stopStudioBrowser();
          const restartedGroup = captureStorageGroup(owned, defaultDir);
          const afterRelaunch: Record<string, any> = { storageGroup: restartedGroup };
          if (restartedGroup.format === "sqlite") inspectOwnedSqliteStorage(owned, defaultDir, restartedGroup, fixture!.origin, afterRelaunch, { key: IMMEDIATE_STORAGE_KEY, value: expected, required: false });
          observation.afterRelaunch = afterRelaunch;
          // The original restart/read and disk arm are already complete here.
          await collectOwnedNativeExits("after-relaunch", cycle);
          expect(actual, "A newly written real LocalStorage key must survive production Studio stop and relaunch").toBe(expected);
          if (cycle === 4 && observation.beforeRelaunch.storageGroup.format === "sqlite") expect(observation.beforeRelaunch.expectedRowFound, "The immediate write must already be durable before any restart can restore or overwrite it").toBe(true);
        }
      });

      await phase("second isolated receiver real UI Pull and disk/read/reload/list/DOM", async () => {
        expect(h!.pageErrors).toEqual([]);
        await closeApp(h!); h = undefined;
        const receiver = await launchOwnedApp("receiver", binary!, receiverUserData);
        expect((await h!.page.evaluate(() => (window as any).agentBrowserAPI.team.status())).team).toBeNull();
        await configureSync();
        expect(Object.keys(configOf(h!).browserProfiles)).toHaveLength(0);
        const diff = await compare();
        expect(diff.profiles.remoteOnly).toEqual([id]);
        expect(diff.extensions.remoteOnly).toEqual([extensionId]);
        await h!.page.locator("#sync-merge-strategy").selectOption("remote");
        const pulled = await clickSync("pull");
        expect(pulled).toMatchObject({ remoteCommit: "none" });
        expect(pulled.items).toEqual(expect.arrayContaining([
          expect.objectContaining({ scope: "cookies", id, state: "queued" }),
          expect.objectContaining({ scope: "localStorage", id, state: "applied" }),
          expect.objectContaining({ scope: "preferences", id, state: "applied" }),
          expect.objectContaining({ scope: "extensions", id: extensionId, state: "applied" }),
        ]));
        expect(pulled.items.some((item: any) => item.scope === "cookies" && item.state === "applied")).toBe(false);
        expect(await h!.page.locator("#sync-operation-result").innerText()).toMatch(/Queued|queued/);
        await screenshot(h!.page, "04-receiver-pull-queued-not-imported");
        expect(regularBytes(owned, profilePath(h!, id, "Default", "Preferences"))).toEqual(stoppedPreferences!);
        const queue = path.join(h!.userDataDir, "pending-cookie-imports", `${id}.json`);
        const queued = JSON.parse(regularBytes(owned, queue).toString());
        expect(queued.find((entry: any) => entry.name === COOKIE_NAME)).toMatchObject({ value: COOKIE_VALUE, domain: "127.0.0.1", path: "/" });
        const restoredStorageGroup = captureStorageGroup(owned, profilePath(h!, id, "Default"));
        expect(restoredStorageGroup, "Receiver must restore the exact published SQLite main/WAL or real legacy LevelDB file group before browser launch").toEqual(stoppedStorageGroup!);
        if (restoredStorageGroup.format === "sqlite") {
          const analysis = {};
          receipt!.observations.receiverSqliteAnalysis = analysis;
          inspectOwnedSqliteStorage(owned, profilePath(h!, id, "Default"), restoredStorageGroup, fixture!.origin, analysis);
        }
        const disk = configOf(h!);
        expect(Object.keys(disk.browserProfiles)).toEqual([id]);
        expect(disk.browserProfiles[id]).toMatchObject({ name: PROFILE_NAME, note: PROFILE_NOTE, platform: "macos", engine: "chromium", fingerprintMode: "managed", proxyName: PROXY_NAME, extensions: { [extensionId]: false } });
        expect(disk.proxies[PROXY_NAME]).toMatchObject({ type: "http", host: "127.0.0.1", port: fixture!.port });
        expect(disk.accounts.find((entry: any) => entry.platformUserName === ACCOUNT_NAME)).toMatchObject({ profileIds: [id], platformUrl: fixture!.origin });
        const repoEntry = disk.extensionRepository[extensionId];
        assertInside(h!.userDataDir, repoEntry.unpackedPath);
        expect(regularBytes(owned, path.join(repoEntry.unpackedPath, "background.js")).toString()).toBe(EXTENSION_JS);
        expect(readJson(path.join(repoEntry.unpackedPath, "manifest.json"))).toMatchObject({ name: "Acceptance local extension", version: "1.0.0" });
        const apiReadback = await h!.page.evaluate(async (profileId) => {
          const api = (window as any).agentBrowserAPI;
          return { proxy: await api.proxy.getProfile(profileId), accounts: await api.agent.accounts.forProfile(profileId), repository: await api.settings.extensionRepository() };
        }, id);
        expect(apiReadback.accounts.map((entry: any) => entry.platformUserName)).toEqual([ACCOUNT_NAME]);
        expect(apiReadback.repository.find((entry: any) => entry.id === extensionId)).toMatchObject({ name: "Acceptance local extension", version: "1.0.0" });
        await assertCleanReadback(id, receiver.port, receiver.token);
        await screenshot(h!.page, "05-receiver-clean-portable-scope");
        // Read the actual surface modules after Pull, without reloading scripts,
        // replacing bridge methods, or painting fixture markup into the DOM.
        await h!.page.locator('.nav-item[data-tab="accounts"]').click();
        await expect.poll(() => h!.page.locator("#accounts-tab-list").innerText(), { timeout: 15_000 }).toContain(ACCOUNT_NAME);
        await h!.page.locator('.nav-item[data-tab="proxy"]').click();
        await expect.poll(() => h!.page.locator("#tab-proxy").innerText(), { timeout: 15_000 }).toContain(PROXY_NAME);
        await h!.page.locator('.nav-item[data-tab="extensions"]').click();
        await expect.poll(() => h!.page.locator("#tab-extensions").innerText(), { timeout: 15_000 }).toContain("Acceptance local extension");
        await h!.page.locator('.nav-item[data-tab="sync"]').click();
        const afterDiff = await compare();
        expect(afterDiff.profiles.changed).toEqual([]);
        const receiverCookieObservation: Record<string, any> = {
          queueBefore: { state: "not-observed" }, queueAfter: { state: "not-observed" },
          launch: { cookieCheck: null, pid: null, cdpPort: null }, business: { state: "not-observed" },
          requests: fixture!.beginBusinessCookieObservation(),
        };
        receipt!.observations.receiverCookieObservation = receiverCookieObservation;
        const browser = await launchStudioBrowser(id, receiverCookieObservation);
        const business = await browserBusinessValues(browser.page, receiverCookieObservation);
        expect(fs.existsSync(queue)).toBe(false);
        await screenshot(browser.page, "06-receiver-real-browser-business-values");
        await stopStudioBrowser();
        receipt!.observations.receiver = { result: pulled, values: business, queuedCookieCount: queued.length, queueConsumedAfterRealLaunch: !fs.existsSync(queue), preferencesSha256: sha256(stoppedPreferences!), storageGroup: restoredStorageGroup, coverage: afterDiff.coverage, repositoryPackageHash: repoEntry.packageHash };

        // Preserve the first receiver receipt above: its Cookie queue really
        // was consumed by that member launch. A later full Pull may requeue it.
        const memberTeam = await h!.page.evaluate(() => (window as any).agentBrowserAPI.team.status());
        expect(memberTeam).toMatchObject({ success: true, enforcement: true, local: { deviceId: receiverIdentity.local.deviceId, role: "member" } });
        expect(memberTeam.team.members.find((member: any) => member.deviceId === receiverIdentity.local.deviceId)).toMatchObject({ role: "member" });
        const rosterOwnerId = memberTeam.team.ownerDeviceId;
        expect(rosterOwnerId).toBeTruthy();
        expect(rosterOwnerId).not.toBe(receiverIdentity.local.deviceId);
        const originalOwner = memberTeam.team.members.find((member: any) => member.deviceId === rosterOwnerId);
        expect(originalOwner).toMatchObject({ deviceId: rosterOwnerId, role: "owner" });
        expect(configOf(h!).team).toEqual(memberTeam.team);

        receipt!.phase = "source owner publishes viewer roster after receiver browser readback";
        await closeApp(h!); h = undefined;
        await launchOwnedApp("source", binary!, sourceUserData);
        const ownerBeforeRoleChange = await h!.page.evaluate(() => (window as any).agentBrowserAPI.team.status());
        expect(ownerBeforeRoleChange).toMatchObject({ success: true, enforcement: true, local: { deviceId: rosterOwnerId, role: "owner" } });
        expect(ownerBeforeRoleChange.team).toEqual(memberTeam.team);
        const roleChanged = await h!.page.evaluate((deviceId) => (window as any).agentBrowserAPI.team.setRole(deviceId, "viewer"), receiverIdentity.local.deviceId);
        assertSuccess(roleChanged);
        const viewerRoster = configOf(h!).team;
        expect(viewerRoster).toEqual(roleChanged.team);
        expect(viewerRoster.ownerDeviceId).toBe(rosterOwnerId);
        expect(viewerRoster.members.find((member: any) => member.deviceId === rosterOwnerId)).toEqual(originalOwner);
        expect(viewerRoster.members.find((member: any) => member.deviceId === receiverIdentity.local.deviceId)).toMatchObject({ role: "viewer" });
        expect(viewerRoster.updatedAt).toBeGreaterThanOrEqual(memberTeam.team.updatedAt);
        assertSuccess(await h!.page.evaluate(() => (window as any).agentBrowserAPI.app.reloadConfig()));
        const ownerAfterRoleChange = await h!.page.evaluate(() => (window as any).agentBrowserAPI.team.status());
        expect(ownerAfterRoleChange.local).toMatchObject({ deviceId: rosterOwnerId, role: "owner" });
        expect(ownerAfterRoleChange.team).toEqual(viewerRoster);
        await h!.page.locator('.nav-item[data-tab="sync"]').click();
        await compare();
        const rosterPush = await clickSync("push");
        expect(rosterPush).toMatchObject({ localCommit: "committed", remoteCommit: "committed" });
        // This is a new full snapshot, not a roster-only PATCH. Do not replace
        // stoppedPayload or compare B's old baseline against this publication.
        const rosterPayload = fixture!.config();
        expect(rosterPayload.snapshotId).toBe(rosterPush.operationId);
        expect(rosterPayload.snapshotId).not.toBe(stoppedPayload.snapshotId);
        const publishedRosterConfig = JSON.parse(zlib.gunzipSync(Buffer.from(rosterPayload.data, "base64")).toString("utf8"));
        expect(publishedRosterConfig.team).toEqual(viewerRoster);
        expect(configOf(h!).browserProfiles[id].syncBaseline.snapshotId).toBe(rosterPayload.snapshotId);
        receipt!.observations.viewerRosterPublication = { ownerDeviceId: rosterOwnerId, receiverDeviceId: receiverIdentity.local.deviceId, roleUpdateApi: "team.setRole", publishedRole: "viewer", push: rosterPush, snapshotId: rosterPayload.snapshotId };

        receipt!.phase = "receiver member Pull adopts viewer roster before launch and write refusals";
        await closeApp(h!); h = undefined;
        const viewerReceiver = await launchOwnedApp("receiver", binary!, receiverUserData);
        const memberBeforePull = await h!.page.evaluate(() => (window as any).agentBrowserAPI.team.status());
        expect(memberBeforePull).toMatchObject({ success: true, enforcement: true, local: { deviceId: receiverIdentity.local.deviceId, role: "member" } });
        expect(memberBeforePull.team).toEqual(memberTeam.team);
        expect(configOf(h!).team).toEqual(memberTeam.team);
        // Keep the existing sync configuration; this Pull is authorized while B
        // is still member and only its final config commit adopts viewer.
        await h!.page.locator('.nav-item[data-tab="sync"]').click();
        await compare();
        await h!.page.locator("#sync-merge-strategy").selectOption("remote");
        const rosterPull = await clickSync("pull");
        expect(rosterPull).toMatchObject({ remoteCommit: "none" });
        expect(rosterPull.items).toEqual(expect.arrayContaining([
          expect.objectContaining({ scope: "cookies", id, state: "queued" }),
          expect.objectContaining({ scope: "localStorage", id, state: "applied" }),
          expect.objectContaining({ scope: "preferences", id, state: "applied" }),
        ]));
        expect(configOf(h!).team).toEqual(publishedRosterConfig.team);
        await assertCleanReadback(id, viewerReceiver.port, viewerReceiver.token);
        const team = await h!.page.evaluate(() => (window as any).agentBrowserAPI.team.status());
        expect(team).toMatchObject({ success: true, enforcement: true, local: { deviceId: receiverIdentity.local.deviceId, role: "viewer" } });
        expect(team.team).toEqual(viewerRoster);
        expect(team.team.ownerDeviceId).toBe(rosterOwnerId);
        expect(team.team.members.find((member: any) => member.deviceId === rosterOwnerId)).toEqual(originalOwner);
        expect(team.team.members.find((member: any) => member.deviceId === receiverIdentity.local.deviceId)).toMatchObject({ role: "viewer" });
        const beforeViewer = regularBytes(owned, path.join(h!.userDataDir, "config.json"));
        const remoteBefore = fixture!.objects.get(CONFIG_KEY)!;
        const requeuedCookies = regularBytes(owned, queue);
        expect(JSON.parse(requeuedCookies.toString()).find((entry: any) => entry.name === COOKIE_NAME)).toMatchObject({ value: COOKIE_VALUE });
        const launchLogPath = path.join(h!.userDataDir, "logs", `browser-${id}.log`);
        const launchLogBefore = regularBytes(owned, launchLogPath);
        expect(await h!.page.evaluate((profileId) => (window as any).agentBrowserAPI.browser.status(profileId), id)).toMatchObject({ running: false });
        expect(ownedProcessesRemain(profilePath(h!, id))).toBe(false);
        // Use the original launch IPC, not the helper that asserts success.
        const deniedLaunch = await h!.page.evaluate((profileId) => (window as any).agentBrowserAPI.browser.launch(profileId), id);
        expect(deniedLaunch).toMatchObject({ success: false, code: "TEAM_ROLE_DENIED" });
        expect(deniedLaunch).not.toHaveProperty("pid");
        expect(deniedLaunch).not.toHaveProperty("cdpPort");
        expect(await h!.page.evaluate((profileId) => (window as any).agentBrowserAPI.browser.status(profileId), id)).toMatchObject({ running: false });
        expect(ownedProcessesRemain(profilePath(h!, id))).toBe(false);
        expect(regularBytes(owned, launchLogPath)).toEqual(launchLogBefore);
        expect(regularBytes(owned, queue)).toEqual(requeuedCookies);
        const viewerStatuses: Record<string, number> = {};
        for (const route of ["/api/sync/push", "/api/sync/pull"]) {
          const denied = await request(viewerReceiver.port, viewerReceiver.token, "POST", route, {});
          expect(denied.status, JSON.stringify(denied.body)).toBe(403);
          expect(await jsSdkError(viewerReceiver.port, viewerReceiver.token, route, {})).toEqual(denied);
          expect(await pythonSdkRequest(viewerReceiver.port, viewerReceiver.token, "POST", route, {})).toMatchObject({ ...denied, bodyTruncated: false });
          viewerStatuses[route] = denied.status;
        }
        expect((await request(viewerReceiver.port, viewerReceiver.token, "GET", "/api/sync/status")).status).toBe(200);
        expect(regularBytes(owned, path.join(h!.userDataDir, "config.json"))).toEqual(beforeViewer);
        expect(fixture!.objects.get(CONFIG_KEY)).toEqual(remoteBefore);
        receipt!.observations.viewer = { productionTeamApiSetup: true, ownerDeviceId: rosterOwnerId, pull: rosterPull, adoptedSnapshotId: rosterPayload.snapshotId, launch: deniedLaunch, nativeProfileProcessesBeforeAndAfter: 0, launchLogUnchanged: true, requeuedCookiesUnchanged: true, restPort: viewerReceiver.port, statuses: viewerStatuses, protectedRead: 200, configUnchanged: true, remoteUnchanged: true };
        expect(fixture!.config().snapshotId).toBe(rosterPayload.snapshotId);
        expect(fixture!.failures).toEqual([]);
        expect(h!.pageErrors).toEqual([]);
      });
      await phase("completed sync rescue history survives ZIP import and later real Push", async () => {
        await closeApp(h!); h = undefined;
        const reopened = await launchOwnedApp("source", binary!, sourceUserData);
        expect((await h!.page.evaluate(() => (window as any).agentBrowserAPI.team.status())).local.role).toBe("owner");
        await configureSync();
        await compare();
        await h!.page.locator("#sync-merge-strategy").selectOption("remote");
        const pulled = await clickSync("pull");
        expect(pulled.items).toEqual(expect.arrayContaining([expect.objectContaining({ scope: "localStorage", id, state: "applied" })]));
        const defaultDir = profilePath(h!, id, "Default");
        const historyNames = fs.readdirSync(defaultDir).filter((name) => name.startsWith(".sqlite-localstorage-backup-")).sort();
        expect(historyNames, "A successful replacement of the existing real SQLite group must retain its old bytes").toHaveLength(1);
        const histories = historyNames.map((name) => ({ name, entries: recoveryTree(owned, path.join(defaultDir, name)) }));
        const backups = fs.mkdtempSync(path.join(h!.userDataDir, "acceptance-history-backup-"));
        const zipPath = path.join(backups, "completed-history.zip");
        const exported = await h!.page.evaluate(({ profileId, destination }) => (window as any).agentBrowserAPI.profile.exportArchive(profileId, destination), { profileId: id, destination: zipPath });
        assertSuccess(exported);
        const zipHash = sha256(regularBytes(owned, zipPath));
        const imported = await h!.page.evaluate((input) => (window as any).agentBrowserAPI.profile.importArchive(input), zipPath);
        assertSuccess(imported);
        expect(imported.dirId).not.toBe(id);
        expect(imported.warnings.join(" ")).toMatch(/recovery|history|historical|retained/i);
        for (const history of histories) {
          const inert = profilePath(h!, imported.dirId, ".profile-archive-recovery", id, "Default", history.name);
          expect(recoveryTree(owned, inert)).toEqual(history.entries);
          expect(fs.existsSync(profilePath(h!, imported.dirId, "Default", history.name))).toBe(false);
          expect(recoveryTree(owned, path.join(defaultDir, history.name))).toEqual(history.entries);
        }
        expect(sha256(regularBytes(owned, zipPath))).toBe(zipHash);
        assertSuccess(await h!.page.evaluate(() => (window as any).agentBrowserAPI.app.reloadConfig()));
        const importedBeforePush = await request(reopened.port, reopened.token, "GET", `/api/profiles/${imported.dirId}`);
        expect(importedBeforePush).toMatchObject({ status: 200, body: { name: imported.name, note: PROFILE_NOTE, syncStatus: "never" } });
        await h!.page.locator('.nav-item[data-tab="sync"]').click();
        await compare();
        const pushed = await clickSync("push");
        expect(pushed).toMatchObject({ success: true, localCommit: "committed", remoteCommit: "committed" });
        expect(pushed.code).not.toBe("LOCAL_STORAGE_RECOVERY_REQUIRED");
        const published = fixture!.config();
        expect(published.snapshotId).toBe(pushed.operationId);
        expect(published.artifactSources.localStorage[imported.dirId]).toBe("captured");
        const publishedMeta = JSON.parse(zlib.gunzipSync(Buffer.from(published.data, "base64")).toString());
        expect(publishedMeta.browserProfiles[imported.dirId]).toMatchObject({ name: imported.name, note: PROFILE_NOTE, syncBaseline: { version: 1, snapshotId: pushed.operationId } });
        assertSuccess(await h!.page.evaluate(() => (window as any).agentBrowserAPI.app.reloadConfig()));
        expect((await request(reopened.port, reopened.token, "GET", `/api/profiles/${imported.dirId}`)).body).toMatchObject({ syncStatus: "synced", syncReason: "baseline-match" });
        for (const history of histories) {
          expect(recoveryTree(owned, path.join(defaultDir, history.name))).toEqual(history.entries);
          expect(recoveryTree(owned, profilePath(h!, imported.dirId, ".profile-archive-recovery", id, "Default", history.name))).toEqual(history.entries);
        }
        receipt!.observations.archivedRecovery = { sourceId: id, importedId: imported.dirId, importedName: imported.name, warnings: imported.warnings, zipSha256: zipHash, histories, originalAndImportedRescueBytesUnchanged: true, push: pushed, publishedSnapshotId: published.snapshotId, importedLocalStorageCaptured: true };
        await screenshot(h!.page, "07-archived-recovery-remains-synchronizable");
        expect(h!.pageErrors).toEqual([]);
        expect(fixture!.failures).toEqual([]);
      });
      receipt.status = "passed";
      receipt.phase = "completed";
    } catch (error) {
      receipt.status = "failed";
      receipt.error = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 6000) : String(error).slice(0, 6000);
      await collectOwnedNativeExits("failure");
      retainStoppedNativeStorage();
      if (h && !h.page.isClosed()) {
        try {
          receipt.observations.failureRenderer = await h.page.evaluate((profileId) => ({
            toasts: ((window as any).__syncAcceptanceObserved?.toasts || []).slice(-12).map((entry: any) => ({ className: entry.className, text: String(entry.text).slice(0, 1200) })),
            archiveBusy: profileId ? (window as any).agentBrowser.ipc.isBusy(`profile.exportArchive:${profileId}`) : null,
          }), receipt.observations.profileId);
        } catch (diagnosticError) { receipt.observations.failureRendererUnavailable = String(diagnosticError).slice(0, 300); }
        try { await screenshot(h.page, "failure-current-owned-app"); }
        catch (captureError) { receipt.cleanup.push("Failure screenshot unavailable: " + String(captureError).slice(0, 300)); }
      }
      throw error;
    }
  }, 360_000);

  afterAll(async () => {
    const errors: string[] = [];
    try { await restoreDialogs(); } catch (error) { errors.push("Dialog restore: " + String(error)); }
    try { await stopStudioBrowser(); } catch (error) { errors.push("Normal browser stop: " + String(error)); }
    try { sqlite?.close(); sqlite = undefined; } catch (error) { errors.push("Owned SQLite close: " + String(error)); }
    if (h) {
      try { await closeApp(h); h = undefined; } catch (error) { errors.push("Owned Electron close: " + String(error)); }
    }
    // setupTestApp can throw after Electron starts but before returning a
    // handle. Even that failure is scoped to our registered owned userData.
    for (const userDataDir of ownedUserData) {
      try {
        if (ownedProcessesRemain(userDataDir)) {
          const pattern = userDataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          try { execFileSync("pkill", ["-9", "-f", pattern], { stdio: "pipe" }); }
          catch (error: any) { if (error.status !== 1) throw new Error("Owned fallback process stop failed"); }
          await waitForOwnedCondition("Exclusive userData processes exited", () => !ownedProcessesRemain(userDataDir), 10_000);
        }
      } catch (error) { errors.push("Exclusive userData process cleanup: " + String(error)); }
    }
    if (fixture) {
      const closing = fixture;
      if (receipt) receipt.observations.s3Journal = closing.journal;
      try {
        await closing.close();
        if (closing.failures.length) throw new Error(closing.failures.join("\n"));
        fixture = undefined;
      } catch (error) { errors.push("Loopback fixture close: " + String(error)); }
      if (receipt) receipt.observations.fixtureNetwork = { deniedConnectResetProbeExercised: true, rejectedTunnelErrors: closing.rejectedTunnelErrors, unexpectedFailures: closing.failures };
    }
    if (owned && receipt) {
      receipt.cleanup.push(...errors);
      receipt.finishedAt = new Date().toISOString();
      if (errors.length) receipt.status = "cleanup-failed";
      // Retain screenshots/receipt, two bounded stopped SQLite failure copies
      // or one final copy after the entire successful chain and process cleanup.
      // Never retain userData, credentials, Cookie DBs, caches or archives.
      // All removed entries are direct children of OUR exclusive mkdtemp root.
      if (!errors.length) {
        if (receipt.status === "passed") retainStoppedNativeStorage("final");
        for (const entry of fs.readdirSync(owned)) {
          if (entry.endsWith(".png") || retainedStorageArtifacts.has(entry)) continue;
          const candidate = path.join(owned, entry);
          assertInside(owned, candidate);
          fs.rmSync(candidate, { recursive: true, force: true });
        }
        receipt.cleanup.push("Owned bulky app/browser/fixture data removed; supplied parent root preserved");
      }
      const json = JSON.stringify(receipt, null, 2) + "\n";
      if (Buffer.byteLength(json) > 128 * 1024) throw new Error("Acceptance receipt exceeds bounded evidence budget");
      fs.writeFileSync(path.join(owned, "receipt.json"), json, { flag: "wx" });
      console.log(`SYNC_STATE_ACCEPTANCE_RECEIPT=${path.join(owned, "receipt.json")}`);
    }
    if (errors.length) throw new Error(errors.join("\n"));
  }, 90_000);
});
