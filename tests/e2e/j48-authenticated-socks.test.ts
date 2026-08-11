// J48: Chromium's no-auth SOCKS5 client is bridged over loopback to an
// authenticated upstream SOCKS5 proxy without resolving the target locally.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { closeApp, setupTestApp, type TestAppHandle } from "./helpers/app.js";
import { connectPageCdp, waitForCdpPort, waitForPortClosed } from "./helpers/cdp.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j48");
const USERNAME = "j48-user";
const PASSWORD = "j48-password";

interface SocksObservation {
  username: string | null;
  password: string | null;
  host: string | null;
  port: number | null;
}

describe("J48 — authenticated SOCKS5 bridge", () => {
  let h: TestAppHandle;
  let upstream: net.Server;
  let upstreamPort = 0;
  let dirId = "";
  const sockets = new Set<net.Socket>();
  const observations: SocksObservation[] = [];

  beforeAll(async () => {
    upstream = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.once("close", () => sockets.delete(socket));
      const observation: SocksObservation = { username: null, password: null, host: null, port: null };
      observations.push(observation);
      let phase: "greeting" | "auth" | "request" | "http" = "greeting";
      let buffered = Buffer.alloc(0);

      const consume = (length: number): Buffer => {
        const value = buffered.subarray(0, length);
        buffered = buffered.subarray(length);
        return value;
      };
      const processBuffered = (): void => {
        for (;;) {
          if (phase === "greeting") {
            if (buffered.length < 2) return;
            const count = buffered[1];
            if (buffered.length < 2 + count) return;
            const greeting = consume(2 + count);
            if (greeting[0] !== 5 || !greeting.subarray(2).includes(2)) {
              socket.end(Buffer.from([5, 255]));
              return;
            }
            socket.write(Buffer.from([5, 2]));
            phase = "auth";
            continue;
          }
          if (phase === "auth") {
            if (buffered.length < 2) return;
            const usernameLength = buffered[1];
            if (buffered.length < 2 + usernameLength + 1) return;
            const passwordLength = buffered[2 + usernameLength];
            const total = 3 + usernameLength + passwordLength;
            if (buffered.length < total) return;
            const auth = consume(total);
            observation.username = auth.subarray(2, 2 + usernameLength).toString("utf8");
            observation.password = auth.subarray(3 + usernameLength).toString("utf8");
            const accepted = observation.username === USERNAME && observation.password === PASSWORD;
            socket.write(Buffer.from([1, accepted ? 0 : 1]));
            if (!accepted) {
              socket.end();
              return;
            }
            phase = "request";
            continue;
          }
          if (phase === "request") {
            if (buffered.length < 5) return;
            if (buffered[0] !== 5 || buffered[1] !== 1 || buffered[3] !== 3) {
              socket.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
              return;
            }
            const length = buffered[4];
            if (buffered.length < 5 + length + 2) return;
            const request = consume(5 + length + 2);
            observation.host = request.subarray(5, 5 + length).toString("utf8");
            observation.port = request.readUInt16BE(5 + length);
            if (observation.host !== "probe.test") {
              socket.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
              return;
            }
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            phase = "http";
            continue;
          }
          if (phase === "http") {
            if (!buffered.includes("\r\n\r\n")) return;
            const body = "<!doctype html><script>window.__socksAuth='ok'</script>";
            socket.end([
              "HTTP/1.1 200 OK",
              "Content-Type: text/html; charset=utf-8",
              "Cache-Control: no-store",
              `Content-Length: ${Buffer.byteLength(body)}`,
              "Connection: close",
              "",
              body,
            ].join("\r\n"));
            buffered = Buffer.alloc(0);
            return;
          }
        }
      };
      socket.on("data", (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        processBuffered();
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("J48 upstream SOCKS server did not bind");
    upstreamPort = address.port;

    h = await setupTestApp({ userDataDir: USERDATA });
    const added = await h.page.evaluate(async ({ port, username, password }) =>
      (window as any).agentBrowser.api.proxy.add("j48-socks-auth", {
        type: "socks5h",
        host: "127.0.0.1",
        port,
        username,
        password,
      }), { port: upstreamPort, username: USERNAME, password: PASSWORD });
    expect(added.success, added.error).toBe(true);
    const created = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({
      name: "J48 SOCKS auth",
      platform: "windows",
      fingerprintSeed: 48484,
      locale: "en-US",
      timezone: "America/New_York",
      webrtcMode: "disable",
      proxyMode: "named",
      proxyName: "j48-socks-auth",
    }));
    dirId = created.dirId;
  }, 60_000);

  afterAll(async () => {
    if (h) await closeApp(h);
    for (const socket of sockets) socket.destroy();
    if (upstream?.listening) await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }, 90_000);

  it("forwards credentials and remote DNS, then closes the loopback bridge", async () => {
    const launched = await h.page.evaluate(async (id: string) =>
      (window as any).agentBrowser.api.browser.launch(id), dirId) as {
      success: boolean; pid: number; cdpPort: number; error?: string;
    };
    expect(launched.success, launched.error || "J48 launch failed").toBe(true);
    h.cdpPids.push(launched.pid);
    await waitForCdpPort(launched.cdpPort, 15_000);

    const logPath = path.join(USERDATA, "logs", `browser-${dirId}.log`);
    const log = fs.readFileSync(logPath, "utf8");
    const socksProxyMatch = log.match(/--proxy-server=socks5:\/\/127\.0\.0\.1:(\d+)/);
    const masqueProxyMatch = log.match(/--proxy-server=quic:\/\/agent-browser-masque\.local:(\d+)/);
    expect(Boolean(socksProxyMatch) !== Boolean(masqueProxyMatch)).toBe(true);
    const managedQuic = Boolean(masqueProxyMatch);
    const bridgePort = Number((socksProxyMatch || masqueProxyMatch)![1]);
    expect(bridgePort).not.toBe(upstreamPort);
    const helperPids = managedQuic ? masqueBridgePids(h.app.process().pid!) : [];
    if (managedQuic) {
      expect(helperPids).toHaveLength(1);
      expect(log).toContain("--host-resolver-rules=MAP agent-browser-masque.local 127.0.0.1");
      expect(log).toContain("--enable-quic");
      expect(log).not.toContain("--disable-quic");
    } else {
      expect(log).toContain("--disable-quic");
    }
    expect(log).not.toContain(USERNAME);
    expect(log).not.toContain(PASSWORD);
    expect(log).not.toContain("proxy-auth-");

    const client = await connectPageCdp(launched.cdpPort);
    try {
      await client.send("Page.enable");
      const navigation = await client.send<{ errorText?: string }>("Page.navigate", {
        url: `http://probe.test/socks-auth?${Date.now()}`,
      });
      expect(navigation.errorText).toBeUndefined();
      const started = Date.now();
      let value: string | null = null;
      while (Date.now() - started < 10_000) {
        value = await client.send<{ result: { value: string | null } }>("Runtime.evaluate", {
          expression: "window.__socksAuth || null",
          returnByValue: true,
        }).then((result) => result.result.value).catch(() => null);
        if (value === "ok") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(value).toBe("ok");
    } finally {
      client.close();
      await h.page.evaluate(async (id: string) => (window as any).agentBrowser.api.browser.stop(id), dirId);
      await waitForPortClosed(launched.cdpPort, 10_000);
      if (managedQuic) await waitForProcessesExit(helperPids, 5_000);
      else await waitForPortClosed(bridgePort, 10_000);
    }

    expect(observations.some((item) =>
      item.username === USERNAME && item.password === PASSWORD &&
      item.host === "probe.test" && item.port === 80)).toBe(true);
    expect(fs.existsSync(path.join(USERDATA, "runtime-extensions", `proxy-auth-${dirId}`))).toBe(false);
  }, 60_000);
});

function masqueBridgePids(parentPid: number): number[] {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[2]) !== parentPid || !match[3].includes("agent-browser-masque-bridge")) return [];
    return [Number(match[1])];
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessesExit(pids: number[], timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs && pids.some((pid) => processExists(pid))) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(pids.some((pid) => processExists(pid))).toBe(false);
}
