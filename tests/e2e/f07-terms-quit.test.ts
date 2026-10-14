// F07: drive the real first-run terms button with isolated Electron state.
// Teardown may kill a failed test's child, but exit assertions run BEFORE it.
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { closeApp, launchHeadlessApp, setupTestApp, type TestAppHandle } from "./helpers/app.js";

const ROOT = path.resolve(__dirname, "../..");
const TRAY_MODULE = pathToFileURL(path.join(ROOT, "dist/main/services/tray-manager.js")).href;
const USERDATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "studio-f07-quit-e2e-"));
const TERMS_KEY = "agent-browser-studio-terms-accepted-v1";
const SCREENSHOT = process.env.F07_SCREENSHOT_PATH
  ? path.resolve(process.env.F07_SCREENSHOT_PATH)
  : path.join(USERDATA_ROOT, "terms-before-decline.png");

function health(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL("/health", url), { timeout: 2000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("health timed out")));
    req.on("error", reject);
  });
}

async function assertPortRefuses(url: string): Promise<void> {
  await expect(health(url)).rejects.toMatchObject({ code: "ECONNREFUSED" });
}

function waitForNaturalExit(handle: TestAppHandle | { app: TestAppHandle["app"] }, timeout = 15_000): Promise<number | null> {
  const child = handle.app.process();
  if (child.exitCode !== null || child.signalCode !== null) throw new Error("Electron exited before the quit gesture");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", exited);
      reject(new Error(`Electron did not exit within ${timeout}ms; exitCode=${child.exitCode}, signalCode=${child.signalCode}`));
    }, timeout);
    function exited(code: number | null) { clearTimeout(timer); resolve(code); }
    child.once("exit", exited);
  });
}

