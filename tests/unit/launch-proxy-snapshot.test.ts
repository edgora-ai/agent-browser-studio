import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MgmtConfig } from "../../src/main/types.js";

// Exercise the real read-only resolver/rotation code without loading userData,
// invoking a config writer, or decrypting any credential (even a fixture one).
const f = vi.hoisted(() => ({ live: {} as MgmtConfig, current: vi.fn(), decrypt: vi.fn(), path: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: f.path } }));
vi.mock("../../src/main/services/main-i18n.js", () => ({ tMain: (_key: string, fallback: string) => fallback }));
vi.mock("../../src/main/services/config/store.js", () => ({
  getCommittedConfig: f.current, readSnapshot: f.current,
  setNormalizer: vi.fn(), setAfterTransactHook: vi.fn(),
  adoptLoadedConfig: vi.fn(() => { throw new Error("No config load allowed"); }),
  transact: vi.fn(() => { throw new Error("No config writer allowed"); }),
}));
vi.mock("../../src/main/services/config/limits.js", () => ({ assertConfigSize: vi.fn() }));
vi.mock("../../src/main/services/secrets.js", () => ({
  decryptSecretOr: f.decrypt, clearLegacySecretMigrationCache: vi.fn(), usingEncryption: () => false, isEncrypted: () => false,
  encryptSecret: vi.fn(() => { throw new Error("No credential writes allowed"); }), migrateSecret: vi.fn(),
}));
vi.mock("../../src/main/services/fingerprint-baseline.js", () => ({ sanitizePortableFingerprintBaseline: vi.fn() }));
vi.mock("../../src/main/services/browser-engine.js", () => ({
  sanitizeBrowserEngine: (value: unknown) => value === "firefox" ? "firefox" : "chromium",
  normalizeManagedFirefoxVersion: (value: unknown) => value || null,
}));
vi.mock("../../src/main/services/native-chromium-manager.js", () => ({ normalizeManagedChromiumVersion: (value: unknown) => value || null }));
vi.mock("../../src/main/services/agent-run-retention.js", () => ({ cleanupNormalizedRunEvictions: vi.fn(), isOwnedRun: vi.fn(), retainAgentRuns: vi.fn() }));

import { resolveProfileProxy, resolveProfileProxySecret } from "../../src/main/services/config-manager.js";

const dirId = "ab_snapshot";
function config(suffix: string): MgmtConfig {
  return {
    deviceId: "fixture-device", deviceName: "fixture", defaultProxy: "primary",
    browserProfiles: { [dirId]: { name: "Snapshot", proxyMode: "named", proxyName: "primary" } },
    proxies: {
      primary: { type: "http", host: `primary-${suffix}.example.test`, port: 8080, fallbacks: ["fallbackA", "fallbackB"] },
      fallbackA: { type: "http", host: `fallback-a-${suffix}.example.test`, port: 8080 },
      fallbackB: { type: "http", host: `fallback-b-${suffix}.example.test`, port: 8080 },
    },
    proxyHealth: { primary: { risk: "poor", consecutiveFailures: 1 } },
  } as unknown as MgmtConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
  f.live = config("live");
  f.live.proxies.primary.fallbacks = ["fallbackB", "fallbackA"];
  f.live.proxyHealth!.fallbackA = { risk: "poor", consecutiveFailures: 1 } as any;
  f.current.mockImplementation(() => f.live);
  f.path.mockImplementation(() => { throw new Error("No userData access allowed"); });
  f.decrypt.mockImplementation(() => { throw new Error("No credential access allowed"); });
});

describe("launch proxy snapshot resolution", () => {
  it.each([resolveProfileProxy, resolveProfileProxySecret])("threads one snapshot through rotation and nested fallback health checks (%#)", (resolve) => {
    const snapshot = config("snapshot");
    const before = structuredClone(snapshot);
    const result = resolve(dirId, snapshot);
    expect(result).toMatchObject({ mode: "named", name: "fallbackA", rotatedFrom: "primary", config: { host: "fallback-a-snapshot.example.test" } });
    expect(snapshot).toEqual(before);
    expect(f.current).not.toHaveBeenCalled();
    expect(f.path).not.toHaveBeenCalled();
    expect(f.decrypt).not.toHaveBeenCalled();
  });

  it("does not let live poor health rotate a healthy snapshot proxy", () => {
    const snapshot = config("snapshot");
    snapshot.proxyHealth = {};
    expect(resolveProfileProxySecret(dirId, snapshot)).toMatchObject({ name: "primary", config: { host: "primary-snapshot.example.test" }, rotatedFrom: null });
    expect(f.current).not.toHaveBeenCalled();
  });

  it("uses the snapshot default selection rather than the live default proxy", () => {
    const snapshot = config("snapshot");
    snapshot.browserProfiles[dirId].proxyMode = "default";
    snapshot.proxyHealth = {};
    f.live.defaultProxy = "fallbackB";
    expect(resolveProfileProxySecret(dirId, snapshot)).toMatchObject({ name: "primary", config: { host: "primary-snapshot.example.test" } });
    expect(f.current).not.toHaveBeenCalled();
  });

  it.each([resolveProfileProxy, resolveProfileProxySecret])("validates a bad profile ID before touching live configuration (%#)", (resolve) => {
    expect(() => resolve("../not-a-profile")).toThrow();
    expect(f.current).not.toHaveBeenCalled();
    expect(f.path).not.toHaveBeenCalled();
  });

  it("preserves the existing live-config route when no snapshot was supplied", () => {
    expect(resolveProfileProxySecret(dirId)).toMatchObject({ name: "fallbackB", config: { host: "fallback-b-live.example.test" } });
    expect(f.current).toHaveBeenCalled();
    expect(f.path).not.toHaveBeenCalled();
    expect(f.decrypt).not.toHaveBeenCalled();
  });
});
