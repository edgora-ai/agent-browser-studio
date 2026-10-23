import { performance } from "node:perf_hooks";
import { closeCdpNavigation, navigateCdp, waitForCdpLoad } from "./cdp-navigation.js";
import { navigationConnectionClosed } from "./cdp-navigation-errors.js";
export { BrowserLoadTimeoutError, BrowserNavigationError } from "./cdp-navigation-errors.js";
import {
  assertProtocolDispatchAllowed,
  captureProtocolDispatchGuard,
  runWithProtocolDispatchGuard,
} from "./dispatch-guard.js";

export interface CdpClient {
  ws: any;
  port: number;
  targetId: string | null;
  closed?: boolean;
  msgId: number;
  callbacks: Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout> }>;
  pendingMessages: Promise<any>[];
  interactionSeed: number;
  interactionCounter: number;
  pointerX: number | null;
  pointerY: number | null;
}

function normalizeCdpWebSocketUrl(value: string, port: number): string {
  const url = new URL(value);
  if (url.protocol !== "ws:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1") || Number(url.port) !== port) {
    throw new Error("CDP websocket target is not on the expected loopback port");
  }
  url.hostname = "127.0.0.1";
  return url.toString();
}

async function getWs(): Promise<any> {
  try { return (await import("ws" as any)).default ?? (await import("ws" as any)); } catch { return null; }
}

export async function cdpConnect(port: number, interactionSeed = port, timeoutMs = 15_000): Promise<CdpClient> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Invalid CDP connection timeout");
  // Elapsed time is measured on the monotonic clock: a wall-clock correction
  // (NTP step, manual change, sleep/wake) must not turn a reply that arrived
  // within the real budget into a fabricated timeout. setTimeout stays the
  // backstop for the ordinary case.
  const deadline = performance.now() + timeoutMs;
  // Capture once: fetch/socket callbacks can execute under the async context that
  // created a transport rather than the context currently awaiting this call.
  const guard = captureProtocolDispatchGuard();
  guard?.(port);

  const abortController = new AbortController();
  let preparationFinished = false;
  let preparationFailed = false;
  let preparationFailure: unknown;
  let newSocket: any = null;
  let newClient: CdpClient | null = null;
  let rejectCancellation!: (error: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });

  const closeNewConnection = (error: unknown) => {
    if (newClient) {
      newClient.closed = true;
      closeCdpNavigation(newClient);
      for (const callback of newClient.callbacks.values()) {
        clearTimeout(callback.timer);
        callback.reject(error);
      }
      newClient.callbacks.clear();
    }
    if (!newSocket) return;
    const socket = newSocket;
    newSocket = null;
    try {
      if (typeof socket.terminate === "function") socket.terminate();
      else socket.close();
    } catch (closeError) {
      console.warn("[agent] failed to close rejected CDP connection", closeError);
    }
  };

  const failPreparation = (error: unknown) => {
    if (preparationFinished || preparationFailed) return;
    preparationFailed = true;
    preparationFailure = error;
    abortController.abort(error);
    closeNewConnection(error);
    rejectCancellation(error);
  };

  const assertPreparationAllowed = () => {
    if (preparationFailed) throw preparationFailure;
    try {
      guard?.(port);
      if (performance.now() >= deadline) throw new Error(`CDP connection preparation timed out on port ${port}`);
    } catch (error) {
      failPreparation(error);
      throw error;
    }
  };

  const deadlineTimer = setTimeout(() => {
    failPreparation(new Error(`CDP connection preparation timed out on port ${port}`));
  }, timeoutMs);
  const guardTimer = guard
    ? setInterval(() => {
        try {
          guard(port);
        } catch (error) {
          failPreparation(error);
        }
      }, 25)
    : undefined;

  try {
    const wsPkg = await Promise.race([getWs(), cancellation]);
    assertPreparationAllowed();
    if (!wsPkg) throw new Error("ws module not available");
    const Ws = wsPkg;

    // One local controller spans both response headers and body consumption, so
    // a held /json endpoint is genuinely cancellable rather than merely checked
    // after an unbounded await.
    const response = await Promise.race([
      fetch(`http://127.0.0.1:${port}/json`, { signal: abortController.signal }),
      cancellation,
    ]);
    assertPreparationAllowed();
    const pages = await Promise.race([response.json(), cancellation]) as any[];
    assertPreparationAllowed();
    const page = pages.find((candidate: any) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
    if (!page) throw new Error("No debuggable page found");
    const wsUrl = normalizeCdpWebSocketUrl(page.webSocketDebuggerUrl, port);
    assertPreparationAllowed();

    const connecting = new Promise<CdpClient>((resolve, reject) => {
      let settled = false;
      const failConnect = (error: unknown) => {
        if (settled) return;
        settled = true;
        closeNewConnection(error);
        reject(error);
      };

      try {
        assertPreparationAllowed();
        newSocket = new Ws(wsUrl);
      } catch (error) {
        failConnect(error);
        return;
      }
      const ws = newSocket;
      const client: CdpClient = {
        ws,
        port,
        targetId: typeof page.id === "string" ? page.id : null,
        msgId: 0,
        callbacks: new Map(),
        pendingMessages: [],
        interactionSeed: Number.isInteger(interactionSeed) ? interactionSeed : port,
        interactionCounter: 0,
        pointerX: null,
        pointerY: null,
      };
      newClient = client;

      ws.on("open", () => {
        try {
          assertPreparationAllowed();
          const setupMethods = [
            "Page.enable",
            "Runtime.enable",
            "Network.enable",
            "DOM.enable",
            "Input.enable",
            "Emulation.enable",
          ];
          const setup = runWithProtocolDispatchGuard(guard, () => setupMethods.map((method) => {
            try {
              return cdpSendRaw(client, method, undefined, undefined, Math.max(1, Math.ceil(deadline - performance.now())));
            } catch (error) {
              // Keep every already-created promise observed even if the guard
              // flips midway through constructing the setup batch.
              return Promise.reject(error);
            }
          }));
          Promise.allSettled(setup).then(() => {
            if (settled) return;
            try {
              // Never hand an uncached connection onward after cancellation,
              // replacement, or deadline expiry during setup.
              assertPreparationAllowed();
              settled = true;
              resolve(client);
            } catch (error) {
              failConnect(error);
            }
          });
        } catch (error) {
          failConnect(error);
        }
      });

      ws.on("message", (data: Buffer) => {
        let msg: any;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg?.id && client.callbacks.has(msg.id)) {
          const callback = client.callbacks.get(msg.id)!;
          client.callbacks.delete(msg.id);
          clearTimeout(callback.timer);
          if (msg.error) callback.reject(new Error(msg.error.message));
          else callback.resolve(msg.result);
        }
      });

      const disconnected = () => {
        const error = navigationConnectionClosed();
        client.closed = true;
        closeCdpNavigation(client);
        for (const callback of client.callbacks.values()) callback.reject(error);
        client.callbacks.clear();
        failConnect(error);
      };
      ws.on("error", disconnected);
      ws.on("close", disconnected);
    });

    const client = await Promise.race([connecting, cancellation]);
    assertPreparationAllowed();
    preparationFinished = true;
    return client;
  } catch (error) {
    if (preparationFailed) throw preparationFailure;
    throw error;
  } finally {
    preparationFinished = true;
    clearTimeout(deadlineTimer);
    if (guardTimer) clearInterval(guardTimer);
  }
}

