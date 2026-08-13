// Config manager unit tests — real imports from production
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-config-manager-test");

vi.mock("electron", () => {
  const path = require("node:path");
  const os = require("node:os");
  const TEST_DATA = path.join(os.tmpdir(), "agent-browser-config-manager-test");
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

import {
  getConfig,
  getConfigPath,
  reloadConfig,
  saveConfig,
  addProxy,
  deleteProxy,
  setDefaultProxyName,
  getProxy,
  getProxyList,
  getAppDataDir,
  getProfilesDir,
  resolveProfileProxy,
  getProxySecret,
  setProxyDetection,
  setProxyDetectionIfCurrent,
  getProxyDetection,
  updateProxy,
  renameProxy,
  setProfileMeta,
  normalizeProfileExtensionMap,
  migrateSecrets,
  getWebRtcDiagnostics,
  setWebRtcDiagnostics,
  clearWebRtcDiagnostics,
  sanitizeAppUrl,
} from "../../src/main/services/config-manager.js";
import type { MgmtConfig } from "../../src/main/types.js";
import {
  decryptSecret,
  initializeSecretStorage,
  planSecretStorage,
  resetSecretStorageForTests,
} from "../../src/main/services/secrets.js";

describe("Config Manager (real functions)", () => {
  beforeEach(() => {
    resetSecretStorageForTests();
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    initializeSecretStorage(planSecretStorage({
      userDataDir: TEST_USER_DATA,
      platform: "darwin",
      trustedMacSignature: false,
      environment: {},
    }));
    reloadConfig(); // force fresh load
  });

  afterEach(() => {
    resetSecretStorageForTests();
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  it("writes default config to disk on first get", () => {
    const cfg = getConfig();
    expect(cfg.version).toBe(4);
    expect(cfg.chromiumBin).toBe("auto");
    expect(cfg.defaultProxy).toBe("default");
    expect(cfg.proxies.default.type).toBe("http");
    expect(cfg.browserProfiles).toEqual({});
    expect(cfg.extensionRepository).toEqual({});
    expect(cfg.skillRepository).toEqual({});
    expect(fs.existsSync(getConfigPath())).toBe(true);
  });

  it("atomically migrates legacy v1 credentials into the local vault", () => {
    const cfg = getConfig();
    cfg.llm = { provider: "openai", apiKey: "v1:bGxt", model: "test" };
    cfg.sync = { ...cfg.sync, secretKey: "v1:c3luYw==" };
    saveConfig(cfg);

    resetSecretStorageForTests();
    initializeSecretStorage(planSecretStorage({
      userDataDir: TEST_USER_DATA,
      platform: "darwin",
      trustedMacSignature: false,
      environment: {},
    }), {
      legacyDecryptor: (stored) => stored === "v1:bGxt" ? "llm-secret" : "sync-secret",
    });
    reloadConfig();

    expect(migrateSecrets()).toBe(2);
    const stored = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(stored.llm.apiKey).toMatch(/^v2:/);
    expect(stored.sync.secretKey).toMatch(/^v2:/);
    expect(decryptSecret(stored.llm.apiKey)).toBe("llm-secret");
    expect(decryptSecret(stored.sync.secretKey)).toBe("sync-secret");
  });

  it("allows repository local extension ids in profile extension maps", () => {
    const normalized = normalizeProfileExtensionMap({
      local_abcdefgh: true,
      aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: false,
    });
    expect(normalized.local_abcdefgh).toBe(true);
    expect(normalized.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa).toBe(false);
    expect(() => normalizeProfileExtensionMap({ local_bad: true })).toThrow(/Invalid extension ID/);
  });

  it("persists and reads back proxy config", () => {
    addProxy("test-proxy", { type: "socks5", host: "10.0.0.1", port: 1080, username: "user", password: "pass" });
    const stored = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    expect(stored.proxies["test-proxy"].type).toBe("socks5");
    expect(stored.proxies["test-proxy"].host).toBe("10.0.0.1");

    const listed = getProxyList();
    const found = listed.find((p) => p.name === "test-proxy");
    expect(found).toBeDefined();
    expect(found!.config.hasAuth).toBe(true);
    expect((found!.config as any).password).toBeUndefined();
  });

  it("stamps updatedAt on proxy/profile edits and preserves it across saves", () => {
    addProxy("ts-proxy", { type: "http", host: "10.0.0.1", port: 8080 });
    const t1 = getConfig().proxies["ts-proxy"].updatedAt;
    expect(typeof t1).toBe("number");

    // An unrelated save must not strip the timestamp (normalize preserves it).
    const cfg = getConfig();
    cfg.llm = { provider: "openai", apiKey: "sk-x", model: "mock" };
    saveConfig(cfg);
    expect(getConfig().proxies["ts-proxy"].updatedAt).toBe(t1);

    // updateProxy bumps it forward.
    expect(updateProxy("ts-proxy", { type: "http", host: "10.0.0.2", port: 8081 })).toBe(true);
    const t2 = getConfig().proxies["ts-proxy"].updatedAt;
    expect(typeof t2).toBe("number");
    expect(t2).toBeGreaterThanOrEqual(t1);

    // Profile edits stamp updatedAt too.
    const pc = getConfig();
    pc.browserProfiles = pc.browserProfiles || {};
    pc.browserProfiles["cb_ts"] = { name: "ts", fingerprintMode: "managed", fingerprintSeed: 123, platform: "windows" } as any;
    saveConfig(pc);
    setProfileMeta("cb_ts", { name: "ts-renamed" });
    const pt = getConfig().browserProfiles["cb_ts"].updatedAt;
    expect(typeof pt).toBe("number");
  });

  it("getProxy returns redacted config without password", () => {
    addProxy("auth-proxy", { type: "http", host: "1.2.3.4", port: 3128, username: "u", password: "p" });
    const proxy = getProxy("auth-proxy");
    expect(proxy).not.toBeNull();
    expect(proxy!.host).toBe("1.2.3.4");
    expect(proxy!.hasAuth).toBe(true);
    expect((proxy as any).password).toBeUndefined();
  });

  it("getProxySecret decrypts stored authenticated proxy passwords for detection", () => {
    addProxy("auth-detect", { type: "http", host: "1.2.3.4", port: 3128, username: "u", password: "plain-secret" });
    const stored = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    expect(stored.proxies["auth-detect"].password).toMatch(/^v2:/);
    expect(stored.proxies["auth-detect"].password).not.toBe("plain-secret");

    const proxy = getProxySecret("auth-detect");
    expect(proxy).not.toBeNull();
    expect(proxy!.username).toBe("u");
    expect(proxy!.password).toBe("plain-secret");
  });

  it("deleteProxy removes the entry", () => {
    addProxy("del-me", { type: "http", host: "8.8.8.8", port: 80 });
    expect(deleteProxy("del-me")).toBe(true);
    expect(getProxy("del-me")).toBeNull();
  });

  it("persists proxy detection cache and migrates/clears it with proxy changes", () => {
    addProxy("geo-proxy", { type: "http", host: "8.8.8.8", port: 80 });
    setProxyDetection("geo-proxy", {
      detectedAt: Date.now(),
      success: true,
      exitIp: "8.8.8.8",
      country: "United States",
      countryCode: "US",
      timezone: "America/New_York",
      provider: "unit",
      latencyMs: 12,
      error: null,
    });
    expect(getProxyDetection("geo-proxy")?.countryCode).toBe("US");
    reloadConfig();
    expect(getProxyDetection("geo-proxy")?.timezone).toBe("America/New_York");

    expect(renameProxy("geo-proxy", "geo-renamed", { type: "http", host: "8.8.8.8", port: 80 })).toBe(true);
    expect(getProxyDetection("geo-proxy")).toBeNull();
    expect(getProxyDetection("geo-renamed")?.countryCode).toBe("US");

    expect(updateProxy("geo-renamed", { type: "http", host: "1.1.1.1", port: 80 })).toBe(true);
    expect(getProxyDetection("geo-renamed")).toBeNull();
  });

  it("drops stale proxy detection cache when rename also changes endpoint", () => {
    addProxy("geo-old", { type: "http", host: "8.8.8.8", port: 80 });
    setProxyDetection("geo-old", {
      detectedAt: Date.now(), success: true, exitIp: "8.8.8.8", country: "United States", countryCode: "US",
      timezone: "America/New_York", provider: "unit", latencyMs: 12, error: null,
    });
    expect(renameProxy("geo-old", "geo-new", { type: "http", host: "1.1.1.1", port: 80 })).toBe(true);
    expect(getProxyDetection("geo-old")).toBeNull();
    expect(getProxyDetection("geo-new")).toBeNull();
  });

  it("drops stale proxy detection cache on same-name rename with changed endpoint", () => {
    addProxy("geo-same", { type: "http", host: "8.8.8.8", port: 80 });
    setProxyDetection("geo-same", {
      detectedAt: Date.now(), success: true, exitIp: "8.8.8.8", country: "United States", countryCode: "US",
      timezone: "America/New_York", provider: "unit", latencyMs: 12, error: null,
    });
    expect(renameProxy("geo-same", "geo-same", { type: "http", host: "1.1.1.1", port: 80 })).toBe(true);
    expect(getProxyDetection("geo-same")).toBeNull();
  });

  it("keeps proxy detection cache on equivalent authenticated proxy update", () => {
    addProxy("geo-auth", { type: "http", host: "8.8.8.8", port: 80, username: "u", password: "secret" });
    setProxyDetection("geo-auth", {
      detectedAt: Date.now(), success: true, exitIp: "8.8.8.8", country: "United States", countryCode: "US",
      timezone: "America/New_York", provider: "unit", latencyMs: 12, error: null,
    });
    expect(updateProxy("geo-auth", { type: "http", host: "8.8.8.8", port: 80, username: "u" })).toBe(true);
    expect(getProxyDetection("geo-auth")?.countryCode).toBe("US");
  });

  it("does not persist stale async proxy detection when config changed", () => {
    addProxy("geo-async", { type: "http", host: "8.8.8.8", port: 80 });
    updateProxy("geo-async", { type: "http", host: "1.1.1.1", port: 80 });
    const ok = setProxyDetectionIfCurrent("geo-async", { type: "http", host: "8.8.8.8", port: 80 }, {
      detectedAt: Date.now(), success: true, exitIp: "8.8.8.8", country: "United States", countryCode: "US",
      timezone: "America/New_York", provider: "unit", latencyMs: 12, error: null,
    });
    expect(ok).toBe(false);
    expect(getProxyDetection("geo-async")).toBeNull();
  });

  it("ignores invalid proxy detection cache entries on reload", () => {
    addProxy("geo-valid", { type: "http", host: "8.8.8.8", port: 80 });
    const cfg = getConfig();
    (cfg as any).proxyDetections = {
      "__proto__": { detectedAt: Date.now(), success: true },
      "geo-valid": { detectedAt: "bad", success: true, latencyMs: "bad" },
    };
    fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2));
    reloadConfig();
    expect(getConfig().proxies["geo-valid"]).toBeTruthy();
    expect(getProxyDetection("__proto__")).toBeNull();
  });

  it("setDefaultProxyName changes the default", () => {
    addProxy("primary", { type: "http", host: "1.1.1.1", port: 8080 });
    expect(setDefaultProxyName("primary")).toBe(true);
    expect(getConfig().defaultProxy).toBe("primary");
  });

  it("resolveProfileProxy returns correct mode/config", () => {
    addProxy("work", { type: "socks5h", host: "6.6.6.6", port: 1080 });
    addProxy("primary", { type: "http", host: "1.1.1.1", port: 8080 });
    setDefaultProxyName("primary");

    const cfg = getConfig();
    cfg.browserProfiles["cb_profile_a"] = {
      name: "Profile A",
      proxyMode: "named",
      proxyName: "work",
      fingerprintSeed: 12345,
      platform: "windows",
      syncedAt: null,
      syncStatus: "never",
      lastModified: Date.now(),
    };
    cfg.browserProfiles["cb_profile_b"] = {
      name: "Profile B",
      proxyMode: "none",
      fingerprintSeed: 54321,
      platform: "macos",
      syncedAt: null,
      syncStatus: "never",
      lastModified: Date.now(),
    };
    cfg.browserProfiles["cb_profile_c"] = {
      name: "Profile C",
      proxyMode: "default",
      fingerprintSeed: 99999,
      platform: "windows",
      syncedAt: null,
      syncStatus: "never",
      lastModified: Date.now(),
    };
    saveConfig(cfg);

    const resolvedNamed = resolveProfileProxy("cb_profile_a");
    expect(resolvedNamed.mode).toBe("named");
    expect(resolvedNamed.name).toBe("work");
    expect(resolvedNamed.config).not.toBeNull();

    const resolvedNone = resolveProfileProxy("cb_profile_b");
    expect(resolvedNone.mode).toBe("none");
    expect(resolvedNone.config).toBeNull();

    const resolvedDefault = resolveProfileProxy("cb_profile_c");
    expect(resolvedDefault.mode).toBe("default");
    expect(resolvedDefault.name).toBe("primary"); // because we set primary as default
  });

  it("normalizes corrupt config to defaults and backs up the original", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{{{corrupt json}}}", "utf-8");

    reloadConfig();
    const cfg = getConfig();
    expect(cfg.version).toBe(4);
    // A .bak file should be created
    const bakFiles = fs.readdirSync(path.dirname(configPath)).filter((f) => f.endsWith(".bak"));
    expect(bakFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("relocates extension repository paths without discarding profiles or proxies", () => {
    const configPath = getConfigPath();
    const extId = "local_abcdefgh";
    const expectedPath = path.join(TEST_USER_DATA, "extension-repository", extId, "current");
    fs.mkdirSync(expectedPath, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      version: 3,
      defaultProxy: "migrated-proxy",
      proxies: {
        "migrated-proxy": { type: "http", host: "127.0.0.1", port: 8080 },
      },
      browserProfiles: {
        cb_migrated_profile: {
          name: "Migrated Profile",
          fingerprintSeed: 12345,
          platform: "windows",
          proxyMode: "named",
          proxyName: "migrated-proxy",
        },
      },
      extensionRepository: {
        [extId]: {
          id: extId,
          name: "Migrated Extension",
          version: "1.0.0",
          description: "",
          source: "local",
          unpackedPath: `/old/app-data/extension-repository/${extId}/current`,
          packageHash: "a".repeat(128),
          manifestHash: "b".repeat(128),
          shared: false,
          tags: [],
          addedAt: 1,
          updatedAt: 1,
        },
      },
    }), "utf-8");

    reloadConfig();
    const cfg = getConfig();
    expect(cfg.browserProfiles.cb_migrated_profile.name).toBe("Migrated Profile");
    expect(cfg.proxies["migrated-proxy"].port).toBe(8080);
    expect(cfg.extensionRepository[extId].unpackedPath).toBe(expectedPath);
    expect(fs.readdirSync(TEST_USER_DATA).filter((f) => f.endsWith(".bak"))).toEqual([]);
  });

  it("cross-platform directories point to userData", () => {
    reloadConfig();
    expect(getAppDataDir()).toBe(TEST_USER_DATA);
    expect(getProfilesDir()).toBe(path.join(TEST_USER_DATA, "profiles"));
    expect(getConfigPath()).toBe(path.join(TEST_USER_DATA, "config.json"));
  });

  it("rejects unknown proxy names and default proxy deletion", () => {
    expect(deleteProxy("default")).toBe(false);
    expect(deleteProxy("nonexistent")).toBe(false);
    expect(() => addProxy("__proto__", { type: "http", host: "1.1.1.1", port: 80 })).toThrow();
  });

  it("persists fingerprint metadata in profiles", () => {
    const cfg = getConfig();
    cfg.browserProfiles["cb_fp_test"] = {
      name: "Fingerprint Test",
      tags: [" ecommerce ", "ai", "ecommerce", ""],
      proxyMode: "default",
      fingerprintMode: "off",
      browserVersion: "149.0.7827.22",
      allowThirdPartyCookies: true,
      fingerprintSeed: 77777,
      platform: "windows",
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      webrtcMode: "altered",
      webrtcIp: "10.10.10.10",
      geolocationMode: "custom",
      geolocationLatitude: 31.2304,
      geolocationLongitude: 121.4737,
      geolocationAccuracy: 25,
      gpuVendor: "Google Inc.",
      gpuRenderer: "ANGLE (AMD Radeon RX 580)",
      hardwareConcurrency: 8,
      deviceMemory: 16,
      screenWidth: 2560,
      screenHeight: 1440,
      storageQuota: null,
      taskbarHeight: 48,
      fontsDir: null,
      syncedAt: null,
      syncStatus: "never",
      lastModified: Date.now(),
    };
    saveConfig(cfg);
    reloadConfig();

    const readBack = getConfig().browserProfiles["cb_fp_test"];
    expect(readBack.fingerprintMode).toBe("off");
    expect(readBack.browserVersion).toBe("149.0.7827.22");
    expect(readBack.allowThirdPartyCookies).toBe(true);
    expect(readBack.fingerprintSeed).toBe(77777);
    expect(readBack.timezone).toBe("Asia/Shanghai");
    expect(readBack.webrtcMode).toBe("altered");
    expect(readBack.geolocationMode).toBe("custom");
    expect(readBack.geolocationLatitude).toBe(31.2304);
    expect(readBack.geolocationLongitude).toBe(121.4737);
    expect(readBack.geolocationAccuracy).toBe(25);
    expect(readBack.gpuVendor).toBe("Google Inc.");
    expect(readBack.hardwareConcurrency).toBe(8);
    expect(readBack.deviceMemory).toBe(16);
    expect(readBack.screenWidth).toBe(2560);
    expect(readBack.tags).toEqual(["ecommerce", "ai"]);
  });
});

describe("Agent Run normalization", () => {
  beforeEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    reloadConfig();
  });
  afterEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    reloadConfig();
  });

  it("persists agentRuns through save/reload", () => {
    const cfg = getConfig();
    cfg.agentRuns = [{
      id: "run_abc123",
      name: "test run",
      source: { type: "chat", conversationId: "c1" },
      status: "done",
      startedAt: 1000,
      finishedAt: 2000,
      steps: [{ id: "step_0", tool: "http_request", args: { url: "https://x" }, result: { ok: true }, ok: true, durationMs: 50, timestamp: 1100 }],
      variables: { token: "v1" },
    }];
    saveConfig(cfg);
    reloadConfig();
    const back = getConfig().agentRuns!;
    expect(back.length).toBe(1);
    expect(back[0].id).toBe("run_abc123");
    expect(back[0].status).toBe("done");
    expect(back[0].steps[0].tool).toBe("http_request");
    expect(back[0].variables.token).toBe("v1");
  });

  it("marks stale running runs as error on reload", () => {
    const cfg = getConfig();
    cfg.agentRuns = [{
      id: "run_stale", name: "x", source: { type: "chat" }, status: "running",
      startedAt: 1, steps: [], variables: {},
    }];
    saveConfig(cfg);
    reloadConfig();
    const back = getConfig().agentRuns![0];
    expect(back.status).toBe("error");
    expect(back.finishedAt).toBeGreaterThan(0);
  });

  it("drops runs with invalid IDs", () => {
    const cfg = getConfig();
    cfg.agentRuns = [
      { id: "run_ok1", name: "a", source: { type: "chat" }, status: "done", startedAt: 1, steps: [], variables: {} },
      { id: "BAD_ID", name: "b", source: { type: "chat" }, status: "done", startedAt: 1, steps: [], variables: {} },
    ];
    saveConfig(cfg);
    reloadConfig();
    expect(getConfig().agentRuns!.length).toBe(1);
  });

  it("redacts secret-like keys in args/results", () => {
    const cfg = getConfig();
    cfg.agentRuns = [{
      id: "run_secret", name: "x", source: { type: "chat" }, status: "done", startedAt: 1,
      steps: [{
        id: "step_0", tool: "http_request",
        args: { url: "https://x", headers: { Authorization: "Bearer SECRET", "X-API-Key": "k", "x-safe": "ok" } },
        result: { body: "data" }, ok: true, durationMs: 1, timestamp: 1,
      }],
      variables: {},
    }];
    saveConfig(cfg);
    reloadConfig();
    const step = getConfig().agentRuns![0].steps[0];
    const headers = (step.args as any).headers;
    expect(headers.Authorization).toBe("[REDACTED]");
    expect(headers["X-API-Key"]).toBe("[REDACTED]");
    expect(headers["x-safe"]).toBe("ok");
  });

  it("caps runs to 200 and truncates long strings", () => {
    const cfg = getConfig();
    cfg.agentRuns = Array.from({ length: 250 }, (_, i) => ({
      id: "run_" + i, name: "x".repeat(1000), source: { type: "chat" }, status: "done", startedAt: i, steps: [], variables: {},
    }));
    saveConfig(cfg);
    reloadConfig();
    const back = getConfig().agentRuns!;
    expect(back.length).toBe(200);
    // newest 200 preserved (250-50..249 → run_50..run_249)
    expect(back[0].id).toBe("run_50");
    expect(back[0].name.length).toBeLessThanOrEqual(160);
  });

  it("normalizes agentFs config", () => {
    const cfg = getConfig();
    cfg.agentFs = { mode: "allowlist" as any, allowlist: ["/a/b", "/a/b", "  /c  ", ""] };
    saveConfig(cfg);
    reloadConfig();
    const fs2 = getConfig().agentFs!;
    expect(fs2.mode).toBe("allowlist");
    expect(fs2.allowlist).toEqual(["/a/b", "/c"]);
  });

  it("defaults agentFs to sandbox", () => {
    expect(getConfig().agentFs?.mode).toBe("sandbox");
    expect(getConfig().agentFs?.allowlist).toEqual([]);
  });

  it("persists and caps WebRTC diagnostics history per profile", () => {
    const dirId = "ab_webrtc_test";
    const entry = {
      at: 123456,
      success: true,
      rtcAvailable: true,
      candidates: ["candidate:1 typ host udp 192.0.2.1"],
      mdnsHosts: [],
      hostIps: ["192.0.2.1"],
      srflxIps: [],
      connectionState: "connected",
      rttMs: 42,
      error: null,
      summary: "⚠️ 暴露本地 IP: 192.0.2.1",
    };
    setWebRtcDiagnostics(dirId, [entry]);
    reloadConfig();
    expect(getWebRtcDiagnostics(dirId).length).toBe(1);
    expect(getWebRtcDiagnostics(dirId)[0].rttMs).toBe(42);

    // history capped at MAX_WEBRTC_DIAG_HISTORY (20)
    const many = Array.from({ length: 25 }, (_, i) => ({ ...entry, at: i, summary: "s" + i }));
    setWebRtcDiagnostics(dirId, many);
    reloadConfig();
    const back = getWebRtcDiagnostics(dirId);
    expect(back.length).toBe(20);
    expect(back[0].at).toBe(5);
    expect(back[back.length - 1].at).toBe(24);

    clearWebRtcDiagnostics(dirId);
    reloadConfig();
    expect(getWebRtcDiagnostics(dirId).length).toBe(0);
  });

  it("sanitizes and persists the Web App (appUrl) setting", () => {
    expect(sanitizeAppUrl("  https://shop.example.com/dash  ")).toBe("https://shop.example.com/dash");
    expect(sanitizeAppUrl("data:text/html,hello")).toMatch(/^data:/);
    expect(sanitizeAppUrl(null)).toBeNull();
    expect(sanitizeAppUrl("")).toBeNull();
    expect(() => sanitizeAppUrl("file:///etc/passwd")).toThrow(/http\/https\/data/);
    expect(() => sanitizeAppUrl("chrome://settings")).toThrow(/http\/https\/data/);

    const dirId = "ab_webapp_test";
    setProfileMeta(dirId, { name: "WebApp", appUrl: "https://shop.example.com/dash" });
    reloadConfig();
    expect(getConfig().browserProfiles![dirId].appUrl).toBe("https://shop.example.com/dash");

    setProfileMeta(dirId, { appUrl: null });
    reloadConfig();
    expect(getConfig().browserProfiles![dirId].appUrl).toBeNull();
  });
});
