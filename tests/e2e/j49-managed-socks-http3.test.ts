// J49: an independent Chromium advertising roxy-quic-proxy-v1 routes normal
// CONNECT traffic and RFC 9298 CONNECT-UDP through the profile-owned helper.
// Set ROXY_E2E_SOCKS5_UDP_URL to an authorized UDP-capable SOCKS5 endpoint.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, setupTestApp, type TestAppHandle } from "./helpers/app.js";
import { connectPageCdp, waitForCdpPort, waitForPortClosed } from "./helpers/cdp.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j49");
const CHROMIUM = path.resolve(REPO, "..", "chromium-build-150", "src", "out", "RoxyRelease", "Chromium.app", "Contents", "MacOS", "Chromium");
const BRIDGE = path.join(REPO, "dist", "native", process.platform === "win32" ? "roxy-masque-bridge.exe" : "roxy-masque-bridge");
const UPSTREAM_URL = process.env.ROXY_E2E_SOCKS5_UDP_URL || "";
const ENDPOINT = "https://quic.tlsfingerprint.io/api/client-fingerprint-quic";

function masqueTempDirs(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("cloak-masque-socks-")).sort();
}

function bridgePids(parentPid: number): number[] {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[2]) !== parentPid || !match[3].includes("roxy-masque-bridge")) return [];
    return [Number(match[1])];
  });
}

