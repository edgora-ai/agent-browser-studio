// J85: JS SDK agent surface (Slice 63). AgentBrowserClient now mirrors the
// Python SDK/REST agent endpoints: LLM config, conversations, one-shot and
// tool-calling chat, run traces, the SQLite store and approvals. Drives the
// real headless controller and verifies each method end-to-end against the
// mock LLM.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { launchHeadlessApp, HeadlessAppHandle } from './helpers/app.js';
import { startMockLlm } from './helpers/mock-llm.js';

const REPO = path.resolve(__dirname, '..', '..');
const USERDATA = path.join(REPO, 'tests', 'e2e', 'userdata', 'j85');

describe('J85 — JS SDK agent surface', () => {
  let h: HeadlessAppHandle;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let sdk: any;
  let client: any;

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 20, chunks: ['J85 ', 'mock ', 'reply.'] });
    h = await launchHeadlessApp({ userDataDir: USERDATA, token: 'j85-sdk-token' });
    sdk = await import('../../sdk/js/agent-browser.mjs');
    client = new sdk.AgentBrowserClient('http://127.0.0.1:' + h.port, { token: h.token });
  }, 60000);

  afterAll(async () => {
    try { if (mock) await mock.close(); } catch {}
    if (h) await h.close();
  }, 90000);

  it('AgentBrowserClient exposes the agent method surface', async () => {
    expect(typeof client.llmConfig).toBe('function');
    expect(typeof client.saveLlmConfig).toBe('function');
    expect(typeof client.listConversations).toBe('function');
    expect(typeof client.createConversation).toBe('function');
    expect(typeof client.getConversation).toBe('function');
    expect(typeof client.renameConversation).toBe('function');
    expect(typeof client.deleteConversation).toBe('function');
    expect(typeof client.chatSimple).toBe('function');
    expect(typeof client.chat).toBe('function');
    expect(typeof client.agentRuns).toBe('function');
    expect(typeof client.agentRun).toBe('function');
    expect(typeof client.deleteAgentRun).toBe('function');
    expect(typeof client.clearAgentRuns).toBe('function');
    expect(typeof client.dbTables).toBe('function');
    expect(typeof client.dbTable).toBe('function');
    expect(typeof client.dbQuery).toBe('function');
    expect(typeof client.dbExec).toBe('function');
    expect(typeof client.pendingApprovals).toBe('function');
    expect(typeof client.resolveApproval).toBe('function');
  }, 20000);

  it('saves and reads the LLM config, then runs one-shot chat', async () => {
    const initial = await client.llmConfig();
    expect(initial.config).toBeNull();

    const saved = await client.saveLlmConfig({
      provider: 'openai',
      apiKey: 'sk-j85',
      model: 'e2e-mock-model',
      apiUrl: mock.url,
    });
    expect(saved.success).toBe(true);
    expect(saved.config.hasApiKey).toBe(true);
    expect(saved.config.apiKey).toBeUndefined();

    const reread = await client.llmConfig();
    expect(reread.config.model).toBe('e2e-mock-model');
    expect(reread.config.hasApiKey).toBe(true);

    const chat = await client.chatSimple([{ role: 'user', content: 'hello from js' }]);
    expect(chat.reply).toBe('J85 mock reply.');
    expect(mock.requests.length).toBeGreaterThan(0);
  }, 30000);

  it('manages conversations over the JS SDK', async () => {
    const created = await client.createConversation('J85 js chat');
    expect(created.conversation.title).toBe('J85 js chat');
    const convId = created.conversation.id;
    expect(convId).toMatch(/^conv_/);

    const list = await client.listConversations();
    expect(list.some((c: any) => c.id === convId)).toBe(true);

    const got = await client.getConversation(convId);
    expect(got.conversation.id).toBe(convId);
    expect(Array.isArray(got.conversation.messages)).toBe(true);

    const renamed = await client.renameConversation(convId, 'J85 renamed');
    expect(renamed.conversation.title).toBe('J85 renamed');

    const del = await client.deleteConversation(convId);
    expect(del.success).toBe(true);
    let err: any = null;
    try { await client.getConversation(convId); } catch (e: any) { err = e; }
    expect(err).toBeTruthy();
    expect(String(err)).toContain('404');
  }, 30000);

  it('runs tool-calling chat and reads the run trace over the JS SDK', async () => {
    mock.setResponses([
      { chunks: [], toolCalls: [{ id: 'j1', name: 'set_var', arguments: { key: 'js_probe', value: 'ok' } }] },
      { chunks: ['J85 ', 'tool ', 'answer.'] },
    ]);
    const conv = await client.createConversation('J85 tool chat');
    const convId = conv.conversation.id;

    const chat = await client.chat(convId, 'run a tool then answer');
    expect(chat.reply).toBe('J85 tool answer.');
    expect(chat.toolCalls.length).toBeGreaterThan(0);
    expect(chat.toolCalls[0].name).toBe('set_var');
    expect(chat.toolCalls[0].redacted).toBe(true);
    expect(chat.runId).toMatch(/^run_/);

    const run = await client.agentRun(chat.runId);
    expect(run.run.status).toBe('done');
    expect(run.run.steps.some((s: any) => s.tool === 'set_var')).toBe(true);

    const runs = await client.agentRuns();
    expect(runs.some((r: any) => r.id === chat.runId)).toBe(true);

    const got = await client.getConversation(convId);
    expect(got.conversation.messages.some((m: any) =>
      m.role === 'assistant' && m.content.includes('J85 tool answer.'))).toBe(true);

    const delRun = await client.deleteAgentRun(chat.runId);
    expect(delRun.success).toBe(true);
    const cleared = await client.clearAgentRuns();
    expect(typeof cleared.deleted).toBe('number');
    const after = await client.agentRuns();
    expect(after.length).toBe(0);
    await client.deleteConversation(convId);
  }, 40000);

  it('browses the agent SQLite store and approval gate over the JS SDK', async () => {
    const tables0 = await client.dbTables();
    expect(Array.isArray(tables0)).toBe(true);

   const exec = await client.dbExec('CREATE TABLE IF NOT EXISTS j85_items (id INTEGER PRIMARY KEY, label TEXT)');
    expect(exec.success).toBe(true);
   await client.dbExec("INSERT INTO j85_items (label) VALUES ('alpha')");

    const tables1 = await client.dbTables();
    expect(tables1.some((t: any) => t.name === 'j85_items')).toBe(true);

    const data = await client.dbTable('j85_items');
    expect(data.columns).toContain('label');
    expect(data.rows.length).toBe(1);
    expect(data.rows[0].label).toBe('alpha');

    const q = await client.dbQuery('SELECT label FROM j85_items');
    expect(q.ok).toBe(true);
    expect(q.count).toBe(1);

    const approvals = await client.pendingApprovals();
    expect(Array.isArray(approvals)).toBe(true);
  }, 30000);
});
