// J38: MCP expansion (P1). The MCP server now exposes browser_* / db / http
// agent tools (prefixed cloak_) plus automation/runs/jobs, so external AI can
// drive a launched profile and the agent DB over MCP. Connects to the running
// app's loopback MCP server with the revealed token. The preferred port is
// 26581, with an ephemeral fallback when another local instance owns it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as http from "node:http";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j38");

function mcpCall(port: number, token: string, method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const req = http.request({
      hostname: "127.0.0.1", port, path: "/mcp", method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${token}`, "content-length": Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("J38 — MCP exposes browser/db/http + automation/runs/jobs", () => {
  let h: TestAppHandle;
  let token = "";
  let port = 0;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    // The MCP server starts on app ready; wait for it, then get port + token.
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const st = await h.page.evaluate(() => (window as any).cloak.api.mcp.status());
      if (st.running) { port = st.port; break; }
      await h.page.waitForTimeout(300);
    }
    expect(port, "MCP server must be running").toBeGreaterThan(0);
    const tok = await h.page.evaluate(() => (window as any).cloak.api.mcp.revealToken());
    token = tok.token;
    expect(token, "MCP token must be available").toBeTruthy();
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("tools/list includes the expanded browser/db/http + automation tools", async () => {
    const res = await mcpCall(port, token, "tools/list", {});
    const names = (res.result?.tools || []).map((t: any) => t.name);
    expect(names).toContain("cloak_browser_navigate");
    expect(names).toContain("cloak_browser_evaluate");
    expect(names).toContain("cloak_db_query");
    expect(names).toContain("cloak_db_exec");
    expect(names).toContain("cloak_http_request");
    expect(names).toContain("cloak_automation_list");
    expect(names).toContain("cloak_runs_list");
    expect(names).toContain("cloak_jobs_list");
  }, 20000);

  it("a passthrough db tool works over MCP (create → query)", async () => {
    const exec = await mcpCall(port, token, "tools/call", { name: "cloak_db_exec", arguments: { sql: "CREATE TABLE IF NOT EXISTS mcp_t (id INTEGER PRIMARY KEY, v TEXT)" } });
    expect(exec.result?.isError).toBeFalsy();
    const q = await mcpCall(port, token, "tools/call", { name: "cloak_db_query", arguments: { sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_t'" } });
    const text = q.result?.content?.[0]?.text || "";
    expect(text).toContain("mcp_t");
  }, 20000);

  it("automation_list returns the rules array over MCP", async () => {
    const res = await mcpCall(port, token, "tools/call", { name: "cloak_automation_list", arguments: {} });
    const text = res.result?.content?.[0]?.text || "";
    expect(text).toContain("rules");
  }, 20000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
