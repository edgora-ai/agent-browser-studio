import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

// Execute the actual CJS preload via Node's loader. Only its Electron capability
// is replaced; no extracted handler, VM script, or synthetic source mapping.
const require = createRequire(import.meta.url);
let api: any;
const events = new EventEmitter();
const invoke = vi.fn(async (...args: any[]) => args);
const ipcRenderer = {
  invoke,
  on: vi.fn((channel: string, listener: (...args: any[]) => void) => events.on(channel, listener)),
  removeListener: vi.fn((channel: string, listener: (...args: any[]) => void) => events.removeListener(channel, listener)),
};
beforeAll(() => {
  const Module = require("node:module");
  const original = Module._load;
  const filename = require.resolve("../../src/main/preload.cjs");
  delete require.cache[filename];
  Module._load = function (request: string, ...rest: any[]) {
    if (request === "electron") return { contextBridge: { exposeInMainWorld: (name: string, value: unknown) => {
      expect(name).toBe("agentBrowserAPI");
      api = value;
    } }, ipcRenderer };
    return original.call(this, request, ...rest);
  };
  try { require(filename); }
  finally { Module._load = original; }
});
beforeEach(() => {
  events.removeAllListeners();
  vi.clearAllMocks();
});

describe("production preload subscriptions", () => {
  it("same callback on two channels can be removed independently", () => {
    const callback = vi.fn();
    api.on("browser:exited", callback);
    api.on("profile:updated", callback);
    api.removeListener("browser:exited", callback);
    events.emit("browser:exited", { secretElectronEvent: true }, "closed");
    expect(callback).not.toHaveBeenCalled();
    events.emit("profile:updated", { secretElectronEvent: true }, "updated");
    expect(callback).toHaveBeenCalledExactlyOnceWith("updated");
    api.removeListener("profile:updated", callback);
    expect(events.listenerCount("browser:exited")).toBe(0);
    expect(events.listenerCount("profile:updated")).toBe(0);
  });

  it("re-registering the same callback/channel does not leave an orphan listener", () => {
    const callback = vi.fn();
    api.on("batch:progress", callback);
    api.on("batch:progress", callback);
    events.emit("batch:progress", {}, { done: 1 });
    expect(callback).toHaveBeenCalledExactlyOnceWith({ done: 1 });
    api.removeListener("batch:progress", callback);
    expect(events.listenerCount("batch:progress")).toBe(0);
  });

  it("unknown channels are refused and removal cannot disturb another registered channel", () => {
    const callback = vi.fn();
    api.on("config:changed", callback);
    api.on("private:credential", callback);
    api.removeListener("private:credential", callback);
    expect(events.listenerCount("private:credential")).toBe(0);
    api.removeListener("config:changed", callback);
    expect(events.listenerCount("config:changed")).toBe(0);
  });

  it("event payloads exclude Electron event capability and keep sync state notifications", () => {
    const callback = vi.fn();
    api.on("sync:state-changed", callback);
    events.emit("sync:state-changed", { sender: "not exposed" }, { running: true }, "tail");
    expect(callback).toHaveBeenCalledExactlyOnceWith({ running: true }, "tail");
    api.removeListener("sync:state-changed", callback);
  });

  it("health and baseline methods dispatch the shared request/confirmation contract", async () => {
    await api.browser.envRisk("profile", { requestId: "env-request" });
    expect(invoke).toHaveBeenLastCalledWith("browser:env-risk", { dirId: "profile", requestId: "env-request" });
    await api.browser.healthHistory("profile");
    expect(invoke).toHaveBeenLastCalledWith("browser:health-history", "profile");
    await api.browser.healthCancel("profile", { kind: "env", requestId: "env-request" });
    expect(invoke).toHaveBeenLastCalledWith("browser:health-cancel", "profile", { kind: "env", requestId: "env-request" });
    await api.browser.captureBaseline("profile", { confirmationToken: "reviewed" });
    expect(invoke).toHaveBeenLastCalledWith("browser:capture-baseline", { dirId: "profile", confirmationToken: "reviewed" });
    await api.webrtc.diag("profile", { allowLaunch: true, requestId: "rtc-request" });
    expect(invoke).toHaveBeenLastCalledWith("webrtc:diag", { dirId: "profile", allowLaunch: true, requestId: "rtc-request" });
  });

  it("existing archive overwrite consent payloads remain intact", async () => {
    await api.profile.exportArchive("profile", "/fixture.zip", { overwrite: false });
    expect(invoke).toHaveBeenLastCalledWith("profile:export-archive", { dirId: "profile", destPath: "/fixture.zip", overwrite: false });
    await api.profile.exportArchives(["profile"], "/fixture", { overwrite: true });
    expect(invoke).toHaveBeenLastCalledWith("profile:export-archives", { dirIds: ["profile"], destDir: "/fixture", overwrite: true });
  });
});
