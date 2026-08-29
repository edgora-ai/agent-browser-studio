import type { BrowserEngine } from "../../types.js";

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

export async function cdpConnect(port: number, interactionSeed = port): Promise<CdpClient> {
  const wsPkg = await getWs();
  if (!wsPkg) throw new Error("ws module not available");
  const Ws = wsPkg;

  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as any[];
  const page = pages.find((p: any) => p.type === "page" && p.webSocketDebuggerUrl);
  if (!page) throw new Error("No debuggable page found");

  return new Promise((resolve, reject) => {
    const ws = new Ws(normalizeCdpWebSocketUrl(page.webSocketDebuggerUrl, port));
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

    ws.on("open", () => {
      Promise.allSettled([
        cdpSendRaw(client, "Page.enable"),
        cdpSendRaw(client, "Runtime.enable"),
        cdpSendRaw(client, "Network.enable"),
        cdpSendRaw(client, "DOM.enable"),
        cdpSendRaw(client, "Input.enable"),
        cdpSendRaw(client, "Emulation.enable"),
      ]).then(() => resolve(client));
    });

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && client.callbacks.has(msg.id)) {
        const cb = client.callbacks.get(msg.id)!;
        client.callbacks.delete(msg.id);
        clearTimeout(cb.timer);
        if (msg.error) cb.reject(new Error(msg.error.message));
        else cb.resolve(msg.result);
      }
    });

    ws.on("error", reject);
  });
}

export function cdpSendRaw(client: CdpClient, method: string, params?: any, sessionId?: string): Promise<any> {
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
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeout);
    const handler = (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === "Page.loadEventFired" || msg.method === "Page.lifecycleEvent" && msg.params?.name === "networkAlmostIdle") {
          clearTimeout(t);
          client.ws.off("message", handler);
          resolve();
        }
      } catch {}
    };
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