describe.skipIf(!UPSTREAM_URL)("J49 — managed SOCKS5 HTTP/3 transport", () => {
  let h: TestAppHandle;
  let dirId = "";
  const tempDirsBefore = masqueTempDirs();

  beforeAll(async () => {
    if (!fs.existsSync(CHROMIUM)) throw new Error(`J49 Chromium build is missing: ${CHROMIUM}`);
    if (!fs.existsSync(BRIDGE)) throw new Error(`J49 MASQUE helper is missing: ${BRIDGE}`);
    const upstream = new URL(UPSTREAM_URL);
    if (upstream.protocol !== "socks5:" && upstream.protocol !== "socks5h:") {
      throw new Error("ROXY_E2E_SOCKS5_UDP_URL must use socks5:// or socks5h://");
    }
    const port = Number(upstream.port || 1080);

    h = await setupTestApp({
      userDataDir: USERDATA,
      allowProfileVersionSelection: true,
      env: {
        CLOAKBROWSER_BINARY_PATH: CHROMIUM,
        CLOAK_MASQUE_BRIDGE_PATH: BRIDGE,
        CLOAKBROWSER_LICENSE_KEY: "",
      },
    });
    const added = await h.page.evaluate(async (proxy) =>
      (window as any).cloak.api.proxy.add("j49-socks-udp", proxy), {
      type: upstream.protocol === "socks5h:" ? "socks5h" : "socks5",
      host: upstream.hostname,
      port,
      username: decodeURIComponent(upstream.username),
      password: decodeURIComponent(upstream.password),
    });
    expect(added.success, added.error).toBe(true);
    const created = await h.page.evaluate(async () => (window as any).cloak.api.cloak.create({
      name: "J49 managed SOCKS HTTP3",
      platform: "windows",
      fingerprintSeed: 49494,
      locale: "en-US",
      timezone: "America/New_York",
      webrtcMode: "disable",
      proxyMode: "named",
      proxyName: "j49-socks-udp",
    }));
    dirId = created.dirId;
  }, 60_000);

  afterAll(async () => {
    if (h) await closeApp(h);
  }, 90_000);

  it("upgrades to h3 through SOCKS5 UDP without leaking credentials or helper state", async () => {
    let launched = await h.page.evaluate(async (id: string) =>
      (window as any).cloak.api.cloak.launch(id), dirId) as {
      success: boolean; pid: number; cdpPort: number; error?: string;
    };
    expect(launched.success, launched.error || "J49 launch failed").toBe(true);
    h.cdpPids.push(launched.pid);
    await waitForCdpPort(launched.cdpPort, 15_000);

    const log = fs.readFileSync(path.join(USERDATA, "logs", `cloak-${dirId}.log`), "utf8");
    expect(log).toMatch(/--proxy-server=quic:\/\/roxy-masque\.local:\d+/);
    expect(log).toContain("--host-resolver-rules=MAP roxy-masque.local 127.0.0.1");
    expect(log).toMatch(/--ignore-certificate-errors-spki-list=[A-Za-z0-9+/]{43}=/);
    expect(log).toMatch(/--origin-to-force-quic-on=roxy-masque\.local:\d+/);
    expect(log).toContain("--enable-quic");
    expect(log).not.toContain("--disable-quic");
    const upstream = new URL(UPSTREAM_URL);
    if (upstream.username) expect(log).not.toContain(decodeURIComponent(upstream.username));
    if (upstream.password) expect(log).not.toContain(decodeURIComponent(upstream.password));
    expect(masqueTempDirs()).toEqual(tempDirsBefore);

    const allHelperPids = bridgePids(h.app.process().pid!);
    expect(allHelperPids).toHaveLength(1);
    let client = await connectPageCdp(launched.cdpPort);
    try {
      await client.send("Page.enable");
      await client.send("Runtime.enable");
      const first = await navigateAndRead(client, `${ENDPOINT}?run=j49-first-${Date.now()}`, false);
      expect(["h2", "h3"]).toContain(first.protocol);

      // Chromium keeps using an already-open H2 session after accepting the
      // Alt-Svc header. A clean restart of this same profile exercises the
      // persisted alternative service without forcing the target origin onto
      // QUIC through a command-line switch.
      if (first.protocol === "h2") {
        client.close();
        await h.page.evaluate(async (id: string) => (window as any).cloak.api.cloak.stop(id), dirId);
        await waitForPortClosed(launched.cdpPort, 10_000);
        await waitForProcessesExit(allHelperPids, 5_000);

        launched = await h.page.evaluate(async (id: string) =>
          (window as any).cloak.api.cloak.launch(id), dirId) as {
          success: boolean; pid: number; cdpPort: number; error?: string;
        };
        expect(launched.success, launched.error || "J49 relaunch failed").toBe(true);
        h.cdpPids.push(launched.pid);
        await waitForCdpPort(launched.cdpPort, 15_000);
        const relaunchedHelperPids = bridgePids(h.app.process().pid!);
        expect(relaunchedHelperPids).toHaveLength(1);
        allHelperPids.push(...relaunchedHelperPids);
        client = await connectPageCdp(launched.cdpPort);
        await client.send("Page.enable");
        await client.send("Runtime.enable");
      }

      const second = await navigateAndRead(client, `${ENDPOINT}?run=j49-second-${Date.now()}`);
      expect(second.protocol).toBe("h3");
      const parsed = JSON.parse(second.body);
      const initials = parsed.ClientInitials;
      const hello = initials?.client_hello;
      const transport = initials?.transport_parameters;
      expect(initials?.hex_id).toBe("91fc7b001022ca85");
      expect(hello?.cipher_suites).toEqual([4865, 4866, 4867]);
      expect(hello?.extensions_normalized?.filter((id: number) => id !== 51764)).toEqual(
        [0, 10, 13, 16, 27, 43, 45, 51, 57, 17613, 65037],
      );
      expect(hello?.supported_groups).toEqual([4588, 29, 23, 24]);
      expect(hello?.signature_algorithms).toEqual([1027, 2052, 1025, 1283, 2053, 1281, 2054, 1537, 513]);
      expect(hello?.alpn).toEqual(["h3"]);
      expect(transport).toMatchObject({
        max_udp_payload_size: [5, 192],
        initial_max_data: [0, 240, 0, 0],
        initial_max_stream_data_bidi_local: [0, 96, 0, 0],
        initial_max_stream_data_bidi_remote: [0, 96, 0, 0],
        initial_max_stream_data_uni: [0, 96, 0, 0],
        initial_max_streams_bidi: [0, 100],
        initial_max_streams_uni: [0, 103],
        tpids: [1, 3, 4, 5, 6, 7, 8, 9, 15, 17, 27, 32, 12584],
      });
      // Stock Chromium 150 advertises either 30s or 300s when the official
      // QuicLongerIdleConnectionTimeout field trial is active.
      expect([[0, 0, 117, 48], [0, 4, 147, 224]]).toContainEqual(transport?.max_idle_timeout);
    } finally {
      client.close();
      await h.page.evaluate(async (id: string) => (window as any).cloak.api.cloak.stop(id), dirId);
      await waitForPortClosed(launched.cdpPort, 10_000);
    }

    await waitForProcessesExit(allHelperPids, 5_000);
    expect(masqueTempDirs()).toEqual(tempDirsBefore);
  }, 90_000);
});

async function navigateAndRead(
  client: Awaited<ReturnType<typeof connectPageCdp>>,
  url: string,
  requireJsonBody = true,
): Promise<{ protocol: string; body: string }> {
  const navigation = await client.send<{ errorText?: string }>("Page.navigate", { url });
  expect(navigation.errorText).toBeUndefined();
  const started = Date.now();
  let lastState = "no Runtime.evaluate result";
  while (Date.now() - started < 15_000) {
    const result = await client.send<{ result: { value?: string } }>("Runtime.evaluate", {
      expression: `JSON.stringify({
        url: location.href,
        readyState: document.readyState,
        protocol: performance.getEntriesByType("navigation")[0]?.nextHopProtocol || "",
        body: document.body?.innerText || ""
      })`,
      returnByValue: true,
    }).catch(() => null);
    const value = result?.result.value;
    if (value) {
      lastState = value;
      const parsed = JSON.parse(value) as {
        url: string;
        readyState: string;
        protocol: string;
        body: string;
      };
      if (parsed.url === url && parsed.readyState === "complete" && parsed.protocol &&
          (!requireJsonBody || parsed.body.startsWith("{"))) {
        return { protocol: parsed.protocol, body: parsed.body };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`J49 navigation did not complete: ${url}; last state: ${lastState}`);
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
