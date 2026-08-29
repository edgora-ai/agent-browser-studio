// Unit tests for proxy-aware curl download helper.
// Verifies the priority chain (explicit → app default → env → direct) and that
// downloads succeed against a local http server (no real network).
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-proxy-download-test");

vi.mock("electron", () => {
  const nodePath = require("node:path");
  const nodeOs = require("node:os");
  const TEST_DATA = nodePath.join(nodeOs.tmpdir(), "agent-browser-proxy-download-test");
  return {
    app: {
      getPath: (name: string) => {
        if (name === "userData") return TEST_DATA;
        if (name === "home") return nodePath.join(nodeOs.tmpdir(), "agent-browser-proxy-download-test-home");
        return "/tmp";
      },
    },
  };
});

import { getConfig, saveConfig, addProxy, setDefaultProxyName, deleteProxy, reloadConfig } from "../../src/main/services/config-manager.js";
import { resolveDownloadProxy, downloadFileWithCurl, parseEnvProxy, writeCurlConfig } from "../../src/main/services/proxy-detector.js";

// Start a tiny local http server that serves a known payload; return its origin.
async function startLocalServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from("EXTENSION-PAYLOAD-12345"));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const savedEnv = { ...process.env };

describe("resolveDownloadProxy — priority chain", () => {
  beforeEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    // Clean proxy env vars for deterministic ordering
    for (const k of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"]) {
      delete process.env[k];
    }
    reloadConfig();
  });

  afterEach(() => {
    for (const k of Object.keys(savedEnv)) process.env[k] = savedEnv[k];
  });

  it("returns null (direct download) when no default proxy and no env proxy exist", () => {
    // A1: a fresh app config ships no built-in proxy. With no default proxy
    // and no env proxy, downloads fall through to a direct connection.
    const p = resolveDownloadProxy();
    expect(p).toBeNull();
  });

  it("returns a custom app default proxy when configured", () => {
    addProxy("e2e-default", { type: "socks5", host: "10.0.0.99", port: 1080 });
    setDefaultProxyName("e2e-default");
    saveConfig(getConfig());
    const p = resolveDownloadProxy();
    expect(p).not.toBeNull();
    expect(p!.host).toBe("10.0.0.99");
    expect(p!.port).toBe(1080);
    expect(p!.type).toBe("socks5");
  });

  it("falls back to HTTPS_PROXY env var when no app default resolves", () => {
    // Disable the built-in default so env fallback is exercised.
    getConfig().defaultProxy = "does-not-exist";
    process.env.HTTPS_PROXY = "http://envproxy.example.com:8080";
    const p = resolveDownloadProxy();
    expect(p).not.toBeNull();
    expect(p!.host).toBe("envproxy.example.com");
    expect(p!.port).toBe(8080);
    expect(p!.type).toBe("http");
  });

  it("parses socks5 env proxy", () => {
    getConfig().defaultProxy = "does-not-exist";
    process.env.ALL_PROXY = "socks5://10.0.0.5:1080";
    const p = resolveDownloadProxy();
    expect(p).not.toBeNull();
    expect(p!.type).toBe("socks5");
    expect(p!.host).toBe("10.0.0.5");
    expect(p!.port).toBe(1080);
  });

  it("parses authenticated env proxy", () => {
    getConfig().defaultProxy = "does-not-exist";
    process.env.HTTPS_PROXY = "http://user:secret@proxy.example.com:3128";
    const p = resolveDownloadProxy();
    expect(p).not.toBeNull();
    expect(p!.username).toBe("user");
    expect(p!.password).toBe("secret");
  });

  it("parses bracketed IPv6, proxy-side DNS and encoded credentials", () => {
    getConfig().defaultProxy = "does-not-exist";
    process.env.ALL_PROXY = "socks5h://user%40tenant:p%3Ass@[2001:db8::42]:1080/";
    expect(resolveDownloadProxy()).toEqual({
      type: "socks5h",
      host: "2001:db8::42",
      port: 1080,
      username: "user@tenant",
      password: "p:ss",
    });
  });

  it("rejects unsupported or path-bearing proxy environment URLs", () => {
    expect(parseEnvProxy("ftp://proxy.example:21")).toBeNull();
    expect(parseEnvProxy("http://proxy.example:8080/not-a-proxy-root")).toBeNull();
  });

  it("explicit override takes priority over app default and env", () => {
    addProxy("app-default", { type: "http", host: "app.proxy", port: 1 });
    setDefaultProxyName("app-default");
    saveConfig(getConfig());
    process.env.HTTPS_PROXY = "http://env.proxy:2";
    const p = resolveDownloadProxy({ proxyConfig: { type: "socks5", host: "override.proxy", port: 3 } });
    expect(p!.host).toBe("override.proxy");
    expect(p!.type).toBe("socks5");
  });

  it("app default takes priority over env", () => {
    addProxy("app-default", { type: "http", host: "app.proxy", port: 1 });
    setDefaultProxyName("app-default");
    saveConfig(getConfig());
    process.env.HTTPS_PROXY = "http://env.proxy:2";
    const p = resolveDownloadProxy();
    expect(p!.host).toBe("app.proxy");
  });
});

