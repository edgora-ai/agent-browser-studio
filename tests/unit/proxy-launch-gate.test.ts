// R10 product P1-1/P1-2: launch-time proxy liveness gate.
// A configured-but-dead proxy must refuse before spawn (not launch a browser
// that can never load a page); consecutive health failures must refuse too.
import { describe, it, expect } from "vitest";
import * as net from "node:net";
import { probeProxyPort } from "../../src/main/services/proxy-detector.js";

describe("probeProxyPort (R10 P1-1)", () => {
  it("returns false for a closed port", async () => {
    // Port 1 is privileged/closed in practice; use an unlikely-open high port.
    expect(await probeProxyPort({ host: "127.0.0.1", port: 19_876 }, 1000)).toBe(false);
  });

  it("returns true for a listening port", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      expect(await probeProxyPort({ host: "127.0.0.1", port }, 2000)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("returns false for invalid host/port without throwing", async () => {
    expect(await probeProxyPort({ host: "", port: 8080 }, 500)).toBe(false);
    expect(await probeProxyPort({ host: "127.0.0.1", port: 0 }, 500)).toBe(false);
    expect(await probeProxyPort({ host: "127.0.0.1", port: 99999 }, 500)).toBe(false);
  });
});
