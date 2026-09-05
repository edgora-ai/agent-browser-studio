// R8 P0-3 follow-through / P1-12: load-bearing fields must survive a
// save round-trip, and unknown top-level keys must be dropped (strict
// whitelist) instead of silently persisted.
import { vi, describe, it, expect } from "vitest";

vi.mock("electron", () => {
  const path = require("node:path");
  const os = require("node:os");
  const TEST_DATA = path.join(os.tmpdir(), "agent-browser-config-whitelist-test");
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

import { mergeConfigForStore } from "../../src/main/services/config-manager.js";

describe("mergeConfig whitelist (R8)", () => {
  it("preserves load-bearing scalar/object fields across a round-trip", () => {
    const parsed: any = {
      version: 4,
      deviceId: "dev-1",
      deviceName: "mbp",
      blockOnConsistencyConflict: true,
      blockOnProxyRisk: true,
      blockOnFingerprintDrift: false,
      blockOnEnvironmentRisk: true,
      blockOnInjectionProbe: false,
      blockOnUnhealthyProxy: true,
      maxConcurrentJobs: 7,
      managedSecureDnsUrl: "https://dns.example/dns-query",
      team: {
        name: "ws",
        ownerDeviceId: "dev-1",
        members: [{ deviceId: "dev-1", name: "a", role: "owner", addedAt: 1 }],
        enabled: true,
        updatedAt: 2,
      },
    };
    const merged: any = mergeConfigForStore(parsed, "load");
    expect(merged.deviceId).toBe("dev-1");
    expect(merged.deviceName).toBe("mbp");
    expect(merged.blockOnConsistencyConflict).toBe(true);
    expect(merged.blockOnProxyRisk).toBe(true);
    expect(merged.blockOnFingerprintDrift).toBe(false);
    expect(merged.blockOnEnvironmentRisk).toBe(true);
    expect(merged.blockOnInjectionProbe).toBe(false);
    expect(merged.blockOnUnhealthyProxy).toBe(true);
    expect(merged.maxConcurrentJobs).toBe(7);
    expect(merged.managedSecureDnsUrl).toBe("https://dns.example/dns-query");
    expect(merged.team.members[0].deviceId).toBe("dev-1");
    // Save path must keep them too.
    const resaved: any = mergeConfigForStore(merged, "save");
    expect(resaved.deviceId).toBe("dev-1");
    expect(resaved.team.members[0].deviceId).toBe("dev-1");
    expect(resaved.maxConcurrentJobs).toBe(7);
  });

  it("drops unknown top-level keys instead of persisting them", () => {
    const merged: any = mergeConfigForStore({ version: 4, evil: 1, totallyUnknown: { a: 1 } }, "load");
    expect((merged as any).evil).toBeUndefined();
    expect((merged as any).totallyUnknown).toBeUndefined();
  });

  it("clamps maxConcurrentJobs into range", () => {
    expect((mergeConfigForStore({ maxConcurrentJobs: 999 }, "load") as any).maxConcurrentJobs).toBe(32);
    expect((mergeConfigForStore({ maxConcurrentJobs: 0 }, "load") as any).maxConcurrentJobs).toBe(1);
  });

  it("rejects malformed team manifests", () => {
    expect((mergeConfigForStore({ team: { members: [] } }, "load") as any).team).toBeUndefined();
    expect((mergeConfigForStore({ team: "nope" }, "load") as any).team).toBeUndefined();
  });
});
