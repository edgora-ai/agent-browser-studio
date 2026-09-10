// Visual harness mock — injected as window.agentBrowserAPI before the renderer boots.
//
// The renderer talks to the main process through window.agentBrowserAPI. For
// pure renderer/CSS work we do not need the real Electron shell: this mock
// answers with representative data (including the awkward cases — long names,
// CJK truncation, locked, running, DRM) so screenshots exercise the same DOM
// the live app builds.
//
// Used by scripts/visual-shot.mjs. Not shipped in the app bundle.
(function () {
  // API paths the renderer *called* but the mock never stubbed. An unstubbed
  // path resolves to [] — the wrong *type* where the caller expects an object —
  // so the UI paints literal `undefined` and reports "clean" instead of
  // throwing. Recording the call turns that whole class of mock gap into
  // something `visual-shot.mjs --audit` reports, instead of something only a
  // human eyeballing a screenshot would catch.
  var mockMisses = [];
  function recordMiss(path) {
    if (path && mockMisses.indexOf(path) === -1) mockMisses.push(path);
  }

  // Every namespace is callable and infinitely nestable, so an API path the
  // mock does not know about (`R.agent.skills.marketplace()`) still returns a
  // promise instead of throwing "is not a function" and aborting the render.
  //
  // Misses are recorded on *call*, not on property access: `api.automation.jobs`
  // touches `automation` on the way to a real method, and counting that as an
  // unstubbed path buries the signal in namespace-name noise.
  function ns(spec, path) {
    path = path || "";
    var target = function () { return Promise.resolve([]); };
    if (spec) { for (var k in spec) if (Object.prototype.hasOwnProperty.call(spec, k)) target[k] = spec[k]; }
    return new Proxy(target, {
      get: function (t, p) {
        if (typeof p === "symbol") return t[p];
        // Never look like a thenable, or `await R.foo` would recurse forever.
        if (p === "then") return undefined;
        if (p in t) return t[p];
        return ns(null, path ? path + "." + String(p) : String(p));
      },
      apply: function () {
        recordMiss((path || "?") + "()");
        return Promise.resolve([]);
      },
    });
  }

  var HOUR = 3600000;
  var DAY = 86400000;
  var NOW = 1757000000000;
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };

  var profiles = [
    {
      dirId: "prof_amazon", name: "Amazon US Shop", running: false,
      lastModified: NOW - DAY * 2, tags: ["us", "ecom"],
      syncStatus: "synced", syncedAt: NOW - HOUR,
      fingerprint: { mode: "managed", seed: 12345, platform: "windows", timezone: "America/Los_Angeles", locale: "en-US", webrtcMode: "altered", webrtcIp: "203.0.113.10", browserVersion: "152.0.7977.72" },
      proxyMode: "named", proxyName: "hk01",
      gpuRenderer: "Apple M2 Pro", hardwareConcurrency: 8, deviceMemory: 16, screenWidth: 1920, screenHeight: 1080,
    },
    {
      dirId: "prof_qa", name: "QA Local", running: true, pid: 4321,
      lastModified: NOW - HOUR * 5, tags: [],
      syncStatus: "dirty",
      fingerprint: { mode: "managed", seed: 67890, platform: "macos", timezone: "Asia/Shanghai", locale: "zh-CN", webrtcMode: "altered", webrtcIp: "198.51.100.5", browserVersion: "152.0.7977.72" },
      proxyMode: "default",
      gpuRenderer: "Apple M2 Pro", hardwareConcurrency: 10, deviceMemory: 32, screenWidth: 2560, screenHeight: 1440,
      drm: true,
    },
    {
      dirId: "prof_ff", name: "Firefox Pass-through", running: false,
      lastModified: NOW - DAY * 9, tags: ["baseline"],
      syncStatus: "never", engine: "firefox",
      fingerprint: { mode: "off" }, proxyMode: "none",
    },
    {
      dirId: "prof_long", name: "A Very Long Profile Name That Should Definitely Be Truncated By Ellipsis Rules",
      running: false, lastModified: NOW - DAY * 30, tags: ["residential", "warmup", "eu-west", "invoice"],
      syncStatus: "synced",
      fingerprint: { mode: "managed", seed: 424242, platform: "windows", timezone: "Europe/Berlin", locale: "de-DE", webrtcMode: "altered", webrtcIp: "192.0.2.66", browserVersion: "152.0.7977.72" },
      proxyMode: "named", proxyName: "us-residential",
      gpuRenderer: "NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0", hardwareConcurrency: 24, deviceMemory: 64, screenWidth: 3840, screenHeight: 2160,
      lock: { owner: "device-b", ownerName: "MacBook Pro 16" },
      appUrl: "https://seller.example.com",
    },
    {
      dirId: "prof_cjk", name: "短名字测试中文截断效果看看会不会溢出",
      running: false, lastModified: NOW - HOUR * 9, tags: ["国内"],
      syncStatus: "dirty",
      fingerprint: { mode: "managed", seed: 9090, platform: "windows", timezone: "Asia/Shanghai", locale: "zh-CN", webrtcMode: "off", browserVersion: "152.0.7977.72" },
      proxyMode: "none",
      gpuRenderer: "Apple M2", hardwareConcurrency: 8, deviceMemory: 8, screenWidth: 1440, screenHeight: 900,
    },
  ];

  var proxies = [
    { name: "hk01", isDefault: true, config: { type: "socks5", host: "proxy.example.com", port: 8080 } },
    { name: "us-residential", config: { type: "http", host: "us.example.com", port: 3128 } },
    { name: "de-datacenter", config: { type: "https", host: "de.example.com", port: 8443 } },
  ];

  // Team workspace (RBAC). `local` mirrors src/main/services/team.ts:232 —
  // getLocalIdentity() always yields a non-empty name (deviceName, else the
  // first 8 chars of deviceId, else "This device"), so a mock that omits it
  // is lying about the contract and makes the renderer print `undefined`.
  var localDeviceId = "dev-8f3a2c91-4b7e-4d02-9a55-1c6e7f0b2d43";
  var teamPopulated = {
    name: "Northwind Ops",
    ownerDeviceId: localDeviceId,
    enabled: true,
    members: [
      { deviceId: localDeviceId, name: "MacBook Pro 16", role: "owner" },
      { deviceId: "dev-2b9c14ae-77d1-4f8a-b0c3-5e9a2f8d1b60", name: "Studio Mac mini", role: "admin" },
      { deviceId: "dev-c40f7e35-91a2-4b6d-8e17-3a5d9c2f7e84", name: "Windows 11 Workstation", role: "member" },
      { deviceId: "dev-7d18e6b2-3c45-4a9f-9d21-8b0e4f6a1c37", name: "QA Laptop (read-only)", role: "viewer" },
    ],
  };

  // Conversations are stateful here on purpose: agentLoadConversations()
  // auto-creates a conversation when the store is empty, so a mock that always
  // answers [] makes the renderer spin (see the _autoCreateConvTried guard).
  // Seeding one conversation also lets the chat surface be screenshotted in its
  // populated state, not just its empty state.
  var conversations = [
    {
      id: "conv_1",
      title: "检查 hk01 代理的指纹漂移",
      messageCount: 3,
      messages: [
        { role: "user", content: "帮我看下 hk01 这个代理的指纹有没有漂移，顺便把 WebRTC 也查一下。" },
        {
          role: "assistant",
          content: "先跑了指纹基线对比，再查 WebRTC。\n\n**结论**：指纹一致，但 WebRTC 暴露了本机内网地址 `192.168.1.24`，需要重新开启 WebRTC 改写。",
          steps: [
            { name: "fingerprint_drift", args: "profile=hk01", done: true },
            { name: "webrtc_leak", args: "profile=hk01", done: true },
            { name: "read_file", args: "profiles/hk01/fingerprint.json", done: true },
          ],
        },
        { role: "tool", content: "192.168.1.24 → STUN srflx 203.0.113.10 (mismatch)" },
      ],
    },
  ];

  // ── Fixtures for tabs that render purely from a list ──────────────────────
  // These paths previously fell through to the Proxy's empty array, so the tab
  // drew its empty state and none of its cards — nor any colour inside them —
  // was ever built or measured. Shapes are read off the consuming render
  // functions (renderRunCard, jobStatusBadge, healthBadgeHtml, …), not invented.
  var dbTables = [
    { name: "profiles", rowCount: 128 },
    { name: "proxy_health", rowCount: 942 },
    { name: "agent_messages", rowCount: 5013 },
  ];

  var runs = [
    // Two runs sharing source.jobId → renders one grouped card (groupRuns).
    { id: "run_9f21", name: "Nightly price sweep", status: "done", dirId: "prof_amazon", stepCount: 14, startedAt: NOW - HOUR * 2, finishedAt: NOW - HOUR * 2 + 41200, source: { type: "automation", jobId: "job_7c4a", ruleId: "rule_nightly", ruleName: "Nightly price sweep" } },
    { id: "run_9f1e", name: "Nightly price sweep", status: "error", dirId: "prof_long", stepCount: 9, startedAt: NOW - HOUR * 2 - 60000, finishedAt: NOW - HOUR * 2 - 30000, source: { type: "automation", jobId: "job_7c4a", ruleId: "rule_nightly", ruleName: "Nightly price sweep" } },
    // Singles: a live run, a plain done run, and a retry (renders the retry tag).
    { id: "run_9f0b", name: "Check hk01 fingerprint", status: "running", dirId: "prof_qa", stepCount: 3, startedAt: NOW - 90000, finishedAt: null, source: { type: "chat" } },
    { id: "run_9ef7", name: "Rotate US residential", status: "done", dirId: null, stepCount: 6, startedAt: NOW - DAY, finishedAt: NOW - DAY + 8100, source: { type: "automation", jobId: "job_51bd", ruleId: "rule_rotate", ruleName: "Rotate US residential" } },
    { id: "run_9ee2", name: "Warm-up batch", status: "error", dirId: "prof_cjk", stepCount: 2, startedAt: NOW - DAY * 2, finishedAt: NOW - DAY * 2 + 1500, source: { type: "chat", retryOf: "run_9ed0" } },
  ];

  // `target` must match targetKind(): job_* / run_* / (ab_|cb_)* — that prefix
  // is what gates the "open job/run/profile" buttons.
  var auditEntries = [
    { category: "profile", action: "profile.launch", target: "cb_amazon", actor: "user", at: NOW - 90000, detail: "Chromium 152.0.7977.72 · proxy hk01" },
    { category: "proxy", action: "proxy.health-check", target: "us-residential", actor: "system", at: NOW - HOUR, detail: "score 38 · exit flagged as datacenter" },
    { category: "automation", action: "automation.job.finished", target: "job_7c4a", actor: "system", at: NOW - HOUR * 2, detail: "attempt 2 · failed at step 9" },
    { category: "agent", action: "agent.run.completed", target: "run_9f0b", actor: "user", at: NOW - 90000, detail: "检查 hk01 代理的指纹漂移" },
    { category: "llm", action: "llm.config.saved", target: null, actor: "user", at: NOW - DAY, detail: "provider openai · model gpt-5.5-high" },
    { category: "settings", action: "settings.agentFs.saved", target: null, actor: "user", at: NOW - DAY * 3, detail: "mode allowlist · 2 entries" },
  ];

  var automationRules = [
    { id: "rule_nightly", name: "Nightly price sweep", enabled: true, trigger: { type: "cron", cron: "0 3 * * *" }, action: { type: "launch-profile", profileDirId: "prof_amazon" }, lastRunAt: NOW - HOUR * 2, lastResult: "ok · 14 steps in 41.2s" },
    { id: "rule_rotate", name: "Rotate US residential", enabled: false, trigger: { type: "event", event: "profile:stopped", profileFilter: "prof_long" }, action: { type: "custom-js", profileDirIds: ["prof_amazon", "prof_long", "prof_cjk"] }, lastRunAt: NOW - DAY, lastResult: "failed: exit node unreachable" },
    { id: "rule_warmup", name: "Weekly warm-up batch", enabled: true, trigger: { type: "once", at: NOW + DAY * 2 }, action: { type: "agent-task", agentPrompt: "打开每个 profile 访问目标站点并保持 5 分钟", profileDirId: "prof_cjk" }, lastRunAt: null, lastResult: null },
  ];

  var automationJobs = [
    { id: "job_7c4a", ruleId: "rule_nightly", ruleName: "Nightly price sweep", status: "failed", source: "manual-test", attempt: 2, createdAt: NOW - HOUR * 2 - 120000, startedAt: NOW - HOUR * 2, finishedAt: NOW - HOUR * 2 + 30000, runId: "run_9f1e", error: "step 9 failed: selector .price not found" },
    { id: "job_51bd", ruleId: "rule_rotate", ruleName: "Rotate US residential", status: "done", source: "scheduler", attempt: 1, createdAt: NOW - DAY - 60000, startedAt: NOW - DAY, finishedAt: NOW - DAY + 8100, runId: "run_9ef7", result: "rotated us-residential → de-datacenter" },
    // queued/running are the only statuses that render the Cancel button.
    { id: "job_4a83", ruleId: "rule_warmup", ruleName: "Weekly warm-up batch", status: "running", source: "scheduler", attempt: 1, createdAt: NOW - 45000, startedAt: NOW - 40000, finishedAt: null, result: "2 of 5 profiles warmed" },
  ];

  var automationLogs = [
    { at: NOW - HOUR * 2, ok: false, ruleId: "rule_nightly", ruleName: "Nightly price sweep", result: "step 9 failed: selector .price not found" },
    { at: NOW - HOUR * 5, ok: true, ruleId: "rule_nightly", ruleName: "Nightly price sweep", result: "launched prof_amazon, 14 steps in 41.2s" },
    { at: NOW - DAY, ok: true, ruleId: "rule_rotate", ruleName: "Rotate US residential", result: "rotated us-residential → de-datacenter" },
  ];

  var extensionRepo = [
    { id: "cjpalhdlnbpafiamejdnhcphjbkeiagm", name: "uBlock Origin", version: "1.62.0", source: "store", packageHash: "9f3c1a77e2b4d05c6a8e", description: "Efficient wide-spectrum content blocker.", tags: ["privacy", "blocker"], shared: true },
    { id: "nffaoalbilbmmfgbnbgppjihopabppdk", name: "Video Speed Controller", version: "0.7.3", source: "local", packageHash: "2b7e9d4f1c3a8e6057bd", description: "Speed up, slow down, advance and rewind any HTML5 video.", tags: ["video"], shared: false },
  ];

  // Fields read by renderAccountsList: platformUserName / platformUrl /
  // hasPassword / tags / profileIds.
  var accountList = [
    { platformUserName: "amazon-buyer@northwind.example", platformUrl: "https://www.amazon.com/ap/signin", hasPassword: true, tags: ["us", "seller"], profileIds: ["prof_amazon"] },
    { platformUserName: "ops@northwind.example", platformUrl: "https://sellercentral.amazon.com", hasPassword: false, tags: ["ops"], profileIds: ["prof_amazon", "prof_long"] },
    { platformUserName: "短账号名测试中文溢出情况", platformUrl: "https://example.cn/login", hasPassword: true, tags: [], profileIds: [] },
  ];

  var proxyHealth = {
    entries: [
      { proxyName: "hk01", risk: "good", score: 92, suggestion: "", cooldownUntil: 0, bindings: ["prof_amazon"], history: [{ success: true, hosting: false, isProxy: false, org: "HKT Limited", as: "AS4760" }] },
      { proxyName: "us-residential", risk: "poor", score: 38, suggestion: "Exit is a datacenter IP — prefer a residential pool.", cooldownUntil: 0, bindings: ["prof_long"], history: [{ success: true, hosting: true, isProxy: true, org: "DigitalOcean", as: "AS14061" }] },
      { proxyName: "de-datacenter", risk: "watch", score: 61, suggestion: "Latency spike across the last 3 checks.", cooldownUntil: NOW + 600000, bindings: [], history: [] },
    ],
    summary: { total: 3, good: 1, watch: 1, poor: 1, inCooldown: 1 },
  };

  var mock = {};
  // def() names the namespace so a recorded miss reads `agent.accounts.x()`
  // instead of a bare `x()`, and so the root proxy below never has to guess.
  function def(name, spec) { mock[name] = ns(spec, name); return mock[name]; }

  mock.on = function () {};
  def("agent", {
      conversations: ns({
        list: function () {
          return Promise.resolve(conversations.map(function (c) {
            return { id: c.id, title: c.title, messageCount: c.messageCount };
          }));
        },
        get: function (id) {
          var found = conversations.filter(function (c) { return c.id === id; })[0];
          return Promise.resolve(found ? JSON.parse(JSON.stringify(found)) : null);
        },
        create: function (title) {
          var conv = { id: "conv_" + (conversations.length + 1), title: title || "New Chat", messageCount: 0, messages: [] };
          conversations.unshift(conv);
          return Promise.resolve({ id: conv.id, title: conv.title });
        },
        delete: function (id) {
          conversations = conversations.filter(function (c) { return c.id !== id; });
          return Promise.resolve({ ok: true });
        },
      }, "agent.conversations"),
      accounts: ns({ list: function () { return Promise.resolve(clone(accountList)); } }, "agent.accounts"),
      skills: ns({ list: function () { return Promise.resolve([]); }, marketplace: function () { return Promise.resolve([]); } }, "agent.skills"),
      platformAdapters: ns({ list: function () { return Promise.resolve([]); } }, "agent.platformAdapters"),
      llmConfig: function () { return Promise.resolve({ provider: "openai", model: "gpt-5.5-high", apiUrl: "https://api.openai.com/v1/chat/completions", hasApiKey: true }); },
      config: function () { return Promise.resolve({ provider: "openai", model: "gpt-5.5-high", apiKey: "", endpoint: "https://api.openai.com/v1/chat/completions" }); },
  });
  def("app", {
      setLanguage: function () { return Promise.resolve(); },
      reloadConfig: function () { return Promise.resolve({}); },
  });
  def("browser", {
      binary: function () { return Promise.resolve({ installed: true, version: "152.0.7977.72", path: "~/.agent-browser-studio/chromium/152", label: "Chromium 152.0.7977.72" }); },
      list: function () { return Promise.resolve(clone(profiles)); },
      status: function (dirId) {
        var found = profiles.filter(function (p) { return p.dirId === dirId; })[0];
        return Promise.resolve({ running: !!(found && found.running), pid: found && found.pid });
      },
      batchMaxConcurrency: function () { return Promise.resolve({ max: 6 }); },
      engineStatus: function () { return Promise.resolve({ installed: true, version: "152.0.7977.72", firefox: { installed: true, version: "142.0" } }); },
  });
  def("proxy", {
      list: function () { return Promise.resolve(clone(proxies)); },
      health: function () { return Promise.resolve({ score: 92, risk: "low", suggestions: [] }); },
      healthGet: function () { return Promise.resolve(clone(proxyHealth)); },
      rotationInfo: function (name) {
        return Promise.resolve({ info: name === "us-residential"
          ? { active: true, to: "de-datacenter", reason: "unhealthy" }
          : { active: false } });
      },
  });
  def("sync", {
      status: function () { return Promise.resolve({ enabled: false }); },
      preview: function () { return Promise.resolve({ items: [] }); },
      previewDiff: function () { return Promise.resolve({ items: [] }); },
  });
  def("team", {
      // teamMode is flipped by --team-empty so both the populated roster and
      // the first-run "No workspace initialized" state get screenshotted.
      status: function () {
        var populated = !(window.__visualHarness && window.__visualHarness.teamMode === "empty");
        return Promise.resolve({
          team: populated ? clone(teamPopulated) : null,
          local: { deviceId: localDeviceId, name: "MacBook Pro 16", role: "owner" },
          enforcement: populated,
        });
      },
      init: function () {
        if (window.__visualHarness) window.__visualHarness.teamMode = "populated";
        return Promise.resolve({ success: true, team: clone(teamPopulated) });
      },
      addMember: function () { return Promise.resolve({ success: true, team: clone(teamPopulated) }); },
      removeMember: function () { return Promise.resolve({ success: true, team: clone(teamPopulated) }); },
      setRole: function () { return Promise.resolve({ success: true, team: clone(teamPopulated) }); },
      rename: function () { return Promise.resolve({ success: true, team: clone(teamPopulated) }); },
      setEnabled: function () { return Promise.resolve({ success: true, team: clone(teamPopulated) }); },
  });
  def("drm", { status: function () { return Promise.resolve({ available: true, cdmPath: "/tmp/cdm" }); } });
  def("settings", {
      launchGates: function () { return Promise.resolve({ gates: [] }); },
      agentFsGet: function () { return Promise.resolve({ mode: "allowlist", allowlist: ["/Users/ahoo/workspace/abs-scratch", "/tmp/abs-exports"] }); },
      extensionRepository: function (filter) {
        var q = String(filter || "").trim().toLowerCase();
        var list = q ? extensionRepo.filter(function (e) { return (e.name + " " + e.id).toLowerCase().indexOf(q) >= 0; }) : extensionRepo;
        return Promise.resolve(clone(list));
      },
  });
  def("agentDb", { tables: function () { return Promise.resolve(clone(dbTables)); } });
  def("agentRuns", { list: function () { return Promise.resolve(clone(runs)); } });
  def("audit", {
      list: function (opts) {
        var cat = opts && opts.category;
        var list = cat ? auditEntries.filter(function (e) { return e.category === cat; }) : auditEntries;
        return Promise.resolve(clone(list));
      },
  });
  def("automation", {
      list: function () { return Promise.resolve(clone(automationRules)); },
      jobs: function (opts) {
        var st = opts && opts.status;
        var list = st ? automationJobs.filter(function (j) { return j.status === st; }) : automationJobs;
        return Promise.resolve(clone(list));
      },
      logs: function () { return Promise.resolve(clone(automationLogs)); },
      validateCron: function (cron) {
        var parts = String(cron || "").trim().split(/\s+/);
        return Promise.resolve(parts.length === 5 ? { valid: true } : { valid: false, error: "expected 5 fields" });
      },
  });
  def("updates", { status: function () { return Promise.resolve({ active: "152.0.7977.72", pinned: null, installed: [], history: [] }); } });
  def("storage", {
      info: function () {
        return Promise.resolve({
          profiles: [
            { dirId: "prof_amazon", name: "Amazon US Shop", sizeBytes: 412647424, lastModified: NOW - DAY * 2 },
            { dirId: "prof_qa", name: "QA Local", sizeBytes: 189792256, lastModified: NOW - HOUR * 5 },
            { dirId: "prof_long", name: "A Very Long Profile Name That Should Definitely Be Truncated By Ellipsis Rules", sizeBytes: 963641344, lastModified: NOW - DAY * 30 },
            { dirId: "prof_cjk", name: "短名字测试中文截断效果看看会不会溢出", sizeBytes: 52428800, lastModified: NOW - HOUR * 9 },
          ],
          totalProfileBytes: 734003200,
          availableDiskBytes: 213745152000,
          diskUsagePercent: 61,
        });
      },
  });
  def("profile", { list: function () { return Promise.resolve(clone(profiles)); } });
  def("license", { status: function () { return Promise.resolve({ plan: "yearly", licensedTo: "Northwind Trading Co.", expiresAt: NOW + DAY * 120 }); } });

  window.agentBrowserAPI = new Proxy({}, {
    get: function (target, prop) {
      if (typeof prop === "symbol") return target[prop];
      if (prop in mock) return mock[prop];
      // Unknown top-level namespace: seed the path so a later call records
      // the full dotted route. Recording happens on call, not here.
      return ns(null, String(prop));
    },
  });

  window.__visualHarness = { profiles: profiles, proxies: proxies, mockMisses: mockMisses, teamMode: "populated" };
})();