async function trayState(handle: { app: TestAppHandle["app"] }) {
  return handle.app.evaluate(async ({ BrowserWindow }, moduleUrl: string) => {
    const vm = process.getBuiltinModule("node:vm");
    const mod = await vm.runInThisContext(`import(${JSON.stringify(moduleUrl)})`, {
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    return {
      windows: BrowserWindow.getAllWindows().length,
      visible: BrowserWindow.getAllWindows().map((win) => win.isVisible()),
      tray: Boolean(mod.getTray()),
    };
  }, TRAY_MODULE);
}

async function verifyIsolation(h: TestAppHandle) {
  const state = await h.app.evaluate(({ app }) => ({
    nodeHome: process.getBuiltinModule("node:os").homedir(),
    envHome: process.env.HOME,
    userData: app.getPath("userData"),
    providerKeys: Object.keys(process.env).filter((key) => /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|DEEPSEEK|COHERE|MISTRAL)_/.test(key)),
  }));
  expect(fs.realpathSync(state.nodeHome)).toBe(fs.realpathSync(path.join(h.userDataDir, "test-home")));
  expect(fs.realpathSync(state.envHome!)).toBe(fs.realpathSync(state.nodeHome));
  expect(fs.realpathSync(state.userData)).toBe(fs.realpathSync(h.userDataDir));
  expect(state.providerKeys).toEqual([]);
  const llm = await h.page.evaluate(async () => ({
    configured: await (window as any).agentBrowserAPI.agent.llmConfig(),
    detected: await (window as any).agentBrowserAPI.agent.detectLlmConfig(),
  }));
  expect(llm.configured?.hasApiKey ?? false).toBe(false);
  expect(llm.detected?.hasApiKey ?? false).toBe(false);
}

async function ports(h: TestAppHandle) {
  const status = await h.page.evaluate(async () => ({
    rest: await (window as any).agentBrowserAPI.apiRpc.status(),
    mcp: await (window as any).agentBrowserAPI.mcp.status(),
  }));
  expect(status.rest).toMatchObject({ running: true, hasToken: true });
  expect(status.mcp).toMatchObject({ running: true, hasToken: true });
  for (const item of [status.rest, status.mcp]) {
    expect(item.port).toBeGreaterThan(0);
    const probe = await health(item.url);
    expect(probe.status).toBe(200);
    expect(probe.body.status).toBe("ok");
    expect(probe.body.port).toBe(item.port);
  }
  expect(status.rest.port).not.toBe(status.mcp.port);
  return { rest: status.rest.url as string, mcp: status.mcp.url as string };
}

describe("F07 — terms decline quits the entire app", () => {
  afterAll(() => { fs.rmSync(USERDATA_ROOT, { recursive: true, force: true }); });

  it("really exits after the first-run Decline button, closes REST/MCP, and requires terms again on relaunch", async () => {
    const userDataDir = path.join(USERDATA_ROOT, "decline");
    let h: TestAppHandle | undefined;
    try {
      h = await setupTestApp({ userDataDir, keepInitialDialogs: true });
      await verifyIsolation(h);
      await h.page.locator("#dlg-terms").waitFor({ state: "visible" });
      expect(await h.page.evaluate((key) => localStorage.getItem(key), TERMS_KEY)).toBeNull();
      expect(await h.page.locator("#dlg-terms").evaluate((dlg: HTMLDialogElement) => dlg.open)).toBe(true);
      expect(await trayState(h)).toMatchObject({ windows: 1, visible: [true], tray: true });
      const listening = await ports(h);
      await h.page.locator("#dlg-terms").screenshot({ path: SCREENSHOT });
      expect(fs.statSync(SCREENSHOT).size).toBeGreaterThan(1024);
      console.info(`F07 terms screenshot: ${SCREENSHOT}`);
      const exited = waitForNaturalExit(h);
      // The real delegated button, NOT a mocked renderer method or IPC call.
      await h.page.locator('#dlg-terms [data-cmd="termsDecline"]').click({ noWaitAfter: true });
      expect(await exited).toBe(0);
      await assertPortRefuses(listening.rest);
      await assertPortRefuses(listening.mcp);
      console.info("F07 decline: natural process exit=0, REST/MCP refused connection");
      // Do not wipe this instance: its renderer localStorage is the persistence proof.
      h = await setupTestApp({ userDataDir, resetUserData: false, keepInitialDialogs: true });
      await verifyIsolation(h);
      await h.page.locator("#dlg-terms").waitFor({ state: "visible" });
      expect(await h.page.locator("#dlg-terms").evaluate((dlg: HTMLDialogElement) => dlg.open)).toBe(true);
      expect(await h.page.evaluate((key) => localStorage.getItem(key), TERMS_KEY)).toBeNull();
      expect(await ports(h)).toMatchObject({ rest: expect.any(String), mcp: expect.any(String) });
      console.info("F07 relaunch: terms open, acceptance key absent, services healthy");
    } finally {
      if (h) await closeApp(h);
    }
  }, 70_000);

  it("keeps the modal actionable and displays an in-dialog error when quit IPC is unavailable", async () => {
    let h: TestAppHandle | undefined;
    try {
      h = await setupTestApp({ userDataDir: path.join(USERDATA_ROOT, "ipc-unavailable"), keepInitialDialogs: true });
      await verifyIsolation(h);
      await h.page.locator("#dlg-terms").waitFor({ state: "visible" });
      const listening = await ports(h);
      // Disable only this isolated app's IPC handler, not the renderer button.
      await h.app.evaluate(({ ipcMain }) => { ipcMain.removeHandler("app:quit"); });
      await h.page.locator('#dlg-terms [data-cmd="termsDecline"]').click();
      const error = h.page.locator("#terms-quit-error");
      await error.waitFor({ state: "visible", timeout: 4000 });
      expect(await error.getAttribute("role")).toBe("alert");
      expect(await error.textContent()).toMatch(/无法退出应用，请重试|Unable to quit the app\. Please try again/);
      expect(await h.page.locator("#dlg-terms").evaluate((dlg: HTMLDialogElement) => dlg.open)).toBe(true);
      expect(await h.page.locator('#dlg-terms [data-cmd="termsDecline"]').isEnabled()).toBe(true);
      expect(await h.page.evaluate((key) => localStorage.getItem(key), TERMS_KEY)).toBeNull();
      expect(h.app.process().exitCode).toBeNull();
      expect((await health(listening.rest)).status).toBe(200);
      expect((await health(listening.mcp)).status).toBe(200);
      expect(h.pageErrors).toEqual([]);
      const failureScreenshot = process.env.F07_FAILURE_SCREENSHOT_PATH
        ? path.resolve(process.env.F07_FAILURE_SCREENSHOT_PATH)
        : path.join(USERDATA_ROOT, "terms-quit-error.png");
      await h.page.locator("#dlg-terms").screenshot({ path: failureScreenshot });
      expect(fs.statSync(failureScreenshot).size).toBeGreaterThan(1024);
      console.info(`F07 failed-quit dialog screenshot: ${failureScreenshot}`);
      const exited = waitForNaturalExit(h);
      await h.app.evaluate(({ app }) => { app.quit(); });
      expect(await exited).toBe(0);
      await assertPortRefuses(listening.rest);
      await assertPortRefuses(listening.mcp);
    } finally {
      if (h) await closeApp(h);
    }
  }, 65_000);

  it("native window close still hides to tray without stopping the services", async () => {
    let h: TestAppHandle | undefined;
    try {
      h = await setupTestApp({ userDataDir: path.join(USERDATA_ROOT, "native-close"), keepInitialDialogs: true });
      await verifyIsolation(h);
      await h.page.locator("#dlg-terms").waitFor({ state: "visible" });
      const listening = await ports(h);
      const windowState = await h.app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.close();
        return { windows: BrowserWindow.getAllWindows().length, visible: win.isVisible() };
      });
      expect(windowState).toEqual({ windows: 1, visible: false });
      expect(await trayState(h)).toMatchObject({ windows: 1, visible: [false], tray: true });
      expect(h.app.process().exitCode).toBeNull();
      expect((await health(listening.rest)).status).toBe(200);
      expect((await health(listening.mcp)).status).toBe(200);
      await h.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].show(); });
      expect(await trayState(h)).toMatchObject({ windows: 1, visible: [true], tray: true });
      // Normal cleanup: app.quit, not BrowserWindow.close or a test force-kill.
      const exited = waitForNaturalExit(h);
      await h.app.evaluate(({ app }) => { app.quit(); });
      expect(await exited).toBe(0);
      await assertPortRefuses(listening.rest);
      await assertPortRefuses(listening.mcp);
      console.info("F07 native close: window hidden, tray and services live, explicit quit exited 0");
    } finally {
      if (h) await closeApp(h);
    }
  }, 65_000);

  it("headless still has no window or tray and keeps its healthy API", async () => {
    const h = await launchHeadlessApp({ userDataDir: path.join(USERDATA_ROOT, "headless") });
    try {
      expect(await trayState(h)).toEqual({ windows: 0, visible: [], tray: false });
      expect(h.app.windows()).toHaveLength(0);
      const api = await health(`http://127.0.0.1:${h.port}`);
      expect(api).toMatchObject({ status: 200, body: { status: "ok", mode: "headless", port: h.port } });
      expect(h.app.process().exitCode).toBeNull();
      const exited = waitForNaturalExit(h);
      await h.app.evaluate(({ app }) => { app.quit(); });
      expect(await exited).toBe(0);
      await assertPortRefuses(`http://127.0.0.1:${h.port}`);
      console.info("F07 headless: zero windows/tray, live health, explicit quit exited 0");
    } finally {
      await h.close();
    }
  }, 65_000);
});
