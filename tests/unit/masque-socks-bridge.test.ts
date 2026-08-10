import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveMasqueBridgeBinary,
  startMasqueSocksBridge,
  type MasqueSocksBridge,
} from "../../src/main/services/masque-socks-bridge.js";

const roots: string[] = [];
const bridges: MasqueSocksBridge[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloak-masque-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("managed MASQUE to SOCKS5 bridge", () => {
  it("consumes a one-shot config, reports a pinned loopback endpoint, and follows lifecycle close", async () => {
    const root = makeRoot();
    const binaryPath = resolveMasqueBridgeBinary();
    expect(fs.statSync(binaryPath).isFile()).toBe(true);

    const bridge = await startMasqueSocksBridge({
      type: "socks5",
      host: "127.0.0.1",
      port: 9,
      username: "unit-user",
      password: "unit-secret",
    }, { temporaryRoot: root, startTimeoutMs: 5_000 });
    bridges.push(bridge);

    expect(bridge.proxyHost).toBe("roxy-masque.local");
    expect(bridge.listenHost).toBe("127.0.0.1");
    expect(bridge.port).toBeGreaterThan(0);
    expect(bridge.capabilities).toEqual(expect.arrayContaining(["connect", "connect-udp"]));
    expect(bridge.spki).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(() => process.kill(bridge.pid, 0)).not.toThrow();

    await bridge.close();
    expect(() => process.kill(bridge.pid, 0)).toThrow();
  });

  it("rejects non-SOCKS proxies before creating a credential handoff", async () => {
    const root = makeRoot();
    await expect(startMasqueSocksBridge({
      type: "http",
      host: "127.0.0.1",
      port: 3128,
    }, { temporaryRoot: root })).rejects.toThrow(/requires a SOCKS5 proxy/);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
