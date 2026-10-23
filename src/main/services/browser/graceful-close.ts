import * as http from "node:http";
import WebSocket from "ws";

export type ChromiumCloseResult =
  | "acknowledged" | "disconnected" | "unavailable" | "failed" | "timeout" | "stale";

const MAX_CLOSE_RESPONSE_BYTES = 16 * 1024;

/** Request native shutdown, not a page-script flush or proof of process exit. */
export function requestChromiumClose(
  port: number,
  isCurrent: () => boolean,
  timeoutMs: number,
): Promise<ChromiumCloseResult> {
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) {
    return Promise.resolve("unavailable");
  }

  return new Promise((resolve) => {
    let settled = false;
    let dispatched = false;
    let request: http.ClientRequest | undefined;
    let response: http.IncomingMessage | undefined;
    let socket: WebSocket | undefined;
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    function finish(result: ChromiumCloseResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      response?.destroy();
      socket?.terminate(); // Only this request's debugger connection, never a page.
      resolve(result);
    }
    function current(): boolean {
      try { return isCurrent(); }
      catch { finish("failed"); return false; }
    }
    if (!current()) { finish("stale"); return; }

    // This is the pinned managed browser's local control port, not an arbitrary
    // URL. Do not follow redirects or fall back to a page-target websocket.
    request = http.get({ hostname: "127.0.0.1", port, path: "/json/version", agent: false }, (incoming) => {
      response = incoming;
      if (settled) { incoming.destroy(); return; }
      if (incoming.statusCode !== 200) { finish("unavailable"); return; }
      let bytes = 0;
      const chunks: Buffer[] = [];
      incoming.on("error", () => finish("failed"));
      incoming.on("aborted", () => finish("failed"));
      incoming.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_CLOSE_RESPONSE_BYTES) { finish("failed"); return; }
        chunks.push(chunk);
      });
      incoming.on("end", () => {
        if (settled) return;
        if (!current()) { finish("stale"); return; }
        try {
          const version = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!version || typeof version !== "object" || Array.isArray(version) ||
              typeof version.webSocketDebuggerUrl !== "string") {
            finish("failed"); return;
          }
          const url = new URL(version.webSocketDebuggerUrl);
          if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" ||
              Number(url.port || "80") !== port || url.username || url.password || url.search || url.hash ||
              !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(url.pathname)) {
            finish("failed"); return;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) { finish("timeout"); return; }
          // The single outer deadline owns a stalled handshake too. A second
          // relative timer can win by a millisecond and misreport timeout as failure.
          socket = new WebSocket(url, {
            followRedirects: false, perMessageDeflate: false,
            maxPayload: MAX_CLOSE_RESPONSE_BYTES,
          });
          socket.on("error", () => finish("failed"));
          socket.on("close", () => finish(dispatched ? "disconnected" : "unavailable"));
          socket.on("open", () => {
            if (settled) return;
            if (!current()) { finish("stale"); return; }
            dispatched = true;
            socket!.send(JSON.stringify({ id: 1, method: "Browser.close" }), (error) => {
              if (error) finish("failed");
            });
          });
          let messages = 0;
          socket.on("message", (data, binary) => {
            if (settled) return;
            if (binary || ++messages > 32) { finish("failed"); return; }
            try {
              const message = JSON.parse(data.toString());
              if (message?.id !== 1) return;
              if (Object.hasOwn(message, "error") || !message.result ||
                  typeof message.result !== "object" || Array.isArray(message.result)) {
                finish("failed"); return;
              }
              finish("acknowledged");
            } catch { finish("failed"); }
          });
        } catch { finish("failed"); }
      });
    });
    request.on("error", () => finish("unavailable"));
  });
}
