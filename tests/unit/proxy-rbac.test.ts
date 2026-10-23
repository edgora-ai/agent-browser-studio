// Proxy edits were the one remaining settings surface with no team gate:
// a viewer could rewrite a proxy's host/credentials (and clear health) while
// every other mutation required member+. These tests pin the gate on each
// mutating channel and prove a denial leaves the stored config untouched.
import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TEST_USER_DATA = path.join(os.tmpdir(), `agent-browser-proxy-rbac-${process.pid}-${Date.now()}`);

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  gate: { ok: true } as { ok: boolean; error?: string },
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: any) => h.handlers.set(name, handler) },
  app: { getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"), getVersion: () => "test" },
  dialog: {},
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));
vi.mock("../../src/main/services/team.js", () => ({
  requireSettingsMutation: () => h.gate,
  requireAccountSecret: () => h.gate,
}));
vi.mock("qrcode", () => ({ default: { toDataURL: async () => "data:image/png;base64,AAAA" } }));

import { registerProxyHandlers } from "../../src/main/ipc/proxy.js";
import { getConfig, reloadConfig } from "../../src/main/services/config-manager.js";

registerProxyHandlers();

const call = (channel: string, arg?: any) => {
  const fn = h.handlers.get(channel);
  expect(fn, `${channel} must be registered`).toBeTypeOf("function");
  return fn!({}, arg);
};

const PROXY = { type: "http" as const, host: "203.0.113.10", port: 8080, username: "u", password: "p" };

beforeEach(() => {
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  reloadConfig();
  h.gate = { ok: true };
});

afterAll(() => { fs.rmSync(TEST_USER_DATA, { recursive: true, force: true }); });

describe("proxy mutations require member+", () => {
  it("denies every mutating channel for a viewer", async () => {
    await call("proxy:add", { name: "seed", config: PROXY });
    h.gate = { ok: false, error: "requires member role (current: viewer)" };

    const attempts: Array<[string, any]> = [
      ["proxy:add", { name: "added", config: PROXY }],
      ["proxy:update", { name: "seed", config: { ...PROXY, host: "198.51.100.9" } }],
      ["proxy:rename", { oldName: "seed", newName: "renamed", config: PROXY }],
      ["proxy:set-default", "seed"],
      ["proxy:set-profile", { dirId: "ab_synthetic", proxyName: "seed", mode: "named" }],
      ["proxy:delete", "seed"],
      ["proxy:health-clear", "seed"],
      ["proxy:rotate", "seed"],
    ];
    for (const [channel, arg] of attempts) {
      const res = await call(channel, arg);
      expect(res, `${channel} must be denied for a viewer`).toMatchObject({ success: false });
      expect(res.error).toContain("requires member");
    }
  });

  it("a denied viewer write leaves the stored proxy byte-for-byte unchanged", async () => {
    await call("proxy:add", { name: "seed", config: PROXY });
    const before = JSON.stringify(getConfig().proxies);
    h.gate = { ok: false, error: "requires member role (current: viewer)" };
    await call("proxy:update", { name: "seed", config: { ...PROXY, host: "198.51.100.9", password: "swapped" } });
    await call("proxy:set-default", "seed");
    expect(JSON.stringify(getConfig().proxies)).toBe(before);
  });

  it("reads stay open to a viewer", async () => {
    await call("proxy:add", { name: "seed", config: PROXY });
    h.gate = { ok: false, error: "requires member role (current: viewer)" };
    const list = await call("proxy:list");
    expect(Array.isArray(list)).toBe(true);
    expect((await call("proxy:health-get")).entries).toBeDefined();
    expect(await call("proxy:rotation-info", "seed")).toMatchObject({ success: true });
  });

  it("allows the same mutations for a member", async () => {
    await call("proxy:add", { name: "seed", config: PROXY });
    const res = await call("proxy:update", { name: "seed", config: { ...PROXY, host: "198.51.100.9" } });
    expect(res.success).toBe(true);
    expect(getConfig().proxies.seed.host).toBe("198.51.100.9");
  });
});
