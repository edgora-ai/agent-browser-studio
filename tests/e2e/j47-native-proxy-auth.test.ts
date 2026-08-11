// J47: authenticated HTTP proxy credentials stay in the browser process. The
// app hands them over through a one-shot 0600 file, does not load an auth
// extension, and disables QUIC while the managed proxy is active.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, setupTestApp, type TestAppHandle } from "./helpers/app.js";
import { connectPageCdp, waitForCdpPort, waitForPortClosed } from "./helpers/cdp.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j47");
const CHROMIUM = path.resolve(REPO, "..", "chromium-build-150", "src", "out", "RoxyRelease", "Chromium.app", "Contents", "MacOS", "Chromium");
const USERNAME = "j47-user";
const PASSWORD = "j47-password";

interface ProxyRequest {
  target: string;
  authenticated: boolean;
}

function nativeAuthTempDirs(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("agent-browser-native-proxy-auth-")).sort();
}

describe("J47 — native HTTP proxy authentication", () => {
  let h: TestAppHandle;
  let proxy: http.Server;
  let proxyPort = 0;
  let dirId = "";
  const requests: ProxyRequest[] = [];
  const tempDirsBefore = nativeAuthTempDirs();

  beforeAll(async () => {
    if (!fs.existsSync(CHROMIUM)) throw new Error(`J47 Chromium build is missing: ${CHROMIUM}`);
    const expectedAuth = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;
    proxy = http.createServer((request, response) => {
      const target = request.url || "";
      const authenticated = request.headers["proxy-authorization"] === expectedAuth;
      requests.push({ target, authenticated });
      if (!authenticated) {
        response.writeHead(407, {
          "proxy-authenticate": "Basic realm=\"J47\"",
          "cache-control": "no-store",
        });
        response.end("proxy authentication required");
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (parsed.hostname !== "probe.test") {
        response.writeHead(502, { "cache-control": "no-store" }).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("<!doctype html><script>window.__nativeProxyAuth='ok'</script>");
    });
    proxy.on("connect", (_request, socket) => {
      socket.on("error", () => socket.destroy());
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("J47 proxy did not bind");
    proxyPort = address.port;

    h = await setupTestApp({
      userDataDir: USERDATA,
      allowProfileVersionSelection: true,
      env: {
        AGENT_BROWSER_CHROMIUM_BINARY_PATH: CHROMIUM,
      },
    });
    const added = await h.page.evaluate(async ({ port, username, password }) =>
      (window as any).agentBrowser.api.proxy.add("j47-auth", {
        type: "http",
        host: "127.0.0.1",
        port,
        username,
        password,
      }), { port: proxyPort, username: USERNAME, password: PASSWORD });
    expect(added.success, added.error).toBe(true);
    const created = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({
      name: "J47 native auth",
      platform: "windows",
      fingerprintSeed: 47474,
      locale: "en-US",
      timezone: "America/New_York",
      webrtcMode: "disable",
      proxyMode: "named",
      proxyName: "j47-auth",
    }));
    dirId = created.dirId;
  }, 60_000);

  afterAll(async () => {
    if (h) await closeApp(h);
    if (proxy) await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }, 90_000);

  it("authenticates without an extension or a persistent credential file", async () => {
    const launched = await h.page.evaluate(async (id: string) =>
      (window as any).agentBrowser.api.browser.launch(id), dirId) as {
      success: boolean; pid: number; cdpPort: number; error?: string;
    };
    expect(launched.success, launched.error || "J47 launch failed").toBe(true);
    h.cdpPids.push(launched.pid);
    await waitForCdpPort(launched.cdpPort, 15_000);
    const client = await connectPageCdp(launched.cdpPort);
    try {
      await client.send("Page.enable");
      const navigation = await client.send<{ errorText?: string }>("Page.navigate", {
        url: `http://probe.test/native-auth?${Date.now()}`,
      });
      expect(navigation.errorText).toBeUndefined();
      const started = Date.now();
      let value: string | null = null;
      while (Date.now() - started < 10_000) {
        value = await client.send<{ result: { value: string | null } }>("Runtime.evaluate", {
          expression: "window.__nativeProxyAuth || null",
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
    }

    expect(requests.some((request) => !request.authenticated)).toBe(true);
    expect(requests.some((request) => request.authenticated && request.target.includes("probe.test/native-auth"))).toBe(true);
    const authExtension = path.join(USERDATA, "runtime-extensions", `proxy-auth-${dirId}`);
    expect(fs.existsSync(authExtension)).toBe(false);
    expect(nativeAuthTempDirs()).toEqual(tempDirsBefore);

    const log = fs.readFileSync(path.join(USERDATA, "logs", `browser-${dirId}.log`), "utf8");
    expect(log).toContain("--disable-quic");
    expect(log).toContain("--agent-browser-proxy-auth-file=<ephemeral>");
    expect(log).not.toContain(PASSWORD);
  }, 60_000);
});
