// Proxy fail-closed gate (PL-04, R2 #46): shared by Chromium + Firefox paths.
// If the profile asked for a proxy and none is resolvable, launching must
// refuse — never silently fall back to a direct connection (real-IP leak).
import { vi, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-proxy-gate-test");

vi.mock("electron", () => {
  const path = require("node:path");
  const os = require("node:os");
  const TEST_DATA = path.join(os.tmpdir(), "agent-browser-proxy-gate-test");
  return {
    app: {
      getPath: (name: string) => {
        if (name === "userData") return TEST_DATA;
        if (name === "home") return TEST_DATA;
        return "/tmp";
      },
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => Buffer.from(plain, "utf8"),
      decryptString: (encrypted: Buffer) => Buffer.from(encrypted).toString("utf8"),
    },
  };
});

import { assertProxyResolvable } from "../../src/main/services/browser-manager.js";

const cfg = { defaultProxy: "office" };

describe("assertProxyResolvable", () => {
  it("refuses a named proxy that no longer resolves", () => {
    const meta = { proxyMode: "named", proxyName: "office-socks" };
    expect(() => assertProxyResolvable(meta, cfg, { mode: "named", name: "office-socks", config: null }))
      .toThrow(/refusing to launch|real IP/i);
  });

  it("refuses a default-mode proxy that exists-but-unresolvable", () => {
    const meta = { proxyMode: "default" };
    expect(() => assertProxyResolvable(meta, { defaultProxy: "office" }, { mode: "none", name: "office", config: null }))
      .toThrow(/refusing to launch|real IP/i);
  });

  it("allows fresh-install default mode with no default proxy (direct is expected)", () => {
    const meta = { proxyMode: "default" };
    expect(() => assertProxyResolvable(meta, {}, { mode: "none", config: null })).not.toThrow();
  });

  it("allows explicit none/off modes", () => {
    expect(() => assertProxyResolvable({ proxyMode: "none" }, cfg, { mode: "none", config: null })).not.toThrow();
    expect(() => assertProxyResolvable({ proxyMode: "off" }, cfg, { mode: "none", config: null })).not.toThrow();
  });

  it("allows a resolvable proxy", () => {
    const meta = { proxyMode: "named", proxyName: "office-socks" };
    expect(() => assertProxyResolvable(meta, cfg, { mode: "named", name: "office-socks", config: { type: "http", host: "1.2.3.4", port: 8080 } })).not.toThrow();
  });

  it("refuses a non-none mode with missing config (second gate)", () => {
    const meta = { proxyMode: "named", proxyName: "p" };
    expect(() => assertProxyResolvable(meta, cfg, { mode: "named", name: "p", config: null }))
      .toThrow(/refusing to launch/i);
  });
});
