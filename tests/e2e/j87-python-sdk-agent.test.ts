// J87: Python SDK agent + skills surface (Slice 64). Drives the real
// headless controller with the actual Python client (sdk/python/
// agent_browser_client.py) against the mock LLM: LLM config, one-shot and
// tool-calling chat, run traces, conversations, SQLite tables, approvals
// and the skill methods added in this slice. Closes the Python SDK e2e
// gap noted in Slice 62.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchHeadlessApp, HeadlessAppHandle } from './helpers/app.js';
import { startMockLlm } from './helpers/mock-llm.js';

const execFileP = promisify(execFile);
const REPO = path.resolve(__dirname, '..', '..');
const USERDATA = path.join(REPO, 'tests', 'e2e', 'userdata', 'j87');

const PY_CHECK = "import json, os, sys\nsys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', 'sdk', 'python'))\nfrom agent_browser_client import AgentBrowserClient\n\nbase = os.environ['AB_BASE_URL']\ntok = os.environ['AB_TOKEN']\napi_url = os.environ.get('AB_LLM_URL', '')\nout = {}\nc = AgentBrowserClient(base, tok)\nout['health'] = c.health().get('mode')\nout['llm_initial'] = c.llm_config().get('config') is None\nif api_url:\n    c.save_llm_config(provider='openai', api_key='sk-j87', model='e2e-mock-model', api_url=api_url)\n    out['llm_has_key'] = c.llm_config().get('config', {}).get('hasApiKey')\n    out['chat_simple'] = c.chat_simple([{'role': 'user', 'content': 'hello py'}]).get('reply')\n    conv = c.create_conversation('j87 py')['conversation']\n    cid = conv['id']\n    out['conv_prefix'] = cid[:5]\n    chat = c.chat(cid, 'run a tool then answer')\n    out['chat_reply'] = chat.get('reply')\n    out['tool'] = (chat.get('toolCalls') or [{}])[0].get('name')\n    run_id = chat.get('runId')\n    if run_id:\n        run = c.agent_run(run_id)['run']\n        out['run_status'] = run.get('status')\n        out['run_steps'] = len(run.get('steps', []))\n    out['conv_msgs'] = len(c.get_conversation(cid)['conversation']['messages'])\n    c.delete_conversation(cid)\nskills = c.list_skills()\nout['skills'] = len(skills)\nout['skill_installed'] = c.install_skill('browser-automation')['skill']['enabled']\nc.delete_skill('browser-automation')\nc.db_exec('CREATE TABLE IF NOT EXISTS j87_py (id INTEGER PRIMARY KEY, v TEXT)')\nout['db_tables'] = len(c.db_tables())\nout['db_table_has'] = any(t['name'] == 'j87_py' for t in c.db_tables())\nout['approvals'] = len(c.pending_approvals())\nprint('J87_RESULT ' + json.dumps(out))\n";

describe('J87 — Python SDK agent + skills surface', () => {
  let h: HeadlessAppHandle;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;

  beforeAll(async () => {
    mock = await startMockLlm({ delayMs: 20, chunks: ['J87 ', 'mock ', 'reply.'] });
    h = await launchHeadlessApp({ userDataDir: USERDATA, token: 'j87-py-token' });
  }, 60000);

  afterAll(async () => {
    try { if (mock) await mock.close(); } catch {}
    if (h) await h.close();
  }, 90000);

  it('runs the Python SDK agent + skills flow against the live controller', async () => {
    mock.setResponses([
      { chunks: ['J87 ', 'mock ', 'reply.'] },
      { chunks: [], toolCalls: [{ id: 'p1', name: 'set_var', arguments: { key: 'py_probe', value: 'ok' } }] },
      { chunks: ['J87 ', 'tool ', 'answer.'] },
    ]);
    fs.mkdirSync(USERDATA, { recursive: true });
    const scriptPath = path.join(USERDATA, 'j87_check.py');
    fs.writeFileSync(scriptPath, PY_CHECK);
    const { stdout } = await execFileP('python3', [scriptPath], {
      env: {
        ...process.env,
        AB_BASE_URL: 'http://127.0.0.1:' + h.port,
        AB_TOKEN: h.token,
        AB_LLM_URL: mock.url,
      },
    });
    const line = stdout.split('\n').find((l) => l.startsWith('J87_RESULT '));
    expect(line, stdout).toBeTruthy();
    const out = JSON.parse(line.slice('J87_RESULT '.length));
    expect(out.health).toBe('headless');
    expect(out.llm_initial).toBe(true);
    expect(out.llm_has_key).toBe(true);
    expect(out.chat_simple).toBe('J87 mock reply.');
    expect(out.conv_prefix).toBe('conv_');
    expect(out.chat_reply).toBe('J87 tool answer.');
    expect(out.tool).toBe('set_var');
    expect(out.run_status).toBe('done');
    expect(out.run_steps).toBeGreaterThan(0);
    expect(out.conv_msgs).toBeGreaterThan(0);
    expect(out.skills).toBeGreaterThan(0);
    expect(out.skill_installed).toBe(true);
    expect(out.db_tables).toBeGreaterThan(0);
    expect(out.db_table_has).toBe(true);
    expect(out.approvals).toBe(0);
  }, 60000);
});
