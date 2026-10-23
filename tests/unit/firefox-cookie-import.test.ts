// Real loopback BiDi framing and private synthetic queue files only. No browser,
// process discovery, real profile, secret store or business endpoint is used.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import type { CookieInfo } from "../../src/main/types.js";

const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), "abs-firefox-cookie-import-")), port: 0, status: vi.fn(), failUnlink: false,
    opens: [] as Parameters<typeof fs.openSync>[], renames: [] as Parameters<typeof fs.renameSync>[] };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => { fixture.opens.push(args); return actual.openSync(...args); },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => { fixture.renames.push(args); return actual.renameSync(...args); },
    unlinkSync: (target: fs.PathLike) => {
      if (fixture.failUnlink && String(target) === path.join(fixture.root, "pending-cookie-imports", "ff_synthetic_cookie_import.json")) {
        throw Object.assign(new Error("synthetic-unlink-denied"), { code: "EACCES" });
      }
      return actual.unlinkSync(target);
    },
  };
});
vi.mock("../../src/main/services/config-manager.js", () => ({
  getAppDataDir: () => fixture.root, getProfilesDir: () => path.join(fixture.root, "profiles"),
}));
vi.mock("../../src/main/services/page-eval.js", () => ({ getProfileEngineByDirId: () => "firefox" }));
vi.mock("../../src/main/services/browser-manager.js", () => ({ statusBrowser: fixture.status }));
vi.mock("../../src/main/services/process-discovery.js", () => ({ findCdpPortSync: () => null }));

import { connectBidi, registerFirefoxSession, dropFirefoxSession, getRegisteredFirefoxSession, type BidiConnection } from "../../src/main/services/bidi-client.js";
import { firefoxCookieService } from "../../src/main/services/bidi-cookie-service.js";
import * as queue from "../../src/main/services/cdp-cookie-service.js";
import { runningProcesses, type RunningEntry } from "../../src/main/services/browser/runtime-table.js";
import { runWithProtocolDispatchGuard } from "../../src/main/services/agent/dispatch-guard.js";

const ID = "ff_synthetic_cookie_import";
const COOKIE: CookieInfo = { domain: "example.test", name: "sid", value: "synthetic-session-value", path: "/", expires: null, secure: true, httpOnly: true, sameSite: 1 };
const SECOND = { ...COOKIE, name: "theme", value: "synthetic-theme-value" };
const file = path.join(fixture.root, "pending-cookie-imports", `${ID}.json`);
type Request = { id: number; method: string; params: any };
let server: WebSocketServer;
let active: WebSocket | null;
let clients: BidiConnection[];
let calls: Request[];
let jar: Map<string, any>;
let onSet: ((socket: WebSocket, request: Request) => void) | undefined;

function reply(socket: WebSocket, id: number, result: unknown): void { socket.send(JSON.stringify({ type: "success", id, result })); }
function stored(socket: WebSocket, request: Request): void {
  jar.set(request.params.cookie.name, request.params.cookie);
  reply(socket, request.id, { partitionKey: { userContext: "default" } });
}
async function owned(): Promise<{ conn: BidiConnection; entry: RunningEntry }> {
  const conn = await connectBidi(`ws://127.0.0.1:${fixture.port}/session`, { timeoutMs: 500 });
  clients.push(conn); registerFirefoxSession(fixture.port, conn);
  const child = { pid: 710001, exitCode: null, signalCode: null, killed: false };
  const entry: RunningEntry = { pid: child.pid, process: child, port: fixture.port, lastActivityAt: 0, engine: "firefox", bidiConn: conn };
  runningProcesses.set(ID, entry);
  return { conn, entry };
}
function queued(cookies = [COOKIE]): Buffer {
  const opensBefore = fixture.opens.length, renamesBefore = fixture.renames.length;
  queue.writeQueuedCookieImports(ID, cookies);
  const staged = fixture.opens.slice(opensBefore).filter(([candidate]) =>
    typeof candidate === "string" && candidate.startsWith(file + ".") && candidate.endsWith(".tmp"));
  expect(staged).toHaveLength(1);
  expect(staged[0]).toEqual([expect.any(String), "wx", 0o600]);
  expect(fixture.renames.slice(renamesBefore)).toEqual([[staged[0][0], file]]);
  const bytes = fs.readFileSync(file);
  expect(JSON.parse(bytes.toString("utf8"))).toEqual(cookies);
  const stat = fs.lstatSync(file);
  expect(stat.isFile()).toBe(true); expect(stat.isSymbolicLink()).toBe(false); expect(stat.nlink).toBe(1);
  // Native Windows stat bits do not establish POSIX permissions or ACL privacy.
  if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
  expect(queue.readQueuedCookieImports(ID, { strict: true })).toEqual(cookies);
  return bytes;
}
async function reloaded(cookies: CookieInfo[]): Promise<void> {
  vi.resetModules();
  const fresh = await import("../../src/main/services/cdp-cookie-service.js");
  expect(fresh.readQueuedCookieImports(ID, { strict: true })).toEqual(cookies);
  expect(fs.readdirSync(path.dirname(file)).includes(`${ID}.json`)).toBe(cookies.length > 0);
}
function writes(): Request[] { return calls.filter(({ method }) => method === "storage.setCookie"); }
async function reusable(conn: BidiConnection): Promise<void> {
  expect(conn.closed).toBe(false);
  expect(getRegisteredFirefoxSession(fixture.port)).toBe(conn);
  expect(await conn.send("browsingContext.getTree", {}, 500)).toEqual({ contexts: [{ context: "synthetic-context" }] });
}
async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("synthetic operation failed to settle promptly")), 500); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function apply(target?: { port: number; isCurrent: () => boolean }, signal?: AbortSignal): Promise<number> {
  // Keep RED executable against the old one-argument public method.
  return (firefoxCookieService.applyQueuedImports as any)(ID, target, signal);
}

