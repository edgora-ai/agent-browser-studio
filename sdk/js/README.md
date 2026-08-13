# JavaScript SDK

A dependency-free client for Agent Browser Studio's loopback control API, plus
one-call Playwright / Puppeteer adapters.

- `agent-browser.mjs` — `AgentBrowserClient` (REST, mirrors the Python SDK) and
  `connectPlaywright` / `connectPuppeteer`.
- `example.mjs` — Playwright drop-in demo.
- `example-agent.mjs` — agent surface demo (LLM config, conversations, chat,
  run traces, SQLite store and approvals).

Works identically against the desktop app and the `--headless` server mode.

## Quick start

Start the controller (GUI or headless):

    AGENT_BROWSER_API_TOKEN=my-token npx electron . --headless

Run the example (installs Playwright first if you do not have it):

    npm install playwright-core
    AGENT_BROWSER_API_TOKEN=my-token node sdk/js/example.mjs

## Playwright drop-in

Swap the import and keep the rest of your existing Playwright code. The
profile is created, launched and connected over CDP automatically; the
returned object is a real Playwright `Browser`, so `newPage`, `goto`, `click`,
`fill`, `screenshot` and everything else keeps working.

Automation profiles launch headless by default (no window to focus, so rAF
stays unthrottled). Pass `headless: false` to connectPlaywright /
connectPuppeteer to open a visible window instead.

```js
import { connectPlaywright } from './agent-browser.mjs';

const { browser, stop } = await connectPlaywright({
  baseUrl: 'http://127.0.0.1:26582',
  token: process.env.AGENT_BROWSER_API_TOKEN,
  name: 'campaign-1',
  platform: 'windows',          // windows | macos
  locale: 'en-US',
  timezone: 'America/New_York',
  fingerprintSeed: 8801,        // stable identity per seed
});

try {
  const page = await browser.newPage();
  await page.goto('https://example.com');
  await page.fill('input[name="q"]', 'agent browser');
  await page.click('button[type="submit"]');
  await page.waitForLoadState('domcontentloaded');
} finally {
  await stop();                 // closes the browser and stops the profile
}
```

Attach to an already-running profile instead of creating a new one:

```js
const { browser, stop } = await connectPlaywright({
  baseUrl: 'http://127.0.0.1:26582',
  token: process.env.AGENT_BROWSER_API_TOKEN,
  dirId: 'cb_abc123',           // existing managed profile id
});
```

## Puppeteer

Same flow, one-line swap:

```js
import { connectPuppeteer } from './agent-browser.mjs';

const { browser, stop } = await connectPuppeteer({
  baseUrl: 'http://127.0.0.1:26582',
  token: process.env.AGENT_BROWSER_API_TOKEN,
  platform: 'windows',
  fingerprintSeed: 8802,
});
```

Install the driver you use: `npm install playwright-core` or
`npm install puppeteer-core`. Both are optional peer dependencies — the SDK
itself has zero dependencies.

## Why CDP connect keeps the fingerprint intact

The engine is a real Chromium build with fingerprints modified at the C++
source level. Connecting over CDP (instead of relaunching through Playwright
or Puppeteer) means no test-harness flags are added and no init scripts are
injected: `navigator.webdriver` stays stock-false and the user agent, screen,
languages and timezone all come from the managed profile. This is verified by
the `j73` e2e suite.

## Client surface

`AgentBrowserClient` covers the same surface as the Python SDK: `health` /
`version` / `openapi`, profiles (list/get/create/delete/launch/stop/status),
proxies, team workspace RBAC, DRM status, automation rules, runs and jobs.
Every method returns the parsed JSON body; non-2xx responses raise
`AgentBrowserError`.

The agent surface is also mirrored: `llmConfig` / `saveLlmConfig`, conversation
management (`listConversations` / `createConversation` / `getConversation` /
`renameConversation` / `deleteConversation`), chat (`chatSimple` and the
conversation-scoped tool-calling `chat`), run traces (`agentRuns` / `agentRun` /
`deleteAgentRun` / `clearAgentRuns`), the SQLite store (`dbTables` / `dbTable` /
`dbQuery` / `dbExec`) and approvals (`pendingApprovals` / `resolveApproval`).
Skills: `listSkills(filter)` / `installSkill(skillId)` / `deleteSkill(skillId)`.
