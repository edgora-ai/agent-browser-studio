// J86: MCP agent skills/approvals/db-tables tools (Slice 64). The MCP
// server now exposes skill management, the approval gate and the agent
// SQLite table list, so an external AI can see installed skills, review
// pending approvals for risky agent operations and inspect tables — the
// AI Agent surface (Skills + approval round-trip) RoxyBrowser advertises.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as http from 'node:http';
import { setupTestApp, closeApp, TestAppHandle } from './helpers/app.js';
import { filterKnownConsoleErrors } from './helpers/diag.js';

const REPO = path.resolve(__dirname, '..', '..');
const USERDATA = path.join(REPO, 'tests', 'e2e', 'userdata', 'j86');

function mcpCall(port: number, token: string, method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + token,
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function toolResult(res: any): any {
  const text = res?.result?.content?.[0]?.text || '';
  try { return JSON.parse(text); } catch { return {}; }
}

describe('J86 — Agent skills/approvals/db-tables over MCP', () => {
  let h: TestAppHandle;
  let token = '';
  let port = 0;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const st = await h.page.evaluate(() => (window as any).agentBrowser.api.mcp.status());
      if (st.running) { port = st.port; break; }
      await h.page.waitForTimeout(300);
    }
    expect(port, 'MCP server must be running').toBeGreaterThan(0);
    const tok = await h.page.evaluate(() => (window as any).agentBrowser.api.mcp.revealToken());
    token = tok.token;
    expect(token, 'MCP token must be available').toBeTruthy();
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it('tools/list includes the skills/approvals/db-tables tools', async () => {
    const res = await mcpCall(port, token, 'tools/list', {});
    const names = (res.result?.tools || []).map((t: any) => t.name);
    for (const n of [
      'agent_browser_skills_list',
      'agent_browser_skill_get',
      'agent_browser_skill_install',
      'agent_browser_approvals_list',
      'agent_browser_approval_resolve',
      'agent_browser_db_tables',
    ]) {
      expect(names).toContain(n);
    }
  }, 20000);

  it('lists, reads and installs agent skills over MCP', async () => {
    const list = await mcpCall(port, token, 'tools/call', { name: 'agent_browser_skills_list', arguments: {} });
    expect(list.result?.isError).toBeFalsy();
    const skills = toolResult(list).skills || [];
    expect(skills.length).toBeGreaterThan(0);
    const builtin = skills.find((s: any) => s.id === 'browser-automation');
    expect(builtin).toBeTruthy();

    const got = await mcpCall(port, token, 'tools/call', {
      name: 'agent_browser_skill_get', arguments: { skillId: 'browser-automation' },
    });
    expect(got.result?.isError).toBeFalsy();
    expect(toolResult(got).skill.id).toBe('browser-automation');
    expect(toolResult(got).skill.tools.length).toBeGreaterThan(0);

    const missing = await mcpCall(port, token, 'tools/call', {
      name: 'agent_browser_skill_get', arguments: { skillId: 'no_such_skill_xyz' },
    });
    expect(missing.result?.isError).toBe(true);

    const installed = await mcpCall(port, token, 'tools/call', {
      name: 'agent_browser_skill_install', arguments: { skillId: 'browser-automation' },
    });
    expect(installed.result?.isError).toBeFalsy();
    expect(toolResult(installed).success).toBe(true);
    expect(toolResult(installed).skill.enabled).toBe(true);
  }, 30000);

  it('lists agent SQLite tables and creates one via the passthrough', async () => {
    const t0 = await mcpCall(port, token, 'tools/call', { name: 'agent_browser_db_tables', arguments: {} });
    expect(t0.result?.isError).toBeFalsy();
    expect(Array.isArray(toolResult(t0).tables)).toBe(true);

    const created = await mcpCall(port, token, 'tools/call', {
      name: 'agent_browser_db_exec',
      arguments: { sql: 'CREATE TABLE IF NOT EXISTS j86_items (id INTEGER PRIMARY KEY, label TEXT)' },
    });
    expect(created.result?.isError).toBeFalsy();

    const t1 = await mcpCall(port, token, 'tools/call', { name: 'agent_browser_db_tables', arguments: {} });
    expect(toolResult(t1).tables.some((t: any) => t.name === 'j86_items')).toBe(true);
  }, 30000);

  it('walks a real pending approval round-trip (destructive db_exec -> list -> resolve)', async () => {
    const empty = await mcpCall(port, token, 'tools/call', { name: 'agent_browser_approvals_list', arguments: {} });
    expect(Array.isArray(toolResult(empty).approvals)).toBe(true);

    // Validation paths without a pending request.
    const badId = await mcpCall(port, token, 'tools/call', {
      name: 'agent_browser_approval_resolve', arguments: { approvalId: 'appr_missing', decision: 'once' },
    });
    expect(badId.result?.isError).toBe(true);
    const badDecision = await mcpCall(port, token, 'tools/call', {
      name: 'agent_browser_approval_resolve', arguments: { approvalId: 'appr_missing', decision: 'maybe' },
    });
    expect(badDecision.result?.isError).toBe(true);

    // Fire a destructive db_exec over MCP; it pauses on the approval gate.
    const pendingDelete = mcpCall(port, token, 'tools/call', {
      name: 'agent_browser_db_exec', arguments: { sql: 'DELETE FROM j86_items' },
    });
    let approvalId = '';
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const list = await mcpCall(port, token, 'tools/call', { name: 'agent_browser_approvals_list', arguments: {} });
      const approvals = toolResult(list).approvals || [];
      const pending = approvals.find((a: any) => a.category === 'db-destroy');
      if (pending) { approvalId = pending.id; break; }
      await new Promise((r2) => setTimeout(r2, 200));
    }
    expect(approvalId, 'a db-destroy approval must be pending').toMatch(/^appr_/);

    const resolved = await mcpCall(port, token, 'tools/call', {
      name: 'agent_browser_approval_resolve', arguments: { approvalId, decision: 'deny' },
    });
    expect(resolved.result?.isError).toBeFalsy();
    expect(toolResult(resolved).success).toBe(true);

    const delResult = await pendingDelete;
    const del = toolResult(delResult);
    expect(del.skipped).toBe(true);
    expect(del.decision).toBe('deny');

    const after = await mcpCall(port, token, 'tools/call', { name: 'agent_browser_approvals_list', arguments: {} });
    expect(toolResult(after).approvals.length).toBe(0);
  }, 40000);

  it('no unexpected console errors', () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(c.length, c.join('\n')).toBe(0);
  });
});

