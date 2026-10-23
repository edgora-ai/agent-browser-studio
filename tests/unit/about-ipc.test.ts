// About dialog contract: the real app:get-build-info handler must answer with
// this binary's observed identity, and the renderer must be able to reach it
// through the preload surface.
//
// The mock here stands in for Electron only. build-info.ts, the engine root
// resolver and the manifest reader are the real modules, so a regression in
// how the payload is assembled (or a fabricated "now" stamp) fails here.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "abs-about-ipc-"));
const resources = path.join(fixture, "Contents", "Resources");
const engines = path.join(resources, "native-browsers");
fs.mkdirSync(engines, { recursive: true });
fs.writeFileSync(path.join(resources, "app.asar"), "asar");
fs.writeFileSync(path.join(engines, "Chromium.app.zip"), "zip");
fs.writeFileSync(path.join(engines, "Firefox.app.zip"), "zip");
fs.writeFileSync(
  path.join(engines, "browsers-manifest.json"),
  JSON.stringify({ platform: "mac", chromiumVersion: "152.0.7977.72", firefoxVersion: "154.0" }),
);

const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }));

vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => h.handlers.set(name, handler) },
  app: {
    getVersion: () => "1.0.1",
    getAppPath: () => path.join(fixture, "Contents", "Resources", "app.asar"),
    isPackaged: true,
    getLocale: () => "zh-CN",
    getPath: (name: string) => (name === "userData" || name === "home" ? path.join(fixture, "ud") : "/tmp"),
    quit: vi.fn(),
  },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

// Electron's `process.resourcesPath` is a runtime property; the test process
// has none, so the handler's engine lookup is pointed at the fixture through
// the resolver's documented shape rather than by patching the handler.
vi.mock("../../src/main/services/bundled-native-browsers.js", async () => ({
  bundledBrowsersRoot: (_platform: string, rp: string | null) => (rp ? path.join(rp, "native-browsers") : null),
}));

import { registerAppHandlers } from "../../src/main/ipc/app.js";

beforeAll(() => {
  registerAppHandlers();
});
afterAll(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});

function handler(): (...args: any[]) => any {
  const fn = h.handlers.get("app:get-build-info");
  expect(fn, "app:get-build-info handler must be registered").toBeTypeOf("function");
  return fn!;
}

describe("app:get-build-info", () => {
  it("returns this build's version and observed file stamps", async () => {
    const info = await handler()({});
    expect(info.version).toBe("1.0.1");
    expect(info.appId).toBe("com.ahoo.agent-browser-studio");
    expect(info.packaged).toBe(true);
    expect(info.appArchive?.path).toBe(path.join(resources, "app.asar"));
    expect(info.appArchive?.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(info.runtime.electron).toBe(process.versions.electron ?? "");
    expect(info.host.platform).toBe(process.platform);
    expect(info.locale.app).toBe("zh-CN");
  });

  it("reports the shipped engine manifest, not a fabricated installed version", async () => {
    const info = await handler()({});
    expect(info.engines.chromium.bundledVersion).toBe("152.0.7977.72");
    expect(info.engines.chromium.bundledSource).toBe("manifest");
    expect(info.engines.firefox.bundledVersion).toBe("154.0");
    // No managed engine is installed in this fixture; null is the honest value.
    expect(info.engineInstalled.chromium).toBeNull();
    expect(info.engineInstalled.firefox).toBeNull();
  });

  it("does not expose secrets, tokens or license codes", async () => {
    const serialized = JSON.stringify(await handler()({}));
    for (const forbidden of ["apiToken", "password", "privateKey", "activation", "licenseCode"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
