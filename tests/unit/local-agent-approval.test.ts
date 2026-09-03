import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => {
  const listeners: Record<string, Function[]> = {};
  return {
    app: {
      getPath: (_name: string) => "/tmp/browser-manger-local-agent-approval-test",
    },
    BrowserWindow: {
      getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => { (listeners[channel] || []).forEach((fn) => fn(payload)); } } }],
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (plain: string) => Buffer.from(plain, "utf8"),
      decryptString: (encrypted: Buffer) => Buffer.from(encrypted).toString("utf8"),
    },
  };
});

vi.mock("../../src/main/services/browser-manager.js", () => ({
  launchBrowser: vi.fn(),
  listBrowserProfiles: () => [],
}));
vi.mock("../../src/main/services/profile-manager.js", () => ({ listProfiles: () => [] }));
vi.mock("../../src/main/services/agent-db.js", () => ({
  agentDbQuery: vi.fn(),
  agentDbExec: vi.fn(),
}));
vi.mock("../../src/main/services/agent-run-trace.js", () => ({
  agentRunRecorder: {
    setVar: vi.fn(),
    getVar: vi.fn(),
    recordStep: vi.fn(),
  },
}));
vi.mock("../../src/main/services/automation.js", () => ({ getRunLogs: () => [] }));
vi.mock("../../src/main/services/automation-data.js", () => ({
  createAutomationRule: vi.fn(),
  deleteAutomationRule: vi.fn(),
}));
vi.mock("../../src/main/services/config-manager.js", () => ({
  getAppDataDir: () => "/tmp/browser-manger-local-agent-approval-test",
  getConfig: () => ({ agentFs: { mode: "sandbox", allowlist: [] }, automation: [] }),
  getProfileMeta: () => null,
  saveConfig: vi.fn(),
}));

const approvalGate = await import("../../src/main/services/approval-gate.js");
const { executeToolCall } = await import("../../src/main/services/local-agent.js");

describe("local agent HTTP approval", () => {
  beforeEach(() => {
    approvalGate.clearApprovalMemory();
  });

  it("requires approval before http_request write methods execute without exposing body values", async () => {
    const allowed = new Set(["http_request"]);
    const promise = executeToolCall("http_request", {
      method: "POST",
      url: "https://user:password@example.com/webhook?token=test-query-token-not-real&ok=1#secret-fragment",
      headers: { Authorization: "Bearer test-header-token-not-real", "X-Trace": "trace-id" },
      body: { ok: true, password: "test-body-password-not-real" },
    }, allowed, { runId: "run_http" });

    const pending = approvalGate.listPendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0].category).toBe("http-write");
    expect(pending[0].tool).toBe("http_request");
    expect(pending[0].description).toContain("https://%5BREDACTED%5D:%5BREDACTED%5D@example.com/webhook?keys=token%2Cok#redacted");
    expect(pending[0].detail).toContain("POST\nhttps://%5BREDACTED%5D:%5BREDACTED%5D@example.com/webhook?keys=token%2Cok#redacted");
    expect(pending[0].detail).toContain("headers:Authorization=[REDACTED],X-Trace");
    expect(pending[0].detail).toContain("body:");
    expect(pending[0].detail).toContain("keys=ok,password");
    expect(pending[0].detail).not.toContain("sha256=");
    expect(pending[0].detail).not.toContain("preview=");
    expect(pending[0].detail).not.toContain("test-query-token-not-real");
    expect(pending[0].detail).not.toContain("test-header-token-not-real");
    expect(pending[0].detail).not.toContain("test-body-password-not-real");
    expect(pending[0].detail).not.toContain("secret-fragment");

    expect(approvalGate.resolveApproval(pending[0].id, "deny")).toBe(true);
    await expect(promise).resolves.toMatchObject({ skipped: true, decision: "deny" });
  });

  it("classifies comment/CTE-prefixed DELETE as db-destroy (R6 #71)", async () => {
    const { classifyDbSql } = approvalGate;
    expect(classifyDbSql("DELETE FROM users").category).toBe("db-destroy");
    expect(classifyDbSql("/* x */ DELETE FROM users").category).toBe("db-destroy");
    expect(classifyDbSql("-- c\nDELETE FROM users").category).toBe("db-destroy");
    expect(classifyDbSql("WITH m AS (SELECT 1) DELETE FROM users").category).toBe("db-destroy");
    expect(classifyDbSql("SELECT * FROM users").category).toBe("db-write");
    expect(classifyDbSql("INSERT INTO t VALUES (1)").category).toBe("db-write");
  });

  it("cancels pending http_request approvals when the agent run is aborted", async () => {
    const allowed = new Set(["http_request"]);
    const controller = new AbortController();
    const promise = executeToolCall("http_request", { method: "POST", url: "https://example.com/webhook", body: { ok: true } }, allowed, { runId: "run_http", signal: controller.signal });

    expect(approvalGate.listPendingApprovals()).toHaveLength(1);
    controller.abort();

    await expect(promise).resolves.toMatchObject({ skipped: true, decision: "deny" });
    expect(approvalGate.listPendingApprovals()).toHaveLength(0);
  });
});
