// Unit tests for health-based proxy rotation (fallback selection, resolution,
// rotation counters, and CRUD fallback-reference maintenance).
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-proxy-rotation-test");

vi.mock("electron", () => {
  const nodePath = require("node:path");
  const nodeOs = require("node:os");
  const TEST_DATA = nodePath.join(nodeOs.tmpdir(), "agent-browser-proxy-rotation-test");
  return {
    app: {
      getPath: (name: string) => {
        if (name === "userData") return TEST_DATA;
        return "/tmp";
      },
    },
  };
});

import {
  addProxy,
  reloadConfig,
  saveConfig,
  getConfig,
  renameProxy,
  deleteProxy,
  resolveProfileProxy,
  getProxyRotationInfo,
} from "../../src/main/services/config-manager.js";
import { recordProxyDetection, recordProxyRotation } from "../../src/main/services/proxy-health.js";

function bindProfile(dirId: string, proxyName: string): void {
  const cfg = getConfig();
  cfg.browserProfiles[dirId] = {
    name: dirId,
    proxyMode: "named",
    proxyName,
    fingerprintSeed: 12345,
    platform: "windows",
    syncedAt: null,
    syncStatus: "never",
    lastModified: Date.now(),
  };
  saveConfig(cfg);
}

function setFallbacks(name: string, fallbacks: string[]): void {
  const cfg = getConfig();
  cfg.proxies[name].fallbacks = fallbacks;
  saveConfig(cfg);
}

function makeUnhealthy(name: string): void {
  for (let i = 0; i < 3; i++) recordProxyDetection(name, { success: false, error: "timeout" });
}

describe("proxy rotation", () => {
  beforeEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    reloadConfig();
    addProxy("p1", { type: "http", host: "127.0.0.1", port: 7890 });
    addProxy("p2", { type: "http", host: "127.0.0.1", port: 7891 });
    addProxy("p3", { type: "http", host: "127.0.0.1", port: 7892 });
    bindProfile("prof", "p1");
  });

  it("resolves to the healthy fallback when the primary is in cooldown", () => {
    setFallbacks("p1", ["p2"]);
    makeUnhealthy("p1");
    const r = resolveProfileProxy("prof");
    expect(r.name).toBe("p2");
    expect(r.rotatedFrom).toBe("p1");
    expect(r.rotationReason).toContain("冷却");
    expect(r.config?.port).toBe(7891);
  });

  it("keeps the primary when it is healthy", () => {
    setFallbacks("p1", ["p2"]);
    recordProxyDetection("p1", { success: true, exitIp: "1.2.3.4", latencyMs: 100 });
    const r = resolveProfileProxy("prof");
    expect(r.name).toBe("p1");
    expect(r.rotatedFrom).toBeNull();
    expect(r.rotationReason).toBeNull();
  });

  it("does not rotate when unhealthy but no fallback is configured (reason still reported)", () => {
    makeUnhealthy("p1");
    const r = resolveProfileProxy("prof");
    expect(r.name).toBe("p1");
    expect(r.rotatedFrom).toBeNull();
    expect(r.rotationReason).toContain("冷却");
  });

  it("skips an unhealthy fallback and picks the next healthy one", () => {
    setFallbacks("p1", ["p2", "p3"]);
    makeUnhealthy("p1");
    makeUnhealthy("p2");
    const r = resolveProfileProxy("prof");
    expect(r.name).toBe("p3");
    expect(r.rotatedFrom).toBe("p1");
  });

  it("getProxyRotationInfo reports active state, target and reason", () => {
    setFallbacks("p1", ["p2"]);
    expect(getProxyRotationInfo("p1")?.active).toBe(false);
    makeUnhealthy("p1");
    const info = getProxyRotationInfo("p1");
    expect(info?.active).toBe(true);
    expect(info?.from).toBe("p1");
    expect(info?.to).toBe("p2");
    expect(info?.reason).toContain("冷却");
    expect(getProxyRotationInfo("missing")).toBeNull();
  });

  it("recordProxyRotation increments counters on the primary entry", () => {
    recordProxyDetection("p1", { success: true, exitIp: "1.2.3.4" });
    const entry = recordProxyRotation("p1", "p2");
    expect(entry?.rotations).toBe(1);
    expect(entry?.lastRotatedTo).toBe("p2");
    expect(entry?.lastRotatedAt).toBeTruthy();
    const after = getConfig().proxyHealth?.["p1"];
    expect(after?.rotations).toBe(1);
  });

  it("renameProxy rewrites fallback references in other proxies", () => {
    setFallbacks("p1", ["p2"]);
    renameProxy("p2", "p2b", { type: "http", host: "127.0.0.1", port: 7891 });
    expect(getConfig().proxies["p1"].fallbacks).toEqual(["p2b"]);
  });

  it("deleteProxy removes the deleted proxy from fallback lists", () => {
    setFallbacks("p1", ["p2", "p3"]);
    deleteProxy("p2");
    expect(getConfig().proxies["p1"].fallbacks).toEqual(["p3"]);
  });

  it("addProxy strips self references from fallbacks", () => {
    addProxy("p9", { type: "http", host: "127.0.0.1", port: 7899, fallbacks: ["p9", "p2", "p2"] });
    expect(getConfig().proxies["p9"].fallbacks).toEqual(["p2"]);
  });
});
