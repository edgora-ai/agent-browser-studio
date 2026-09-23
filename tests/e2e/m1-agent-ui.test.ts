// M1 renderer journey: explicit browser scope, cancellable/restorable chat runs,
// queued approvals, truthful step status, and run-detail link failure states.
// This file intentionally uses the real preload/UI and the controllable mock LLM.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as path from "node:path";
import type { Page } from "playwright";
import { closeApp, setupTestApp, type TestAppHandle } from "./helpers/app.js";
import { startMockLlm, type MockLlmServer } from "./helpers/mock-llm.js";
import { closeAllDialogs, filterKnownConsoleErrors, shot } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "m1-agent-ui");

async function configureMock(h: TestAppHandle, mock: MockLlmServer): Promise<void> {
  await h.page.evaluate(() => (window as any).agentBrowser.switchTab("agent"));
  await h.page.waitForTimeout(200);
  await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("config"));
  await h.page.locator("#agent-llm-provider").selectOption("openai");
  await h.page.locator("#agent-llm-apikey").fill("sk-m1-ui-not-real");
  await h.page.locator("#agent-llm-model").fill(mock.model);
  await h.page.locator("#agent-llm-url").fill(mock.url);
  await h.page.locator('[data-cmd="agentSaveConfig"]').click({ timeout: 5000 });
  await h.page.locator("#agent-config-saved").waitFor({ state: "visible", timeout: 5000 });
  await h.page.evaluate(() => (window as any).agentBrowser.switchAgentSub("chat"));
  await h.page.waitForTimeout(250);
}

async function createConversation(page: Page, title: string): Promise<string> {
  return page.evaluate(async (name) => {
    const app = (window as any).agentBrowser;
    const conversation = await app.api.agent.conversations.create(name);
    await app.agentSelectConv(conversation.id);
    await app.agentLoadConversations();
    return conversation.id;
  }, title);
}

async function selectConversation(page: Page, conversationId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await (window as any).agentBrowser.agentSelectConv(id);
  }, conversationId);
}

async function sendFromComposer(page: Page, message: string): Promise<void> {
  await page.locator("#agent-chat-input").fill(message);
  await page.locator("#agent-chat-input").press("Enter");
}

async function waitForRequest(mock: MockLlmServer, absoluteIndex: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (mock.requests.length <= absoluteIndex && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(mock.requests.length, `mock request ${absoluteIndex} did not arrive`).toBeGreaterThan(absoluteIndex);
}

async function waitForClosedRequest(mock: MockLlmServer, absoluteIndex: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (mock.requests[absoluteIndex]?.closedBeforeEnd !== true && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(mock.requests[absoluteIndex]?.closedBeforeEnd).toBe(true);
}

async function waitForRunIdle(page: Page, conversationId: string, timeout = 15000): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const controller = (window as any).agentBrowser.agentChatController;
      const session = controller?.getSession(id);
      return !!session && session.run === null;
    },
    conversationId,
    { timeout },
  );
}

async function latestToast(page: Page): Promise<string> {
  const message = page.locator(".toast .toast-msg").last();
  await message.waitFor({ state: "visible", timeout: 5000 });
  return message.innerText();
}

