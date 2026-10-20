import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  quit: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => h.handlers.set(name, handler) },
  app: { quit: h.quit, getVersion: () => "1.0.1" },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));
vi.mock("../../src/main/services/config-manager.js", () => ({
  getAppDataDir: () => "fixture", getConfigPath: () => "fixture/config.json",
  getProfilesDir: () => "fixture/profiles", reloadConfig: vi.fn(),
}));
vi.mock("../../src/main/services/browser-manager.js", () => ({ findRuntimeChromiumBinary: () => null }));
vi.mock("../../src/main/services/main-i18n.js", () => ({ setMainLanguage: vi.fn(), getMainLanguage: () => "en-US" }));
import { registerAppHandlers } from "../../src/main/ipc/app.js";

const ROOT = path.resolve(__dirname, "../..");
const WIZARD = fs.readFileSync(path.join(ROOT, "src/renderer/js/app/wizard.js"), "utf8");
const I18N = fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js"), "utf8");
const TERMS_KEY = "agent-browser-studio-terms-accepted-v1";

function translations(language: string) {
  const document = {
    documentElement: { lang: "" }, querySelectorAll: () => [], querySelector: () => null,
    addEventListener: () => {}, dispatchEvent: () => true,
  };
  const ctx: any = {
    window: { agentBrowserAPI: { app: { setLanguage: () => Promise.resolve() } } }, document,
    navigator: { language: "en-US" }, CustomEvent: class {},
    localStorage: { getItem: () => null, setItem: () => {} }, setTimeout, console,
  };
  ctx.window.document = document;
  ctx.window.navigator = ctx.navigator;
  ctx.window.localStorage = ctx.localStorage;
  vm.createContext(ctx);
  vm.runInContext(I18N, ctx);
  ctx.window.i18n.set(language);
  return ctx.window.i18n as { t: (key: string, fallback?: string) => string };
}

function renderer(quit: () => Promise<{ success: boolean }>, language = "en-US") {
  const dialog = { open: true, showModal: vi.fn(), close: vi.fn() };
  const decline = { disabled: false };
  const error = { hidden: true, textContent: "" };
  const ack = { checked: false, focus: vi.fn() };
  const toast = vi.fn();
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
  const close = vi.fn();
  const document = {
    getElementById: (id: string) => id === "dlg-terms" ? dialog : id === "terms-ack" ? ack : id === "terms-quit-error" ? error : null,
    querySelector: (selector: string) => selector === '#dlg-terms [data-cmd="termsDecline"]' ? decline : null,
  };
  const window: any = {
    close,
    i18n: translations(language),
    agentBrowser: { api: { app: { quit } }, R: {}, state: {}, helpers: { toast } },
  };
  const ctx = { window, document, localStorage: storage, setTimeout, console };
  vm.createContext(ctx);
  vm.runInContext(WIZARD, ctx);
  return { window, dialog, decline, error, toast, storage, close };
}

describe("F07 terms refusal IPC", () => {
  beforeEach(() => { h.handlers.clear(); h.quit.mockReset(); registerAppHandlers(); });

  it("registers a no-argument quit request that calls Electron app.quit", async () => {
    const handler = h.handlers.get("app:quit");
    expect(handler).toBeTypeOf("function");
    expect(await handler!({ sender: {} })).toEqual({ success: true });
    expect(h.quit).toHaveBeenCalledOnce();
    expect(h.quit).toHaveBeenCalledWith();
  });

  it("does not acknowledge a main-process quit failure as success", async () => {
    h.quit.mockImplementationOnce(() => { throw new Error("quit refused"); });
    await expect(h.handlers.get("app:quit")!({ sender: {} })).rejects.toThrow("quit refused");
  });

  it("prevents duplicate quit requests while the first request is pending", async () => {
    let finish!: (value: { success: boolean }) => void;
    const quit = vi.fn(() => new Promise<{ success: boolean }>((resolve) => { finish = resolve; }));
    const ui = renderer(quit);
    const pending = ui.window.agentBrowser.termsDecline();
    expect(ui.decline.disabled).toBe(true);
    await ui.window.agentBrowser.termsDecline();
    expect(quit).toHaveBeenCalledOnce();
    finish({ success: false });
    await pending;
    expect(ui.decline.disabled).toBe(false);
    expect(ui.dialog.open).toBe(true);
  });

  it.each(["en-US", "zh-CN"])("keeps the terms dialog usable and shows localized feedback on explicit refusal (%s)", async (language) => {
    const quit = vi.fn().mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true });
    const ui = renderer(quit, language);
    await ui.window.agentBrowser.termsDecline();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledWith();
    expect(translations(language).t("terms.quit-failed")).toBe(language === "zh-CN" ? "无法退出应用，请重试。" : "Unable to quit the app. Please try again.");
    expect(ui.error).toEqual({ hidden: false, textContent: translations(language).t("terms.quit-failed") });
    expect(ui.toast).not.toHaveBeenCalled();
    expect(ui.decline.disabled).toBe(false);
    expect(ui.dialog.open).toBe(true);
    expect(ui.dialog.close).not.toHaveBeenCalled();
    expect(ui.storage.setItem).not.toHaveBeenCalled();
    expect(ui.close).not.toHaveBeenCalled();
    await ui.window.agentBrowser.termsDecline();
    expect(quit).toHaveBeenCalledTimes(2);
    expect(ui.error).toEqual({ hidden: true, textContent: "" });
    // An IPC acknowledgement is not evidence that the process actually exited.
    expect(ui.dialog.open).toBe(true);
  });

  it("handles rejected transport promises without accepting terms or hiding the window", async () => {
    const ui = renderer(vi.fn().mockRejectedValue(new Error("transport refused")));
    await ui.window.agentBrowser.termsDecline();
    expect(ui.error).toEqual({ hidden: false, textContent: translations("en-US").t("terms.quit-failed") });
    expect(ui.decline.disabled).toBe(false);
    expect(ui.dialog.open).toBe(true);
    expect(ui.storage.setItem).not.toHaveBeenCalledWith(TERMS_KEY, "1");
    expect(ui.close).not.toHaveBeenCalled();
  });
});
