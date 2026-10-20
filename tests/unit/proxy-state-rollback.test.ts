import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ProxyConfig, ProxyDetectionCacheEntry } from "../../src/main/types.js";

const fixture = vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-state-rollback-"));
  return { root, userData: path.join(root, "app"), failRename: false, renameCalls: 0, owner: fs.lstatSync(root) };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      fixture.renameCalls++;
      if (fixture.failRename) throw Object.assign(new Error("synthetic rename failure"), { code: "EIO" });
      return actual.renameSync(from, to);
    },
  };
});
vi.mock("node:os", async (original) => ({
  ...await original<typeof import("node:os")>(), hostname: () => "synthetic-proxy-fixture", homedir: () => fixture.root,
}));
vi.mock("node:child_process", () => ({ spawn: () => { throw new Error("Unexpected subprocess"); }, execFileSync: () => { throw new Error("Unexpected subprocess"); } }));
vi.mock("node:dns", () => ({ lookup: () => { throw new Error("Unexpected DNS access"); } }));
vi.mock("node:dns/promises", () => ({ lookup: () => { throw new Error("Unexpected DNS access"); }, resolve: () => { throw new Error("Unexpected DNS access"); } }));
vi.mock("electron", () => ({
  app: { getPath: () => fixture.userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text, "utf8"),
    decryptString: (bytes: Buffer) => bytes.toString("utf8"),
  },
}));
import {
  addProxy, deleteProxy, getConfig, getConfigPath, getProxy, getProxyDetection, getProxyHealthEntry,
  reloadConfig, renameProxy, setDefaultProxyName, setProxyDetection, updateProxy,
} from "../../src/main/services/config-manager.js";
import { clearProxyHealth, listProxyHealth, recordProxyDetection } from "../../src/main/services/proxy-health.js";

const PROXY: ProxyConfig = { type: "http", host: "fixture-proxy.invalid", port: 21789 };
const DETECTION: ProxyDetectionCacheEntry = {
  detectedAt: Date.parse("2026-10-19T00:00:00Z"), success: true, exitIp: "192.0.2.10", country: "United States",
  countryCode: "US", timezone: "America/New_York", provider: "synthetic", latencyMs: 120,
  org: null, as: null, hosting: false, isProxy: false, error: null,
};
function assertOwnedRoot() {
  const current = fs.lstatSync(fixture.root);
  expect(current.isDirectory() && !current.isSymbolicLink()).toBe(true);
  expect([current.dev, current.ino, current.uid]).toEqual([fixture.owner.dev, fixture.owner.ino, fixture.owner.uid]);
}
function stored() { return JSON.parse(fs.readFileSync(getConfigPath(), "utf8")); }
beforeEach(() => {
  fixture.failRename = false;
  assertOwnedRoot();
  fs.rmSync(fixture.userData, { recursive: true, force: true });
  reloadConfig();
  getConfig();
  addProxy("p1", PROXY);
  addProxy("p2", { ...PROXY, port: PROXY.port + 1, fallbacks: ["p1"] });
  setDefaultProxyName("p1");
  setProxyDetection("p1", DETECTION);
  recordProxyDetection("p1", { success: true, exitIp: DETECTION.exitIp, countryCode: DETECTION.countryCode, latencyMs: 120, observedAt: DETECTION.detectedAt, source: "network" });
  fixture.renameCalls = 0;
});
afterAll(() => {
  fixture.failRename = false;
  assertOwnedRoot();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

const writes: Array<[string, () => unknown]> = [
  ["equal-content add/upsert reset", () => addProxy("p1", PROXY)],
  ["endpoint update", () => updateProxy("p1", { ...PROXY, port: PROXY.port + 2 })],
  ["rename plus default/fallback references", () => renameProxy("p1", "renamed", PROXY)],
  ["delete plus default/fallback references", () => deleteProxy("p1")],
  ["default selection", () => setDefaultProxyName("p2")],
  ["detection projection", () => setProxyDetection("p1", { ...DETECTION, exitIp: "198.51.100.20" })],
  ["health projection", () => recordProxyDetection("p1", { success: false, error: "synthetic failure", observedAt: DETECTION.detectedAt, source: "network" })],
  ["named health clear", () => clearProxyHealth("p1")],
  ["all health clear", () => clearProxyHealth()],
];
describe("proxy state commit boundaries on real owned disk", () => {
  it.each(writes)("keeps memory and actual disk together when %s cannot commit", (_label, operation) => {
    const beforeDisk = fs.readFileSync(getConfigPath());
    const beforeMemory = structuredClone(getConfig());
    fixture.failRename = true;
    try {
      expect(operation).toThrow("synthetic rename failure");
    } finally {
      fixture.failRename = false;
    }
    expect(fixture.renameCalls, "one failed transaction is not retried with a stale config snapshot").toBe(1);
    expect(fs.readFileSync(getConfigPath())).toEqual(beforeDisk);
    expect(getConfig()).toEqual(beforeMemory);
    reloadConfig();
    expect(stored()).toEqual(JSON.parse(beforeDisk.toString("utf8")));
    expect(getProxy("p1")).toMatchObject(PROXY);
    expect(getProxyDetection("p1")).toEqual(beforeMemory.proxyDetections!.p1);
    expect(getProxyHealthEntry("p1")).toEqual(beforeMemory.proxyHealth!.p1);
  });

  it("writes, independently reads, reloads and searches a renamed proxy's bound projections", () => {
    expect(renameProxy("p1", "renamed", PROXY)).toBe(true);
    const disk = stored();
    expect(disk.proxies).not.toHaveProperty("p1");
    expect(disk.proxies.renamed).toMatchObject(PROXY);
    expect(disk.proxyDetections.renamed).toMatchObject({ exitIp: DETECTION.exitIp });
    expect(disk.proxyHealth.renamed).toMatchObject({ proxyName: "renamed", checks: 1, successes: 1 });
    expect(disk.defaultProxy).toBe("renamed");
    expect(disk.proxies.p2.fallbacks).toEqual(["renamed"]);
    reloadConfig();
    expect(getProxy("renamed")).toMatchObject(PROXY);
    expect(getProxyDetection("renamed")).toMatchObject({ exitIp: DETECTION.exitIp });
    expect(listProxyHealth().find((entry) => entry.proxyName === "renamed")).toMatchObject({ checks: 1 });
    expect(getProxy("p1")).toBeNull();
    expect(getProxyHealthEntry("p1")).toBeNull();
  });

  it("clears only the requested health scope and verifies the result after reload", () => {
    recordProxyDetection("p2", { success: false, error: "synthetic failure", observedAt: DETECTION.detectedAt, source: "network" });
    const before = stored();
    expect(clearProxyHealth("p1")).toBe(1);
    const disk = stored();
    expect(disk.proxyHealth).not.toHaveProperty("p1");
    expect(disk.proxyHealth.p2).toEqual(before.proxyHealth.p2);
    expect(disk.proxyDetections.p1).toEqual(before.proxyDetections.p1);
    reloadConfig();
    expect(getProxyHealthEntry("p1")).toBeNull();
    expect(listProxyHealth().map((entry) => entry.proxyName)).toEqual(["p2"]);
  });
});
