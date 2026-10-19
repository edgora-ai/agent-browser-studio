import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import {
  cdpConnect, cdpDisconnect, cdpNavigate, cdpSendRaw, cdpWaitForLoad, type CdpClient,
} from "../../src/main/services/agent/cdp-transport.js";
import { runWithProtocolDispatchGuard } from "../../src/main/services/agent/dispatch-guard.js";

type Command = { id: number; method: string; params?: any; sessionId?: string };
type Frame = { id: string; loaderId: string; parentId?: string };
const ROOT = "actual-root-frame";
const TARGET = "target-is-not-frame";
const INITIAL = "initial-loader";
const URL = "https://navigation.fixture.test/page?private=not-retained";
const closers: Array<() => Promise<void>> = [];

/** Real transport, synthetic wire only: no browser, DNS, page code, or external site. */
async function wire() {
  const calls: Command[] = [];
  const sockets = new Set<WebSocket>();
  const clients: CdpClient[] = [];
  let port = 0;
  let frame: Frame = { id: ROOT, loaderId: INITIAL };
  let readyState = "loading";
  let navigate: (call: Command, socket: WebSocket) => void = (call, socket) => {
    frame = { id: ROOT, loaderId: `loader-${call.id}` };
    reply(socket, call, { frameId: ROOT, loaderId: frame.loaderId });
  };
  let beforeReply: ((call: Command, socket: WebSocket) => boolean | void) | undefined;
  const unexpected: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.url !== "/json") { unexpected.push(`HTTP ${req.url}`); res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify([{ type: "page", id: TARGET, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/page` }]));
  });
  const wss = new WebSocketServer({ server });
  function reply(socket: WebSocket, call: Command, result: any) {
    socket.send(JSON.stringify({ id: call.id, result }));
  }
  function event(socket: WebSocket, method: string, params: any, sessionId?: string) {
    socket.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  }
  wss.on("connection", (socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("message", (bytes) => {
      const call = JSON.parse(bytes.toString()) as Command;
      calls.push(call);
      if (beforeReply?.(call, socket)) return;
      switch (call.method) {
        case "Page.enable": case "Runtime.enable": case "Network.enable": case "DOM.enable":
        case "Input.enable": case "Emulation.enable": case "Page.setLifecycleEventsEnabled": reply(socket, call, {}); break;
        case "Page.getFrameTree": reply(socket, call, { frameTree: { frame } }); break;
        case "Page.createIsolatedWorld":
          if (call.params?.frameId !== ROOT) unexpected.push("isolated world not bound to root frame");
          reply(socket, call, { executionContextId: 917 }); break;
        case "Runtime.evaluate":
          if (call.params?.expression === "document.readyState" && call.params.contextId !== 917) unexpected.push("unbound readiness evaluation");
          reply(socket, call, { result: { value: call.params?.expression === "document.readyState" ? readyState : 1 } }); break;
        case "Page.navigate": navigate(call, socket); break;
        default:
          unexpected.push(call.method);
          socket.send(JSON.stringify({ id: call.id, error: { message: `Unregistered fixture command ${call.method}` } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  closers.push(async () => {
    for (const client of clients) cdpDisconnect(client);
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(unexpected).toEqual([]);
  });
  return {
    calls, sockets, reply, event,
    get frame() { return frame; }, set frame(value: Frame) { frame = value; },
    set ready(value: string) { readyState = value; },
    set onNavigate(value: typeof navigate) { navigate = value; },
    set beforeReply(value: typeof beforeReply) { beforeReply = value; },
    async connect() { const client = await cdpConnect(port); clients.push(client); return client; },
    emit(method: string, params: any, sessionId?: string) { for (const socket of sockets) event(socket, method, params, sessionId); },
    load(loaderId = frame.loaderId, frameId = ROOT, sessionId?: string) {
      for (const socket of sockets) event(socket, "Page.lifecycleEvent", { name: "load", frameId, loaderId }, sessionId);
    },
  };
}

async function pendingAfter(promise: Promise<unknown>, ms = 20): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => false, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

afterEach(async () => { for (const close of closers.splice(0)) await close(); });

describe("CDP navigation acceptance and document-bound load proof", () => {
  it("rejects native nonempty errorText with a stable code rather than returning an accepted navigation", async () => {
    const w = await wire(); const client = await w.connect();
    w.onNavigate = (call, socket) => w.reply(socket, call, { frameId: ROOT, loaderId: "failed-loader", errorText: "net::ERR_PROXY_CONNECTION_FAILED" });
    await expect(cdpNavigate(client, URL)).rejects.toMatchObject({ name: "BrowserNavigationError", code: "BROWSER_NAVIGATION_FAILED", errorText: "net::ERR_PROXY_CONNECTION_FAILED" });
  });

  it("keeps the successful result shape and does not wait for full load in cdpNavigate", async () => {
    const w = await wire(); const client = await w.connect();
    expect(await cdpNavigate(client, URL)).toEqual({ frameId: ROOT, loaderId: w.frame.loaderId });
    expect(w.calls.filter((call) => call.method === "Page.setLifecycleEventsEnabled").map((call) => call.params)).toEqual([{ enabled: true }]);
    expect(w.calls.findIndex((call) => call.method === "Page.getFrameTree")).toBeLessThan(w.calls.findIndex((call) => call.method === "Page.navigate"));
  });

  it("rejects an actual no-load timeout instead of resolving Promise<void>", async () => {
    const w = await wire(); const client = await w.connect();
    await cdpNavigate(client, URL);
    await expect(cdpWaitForLoad(client, 60)).rejects.toMatchObject({ name: "BrowserLoadTimeoutError", code: "BROWSER_LOAD_TIMEOUT" });
  });

  it("retains an exact root lifecycle load that arrived before the navigation reply", async () => {
    const w = await wire(); const client = await w.connect();
    w.onNavigate = (call, socket) => {
      w.frame = { id: ROOT, loaderId: "early-loader" };
      w.event(socket, "Page.lifecycleEvent", { name: "load", frameId: ROOT, loaderId: "early-loader" });
      setTimeout(() => w.reply(socket, call, { frameId: ROOT, loaderId: "early-loader" }), 5);
    };
    await cdpNavigate(client, URL);
    const waiting = cdpWaitForLoad(client, 80);
    expect(await pendingAfter(waiting)).toBe(false);
    await expect(waiting).resolves.toBeUndefined();
  });

  it.each(["Page.frameStartedLoading", "Page.frameStartedNavigating"])("does not replay a completed L1 as current after a newer buffered root %s", async (method) => {
    const w = await wire(); const client = await w.connect();
    w.onNavigate = (call, socket) => {
      w.frame = { id: ROOT, loaderId: "accepted-L1" };
      w.event(socket, "Page.frameStartedNavigating", { frameId: ROOT, loaderId: "accepted-L1", navigationType: "differentDocument", url: URL });
      w.event(socket, "Page.lifecycleEvent", { name: "load", frameId: ROOT, loaderId: "accepted-L1" });
      // L2 is provisional. getFrameTree legitimately still returns the committed
      // complete L1, so a final frame-tree equality check cannot erase this start.
      w.event(socket, method, { frameId: ROOT, ...(method === "Page.frameStartedNavigating" ? { loaderId: "provisional-L2", navigationType: "differentDocument", url: URL + "/newer" } : {}) });
      w.reply(socket, call, { frameId: ROOT, loaderId: "accepted-L1" });
    };
    const completion = cdpNavigate(client, URL).then(() => cdpWaitForLoad(client, 100));
    await expect(completion).rejects.toMatchObject({ code: "BROWSER_NAVIGATION_SUPERSEDED" });
    expect(w.frame).toEqual({ id: ROOT, loaderId: "accepted-L1" });
    expect(w.calls.some((call) => call.method === "Runtime.evaluate" && call.params?.expression === "document.readyState")).toBe(false);
    const provisional = cdpWaitForLoad(client, 60);
    const timedOut = expect(provisional).rejects.toMatchObject({ code: "BROWSER_LOAD_TIMEOUT" });
    w.emit("Page.frameNavigated", { frame: { id: ROOT, loaderId: "accepted-L1", url: URL } });
    w.load("accepted-L1");
    await timedOut;
    w.frame = { id: ROOT, loaderId: "provisional-L2" };
    w.emit("Page.frameNavigated", { frame: { ...w.frame, url: URL + "/newer" } });
    w.load("provisional-L2");
    await cdpSendRaw(client, "Runtime.evaluate", { expression: "1" });
    await expect(cdpWaitForLoad(client, 100)).resolves.toBeUndefined();
  });

  it.each(["Page.frameStartedLoading", "Page.frameStartedNavigating"])("still accepts the acknowledged navigation's own buffered %s before its load", async (method) => {
    const w = await wire(); const client = await w.connect();
    w.onNavigate = (call, socket) => {
      w.frame = { id: ROOT, loaderId: "own-L1" };
      w.event(socket, method, { frameId: ROOT, ...(method === "Page.frameStartedNavigating" ? { loaderId: "own-L1", navigationType: "differentDocument", url: URL } : {}) });
      w.event(socket, "Page.lifecycleEvent", { name: "load", frameId: ROOT, loaderId: "own-L1" });
      w.reply(socket, call, { frameId: ROOT, loaderId: "own-L1" });
    };
    await expect(cdpNavigate(client, URL)).resolves.toEqual({ frameId: ROOT, loaderId: "own-L1" });
    await expect(cdpWaitForLoad(client, 100)).resolves.toBeUndefined();
  });

  it("supports split navigate then late wait after load without waiting for another event", async () => {
    const w = await wire(); const client = await w.connect();
    await cdpNavigate(client, URL); w.load();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const waiting = cdpWaitForLoad(client, 80);
    expect(await pendingAfter(waiting)).toBe(false);
    await expect(waiting).resolves.toBeUndefined();
  });

  it("does not accept old loader, child frame/session, almost-idle or unqualified load events", async () => {
    const w = await wire(); const client = await w.connect();
    await cdpNavigate(client, URL);
    const waiting = cdpWaitForLoad(client, 180);
    w.load(INITIAL); w.load(w.frame.loaderId, "child-frame"); w.load(w.frame.loaderId, ROOT, "child-session");
    w.emit("Page.lifecycleEvent", { name: "networkAlmostIdle", frameId: ROOT, loaderId: w.frame.loaderId });
    w.emit("Page.loadEventFired", { timestamp: 1 });
    expect(await pendingAfter(waiting)).toBe(true);
    w.load(); await expect(waiting).resolves.toBeUndefined();
  });

  it("does not accept the old complete document while a new Page.navigate reply is pending", async () => {
    const w = await wire(); const client = await w.connect();
    await cdpNavigate(client, URL); w.load(); w.ready = "complete";
    let release!: () => void;
    w.onNavigate = (call, socket) => { release = () => { w.frame = { id: ROOT, loaderId: "next-loader" }; w.reply(socket, call, { frameId: ROOT, loaderId: "next-loader" }); }; };
    const next = cdpNavigate(client, URL + "#next");
    while (!release) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    const waiting = cdpWaitForLoad(client, 180);
    w.load(INITIAL); w.emit("Page.loadEventFired", {});
    expect(await pendingAfter(waiting)).toBe(true);
    release(); await next;
    expect(await pendingAfter(waiting)).toBe(true);
    w.load(); await expect(waiting).resolves.toBeUndefined();
  });

  it("follows redirects within the acknowledged root loader instead of keying completion to URL", async () => {
    const w = await wire(); const client = await w.connect();
    w.onNavigate = (call, socket) => {
      w.frame = { id: ROOT, loaderId: "redirect-loader" };
      for (const redirect of [false, true]) w.event(socket, "Network.requestWillBeSent", { requestId: "chain", frameId: ROOT, loaderId: "redirect-loader", type: "Document", ...(redirect ? { redirectResponse: { status: 302, url: "https://navigation.fixture.test/private" } } : {}) });
      w.event(socket, "Page.frameNavigated", { frame: { ...w.frame, url: "https://redirect.fixture.test/private" } });
      w.event(socket, "Page.lifecycleEvent", { name: "load", frameId: ROOT, loaderId: "redirect-loader" });
      w.reply(socket, call, { frameId: ROOT, loaderId: "redirect-loader" });
    };
    await cdpNavigate(client, URL);
    const waiting = cdpWaitForLoad(client, 80);
    expect(await pendingAfter(waiting)).toBe(false); await waiting;
  });

  it("requires the corresponding same-document transition before reusing document completion", async () => {
    const w = await wire(); const client = await w.connect();
    await cdpNavigate(client, URL); w.load();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    w.onNavigate = (call, socket) => w.reply(socket, call, { frameId: ROOT });
    await cdpNavigate(client, URL + "#same");
    const waiting = cdpWaitForLoad(client, 120);
    expect(await pendingAfter(waiting)).toBe(true);
    w.emit("Page.navigatedWithinDocument", { frameId: ROOT, url: URL + "#same" });
    expect(await pendingAfter(waiting)).toBe(false);
    await expect(waiting).resolves.toBeUndefined();
  });

  it.each(["sameDocument", "historySameDocument"])("retains completed D across an external %s transition without another lifecycle load", async (navigationType) => {
    const w = await wire(); const client = await w.connect(); w.ready = "complete";
    await cdpNavigate(client, URL); w.load(); await cdpWaitForLoad(client, 100);
    const document = { ...w.frame };
    const nativeNavigations = w.calls.filter((call) => call.method === "Page.navigate").length;
    w.emit("Page.frameStartedNavigating", { frameId: ROOT, loaderId: document.loaderId, navigationType, url: URL + "#external-same" });
    // Round-trip on the existing wire so the external start is definitely
    // consumed before B begins its independent wait.
    await cdpSendRaw(client, "Runtime.evaluate", { expression: "1" });
    const waiting = cdpWaitForLoad(client, 160);
    const resolved = expect(waiting).resolves.toBeUndefined();
    expect(await pendingAfter(waiting)).toBe(true);
    w.emit("Page.navigatedWithinDocument", { frameId: ROOT, navigationType: navigationType === "historySameDocument" ? "historyApi" : "fragment", url: URL + "#external-same" });
    await resolved;
    expect(w.frame).toEqual(document);
    expect(w.calls.filter((call) => call.method === "Page.navigate")).toHaveLength(nativeNavigations);
  });

  it.each([
    { navigationType: "differentDocument", matchingLoader: true },
    { navigationType: undefined, matchingLoader: true },
    { navigationType: "sameDocument", matchingLoader: false },
  ])("does not infer an external same-document transition from incomplete/mismatched start identity ($navigationType, matchingLoader=$matchingLoader)", async ({ navigationType, matchingLoader }) => {
    const w = await wire(); const client = await w.connect(); w.ready = "complete";
    await cdpNavigate(client, URL); w.load(); await cdpWaitForLoad(client, 100);
    w.emit("Page.frameStartedNavigating", { frameId: ROOT, loaderId: matchingLoader ? w.frame.loaderId : "other-document-loader", ...(navigationType ? { navigationType } : {}), url: URL + "#unqualified" });
    await cdpSendRaw(client, "Runtime.evaluate", { expression: "1" });
    const waiting = cdpWaitForLoad(client, 80);
    const rejected = expect(waiting).rejects.toMatchObject({ code: "BROWSER_LOAD_TIMEOUT" });
    w.emit("Page.navigatedWithinDocument", { frameId: ROOT, navigationType: "fragment", url: URL + "#unqualified" });
    await rejected;
  });

  it("preserves a download receipt but never treats it as a loaded document", async () => {
    const w = await wire(); const client = await w.connect();
    w.onNavigate = (call, socket) => w.reply(socket, call, { frameId: ROOT, isDownload: true });
    expect(await cdpNavigate(client, URL)).toEqual({ frameId: ROOT, isDownload: true });
    await expect(cdpWaitForLoad(client, 60)).rejects.toMatchObject({ code: "BROWSER_NAVIGATION_DOWNLOAD" });
  });

  it("rejects waits promptly when the websocket closes instead of converting disconnect to timeout/success", async () => {
    const w = await wire(); const client = await w.connect(); await cdpNavigate(client, URL);
    const waiting = cdpWaitForLoad(client, 300);
    const rejection = expect(waiting).rejects.toMatchObject({ code: "BROWSER_CONNECTION_CLOSED" });
    for (const socket of w.sockets) socket.close();
    await rejection;
    expect(client.callbacks.size).toBe(0);
  });

  it("keeps caller cancellation isolated when two waits share a client", async () => {
    const w = await wire(); const client = await w.connect(); await cdpNavigate(client, URL);
    let allowed = true;
    const cancelled = runWithProtocolDispatchGuard(() => { if (!allowed) throw new Error("only caller A cancelled"); }, () => cdpWaitForLoad(client, 300));
    const rejected = expect(cancelled).rejects.toThrow("only caller A cancelled");
    const healthy = runWithProtocolDispatchGuard(() => {}, () => cdpWaitForLoad(client, 300));
    allowed = false; await rejected;
    runWithProtocolDispatchGuard(() => { throw new Error("unrelated emitting context"); }, () => w.load());
    expect(await pendingAfter(healthy)).toBe(false);
    await expect(healthy).resolves.toBeUndefined();
    expect(await cdpSendRaw(client, "Runtime.evaluate", { expression: "1", returnByValue: true })).toEqual({ result: { value: 1 } });
  });

  it("fails a superseded wait rather than letting a later navigation fulfill it", async () => {
    const w = await wire(); const client = await w.connect(); await cdpNavigate(client, URL);
    const old = cdpWaitForLoad(client, 180);
    const rejected = expect(old).rejects.toMatchObject({ code: "BROWSER_NAVIGATION_SUPERSEDED" });
    await cdpNavigate(client, URL + "#replacement");
    w.load(); await rejected;
    const current = cdpWaitForLoad(client, 80);
    expect(await pendingAfter(current)).toBe(false); await current;
  });

  it("requires an acknowledged lifecycle enable and allows a fresh retry after a protocol refusal", async () => {
    const w = await wire(); const client = await w.connect();
    w.beforeReply = (call, socket) => {
      if (call.method !== "Page.setLifecycleEventsEnabled") return;
      socket.send(JSON.stringify({ id: call.id, error: { message: "synthetic lifecycle refusal" } })); return true;
    };
    await expect(cdpNavigate(client, URL)).rejects.toThrow("synthetic lifecycle refusal");
    expect(w.calls.some((call) => call.method === "Page.navigate")).toBe(false);
    w.beforeReply = undefined;
    await expect(cdpNavigate(client, URL)).resolves.toMatchObject({ frameId: ROOT });
  });

  it("includes held lifecycle preparation in the navigation deadline and removes only its callback", async () => {
    const w = await wire(); const client = await w.connect();
    w.beforeReply = (call) => call.method === "Page.setLifecycleEventsEnabled";
    await expect(cdpNavigate(client, URL, 35)).rejects.toMatchObject({ code: "BROWSER_NAVIGATION_TIMEOUT" });
    expect(client.callbacks.size).toBe(0);
    expect(w.calls.some((call) => call.method === "Page.navigate")).toBe(false);
    w.beforeReply = undefined;
    await expect(cdpNavigate(client, URL)).resolves.toMatchObject({ frameId: ROOT });
  });

  it("bounds held standalone readiness commands and never accepts late complete", async () => {
    const w = await wire(); const client = await w.connect(); let release!: () => void;
    w.beforeReply = (call, socket) => {
      if (call.method === "Runtime.evaluate" && call.params?.expression === "document.readyState") { release = () => w.reply(socket, call, { result: { value: "complete" } }); return true; }
    };
    await expect(cdpWaitForLoad(client, 35)).rejects.toMatchObject({ code: "BROWSER_LOAD_TIMEOUT" });
    expect(client.callbacks.size).toBe(0);
    release();
    expect(await cdpSendRaw(client, "Runtime.evaluate", { expression: "1" })).toEqual({ result: { value: 1 } });
  });

  it("fails closed when more than 64 pre-reply identity events lose completion proof", async () => {
    const w = await wire(); const client = await w.connect();
    w.onNavigate = (call, socket) => {
      w.frame = { id: ROOT, loaderId: "bounded-loader" };
      for (let i = 0; i < 65; i++) w.event(socket, "Page.lifecycleEvent", { name: "load", frameId: ROOT, loaderId: "bounded-loader", url: URL });
      w.reply(socket, call, { frameId: ROOT, loaderId: "bounded-loader" });
    };
    await cdpNavigate(client, URL);
    await expect(cdpWaitForLoad(client, 70)).rejects.toMatchObject({ code: "BROWSER_NAVIGATION_EVIDENCE_LOST" });
  });

  it("retains exactly 64 sanitized pre-reply events and excludes child sessions or unrelated events from that budget", async () => {
    const w = await wire(); const client = await w.connect();
    w.onNavigate = (call, socket) => {
      w.frame = { id: ROOT, loaderId: "boundary-loader" };
      for (let i = 0; i < 80; i++) {
        w.event(socket, "Network.requestWillBeSent", { request: { url: URL } });
        w.event(socket, "Page.lifecycleEvent", { name: "load", frameId: ROOT, loaderId: "boundary-loader" }, "unrelated-session");
      }
      for (let i = 0; i < 64; i++) w.event(socket, "Page.lifecycleEvent", { name: "load", frameId: ROOT, loaderId: "boundary-loader", url: URL });
      w.reply(socket, call, { frameId: ROOT, loaderId: "boundary-loader", errorText: "" });
    };
    await expect(cdpNavigate(client, URL)).resolves.toMatchObject({ errorText: "" });
    const waiting = cdpWaitForLoad(client, 80);
    expect(await pendingAfter(waiting)).toBe(false); await waiting;
  });

  it("does not infer same-document success from a missing loader and the previous complete document alone", async () => {
    const w = await wire(); const client = await w.connect();
    await cdpNavigate(client, URL); w.load(); w.ready = "complete";
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    w.onNavigate = (call, socket) => w.reply(socket, call, { frameId: ROOT });
    await cdpNavigate(client, URL + "#unconfirmed");
    await expect(cdpWaitForLoad(client, 40)).rejects.toMatchObject({ code: "BROWSER_LOAD_TIMEOUT" });
  });

  it("can verify an already-complete same-document navigation on a fresh client only after its transition", async () => {
    const w = await wire(); const client = await w.connect(); w.ready = "complete";
    w.onNavigate = (call, socket) => {
      w.event(socket, "Page.navigatedWithinDocument", { frameId: ROOT, url: URL + "#fresh-same" });
      w.reply(socket, call, { frameId: ROOT });
    };
    await cdpNavigate(client, URL + "#fresh-same");
    const waiting = cdpWaitForLoad(client, 80);
    expect(await pendingAfter(waiting)).toBe(false); await waiting;
    expect(w.calls.find((call) => call.method === "Page.createIsolatedWorld")?.params.frameId).toBe(ROOT);
  });

  it("matches an early same-document transition without waiting for a nonexistent new loader", async () => {
    const w = await wire(); const client = await w.connect();
    await cdpNavigate(client, URL); w.load();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    w.onNavigate = (call, socket) => {
      w.event(socket, "Page.navigatedWithinDocument", { frameId: ROOT, url: URL + "#same" });
      w.reply(socket, call, { frameId: ROOT });
    };
    await cdpNavigate(client, URL + "#same");
    const waiting = cdpWaitForLoad(client, 70);
    expect(await pendingAfter(waiting)).toBe(false); await waiting;
  });

  it("rejects standalone complete if before/after document identity changes without a load event", async () => {
    const w = await wire(); const client = await w.connect(); w.ready = "complete";
    let reads = 0;
    w.beforeReply = (call) => {
      if (call.method === "Page.getFrameTree" && ++reads === 2) w.frame = { id: ROOT, loaderId: "replaced-without-event" };
    };
    await expect(cdpWaitForLoad(client, 100)).rejects.toMatchObject({ code: "BROWSER_NAVIGATION_SUPERSEDED" });
  });

  it("does not accept old readiness when root loading starts during standalone preparation", async () => {
    const w = await wire(); const client = await w.connect(); w.ready = "complete";
    let first = true;
    w.beforeReply = (call, socket) => {
      if (call.method === "Page.getFrameTree" && first) { first = false; w.event(socket, "Page.frameStartedLoading", { frameId: ROOT }); }
    };
    await expect(cdpWaitForLoad(client, 45)).rejects.toMatchObject({ code: "BROWSER_LOAD_TIMEOUT" });
    expect(w.calls.some((call) => call.method === "Runtime.evaluate" && call.params?.expression === "document.readyState")).toBe(false);
  });

  it("does not let a cancelled standalone preparation poison another caller sharing the same client", async () => {
    const w = await wire(); const client = await w.connect(); w.ready = "complete";
    let held = false;
    w.beforeReply = (call) => { if (call.method === "Page.createIsolatedWorld" && !held) { held = true; return true; } };
    let allowed = true;
    const first = runWithProtocolDispatchGuard(() => { if (!allowed) throw new Error("first standalone caller cancelled"); }, () => cdpWaitForLoad(client, 200));
    const rejected = expect(first).rejects.toThrow("first standalone caller cancelled");
    while (!held) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    const healthy = cdpWaitForLoad(client, 100);
    allowed = false; await rejected;
    await expect(healthy).resolves.toBeUndefined();
    expect(client.callbacks.size).toBe(0);
  });

  it.each([
    { warm: false, method: "Page.setLifecycleEventsEnabled" },
    { warm: false, method: "Page.getFrameTree" },
    { warm: true, method: "Page.getFrameTree" },
  ])("does not publish caller A's pre-dispatch cancellation as a shared document failure ($method, warm=$warm)", async ({ warm, method }) => {
    const w = await wire(); const client = await w.connect(); w.ready = "complete";
    if (warm) { await cdpNavigate(client, URL); w.load(); await cdpWaitForLoad(client, 100); }
    const nativeNavigations = w.calls.filter((call) => call.method === "Page.navigate").length;
    let preparationSeen!: () => void;
    const preparation = new Promise<void>((resolve) => { preparationSeen = resolve; });
    let releaseLateReply!: () => void;
    w.beforeReply = (call, socket) => {
      if (call.method !== method) return;
      releaseLateReply = () => w.reply(socket, call, method === "Page.getFrameTree" ? { frameTree: { frame: w.frame } } : {});
      preparationSeen(); return true;
    };
    let allowed = true;
    const first = runWithProtocolDispatchGuard(() => { if (!allowed) throw new Error("only preparatory caller A cancelled"); }, () => cdpNavigate(client, URL + "/never-dispatched"));
    const rejected = expect(first).rejects.toThrow("only preparatory caller A cancelled");
    await preparation;
    allowed = false; await rejected;
    expect(w.calls.filter((call) => call.method === "Page.navigate")).toHaveLength(nativeNavigations);
    expect(client.callbacks.size).toBe(0);
    w.beforeReply = undefined;
    releaseLateReply();
    // This is the unchanged current document, not a retry of A's navigation.
    await expect(cdpWaitForLoad(client, 120)).resolves.toBeUndefined();
    await expect(cdpWaitForLoad(client, 120)).resolves.toBeUndefined();
    expect(w.calls.filter((call) => call.method === "Page.navigate")).toHaveLength(nativeNavigations);
  });

  it("keeps an already-waiting B healthy when A cancels its undispatched preparation", async () => {
    const w = await wire(); const client = await w.connect(); w.ready = "complete";
    await cdpNavigate(client, URL); w.load(); await cdpWaitForLoad(client, 100);
    let preparationSeen!: () => void;
    const preparation = new Promise<void>((resolve) => { preparationSeen = resolve; });
    w.beforeReply = (call) => {
      if (call.method !== "Page.getFrameTree") return;
      preparationSeen(); return true;
    };
    let allowed = true;
    const first = runWithProtocolDispatchGuard(() => { if (!allowed) throw new Error("only undispatched A cancelled"); }, () => cdpNavigate(client, URL + "/never-dispatched"));
    const rejected = expect(first).rejects.toThrow("only undispatched A cancelled");
    await preparation;
    const healthy = cdpWaitForLoad(client, 200);
    const resolved = expect(healthy).resolves.toBeUndefined();
    expect(await pendingAfter(healthy)).toBe(true);
    w.beforeReply = undefined;
    allowed = false; await rejected;
    await resolved;
    expect(w.calls.filter((call) => call.method === "Page.navigate")).toHaveLength(1);
    await expect(cdpWaitForLoad(client, 100)).resolves.toBeUndefined();
  });

  it("preserves an external provisional start observed before a preparatory caller cancels", async () => {
    const w = await wire(); const client = await w.connect(); w.ready = "complete";
    await cdpNavigate(client, URL); w.load(); await cdpWaitForLoad(client, 100);
    let preparationSeen!: () => void;
    const preparation = new Promise<void>((resolve) => { preparationSeen = resolve; });
    w.beforeReply = (call, socket) => {
      if (call.method !== "Page.getFrameTree") return;
      w.event(socket, "Page.frameStartedNavigating", { frameId: ROOT, loaderId: "external-provisional", navigationType: "differentDocument", url: URL + "/external" });
      preparationSeen(); return true;
    };
    let allowed = true;
    const first = runWithProtocolDispatchGuard(() => { if (!allowed) throw new Error("preparation cancelled after external start"); }, () => cdpNavigate(client, URL + "/never-dispatched"));
    const rejected = expect(first).rejects.toThrow("preparation cancelled after external start");
    await preparation;
    await cdpSendRaw(client, "Runtime.evaluate", { expression: "1" });
    allowed = false; await rejected;
    w.beforeReply = undefined;
    // Discarding A's local cancellation must not discard the external start and
    // let B probe the still-committed old document's complete readyState.
    await expect(cdpWaitForLoad(client, 80)).rejects.toMatchObject({ code: "BROWSER_LOAD_TIMEOUT" });
    expect(w.calls.filter((call) => call.method === "Page.navigate")).toHaveLength(1);
  });

  it("checks a caller's replacement guard during a held navigation command and leaves the connection usable", async () => {
    const w = await wire(); const client = await w.connect(); let navigateSeen = false;
    w.onNavigate = () => { navigateSeen = true; };
    let current = true;
    const pending = runWithProtocolDispatchGuard(() => { if (!current) throw new Error("selected runtime was replaced"); }, () => cdpNavigate(client, URL));
    const rejected = expect(pending).rejects.toThrow("selected runtime was replaced");
    while (!navigateSeen) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    current = false; await rejected;
    expect(client.callbacks.size).toBe(0);
    expect(await cdpSendRaw(client, "Runtime.evaluate", { expression: "1" })).toEqual({ result: { value: 1 } });
  });

  it("retains one navigation event listener across repeated calls and cleans it on disconnect", async () => {
    const w = await wire(); const client = await w.connect();
    const baseline = client.ws.listenerCount("message");
    for (let i = 0; i < 5; i++) { await cdpNavigate(client, URL); w.load(); await cdpWaitForLoad(client, 100); }
    expect(client.ws.listenerCount("message")).toBe(baseline + 1);
    cdpDisconnect(client);
    expect(client.ws.listenerCount("message")).toBe(baseline);
  });

  it("binds standalone readiness to actual frame/loader and its isolated execution context", async () => {
    const w = await wire(); const client = await w.connect(); w.ready = "complete";
    const waiting = cdpWaitForLoad(client, 100);
    expect(await pendingAfter(waiting)).toBe(false); await waiting;
    expect(w.calls.filter((call) => call.method === "Page.getFrameTree").length).toBeGreaterThanOrEqual(2);
    expect(w.calls.find((call) => call.method === "Page.createIsolatedWorld")?.params.frameId).toBe(ROOT);
    expect(w.calls.find((call) => call.method === "Runtime.evaluate" && call.params.expression === "document.readyState")?.params.contextId).toBe(917);
  });
});
