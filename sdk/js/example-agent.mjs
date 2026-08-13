// Agent Browser Studio — JS SDK agent example (Slice 63).
// Demonstrates the agent surface: LLM config, conversations, one-shot and
// tool-calling chat, run traces, the SQLite store and approvals.
//
//   AGENT_BROWSER_API_TOKEN=my-token node sdk/js/example-agent.mjs
//   AGENT_BROWSER_LLM_API_KEY=sk-... AGENT_BROWSER_LLM_MODEL=gpt-4o \
//     AGENT_BROWSER_LLM_API_URL=https://api.openai.com/v1/chat/completions \
//     node sdk/js/example-agent.mjs
import { AgentBrowserClient } from './agent-browser.mjs';

const baseUrl = process.env.AGENT_BROWSER_BASE_URL || 'http://127.0.0.1:26582';
const token = process.env.AGENT_BROWSER_API_TOKEN || '';

const client = new AgentBrowserClient(baseUrl, { token });

const llmApiKey = process.env.AGENT_BROWSER_LLM_API_KEY || '';
const llmModel = process.env.AGENT_BROWSER_LLM_MODEL || 'gpt-4o-mini';
const llmApiUrl = process.env.AGENT_BROWSER_LLM_API_URL || 'https://api.openai.com/v1/chat/completions';

// 1. LLM config — only touched when a key is provided, otherwise the saved
//    config is read back (redacted).
const current = await client.llmConfig();
console.log('llm config     :', current.config ? JSON.stringify(current.config) : '(none)');
if (llmApiKey) {
  const saved = await client.saveLlmConfig({
    provider: llmApiUrl.includes('openai.com') ? 'openai' : 'custom',
    apiKey: llmApiKey,
    apiUrl: llmApiUrl,
    model: llmModel,
  });
  console.log('llm saved      :', saved.success, 'hasApiKey=' + saved.config.hasApiKey);
}

// 2. One-shot chat (no tools, no persistence).
if (llmApiKey || current.config) {
  const simple = await client.chatSimple([{ role: 'user', content: 'Say hello in one short sentence.' }]);
  console.log('chat-simple    :', simple.reply);
}

// 3. Conversation-scoped tool-calling chat + run trace.
if (llmApiKey || current.config) {
  const conv = await client.createConversation('js-sdk-agent-demo');
  const convId = conv.conversation.id;
  console.log('conversation   :', convId);
  const chat = await client.chat(convId, 'Set the variable demo_probe to ok, then summarize in one sentence.');
  console.log('chat           :', chat.reply);
  console.log('tool calls     :', JSON.stringify(chat.toolCalls || []));
  if (chat.runId) {
    const run = await client.agentRun(chat.runId);
    console.log('run            :', run.run.status, 'steps=' + (run.run.steps || []).length);
  }
  const history = await client.getConversation(convId);
  console.log('messages       :', history.conversation.messages.length);
  await client.deleteConversation(convId);
}

// 4. Read-only agent surfaces (always available).
const runs = await client.agentRuns({ limit: 5 });
console.log('runs           :', runs.length);
const tables = await client.dbTables();
console.log('db tables      :', tables.map((t) => t.name).join(', '));
const approvals = await client.pendingApprovals();
console.log('approvals      :', approvals.length);

