// R0925-05 regression: launch safety gates are a local security policy and
// require member+ when a team workspace is enabled. A denied viewer write
// must leave every persisted gate byte-identical; the read path stays open.
import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(
  os.tmpdir(),
  `agent-browser-gates-rbac-${process.pid}-${Date.now()}`,
);

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  gate: { ok: true } as { ok: boolean; error?: string },
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: any) => h.handlers.set(name, handler) },
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
  dialog: {},
}));
vi.mock("../../src/main/services/team.js", () => ({
  requireSettingsMutation: () => h.gate,
}));

import { registerSettingsHandlers } from "../../src/main/ipc/settings.js";
import { getConfig, saveConfig, reloadConfig, getConfigPath } from "../../src/main/services/config-manager.js";

registerSettingsHandlers();

const ALL_GATES = ["blockOnConsistencyConflict", "blockOnProxyRisk", "blockOnFingerprintDrift", "blockOnEnvironmentRisk"] as const;

function readDiskGates(): Record<string, unknown> {
  const raw = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
  return Object.fromEntries(ALL_GATES.map((k) => [k, raw[k]]));
}

describe("settings:launch-gates:set role gate (R0925-05)", () => {
  beforeEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    reloadConfig();
    const cfg = getConfig() as any;
    for (const k of ALL_GATES) cfg[k] = true;
    saveConfig(cfg);
    h.gate = { ok: true };
  });
  afterAll(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  it("member+ can update gates and the values persist + read back", async () => {
    const r = await h.handlers.get("settings:launch-gates:set")!(null, { blockOnProxyRisk: false });
    expect(r).toEqual({ success: true });
    expect(readDiskGates().blockOnProxyRisk).toBe(false);
    reloadConfig();
    const readback = await h.handlers.get("settings:launch-gates")!(null);
    expect(readback.blockOnProxyRisk).toBe(false);
    expect(readback.blockOnConsistencyConflict).toBe(true);
  });

  it("viewer is denied BEFORE any config write — all four gates stay true on disk", async () => {
    h.gate = { ok: false, error: "requires member role (current: viewer)" };
    const r = await h.handlers.get("settings:launch-gates:set")!(null, {
      blockOnConsistencyConflict: false,
      blockOnProxyRisk: false,
      blockOnFingerprintDrift: false,
      blockOnEnvironmentRisk: false,
    });
    expect(r).toEqual({ success: false, error: "requires member role (current: viewer)" });
    const disk = readDiskGates();
    for (const k of ALL_GATES) expect(disk[k], k).toBe(true);
    reloadConfig();
    const readback = await h.handlers.get("settings:launch-gates")!(null);
    expect(readback.blockOnConsistencyConflict).toBe(true);
    expect(readback.blockOnProxyRisk).toBe(true);
    expect(readback.blockOnFingerprintDrift).toBe(true);
    expect(readback.blockOnEnvironmentRisk).toBe(true);
  });

  it("a denied viewer keeps the read-only launch-gates getter", async () => {
    h.gate = { ok: false, error: "requires member role (current: viewer)" };
    const readback = await h.handlers.get("settings:launch-gates")!(null);
    expect(readback.blockOnConsistencyConflict).toBe(true);
  });
});
