// Proxy bulk import/export unit tests — real imports from production.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-proxy-import-test");

vi.mock("electron", () => {
  const path = require("node:path");
  const os = require("node:os");
  const TEST_DATA = path.join(os.tmpdir(), "agent-browser-proxy-import-test");
  return {
    app: {
      getPath: (name) => {
        if (name === "userData") return TEST_DATA;
        if (name === "home") return TEST_DATA;
        return "/tmp";
      },
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain, "utf8"),
      decryptString: (encrypted) => Buffer.from(encrypted).toString("utf8"),
    },
  };
});

import { reloadConfig } from "../../src/main/services/config-manager.js";
import {
  parseProxyLine,
  parseProxyText,
  importProxies,
  exportProxiesCsv,
} from "../../src/main/services/proxy-import.js";
import {
  resetSecretStorageForTests,
  initializeSecretStorage,
  planSecretStorage,
} from "../../src/main/services/secrets.js";

describe("parseProxyLine", () => {
  it("parses a bare host:port line as http", () => {
    const p = parseProxyLine("127.0.0.1:7890");
    expect(p.config).toMatchObject({ type: "http", host: "127.0.0.1", port: 7890 });
    expect(p.name).toBe("127.0.0.1-7890");
  });

  it("parses socks5h with credentials and URL-encoded password", () => {
    const p = parseProxyLine("socks5h://user:p%40ss@proxy.example.com:1080");
    expect(p.config).toMatchObject({ type: "socks5h", host: "proxy.example.com", port: 1080, username: "user", password: "p@ss" });
  });

  it("parses an IPv6 host in brackets", () => {
    const p = parseProxyLine("socks5://[::1]:1080");
    expect(p.config).toMatchObject({ type: "socks5", host: "::1", port: 1080 });
  });

  it("maps https scheme to http", () => {
    const p = parseProxyLine("https://h:8080");
    expect(p.config.type).toBe("http");
  });

  it("throws on invalid lines", () => {
    expect(() => parseProxyLine("")).toThrow("empty line");
    expect(() => parseProxyLine("no-port-here")).toThrow("expected host:port");
    expect(() => parseProxyLine("ftp://host:21")).toThrow("unknown scheme");
  });
});

describe("parseProxyText", () => {
  it("parses mixed URI lines and keeps per-line errors without aborting", () => {
    const res = parseProxyText("socks5://u:p@h1:1080\nh2:8080\nbad-line\n# comment\n");
    expect(res.proxies.length).toBe(2);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0].line).toBe("bad-line");
  });

  it("parses a CSV header with name/type/host/port/username/password", () => {
    const res = parseProxyText("name,type,host,port,username,password\nUS-1,socks5,1.2.3.4,1080,bob,secret\nJP-2,http,5.6.7.8,8080,, \n");
    expect(res.proxies.length).toBe(2);
    expect(res.proxies[0]).toMatchObject({
      name: "US-1",
      config: { type: "socks5", host: "1.2.3.4", port: 1080, username: "bob", password: "secret" },
    });
    expect(res.proxies[1].config.username).toBeUndefined();
  });

  it("treats a bad CSV row as a per-line error", () => {
    const res = parseProxyText("name,type,host,port\nA,http,1.2.3.4,8080\nB,socks5,9.9.9.9\n");
    expect(res.proxies.length).toBe(1);
    expect(res.errors.length).toBe(1);
  });

  it("handles URI lines mixed into a CSV batch", () => {
    const res = parseProxyText("name,type,host,port\nA,http,1.2.3.4,8080\nsocks5h://bob:p%40ss@5.6.7.8:1080\n9.9.9.9:8080\nbad-line\n");
    expect(res.proxies.length).toBe(3);
    expect(res.errors.length).toBe(1);
    expect(res.proxies[1]).toMatchObject({ config: { type: "socks5h", host: "5.6.7.8", port: 1080, username: "bob", password: "p@ss" } });
    expect(res.proxies[2]).toMatchObject({ config: { type: "http", host: "9.9.9.9", port: 8080 } });
  });

  it("returns empty for blank input", () => {
    expect(parseProxyText("")).toEqual({ proxies: [], errors: [] });
    expect(parseProxyText("   \n #x\n")).toEqual({ proxies: [], errors: [] });
  });
});

describe("importProxies / exportProxiesCsv (real store)", () => {
  beforeEach(() => {
    resetSecretStorageForTests();
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    initializeSecretStorage(planSecretStorage({
      userDataDir: TEST_USER_DATA,
      platform: "darwin",
      trustedMacSignature: false,
      environment: {},
    }));
    reloadConfig();
  });

  afterEach(() => {
    resetSecretStorageForTests();
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  it("imports proxies and dedupes by fingerprint", () => {
    const parsed = parseProxyText("http://h1:8080\nh1:8080\nh2:8080\n").proxies;
    const report = importProxies(parsed);
    expect(report.imported).toHaveLength(2);
    expect(report.skipped.some((s) => s.reason.includes("duplicate"))).toBe(true);
    const csv = exportProxiesCsv().split("\n");
    expect(csv).toHaveLength(3); // header + 2 imported (no built-in default proxy)
    expect(csv.filter((r) => r.startsWith("h1-8080,") || r.startsWith("h2-8080,"))).toHaveLength(2);
  });

  it("auto-renames colliding names with -2/-3 suffixes", () => {
    const parsed = parseProxyText("name,host,port\np,1.1.1.1,80\np,2.2.2.2,80\n").proxies;
    const report = importProxies(parsed);
    expect(report.imported).toEqual(["p", "p-2"]);
  });

  it("replaces same-name proxies when replace is set", () => {
    const parsed = parseProxyText("name,host,port\np,1.1.1.1,80\n").proxies;
    importProxies(parsed);
    const second = parseProxyText("name,host,port\np,3.3.3.3,90\n").proxies;
    const report = importProxies(second, { replace: true });
    expect(report.imported).toEqual(["p"]);
    expect(report.skipped).toHaveLength(0);
    const csv = exportProxiesCsv();
    expect(csv).toContain("3.3.3.3,90");
  });

  it("escapes CSV fields containing commas or quotes", () => {
    const parsed = parseProxyText("name,host,port,username\n\"a,b\",1.1.1.1,80,\"x,y\"\n").proxies;
    expect(parsed).toHaveLength(1);
    const report = importProxies(parsed);
    expect(report.imported).toEqual(["a_b"]);
    const csv = exportProxiesCsv();
    expect(csv).toContain("\"x,y\"");
    expect(csv).toContain("a_b,http,1.1.1.1,80");
  });
});