export function cdpSendRaw(client: CdpClient, method: string, params?: any, sessionId?: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<any> {
  // The optional signal owns only this callback, never the shared socket.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Invalid CDP command timeout");
  assertProtocolDispatchAllowed(client.port);
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (client.closed || client.ws.readyState !== undefined && client.ws.readyState !== 1) return Promise.reject(navigationConnectionClosed());
  const guard = captureProtocolDispatchGuard();
  // Monotonic budget: a wall-clock step during an awaited command must not
  // fabricate a timeout for a reply that actually arrived in time.
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const id = ++client.msgId;
    let settled = false;
    let guardTimer: ReturnType<typeof setInterval> | undefined;
    const finish = (ok: boolean, value: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (guardTimer) clearInterval(guardTimer);
      client.callbacks.delete(id);
      signal?.removeEventListener("abort", aborted);
      if (ok) {
        try {
          guard?.(client.port);
          if (signal?.aborted) throw signal.reason;
          if (performance.now() >= deadline) throw new Error(`CDP ${method} timeout`);
          resolve(value);
        } catch (error) { reject(error); }
      } else reject(value);
    };
    const aborted = () => finish(false, signal!.reason);
    const timer = setTimeout(() => finish(false, new Error(`CDP ${method} timeout`)), timeoutMs);
    client.callbacks.set(id, { resolve: (value: any) => finish(true, value), reject: (error: unknown) => finish(false, error), timer });
    signal?.addEventListener("abort", aborted, { once: true });
    if (guard) guardTimer = setInterval(() => {
      try { guard(client.port); } catch (error) { finish(false, error); }
    }, 25);
    try {
      assertProtocolDispatchAllowed(client.port);
      if (signal?.aborted) throw signal.reason;
      client.ws.send(JSON.stringify({ id, method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) }));
    } catch (error) { finish(false, error); }
  });
}

export function cdpDisconnect(client: CdpClient): void {
  client.closed = true;
  closeCdpNavigation(client);
  for (const callback of client.callbacks.values()) callback.reject(navigationConnectionClosed());
  client.callbacks.clear();
  try {
    client.ws.close();
  } catch (error) {
    console.warn("[agent] CDP websocket close failed", error);
  }
}

export async function cdpNavigate(client: CdpClient, url: string, timeoutMs = 15_000): Promise<any> {
  return navigateCdp(client, url, timeoutMs, cdpSendRaw);
}

export async function cdpWaitForLoad(client: CdpClient, timeout = 10000): Promise<void> {
  return waitForCdpLoad(client, timeout, cdpSendRaw);
}

export async function cdpGetContent(client: CdpClient): Promise<string> {
  const r = await cdpSendRaw(client, "Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true });
  return r?.result?.value || "";
}

export async function cdpGetTitle(client: CdpClient): Promise<string> {
  const r = await cdpSendRaw(client, "Runtime.evaluate", { expression: "document.title", returnByValue: true });
  return r?.result?.value || "";
}

export async function cdpGetUrl(client: CdpClient): Promise<string> {
  const r = await cdpSendRaw(client, "Runtime.evaluate", { expression: "location.href", returnByValue: true });
  return r?.result?.value || "";
}

export async function cdpSnapshot(client: CdpClient): Promise<any> {
  return cdpSendRaw(client, "Accessibility.getFullAXTree");
}

export async function cdpTextSnapshot(client: CdpClient): Promise<string> {
  const r = await cdpSendRaw(client, "Runtime.evaluate", { expression: "document.body ? document.body.innerText.slice(0,12000) : ''", returnByValue: true });
  return r?.result?.value || "";
}
