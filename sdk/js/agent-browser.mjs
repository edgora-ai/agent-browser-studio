// Agent Browser Studio — JavaScript SDK.
//
// Two layers:
//   1. AgentBrowserClient — zero-dependency REST client for the loopback
//      control API (mirrors sdk/python/agent_browser_client.py).
//   2. connectPlaywright / connectPuppeteer — one-call adapters that create
//      (or attach to) a managed profile and hand back a Playwright/Puppeteer
//      Browser connected over CDP.
//
// Connecting over CDP (rather than relaunching) keeps the engine's C++-level
// fingerprint intact: navigator.webdriver stays stock-false and the UA /
// screen / languages come from the managed profile (verified by e2e j73).
// Requires Node >= 18 (global fetch). Playwright/Puppeteer are optional peer
// drivers and are imported lazily so this module stays dependency-free.

export class AgentBrowserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentBrowserError';
  }
}

async function readJson(resp) {
  const text = await resp.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export class AgentBrowserClient {
  constructor(baseUrl, options = {}) {
    this.baseUrl = String(baseUrl || 'http://127.0.0.1:26582').replace(/\/+$/, '');
    this.token = options.token || '';
    this.timeout = options.timeout ?? 15000;
  }

  headers(hasBody) {
    const headers = {};
    if (hasBody) headers['content-type'] = 'application/json';
    if (this.token) headers['authorization'] = 'Bearer ' + this.token;
    return headers;
  }

  async request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    let resp;
    try {
      resp = await fetch(this.baseUrl + path, {
        method,
        headers: this.headers(body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      throw new AgentBrowserError(method + ' ' + path + ' -> network error: ' + detail);
    } finally {
      clearTimeout(timer);
    }
    const data = await readJson(resp);
    if (!resp.ok) {
      const detail = data && data.error ? data.error : JSON.stringify(data).slice(0, 500);
      throw new AgentBrowserError(method + ' ' + path + ' -> ' + resp.status + ': ' + detail);
    }
    return data;
  }

  get(path) { return this.request('GET', path, undefined); }
  post(path, body) { return this.request('POST', path, body); }
  delete(path) { return this.request('DELETE', path, undefined); }

  put(path, body) { return this.request('PUT', path, body); }
  patch(path, body) { return this.request('PATCH', path, body); }

  health() { return this.request('GET', '/health'); }
  version() { return this.request('GET', '/version'); }
  openapi() { return this.request('GET', '/openapi.json'); }

  listProfiles() {
    return this.request('GET', '/api/profiles').then((d) => d.profiles || []);
  }
  getProfile(dirId) {
    return this.request('GET', '/api/profiles/' + encodeURIComponent(dirId));
  }
  createProfile(name, options = {}) {
    return this.request('POST', '/api/profiles', Object.assign({ name: name }, options));
  }
  deleteProfile(dirId) {
    return this.request('DELETE', '/api/profiles/' + encodeURIComponent(dirId));
  }
  launchProfile(dirId, opts = {}) {
    return this.request('POST', '/api/profiles/' + encodeURIComponent(dirId) + '/launch', opts);
  }
  stopProfile(dirId) {
    return this.request('POST', '/api/profiles/' + encodeURIComponent(dirId) + '/stop');
  }
  profileStatus(dirId) {
    return this.request('GET', '/api/profiles/' + encodeURIComponent(dirId) + '/status');
  }

  listProxies() { return this.request('GET', '/api/proxies').then((d) => d.proxies || []); }
  addProxy(name, config) { return this.request('POST', '/api/proxies', { name: name, config: config }); }
  deleteProxy(name) {
    return this.request('DELETE', '/api/proxies/' + encodeURIComponent(name));
  }

  teamStatus() { return this.request('GET', '/api/team'); }
  teamInit(name) { return this.request('POST', '/api/team/init', { name: name }); }
  teamAddMember(deviceId, role, name) {
    return this.request('POST', '/api/team/members', {
      deviceId: deviceId,
      name: name || '',
      role: role,
    });
  }
  teamRemoveMember(deviceId) {
    return this.request('DELETE', '/api/team/members/' + encodeURIComponent(deviceId));
  }

  drmStatus() { return this.request('GET', '/api/drm/status'); }
  serverIdle() { return this.request('GET', '/api/server/idle'); }

  automationRules() {
    return this.request('GET', '/api/automation/rules').then((d) => d.rules || []);
  }
  runs(query) {
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    return this.request('GET', '/api/runs' + qs).then((d) => d.runs || []);
  }
  jobs(query) {
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    return this.request('GET', '/api/jobs' + qs).then((d) => d.jobs || []);
  }

  // ── agent / LLM ───────────────────────────────────────────────────────
  llmConfig() {
    return this.request('GET', '/api/agent/llm-config');
  }
  saveLlmConfig({ provider, apiKey, apiUrl, model }) {
    const body = { provider: provider, apiKey: apiKey };
    if (apiUrl !== undefined) body.apiUrl = apiUrl;
    if (model !== undefined) body.model = model;
    return this.request('PUT', '/api/agent/llm-config', body);
  }

  // ── agent conversations ───────────────────────────────────────────────
  listConversations() {
    return this.request('GET', '/api/agent/conversations').then((d) => d.conversations || []);
  }
  createConversation(title) {
    return this.request('POST', '/api/agent/conversations', title ? { title: title } : {});
  }
  getConversation(conversationId) {
    return this.request('GET', '/api/agent/conversations/' + encodeURIComponent(conversationId));
  }
  renameConversation(conversationId, title) {
    return this.request('PATCH', '/api/agent/conversations/' + encodeURIComponent(conversationId), { title: title });
  }
  deleteConversation(conversationId) {
    return this.request('DELETE', '/api/agent/conversations/' + encodeURIComponent(conversationId));
  }

  // ── agent chat ────────────────────────────────────────────────────────
  chatSimple(messages) {
    return this.request('POST', '/api/agent/chat-simple', { messages: messages });
  }
  chat(conversationId, message, timeoutMs) {
    const body = { conversationId: conversationId, message: message };
    if (timeoutMs !== undefined) body.timeoutMs = timeoutMs;
    return this.request('POST', '/api/agent/chat', body);
  }

  // ── agent run traces ──────────────────────────────────────────────────
  agentRuns(query) {
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    return this.request('GET', '/api/agent/runs' + qs).then((d) => d.runs || []);
  }
  agentRun(runId) {
    return this.request('GET', '/api/agent/runs/' + encodeURIComponent(runId));
  }
  deleteAgentRun(runId) {
    return this.request('DELETE', '/api/agent/runs/' + encodeURIComponent(runId));
  }
  clearAgentRuns() {
    return this.request('DELETE', '/api/agent/runs');
  }

  // ── agent SQLite store ────────────────────────────────────────────────
  dbTables() {
    return this.request('GET', '/api/agent/db/tables').then((d) => d.tables || []);
  }
  dbTable(table, query) {
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    return this.request('GET', '/api/agent/db/' + encodeURIComponent(table) + qs);
  }
  dbQuery(sql) {
    return this.request('POST', '/api/agent/db/query', { sql: sql });
  }
  dbExec(sql) {
    return this.request('POST', '/api/agent/db/exec', { sql: sql });
  }

  // ── approval gate ─────────────────────────────────────────────────────
  pendingApprovals() {
    return this.request('GET', '/api/agent/approvals').then((d) => d.approvals || []);
  }
  resolveApproval(approvalId, decision) {
    return this.request('POST', '/api/agent/approvals/' + encodeURIComponent(approvalId) + '/resolve', { decision: decision });
  }
}

async function waitForCdp(baseUrl, port, timeoutMs) {
  const url = 'http://127.0.0.1:' + port + '/json/version';
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return await resp.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const suffix = lastError && lastError.message ? ': ' + lastError.message : '';
  throw new AgentBrowserError('CDP endpoint did not come up at ' + url + suffix);
}

async function loadDriver(kind) {
  const candidates = kind === 'playwright'
    ? ['playwright-core', 'playwright']
    : ['puppeteer-core', 'puppeteer'];
  for (const name of candidates) {
    try {
      return await import(name);
    } catch {
      // try the next candidate
    }
  }
  const hint = kind === 'playwright'
    ? 'Run: npm install playwright-core'
    : 'Run: npm install puppeteer-core';
  throw new AgentBrowserError('No ' + kind + ' driver installed. ' + hint);
}

const PROFILE_OPTION_KEYS = [
  'platform',
  'fingerprintSeed',
  'timezone',
  'locale',
  'webrtcMode',
  'webrtcIp',
  'geolocationMode',
  'geolocationLatitude',
  'geolocationLongitude',
  'geolocationAccuracy',
  'gpuVendor',
  'gpuRenderer',
  'hardwareConcurrency',
  'deviceMemory',
  'screenWidth',
  'screenHeight',
  'storageQuota',
  'taskbarHeight',
  'fontsDir',
  'drm',
  'tags',
  'browserVersion',
  'fingerprintMode',
  'proxyMode',
  'proxyName',
];

async function resolveProfile(client, options) {
  if (options.dirId) {
    const status = await client.profileStatus(options.dirId);
    if (!status || !status.cdpPort) {
      throw new AgentBrowserError(
        'Profile ' + options.dirId + ' is not running; launch it first',
      );
    }
    const profile = await client.getProfile(options.dirId);
    return { dirId: options.dirId, cdpPort: status.cdpPort, profile: profile };
  }
  const createOptions = {};
  for (const key of PROFILE_OPTION_KEYS) {
    if (options[key] !== undefined) createOptions[key] = options[key];
  }
 const profile = await client.createProfile(options.name || 'agent-browser-js', createOptions);
  // Automation connects over CDP; launch headless by default so there is no
  // unfocused window throttling rAF (Playwright actionability needs frames).
  const launched = await client.launchProfile(profile.dirId, {
    headless: options.headless !== false,
  });
  if (!launched || !launched.cdpPort) {
    throw new AgentBrowserError(
      'Profile launch did not return a CDP port: ' + JSON.stringify(launched),
    );
  }
  return { dirId: profile.dirId, cdpPort: launched.cdpPort, profile: profile };
}

function makeHandle(browser, client, resolved, info) {
  return {
    browser: browser,
    client: client,
    profile: resolved.profile,
    dirId: resolved.dirId,
    cdpPort: resolved.cdpPort,
    webSocketDebuggerUrl: info && info.webSocketDebuggerUrl,
    stop: async () => {
      try { await browser.close(); } catch { /* already closed */ }
      try { await client.stopProfile(resolved.dirId); } catch { /* already stopped */ }
    },
  };
}

export async function connectPlaywright(options = {}) {
  const client = new AgentBrowserClient(options.baseUrl, {
    token: options.token,
    timeout: options.timeout,
  });
  const driver = await loadDriver('playwright');
  const resolved = await resolveProfile(client, options);
  const info = await waitForCdp(client.baseUrl, resolved.cdpPort, options.cdpTimeoutMs || 15000);
  const browser = await driver.chromium.connectOverCDP(
    'http://127.0.0.1:' + resolved.cdpPort,
  );
  return makeHandle(browser, client, resolved, info);
}

export async function connectPuppeteer(options = {}) {
  const client = new AgentBrowserClient(options.baseUrl, {
    token: options.token,
    timeout: options.timeout,
  });
  const driver = await loadDriver('puppeteer');
  const resolved = await resolveProfile(client, options);
  const info = await waitForCdp(client.baseUrl, resolved.cdpPort, options.cdpTimeoutMs || 15000);
  const browser = await driver.connect({
    browserWSEndpoint: info.webSocketDebuggerUrl,
    defaultViewport: null,
  });
  return makeHandle(browser, client, resolved, info);
}