beforeEach(async () => {
  calls = []; jar = new Map(); clients = []; active = null; onSet = undefined; fixture.failUnlink = false;
  fixture.opens.length = 0; fixture.renames.length = 0;
  runningProcesses.clear(); fixture.status.mockReset().mockImplementation(() => ({ running: true, cdpPort: fixture.port }));
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/session" });
  server.on("connection", (socket) => {
    socket.on("close", () => { if (active === socket) active = null; });
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString()) as Request;
      calls.push(request);
      if (request.method === "session.new") {
        if (active && active !== socket) {
          socket.send(JSON.stringify({ type: "error", id: request.id, error: "session not created", message: "A BiDi session is already active" }));
        } else { active = socket; reply(socket, request.id, { sessionId: "synthetic-session", capabilities: {} }); }
      } else if (request.method === "storage.setCookie") {
        if (onSet) onSet(socket, request); else stored(socket, request);
      } else if (request.method === "storage.getCookies") {
        const name = request.params?.filter?.name;
        reply(socket, request.id, { cookies: [...jar.values()].filter((cookie) => !name || cookie.name === name), partitionKey: { userContext: "default" } });
      } else if (request.method === "browsingContext.getTree") reply(socket, request.id, { contexts: [{ context: "synthetic-context" }] });
      else socket.send(JSON.stringify({ type: "error", id: request.id, error: "unknown command", message: "synthetic unsupported command" }));
    });
  });
  await once(server, "listening"); fixture.port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  dropFirefoxSession(fixture.port); runningProcesses.clear();
  for (const conn of clients) conn.close();
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  vi.restoreAllMocks();
});
afterAll(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

describe("Firefox imports borrow only the owned matching BiDi session", () => {
  it("proves the fixture rejects a second session.new while the launched session remains usable", async () => {
    const { conn } = await owned();
    await expect(connectBidi(conn.wsUrl, { timeoutMs: 500 })).rejects.toThrow(/session not created.*already active/);
    await reusable(conn);
  });

  it("accepts the real partitionKey success, writes and reads back values, without opening or closing a second session", async () => {
    const { conn } = await owned();
    expect(await firefoxCookieService.importCookies(ID, [COOKIE, SECOND])).toBe(2);
    expect(calls.filter(({ method }) => method === "session.new")).toHaveLength(1);
    expect(writes().map(({ params }) => params.cookie.name)).toEqual([COOKIE.name, SECOND.name]);
    expect(jar.get(COOKIE.name).value).toEqual({ type: "string", value: COOKIE.value });
    expect((await conn.send("storage.getCookies", { filter: { name: COOKIE.name } }, 500)).cookies).toEqual([jar.get(COOKIE.name)]);
    expect(fixture.status).not.toHaveBeenCalled();
    await reusable(conn);
  });

  it.each(["untracked", "adopted", "unregistered", "different-connection", "foreign-url", "wrong-engine", "wrong-port"] as const)(
    "does not adopt or connect to an unknown endpoint when the owner is %s", async (change) => {
      const { conn, entry } = await owned();
      if (change === "untracked") runningProcesses.delete(ID);
      if (change === "adopted") entry.process = null;
      if (change === "unregistered") dropFirefoxSession(fixture.port);
      if (change === "different-connection") registerFirefoxSession(fixture.port, { ...conn });
      if (change === "foreign-url") conn.wsUrl = "ws://unowned.example.test:9123/session";
      if (change === "wrong-engine") entry.engine = "chromium";
      if (change === "wrong-port") entry.port++;
      const before = calls.length;
      await expect(firefoxCookieService.importCookies(ID, [COOKIE])).rejects.toThrow();
      expect(calls).toHaveLength(before); expect(fixture.status).not.toHaveBeenCalled(); expect(conn.closed).toBe(false);
    },
  );

  it("rejects a pinned port mismatch before any command", async () => {
    const { conn } = await owned(); const bytes = queued(); const before = calls.length;
    await expect(apply({ port: fixture.port + 1, isCurrent: () => true })).rejects.toThrow();
    expect(calls).toHaveLength(before); expect(fs.readFileSync(file)).toEqual(bytes); await reusable(conn);
  });

  it("reports an unavailable connection instead of returning zero and retains the pending queue", async () => {
    const { conn } = await owned(); const bytes = queued(); conn.close();
    await expect(apply()).rejects.toThrow();
    expect(writes()).toEqual([]); expect(fs.readFileSync(file)).toEqual(bytes); await reloaded([COOKIE]);
  });
});

describe("Firefox strict queued imports and generation-pinned completion", () => {
  it("rejects a partial import, preserves the full original queue, then clears it only after a complete confirmed retry", async () => {
    const { conn } = await owned(); const bytes = queued([COOKIE, SECOND]);
    onSet = (socket, request) => {
      if (request.params.cookie.name === SECOND.name) socket.send(JSON.stringify({ type: "error", id: request.id, error: "invalid argument", message: "synthetic-cookie-canary" }));
      else stored(socket, request);
    };
    await expect(apply()).rejects.toThrow(/1\/2/);
    expect(fs.readFileSync(file)).toEqual(bytes); expect(queue.readQueuedCookieImports(ID, { strict: true })).toEqual([COOKIE, SECOND]);
    expect([...jar.keys()]).toEqual([COOKIE.name]); await reusable(conn);
    onSet = undefined;
    expect(await apply()).toBe(2);
    expect(fs.existsSync(file)).toBe(false); expect([...jar.keys()]).toEqual([COOKIE.name, SECOND.name]);
    expect((await conn.send("storage.getCookies", { filter: { name: SECOND.name } }, 500)).cookies[0].value.value).toBe(SECOND.value);
    expect(calls.filter(({ method }) => method === "session.new")).toHaveLength(1);
    await reusable(conn); await reloaded([]);
  });

  it("does not count a CDP-shaped success:true as a BiDi cookie write", async () => {
    const { conn } = await owned(); const bytes = queued();
    onSet = (socket, request) => reply(socket, request.id, { success: true });
    await expect(apply()).rejects.toThrow(/0\/1/);
    expect(jar.size).toBe(0); expect(fs.readFileSync(file)).toEqual(bytes); await reusable(conn);
  });

  it.each(["json", "shape", "invalid-cookie", "directory"] as const)("fails explicitly for a damaged %s queue without protocol work", async (kind) => {
    queued();
    const raw = kind === "json" ? "{synthetic-broken-json" : kind === "shape" ? JSON.stringify({ cookies: [COOKIE] }) : JSON.stringify([COOKIE, { ...SECOND, value: 17 }]);
    if (kind === "directory") { fs.rmSync(file); fs.mkdirSync(file); }
    else fs.writeFileSync(file, raw);
    await expect(apply()).rejects.toThrow(/^COOKIE_QUEUE_UNREADABLE$/);
    expect(calls).toEqual([]); expect(fixture.status).not.toHaveBeenCalled();
    if (kind === "directory") expect(fs.lstatSync(file).isDirectory()).toBe(true);
    else expect(fs.readFileSync(file, "utf8")).toBe(raw);
    expect(() => queue.readQueuedCookieImports(ID, { strict: true })).toThrow(/^COOKIE_QUEUE_UNREADABLE$/);
  });

  it.each(["different-bytes", "same-bytes"] as const)("does not clear a replacement queue with %s after completing an older import", async (kind) => {
    const { conn } = await owned(); queued(); const originalInode = fs.statSync(file).ino;
    let release!: () => void;
    onSet = (socket, request) => { release = () => stored(socket, request); };
    const pending = apply().then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const replacement = kind === "same-bytes" ? [COOKIE] : [SECOND];
    const bytes = queued(replacement);
    expect(fs.statSync(file).ino).not.toBe(originalInode);
    release();
    expect((await bounded(pending)).error).toMatchObject({ message: "COOKIE_QUEUE_CHANGED" });
    expect(writes()).toHaveLength(1); expect(jar.has(COOKIE.name)).toBe(true);
    expect(fs.readFileSync(file)).toEqual(bytes); await reusable(conn); await reloaded(replacement);
  });

  it("does not clear an in-place corrupted queue after the original native write completes", async () => {
    const { conn } = await owned(); queued(); let release!: () => void;
    onSet = (socket, request) => { release = () => stored(socket, request); };
    const pending = apply().then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const corrupted = JSON.stringify([COOKIE, null]); fs.writeFileSync(file, corrupted);
    release(); expect((await bounded(pending)).error).toMatchObject({ message: "COOKIE_QUEUE_UNREADABLE" });
    expect(fs.readFileSync(file, "utf8")).toBe(corrupted); await reusable(conn);
  });

  it("retains a queue when its compare-and-clear unlink fails instead of reporting completion", async () => {
    const { conn } = await owned(); const bytes = queued();
    fixture.failUnlink = true;
    await expect(apply()).rejects.toThrow(/^COOKIE_QUEUE_UNREADABLE$/);
    expect(fs.readFileSync(file)).toEqual(bytes); await reusable(conn);
  });
});

describe("Firefox caller cancellation and replacement guards never close a borrowed session", () => {
  it("rejects pre-cancellation before any import or discovery and preserves queue bytes", async () => {
    const { conn } = await owned(); const bytes = queued(); const before = calls.length;
    const controller = new AbortController(); controller.abort(new Error("synthetic caller cancellation"));
    await expect(apply(undefined, controller.signal)).rejects.toThrow(/cancelled/i);
    expect(calls).toHaveLength(before); expect(fs.readFileSync(file)).toEqual(bytes); await reusable(conn);
  });

  it("cancels an in-flight write promptly, suppresses following writes, retains queue and ignores the late reply", async () => {
    const { conn } = await owned(); const bytes = queued([COOKIE, SECOND]); let release!: () => void;
    onSet = (socket, request) => { release = () => stored(socket, request); };
    const controller = new AbortController();
    const pending = apply(undefined, controller.signal).then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function")); controller.abort(new Error("synthetic caller cancellation"));
    try {
      expect((await bounded(pending)).error).toBeInstanceOf(Error);
      expect(writes()).toHaveLength(1); expect(fs.readFileSync(file)).toEqual(bytes); await reusable(conn);
    } finally { release(); await bounded(pending); }
    await reusable(conn); expect(writes()).toHaveLength(1);
  });

  it.each(["owner", "registered-session", "target", "stopping", "child-exit"] as const)("rejects %s replacement during a held write without clearing or closing", async (change) => {
    const { conn, entry } = await owned(); const bytes = queued([COOKIE, SECOND]); let release!: () => void; let current = true;
    onSet = (socket, request) => { release = () => stored(socket, request); };
    const pending = apply({ port: fixture.port, isCurrent: () => current }).then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    if (change === "owner") runningProcesses.set(ID, { ...entry, process: { ...entry.process } });
    if (change === "registered-session") registerFirefoxSession(fixture.port, { ...conn });
    if (change === "target") current = false;
    if (change === "stopping") entry.stopping = true;
    if (change === "child-exit") entry.process.exitCode = 0;
    try {
      expect((await bounded(pending)).error).toBeInstanceOf(Error);
      expect(writes()).toHaveLength(1); expect(fs.readFileSync(file)).toEqual(bytes); expect(conn.closed).toBe(false);
    } finally { release(); await bounded(pending); }
    registerFirefoxSession(fixture.port, conn); await reusable(conn); await reloaded([COOKIE, SECOND]);
  });

  it("preserves an outer per-call dispatch guard while adding its own ownership guard", async () => {
    const { conn } = await owned(); const bytes = queued(); let release!: () => void; let allowed = true;
    onSet = (socket, request) => { release = () => stored(socket, request); };
    const operation = runWithProtocolDispatchGuard((port) => {
      expect(port).toBe(fixture.port); if (!allowed) throw new Error("synthetic outer guard revoked");
    }, () => apply());
    const pending = operation.then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function")); allowed = false;
    try { expect((await bounded(pending)).error).toMatchObject({ message: "synthetic outer guard revoked" }); }
    finally { release(); await bounded(pending); }
    expect(fs.readFileSync(file)).toEqual(bytes); await reusable(conn);
  });
});