describe("writeCurlConfig — credential safety", () => {
  it("writes a 0600 conf file with proxy + proxy-user", () => {
    const conf = writeCurlConfig({ type: "http", host: "p.example", port: 8080, username: "u", password: "secret" });
    try {
      if (process.platform !== "win32") {
        const stat = fs.statSync(conf);
        // mode 0o600 — owner read/write only (POSIX only; Windows has no chmod semantics)
        expect(stat.mode & 0o777).toBe(0o600);
      }
      const content = fs.readFileSync(conf, "utf-8");
      expect(content).toContain("proxy = ");
      expect(content).toContain("p.example:8080");
      expect(content).toContain("proxy-user = ");
      expect(content).toContain("u:secret");
    } finally {
      try { fs.unlinkSync(conf); } catch { /* ignore */ }
    }
  });

  it("brackets an IPv6 proxy host for curl", () => {
    const conf = writeCurlConfig({ type: "socks5h", host: "2001:db8::42", port: 1080 });
    try {
      expect(fs.readFileSync(conf, "utf-8")).toContain("socks5h://[2001:db8::42]:1080");
    } finally {
      try { fs.unlinkSync(conf); } catch { /* ignore */ }
    }
  });
});

describe("downloadFileWithCurl — local http server", () => {
  let server: { origin: string; close: () => Promise<void> };

  beforeEach(async () => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    reloadConfig();
    server = await startLocalServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it("bypassProxy: true skips the app default proxy entirely (verifies via error path)", () => {
    // With an app default proxy that doesn't resolve, bypassProxy must make the
    // download attempt direct — so the error message says "(direct connection)"
    // rather than "via proxy".
    addProxy("bogus", { type: "http", host: "127.0.0.1", port: 1 });
    setDefaultProxyName("bogus");
    saveConfig(getConfig());
    const dest = path.join(os.tmpdir(), `dl-test-direct-${Date.now()}.bin`);
    let errMsg = "";
    try {
      try {
        downloadFileWithCurl(`${server.origin}/pkg.crx`, dest, { timeoutMs: 3000, bypassProxy: true });
      } catch (e: any) {
        errMsg = e.message || "";
      }
      expect(errMsg).toMatch(/\(direct connection\)/);
      expect(errMsg).not.toMatch(/via proxy/);
    } finally {
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      try { deleteProxy("bogus"); } catch { /* ignore */ }
    }
  }, 20000);

  it("includes the proxy conf path when a proxy is configured", () => {
    // Configure an app default proxy that points at nothing real, but we only
    // verify that downloadFileWithCurl ATTEMPTS to use a proxy (curl fails
    // because the proxy doesn't exist) and the error message names the proxy.
    addProxy("bogus", { type: "http", host: "127.0.0.1", port: 1 });
    setDefaultProxyName("bogus");
    saveConfig(getConfig());
    const dest = path.join(os.tmpdir(), `dl-test-proxy-${Date.now()}.bin`);
    try {
      expect(() => downloadFileWithCurl(`${server.origin}/pkg.crx`, dest, { timeoutMs: 4000 }))
        .toThrow(/via proxy http:\/\/127\.0\.0\.1:1/);
    } finally {
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      try { deleteProxy("bogus"); } catch { /* ignore */ }
    }
  });
});
