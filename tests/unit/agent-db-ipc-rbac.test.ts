// R0925-01 regression: agent-db:exec IPC must apply the same member+ gate as
// REST /api/agent/db/exec. Runs the REAL SQLite store on disk so a denied
// write is proven by direct database inspection, not by a mocked no-op.
import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(
  os.tmpdir(),
  `agent-browser-db-rbac-test-${process.pid}-${Date.now()}`,
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
  clipboard: { writeText: vi.fn() },
  dialog: {},
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));
vi.mock("../../src/main/services/team.js", () => ({
  requireSettingsMutation: () => h.gate,
  requireAccountMutation: () => ({ ok: true }),
  requireAccountSecret: () => ({ ok: true }),
}));
// Keep agent-db REAL; stub the rest of agent.ts's dependency surface.
vi.mock("../../src/main/services/local-agent.js", () => ({}));
vi.mock("../../src/main/services/agent/desktop-chat.js", () => ({}));
vi.mock("../../src/main/services/agent/chat-runs.js", () => ({}));
vi.mock("../../src/main/services/agent-run-trace.js", () => ({ agentRunRecorder: {} }));
vi.mock("../../src/main/services/run-result-store.js", () => ({ runResultStore: {} }));
vi.mock("../../src/main/services/agent-run-export.js", () => ({}));
vi.mock("../../src/main/services/local-export-path-guard.js", () => ({}));
vi.mock("../../src/main/services/approval-gate.js", () => ({}));
vi.mock("../../src/main/services/skill-repository.js", () => ({}));
vi.mock("../../src/main/services/audit-log.js", () => ({ recordAudit: vi.fn() }));
vi.mock("../../src/main/services/task-templates.js", () => ({ TASK_TEMPLATES: [] }));
vi.mock("../../src/main/services/platform-adapters.js", () => ({}));

import { registerAgentHandlers } from "../../src/main/ipc/agent.js";
import { closeAgentDb } from "../../src/main/services/agent-db.js";

registerAgentHandlers();

const dbFile = () => path.join(TEST_USER_DATA, "agent-store.sqlite");
const execViaIpc = (sql: string) => h.handlers.get("agent-db:exec")!(null, sql);

describe("agent-db:exec IPC role gate (R0925-01)", () => {
  beforeEach(() => {
    closeAgentDb();
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    h.gate = { ok: true };
  });
  afterAll(() => {
    closeAgentDb();
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  it("member+ writes reach the real database", async () => {
    const r = await execViaIpc("CREATE TABLE rbac_probe (v TEXT); INSERT INTO rbac_probe VALUES ('written');");
    expect(r).toEqual({ ok: true });
    const direct = new DatabaseSync(dbFile(), { readOnly: true });
    try {
      expect(direct.prepare("SELECT v FROM rbac_probe").all()).toEqual([{ v: "written" }]);
    } finally {
      direct.close();
    }
  });

  it("viewer is denied BEFORE any SQL executes — database and schema stay byte-identical", async () => {
    h.gate = { ok: false, error: "requires member role (current: viewer)" };
    const r = await execViaIpc("CREATE TABLE viewer_probe (v TEXT); INSERT INTO viewer_probe VALUES ('nope');");
    expect(r).toEqual({ ok: false, error: "requires member role (current: viewer)" });
    // The lazy writer handle never opened: no database file may even exist.
    expect(fs.existsSync(dbFile())).toBe(false);
  });

  it("a denied viewer can still read via agent-db:query", async () => {
    await execViaIpc("CREATE TABLE readable (v TEXT); INSERT INTO readable VALUES ('yes');");
    h.gate = { ok: false, error: "requires member role (current: viewer)" };
    const r = await h.handlers.get("agent-db:query")!(null, "SELECT v FROM readable");
    expect(r).toMatchObject({ ok: true, rows: [{ v: "yes" }] });
  });
});
