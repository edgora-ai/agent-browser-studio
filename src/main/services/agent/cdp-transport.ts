import type { BrowserEngine } from "../../types.js";
import {
  assertProtocolDispatchAllowed,
  captureProtocolDispatchGuard,
  runWithProtocolDispatchGuard,
} from "./dispatch-guard.js";

export interface CdpClient {
  ws: any;
  port: number;
  targetId: string | null;
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

const CDP_CONNECT_PREPARATION_TIMEOUT_MS = 15_000;

export async function cdpConnect(port: number, interactionSeed = port): Promise<CdpClient> {
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
    } catch (error) {
      failPreparation(error);
      throw error;
    }
  };

  const deadlineTimer = setTimeout(() => {
    failPreparation(new Error(`CDP connection preparation timed out on port ${port}`));
  }, CDP_CONNECT_PREPARATION_TIMEOUT_MS);
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
              return cdpSendRaw(client, method);
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
        const msg = JSON.parse(data.toString());
        if (msg.id && client.callbacks.has(msg.id)) {
          const callback = client.callbacks.get(msg.id)!;
          client.callbacks.delete(msg.id);
          clearTimeout(callback.timer);
          if (msg.error) callback.reject(new Error(msg.error.message));
          else callback.resolve(msg.result);
        }
      });

      ws.on("error", failConnect);
      ws.on("close", () => failConnect(new Error("CDP websocket closed during connection preparation")));
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

export function cdpSendRaw(client: CdpClient, method: string, params?: any, sessionId?: string): Promise<any> {
  // Check before allocating an id/timer so a rejected dispatch leaves no waiter.
  assertProtocolDispatchAllowed(client.port);
  return new Promise((resolve, reject) => {
    const id = ++client.msgId;
    const timer = setTimeout(() => {
      if (client.callbacks.has(id)) {
        client.callbacks.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }
    }, 15000);
    client.callbacks.set(id, { resolve, reject, timer });
    try {
      // Re-check immediately before the actual wire write. If this throws after
      // allocation, the catch below removes both callback and timer.
      assertProtocolDispatchAllowed(client.port);
      client.ws.send(JSON.stringify({
        id,
        method,
        ...(params ? { params } : {}),
        ...(sessionId ? { sessionId } : {}),
      }));
    } catch (error) {
      clearTimeout(timer);
      client.callbacks.delete(id);
      reject(error);
    }
  });
}

export function cdpDisconnect(client: CdpClient): void {
  try {
    client.ws.close();
  } catch (error) {
    console.warn("[agent] CDP websocket close failed", error);
  }
}

export async function cdpNavigate(client: CdpClient, url: string): Promise<any> {
  return cdpSendRaw(client, "Page.navigate", { url });
}

export async function cdpWaitForLoad(client: CdpClient, timeout = 10000): Promise<void> {
  // Socket events may be emitted under the context that created a cached client.
  // Bind this wait to its caller's guard instead of consulting ambient ALS later.
  const guard = captureProtocolDispatchGuard();
  guard?.(client.port);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout>;
    let guardTimer: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (guardTimer) clearInterval(guardTimer);
      client.ws.off("message", handler);
    };
    const finish = (ok: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (ok) resolve();
      else reject(error);
    };
    const checkGuard = () => {
      try {
        guard?.(client.port);
        return true;
      } catch (error) {
        finish(false, error);
        return false;
      }
    };
    const handler = (data: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.method === "Page.loadEventFired" || msg.method === "Page.lifecycleEvent" && msg.params?.name === "networkAlmostIdle") {
        if (checkGuard()) finish(true);
      }
    };
    timeoutTimer = setTimeout(() => {
      if (checkGuard()) finish(true);
    }, timeout);
    if (guard) {
      // This is a local event wait, not an issued browser command. Polling the
      // per-call assertion makes cancellation prompt without closing a shared
      // websocket or attaching a global signal to it.
      guardTimer = setInterval(checkGuard, 25);
    }
    client.ws.on("message", handler);
  });
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
