// R9 P1-4: env-risk snapshots persist per profile (mirrors webrtc diag).
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("electron", () => {
  const path = require("node:path");
  const os = require("node:os");
  const TEST_DATA = path.join(os.tmpdir(), "agent-browser-env-risk-test");
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
  getEnvRiskDiagnostics,
  setEnvRiskDiagnostics,
  clearEnvRiskDiagnostics,
  reloadConfig,
} from "../../src/main/services/config-manager.js";

beforeEach(() => {
  reloadConfig();
});

describe("env-risk diagnostics persistence (R9 P1-4)", () => {
  it("stores and reads back snapshots per profile", () => {
    const entry: any = {
      at: 123, ok: false, high: 2, medium: 1, summary: "dns-resolver-leak, cn-fonts-exposed",
      findings: [{ severity: "high", code: "dns-resolver-leak", message: "m", fix: "f" }],
      resolvers: ["114.114.114.114"], cnFonts: ["SimSun"],
    };
    setEnvRiskDiagnostics("prof1", [entry]);
    const back = getEnvRiskDiagnostics("prof1");
    expect(back.length).toBe(1);
    expect(back[0].summary).toContain("dns-resolver-leak");
    expect(back[0].findings[0].code).toBe("dns-resolver-leak");
    expect(getEnvRiskDiagnostics("other")).toEqual([]);
  });

  it("caps history at 20 entries", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ at: i, ok: true, high: 0, medium: 0, summary: "s" + i, findings: [], resolvers: [], cnFonts: [] }));
    setEnvRiskDiagnostics("prof1", many as any);
    expect(getEnvRiskDiagnostics("prof1").length).toBe(20);
    expect(getEnvRiskDiagnostics("prof1")[19].at).toBe(29);
  });

  it("clears per profile", () => {
    setEnvRiskDiagnostics("prof1", [{ at: 1, ok: true, high: 0, medium: 0, summary: "x", findings: [], resolvers: [], cnFonts: [] }] as any);
    clearEnvRiskDiagnostics("prof1");
    expect(getEnvRiskDiagnostics("prof1")).toEqual([]);
  });
});
