// MCP team-RBAC gates (R2 #50): mutation-class tools must enforce the same
// role checks as their REST equivalents.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const fixture = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => fixture.userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (p: string) => Buffer.from(p, "utf8"),
    decryptString: (e: Buffer) => Buffer.from(e).toString("utf8"),
  },
}));

import { getConfig } from "../../src/main/services/config-manager.js";
import { requireSettingsMutation } from "../../src/main/services/team.js";

describe("mcp team RBAC (via shared team gate)", () => {
  beforeAll(() => {
    fixture.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rbac-test-"));
  });

  afterAll(() => {
    if (!fixture.userDataDir) return;
    const entry = fs.lstatSync(fixture.userDataDir);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Refusing to clean a replaced RBAC fixture directory");
    fs.rmSync(fixture.userDataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const cfg = getConfig() as any;
    delete cfg.team;
  });

  it("allows mutation tools when no team workspace is initialized", () => {
    expect(requireSettingsMutation().ok).toBe(true);
  });

  it("denies viewer-role mutation when a team workspace is enabled", async () => {
    const cfg = getConfig() as any;
    const { getLocalIdentity } = await import("../../src/main/services/team.js");
    const me = getLocalIdentity();
    cfg.team = {
      enabled: true,
      members: [{ deviceId: me.deviceId, role: "viewer", name: "v" }],
    };
    expect(requireSettingsMutation().ok).toBe(false);
  });
});