describe.sequential("M1 — Agent execution controls and truthful run UI", () => {
  let h: TestAppHandle;
  let mock: MockLlmServer;
  let recoveredConversationId = "";
  let approvalConversationA = "";
  let approvalConversationB = "";

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 30 });
    h = await setupTestApp({ userDataDir: USERDATA });
    await h.page.evaluate(() => (window as any).i18n.set("en-US"));
    await configureMock(h, mock);
  }, 60000);

  afterAll(async () => {
    for (let i = 0; mock && i < mock.requests.length; i++) mock.releaseRequest(i);
    if (h) await closeApp(h);
    if (mock) await mock.close().catch(() => undefined);
  }, 90000);

  it("defaults to no-browser scope and explains the restricted tool boundary", async () => {
    await h.page.locator("#agent-env-select").waitFor({ state: "visible", timeout: 5000 });
    await h.page.waitForFunction(() => !(document.getElementById("agent-env-select") as HTMLSelectElement).disabled);

    expect(await h.page.locator("#agent-env-select").inputValue()).toBe("");
    expect(await h.page.locator("#agent-env-select option").first().innerText()).toContain("No browser environment");
    expect(await h.page.locator("#agent-env-status").innerText()).toContain("Browser actions are off");
    const note = await h.page.locator(".agent-scope-note").innerText();
    expect(note).toContain("cannot start browsers itself");
    expect(note).toContain("schedule creation or deletion");
  });

  it("stops a delayed stream without accepting later chunks or logging cancellation as unexpected", async () => {
    mock.setResponses([{ chunks: ["first chunk", " SHOULD_NOT_RENDER"], pause: true, pauseAfterChunks: 1 }]);
    const conversationId = await createConversation(h.page, "M1 stop during stream");
    const requestIndex = mock.requests.length;

    await sendFromComposer(h.page, "hold this response until I stop it");
    await waitForRequest(mock, requestIndex);
    await h.page.getByText("first chunk", { exact: false }).waitFor({ state: "visible", timeout: 10000 });
    await h.page.locator("#agent-chat-stop").waitFor({ state: "visible", timeout: 5000 });
    await h.page.locator("#agent-chat-stop").click();

    await waitForRunIdle(h.page, conversationId);
    await waitForClosedRequest(mock, requestIndex);
    expect(await h.page.locator("#agent-run-state").innerText()).toContain("Stopped by user");
    expect(await h.page.locator("#agent-chat-messages").innerText()).not.toContain("SHOULD_NOT_RENDER");
    expect(await h.page.locator("#agent-run-verification").innerText()).toBe("Unverified");
  }, 30000);

  it("switches conversations, reloads, restores the active snapshot, and never re-sends or cross-writes", async () => {
    mock.setResponses([{ chunks: ["A snapshot", " after release"], pause: true, pauseAfterChunks: 1 }]);
    recoveredConversationId = await createConversation(h.page, "M1 recovery A");
    const otherConversationId = await createConversation(h.page, "M1 recovery B");
    await selectConversation(h.page, recoveredConversationId);
    const requestIndex = mock.requests.length;

    await sendFromComposer(h.page, "recover exactly this request");
    await waitForRequest(mock, requestIndex);
    await h.page.getByText("A snapshot", { exact: false }).waitFor({ state: "visible", timeout: 10000 });

    await selectConversation(h.page, otherConversationId);
    expect(await h.page.locator("#agent-chat-messages").innerText()).not.toContain("A snapshot");
    await h.page.locator("#agent-chat-input").fill("draft owned by B");
    await selectConversation(h.page, recoveredConversationId);
    await selectConversation(h.page, otherConversationId);
    expect(await h.page.locator("#agent-chat-input").inputValue()).toBe("draft owned by B");

    const requestCountBeforeReload = mock.requests.length;
    await h.page.reload({ waitUntil: "domcontentloaded" });
    await h.page.waitForFunction(() => !!(window as any).agentBrowser?.agentChatController, { timeout: 20000 });
    await closeAllDialogs(h.page);
    await h.page.evaluate(() => {
      (window as any).agentBrowser.switchTab("agent");
      (window as any).agentBrowser.switchAgentSub("chat");
    });
    await selectConversation(h.page, recoveredConversationId);

    await h.page.waitForFunction(
      (id) => !!(window as any).agentBrowser.agentChatController.getSession(id)?.run,
      recoveredConversationId,
      { timeout: 10000 },
    );
    expect(await h.page.locator("#agent-chat-messages").innerText()).toContain("A snapshot");
    expect(mock.requests.length, "active-run recovery must not resend the prompt").toBe(requestCountBeforeReload);

    await selectConversation(h.page, otherConversationId);
    expect(await h.page.locator("#agent-chat-messages").innerText()).not.toContain("A snapshot");
    await selectConversation(h.page, recoveredConversationId);
    expect(mock.releaseRequest(requestIndex)).toBe(true);
    await waitForRunIdle(h.page, recoveredConversationId, 20000);
    expect(await h.page.locator("#agent-chat-messages").innerText()).toContain("A snapshot after release");
    expect(mock.requests.length, "released request should finish without a duplicate request").toBe(requestCountBeforeReload);
  }, 45000);

  it("queues two chat approvals; stopping A keeps B, and B's denied step stays failed after natural completion", async () => {
    await h.page.evaluate(async () => {
      const db = (window as any).agentBrowser.api.agentDb;
      await db.exec("CREATE TABLE IF NOT EXISTS m1_queue_a (id INTEGER)");
      await db.exec("CREATE TABLE IF NOT EXISTS m1_queue_b (id INTEGER)");
    });
    mock.setResponses([
      { chunks: [], toolCalls: [{ id: "m1-a", name: "db_exec", arguments: { sql: "DROP TABLE m1_queue_a" } }] },
      { chunks: [], toolCalls: [{ id: "m1-b", name: "db_exec", arguments: { sql: "DROP TABLE m1_queue_b" } }] },
      { chunks: ["B finished after the denied operation."] },
    ]);

    approvalConversationA = await createConversation(h.page, "M1 approval A");
    const firstRequestIndex = mock.requests.length;
    await sendFromComposer(h.page, "drop the A table");
    await waitForRequest(mock, firstRequestIndex);
    await h.page.locator("#dlg-approval[open]").waitFor({ state: "visible", timeout: 15000 });
    expect(await h.page.locator("#approval-desc").innerText()).toContain("m1_queue_a");
    expect(await h.page.locator("#dlg-approval").getByRole("button", { name: "Close", exact: true }).count()).toBe(1);
    await shot(h.page, "m1-approval-stop-a");

    approvalConversationB = await h.page.evaluate(async () => {
      const app = (window as any).agentBrowser;
      const conversation = await app.api.agent.conversations.create("M1 approval B");
      await app.agentSelectConv(conversation.id);
      void app._doAgentSend("drop the B table");
      return conversation.id;
    });
    await waitForRequest(mock, firstRequestIndex + 1);
    await h.page.waitForFunction(async () => (await (window as any).agentBrowser.api.approval.list()).length === 2, undefined, { timeout: 15000 });

    // Main's list RPC can reply before the renderer consumes the second
    // approval event. Wait for that event's visible effect, not an arbitrary delay.
    await expect.poll(() => h.page.locator("#approval-queue-count").innerText(), { timeout: 5000 }).toContain("2");
    expect(await h.page.locator("#approval-desc").innerText()).toContain("m1_queue_a");
    await h.page.locator("#approval-stop-run").waitFor({ state: "visible", timeout: 5000 });
    await h.page.locator("#approval-stop-run").click();

    await h.page.waitForFunction(() => document.getElementById("approval-desc")?.textContent?.includes("m1_queue_b"), undefined, { timeout: 10000 });
    expect(await h.page.locator("#dlg-approval").evaluate((dialog: HTMLDialogElement) => dialog.open)).toBe(true);
    const pendingAfterStop = await h.page.evaluate(async () => (window as any).agentBrowser.api.approval.list());
    expect(pendingAfterStop).toHaveLength(1);
    expect(pendingAfterStop[0].description).toContain("m1_queue_b");

    await h.page.locator('#dlg-approval [data-cmd="approvalDeny"][data-cmd-arg="deny"]').click();
    await waitForRequest(mock, firstRequestIndex + 2);
    await waitForRunIdle(h.page, approvalConversationB, 20000);
    expect(await h.page.locator("#agent-chat-messages").innerText()).toContain("B finished after the denied operation.");
    const traceState = await h.page.evaluate((id) => {
      const app = (window as any).agentBrowser;
      const session = app.agentChatController.getSession(id);
      return {
        selected: app.state.agentActiveConvId,
        messages: session.messagesRef,
        terminalSteps: session.lastRun?.steps,
        rendered: document.getElementById("agent-chat-messages")?.innerHTML,
      };
    }, approvalConversationB);
    expect(await h.page.locator('#agent-chat-messages [data-step-status="failed"]').count(), JSON.stringify(traceState)).toBeGreaterThanOrEqual(1);
    expect(await h.page.locator("#agent-run-state").innerText()).toBe("Execution finished");
    expect(await h.page.locator("#agent-run-action").innerText()).toBe("");
    expect(await h.page.locator("#agent-run-verification").innerText()).toBe("Unverified");

    const failedStep = await h.page.evaluate(async (id) => {
      const runs = await (window as any).agentBrowser.api.agentRuns.list();
      const summary = runs.find((run: any) => run.source?.conversationId === id);
      const run = summary ? await (window as any).agentBrowser.api.agentRuns.get(summary.id) : null;
      return run?.steps?.find((step: any) => step.tool === "db_exec") || null;
    }, approvalConversationB);
    expect(failedStep).toMatchObject({ tool: "db_exec", ok: false });
  }, 50000);

  it("run links distinguish a read failure from a record that was cleared", async () => {
    await selectConversation(h.page, approvalConversationB);
    const link = h.page.locator("#agent-chat-messages .chat-run-link").last();
    await link.waitFor({ state: "visible", timeout: 5000 });
    const runId = await link.getAttribute("data-cmd-arg");
    expect(runId).toBeTruthy();

    await h.page.evaluate(() => {
      const app = (window as any).agentBrowser;
      (window as any).__m1OriginalIpcCall = app.ipc.call;
      app.ipc.call = (key: string, fn: () => Promise<any>, options: any) => {
        if (key.startsWith("agentRuns.get:")) return Promise.reject(new Error("simulated run read failure"));
        return (window as any).__m1OriginalIpcCall(key, fn, options);
      };
    });
    await link.click();
    expect(await latestToast(h.page)).toContain("Could not load run details: simulated run read failure");

    await h.page.evaluate(async (id) => {
      const app = (window as any).agentBrowser;
      app.ipc.call = (window as any).__m1OriginalIpcCall;
      document.querySelectorAll(".toast").forEach((toast) => toast.remove());
      await app.api.agentRuns.delete(id);
    }, runId);
    await link.click();
    expect(await latestToast(h.page)).toContain("This run record was cleared");
    expect(await h.page.locator("#dlg-agent-run").evaluate((dialog: HTMLDialogElement) => dialog.open)).toBe(false);
  }, 20000);

  it("captures English/light and Chinese/dark narrow states without chat-panel overflow", async () => {
    await selectConversation(h.page, approvalConversationB);
    await h.page.setViewportSize({ width: 1200, height: 820 });
    await h.page.evaluate(() => {
      // The preceding deep-link test intentionally creates an English toast.
      // It is not part of either locale fixture and must not cover the composer.
      document.querySelectorAll(".toast").forEach((toast) => toast.remove());
      document.documentElement.setAttribute("data-theme", "light");
      (window as any).i18n.set("en-US");
      (window as any).i18n.apply();
    });
    await selectConversation(h.page, approvalConversationB);
    await shot(h.page, "m1-agent-ui-en-light");

    await h.page.setViewportSize({ width: 700, height: 820 });
    await h.page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "dark");
      (window as any).i18n.set("zh-CN");
      (window as any).i18n.apply();
    });
    await selectConversation(h.page, approvalConversationB);
    await h.page.waitForTimeout(200);
    const geometry = await h.page.locator("#agent-view-chat").evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(await h.page.locator("#agent-env-status").innerText()).toContain("浏览器操作已关闭");
    expect(await h.page.locator(".agent-hint").innerText()).toBe("Enter 发送，Shift+Enter 换行");
    await shot(h.page, "m1-agent-ui-zh-dark-narrow");
  }, 20000);

  it("has no unexpected renderer errors, including user cancellation", () => {
    const consoleErrors = filterKnownConsoleErrors(h.consoleErrors);
    const pageErrors = h.pageErrors.filter((error) => !/favicon|punycode/i.test(error));
    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
    expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  });
});
