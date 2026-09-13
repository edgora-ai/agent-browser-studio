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
  // R158: NOW used to be a fixed 2025 timestamp — anything rendered relative
  // to the wall clock (live-run "elapsed", cooldowns) drifted a year out of
  // date as real time moved on. Anchor to load time instead.
  var NOW = Date.now();
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
    // R182: was type "https", which is not a member of ProxyConfig["type"]
    // ("http" | "socks5" | "socks5h"). The edit dialog's <select> has no such
    // option, so it silently fell back to the first one and the form showed a
    // type the config never had.
    { name: "de-datacenter", config: { type: "http", host: "de.example.com", port: 8443, bypassList: ["*.internal"], fallbacks: ["de-backup"] } },
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
  // Rows for the table drill-down. The values deliberately include the three
  // cases the grid has to survive: NULL (renders the (null) placeholder), a
  // value past the 80-char truncation, and CJK — all of which a tidy fixture
  // would hide.
  var dbTableRows = {
    profiles: [
      { id: 1, name: "Amazon US Shop", platform: "windows", proxy_mode: "named", seed: 54321, last_used: "2025-09-02 23:33:20" },
      { id: 2, name: "QA Local", platform: "macos", proxy_mode: "default", seed: 10042, last_used: "2025-09-04 18:33:20" },
      { id: 3, name: "Firefox Pass-through", platform: "macos", proxy_mode: null, seed: 7781, last_used: null },
      { id: 4, name: "短名字测试中文截断效果看看会不会溢出", platform: "windows", proxy_mode: "none", seed: 20250904, last_used: "2025-09-04 14:33:20" },
      { id: 5, name: "A Very Long Profile Name That Should Definitely Be Truncated By Ellipsis Rules", platform: "windows", proxy_mode: "named", seed: 908172, last_used: "2025-08-05 23:33:20" },
    ],
    proxy_health: [
      { id: 1, proxy_name: "hk01", score: 92, risk: "good", hosting: 0, is_proxy: 0, org: "HKT Limited", checked_at: "2025-09-04 22:33:20" },
      { id: 2, proxy_name: "us-residential", score: 38, risk: "poor", hosting: 1, is_proxy: 1, org: "DigitalOcean", checked_at: "2025-09-04 22:33:20" },
      { id: 3, proxy_name: "de-datacenter", score: 61, risk: "watch", hosting: 1, is_proxy: 0, org: null, checked_at: "2025-09-03 11:02:05" },
    ],
    agent_messages: [
      { id: 1, run_id: "run_9f0b", role: "user", content: "帮我看下 hk01 这个代理的指纹有没有漂移", created_at: "2025-09-04 23:31:20" },
      { id: 2, run_id: "run_9f0b", role: "assistant", content: "先跑了指纹基线对比，再查 WebRTC。结论：指纹一致，但 WebRTC 暴露了本机内网地址。", created_at: "2025-09-04 23:31:50" },
      { id: 3, run_id: "run_9f1e", role: "tool", content: "step 9 failed: selector .price not found", created_at: "2025-09-04 21:33:20" },
    ],
  };
  // Used when a table is empty, so the grid still knows its columns (the real
  // handler reads them from PRAGMA table_info, which returns them regardless of
  // row count).
  var dbTableColumns = {
    profiles: ["id", "name", "platform", "proxy_mode", "seed", "last_used"],
    proxy_health: ["id", "proxy_name", "score", "risk", "hosting", "is_proxy", "org", "checked_at"],
    agent_messages: ["id", "run_id", "role", "content", "created_at"],
  };

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
  // R152: these fixtures used to invent audit shapes the backend never writes
  // (action "proxy.health-check", "automation.job.finished", " · "-separated
  // detail prose), which made the activity page render log lines no user will
  // ever see. Every entry below mirrors a real recordAudit() call site —
  // browser-manager.ts launch, local-agent.ts llm save, launch-guards.ts drift,
  // idle-tracker.ts auto-stop — same action names, same key=value detail format.
  var auditEntries = [
    { category: "profile", action: "launch", target: "cb_amazon", actor: "user", at: NOW - 90000, detail: "pid=4127 cdpPort=9222 fingerprint=managed browser=Chromium 152.0.7977.72" },
    { category: "profile", action: "fingerprint-drift", target: "cb_amazon", actor: "auto", at: NOW - HOUR, detail: "3 field(s) changed (risky): userAgent, platform, hardwareConcurrency" },
    { category: "automation", action: "job-cancel", target: "job_7c4a", actor: "api", at: NOW - HOUR * 2, detail: "job cancelled via API" },
    { category: "agent", action: "bind", target: "https://example.com/login", actor: "user", at: NOW - 90000, detail: "profiles=2" },
    { category: "llm", action: "save", target: null, actor: "user", at: NOW - DAY, detail: "provider=openai model=gpt-5.5-high" },
    { category: "profile", action: "stop", target: "cb_amazon", actor: "auto", at: NOW - DAY * 3, detail: "idle timeout" },
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
      // R154: suggestion strings used to be invented ("Exit is a datacenter IP
      // — prefer a residential pool.", "Latency spike across the last 3
      // checks."). The real producer is suggestionFor() in proxy-health.ts,
      // which derives copy from the entry via tMain: hosting=true + org/as
      // yields proxy.sug.idc, high avgLatencyMs yields proxy.sug.latency,
      // good risk with no flags yields proxy.sug.good. Fixtures mirror that
      // derivation (EN branch) so the page previews what users actually see.
      { proxyName: "hk01", risk: "good", score: 92, suggestion: "Healthy", cooldownUntil: 0, bindings: ["prof_amazon"], history: [{ success: true, hosting: false, isProxy: false, org: "HKT Limited", as: "AS4760" }] },
      { proxyName: "us-residential", risk: "poor", score: 38, suggestion: "Exit is a datacenter/IDC IP (DigitalOcean · AS14061). Cloud datacenter exits get flagged by ping0 and platform risk engines (net.isidc) — prefer a residential, non-IDC exit.", cooldownUntil: 0, bindings: ["prof_long"], history: [{ success: true, hosting: true, isProxy: true, org: "DigitalOcean", as: "AS14061" }] },
      { proxyName: "de-datacenter", risk: "watch", score: 61, suggestion: "Latency is high — switch to a closer node", cooldownUntil: NOW + 600000, avgLatencyMs: 1200, bindings: [], history: [] },
    ],
    summary: { total: 3, good: 1, watch: 1, poor: 1, inCooldown: 1 },
  };

  var mock = {};
  // def() names the namespace so a recorded miss reads `agent.accounts.x()`
  // instead of a bare `x()`, and so the root proxy below never has to guess.
  function def(name, spec) { mock[name] = ns(spec, name); return mock[name]; }

  // R175: was a no-op, which made every event-driven surface untestable —
  // dlg-approval (agent:approval-request), the batch progress bar
  // (batch:progress), live run updates (agent:run-*) and the profile/browser
  // state refreshes. Recording listeners lets a probe fire the same events the
  // main process would. Mirrors preload.cjs `on(channel, cb)` with its
  // channel allowlist, so a typo'd channel is silently ignored there too.
  var EVENT_CHANNELS = ["browser:exited", "profile:updated", "config:changed", "agent:tool-call",
    "agent:stream-chunk", "agent:stream-tool-call", "agent:stream-done", "agent:stream-error",
    "agent:run-start", "agent:run-step", "agent:run-finish", "agent:approval-request", "batch:progress"];
  var eventListeners = {};
  mock.on = function (channel, cb) {
    if (typeof cb !== "function") return;
    if (EVENT_CHANNELS.indexOf(channel) === -1) return;
    (eventListeners[channel] = eventListeners[channel] || []).push(cb);
  };
  mock.emit = function (channel) {
    var args = Array.prototype.slice.call(arguments, 1);
    (eventListeners[channel] || []).forEach(function (cb) {
      try { cb.apply(null, args); } catch (e) { /* a listener throwing must not stop the others */ }
    });
  };
  mock.listenerCount = function (channel) { return (eventListeners[channel] || []).length; };
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
      // R165: only list() was stubbed, so copy/bind/delete fell through to the
      // miss proxy ([] — no `.ok`), and every copy action toasted the failure
      // branch. Shapes mirror ipc/agent.ts: copy* → {ok, error?}; add/update/
      // bind → the account (hasPassword) or null; delete → boolean; bulk → a
      // {added, created?, skipped} counts object.
      accounts: ns({
        list: function () { return Promise.resolve(clone(accountList)); },
        add: function (account) {
          var rec = Object.assign({}, account, { hasPassword: Boolean(account && account.platformPassword) });
          accountList.push({ platformUserName: rec.platformUserName, platformUrl: rec.platformUrl, hasPassword: rec.hasPassword, tags: rec.tags || [], profileIds: [] });
          delete rec.platformPassword;
          return Promise.resolve(rec);
        },
        update: function (index, account) {
          if (index < 0 || index >= accountList.length) return Promise.resolve(null);
          var cur = accountList[index];
          if (account.platformUserName !== undefined) cur.platformUserName = account.platformUserName;
          if (account.platformUrl !== undefined) cur.platformUrl = account.platformUrl;
          if (account.tags !== undefined) cur.tags = account.tags;
          if (account.platformPassword) cur.hasPassword = true;
          return Promise.resolve(clone(cur));
        },
        delete: function (index) {
          if (index < 0 || index >= accountList.length) return Promise.resolve(false);
          accountList.splice(index, 1);
          return Promise.resolve(true);
        },
        copyUsername: function (index) {
          if (index < 0 || index >= accountList.length) return Promise.resolve({ ok: false, error: "account not found" });
          var u = accountList[index].platformUserName || "";
          return Promise.resolve(u ? { ok: true } : { ok: false, error: "account has no username" });
        },
        copyPassword: function (index) {
          if (index < 0 || index >= accountList.length) return Promise.resolve({ ok: false, error: "account not found" });
          return Promise.resolve(accountList[index].hasPassword ? { ok: true } : { ok: false, error: "account has no password" });
        },
        bind: function (index, profileIds) {
          if (index < 0 || index >= accountList.length) return Promise.resolve(null);
          accountList[index].profileIds = (profileIds || []).slice();
          return Promise.resolve(clone(accountList[index]));
        },
        bulkAdd: function (text) {
          var n = String(text || "").split("\n").filter(function (l) { return l.trim(); }).length;
          return Promise.resolve({ added: n, skipped: 0 });
        },
        bulkCreate: function (text, options) {
          var n = String(text || "").split("\n").filter(function (l) { return l.trim(); }).length;
          return Promise.resolve({ added: n, created: n, skipped: 0 });
        },
      }, "agent.accounts"),
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
      // R182: get() was missing, so editProxy() fell through to the ns() miss
      // proxy and received []. Every field then read `undefined` off an array
      // — the edit dialog opened with "undefined" in Host and an empty Port,
      // and Save would have written those garbage values back. The real
      // handler (config-manager.ts:127) returns the ProxyConfig itself, or
      // null for an unknown name.
      get: function (name) {
        var found = proxies.filter(function (p) { return p.name === name; })[0];
        if (!found) return Promise.resolve(null);
        return Promise.resolve(clone(found.config));
      },
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
  def("agentDb", {
    tables: function () { return Promise.resolve(clone(dbTables)); },
    // Shape follows agentDbTableData in src/main/services/agent-db.ts, which
    // always returns { rows, total, columns } — `total` is a COUNT(*) of the
    // whole table, not rows.length. Without this the SQL result view was never
    // exercised at all: the db tab's 87-char census was a pure empty state, so
    // every "clean" verdict for it was vacuous, and a real render bug hid there
    // (db.table-empty had been truncated mid-markup into "表 <code>").
    tableData: function (table, limit, offset) {
      var all = dbTableRows[table] || [];
      var off = Math.max(0, offset || 0);
      var lim = Math.max(1, limit || 100);
      var page = all.slice(off, off + lim);
      var columns = page.length ? Object.keys(page[0]) : (dbTableColumns[table] || []);
      return Promise.resolve({ rows: clone(page), total: all.length, columns: columns.slice() });
    },
  });
  // R158: get() used to fall through to the ns() miss proxy →
  // Promise.resolve([]). An empty array is truthy, so runsOpen() passed the
  // `if (!run)` guard and renderDetail([]) printed "undefined" everywhere
  // (title, raw "runs.status.undefined" key, garbage spans). The real handler
  // (ipc/agent.ts agent-run:get → agentRunRecorder.getRun) returns the FULL
  // AgentRun — steps + variables, unlike list() which returns stepCount
  // summaries — or null for unknown ids. Fixture mirrors that contract.
  var runDetailSteps = [
    { id: "s1", tool: "browser_navigate", args: { url: "https://www.hk01.example/verify" }, result: { ok: true, title: "Verify — step 1 of 3" }, ok: true, durationMs: 2140, timestamp: NOW - 88000 },
    { id: "s2", tool: "browser_snapshot", args: { selector: "#fingerprint-panel" }, result: { text: "canvas: managed · webgl: vendor=Apple" }, ok: true, durationMs: 340, timestamp: NOW - 84000 },
    { id: "s3", tool: "llm_complete", args: { prompt: "Does the fingerprint panel report the expected locale?" }, result: { reply: "Yes — zh-CN, Asia/Hong_Kong, matching proxy exit." }, ok: true, durationMs: 6100, timestamp: NOW - 72000 },
  ];
  def("agentRuns", {
      list: function () { return Promise.resolve(clone(runs)); },
      get: function (runId) {
        var found = runs.filter(function (r) { return r.id === runId; })[0];
        if (!found) return Promise.resolve(null);
        return Promise.resolve(clone(Object.assign({}, found, { steps: runDetailSteps, variables: { locale: "zh-CN", proxyExit: "hk01", url: "https://www.hk01.example/verify" } })));
      },
  });
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
      // R173: jobGet was missing (the ns() miss proxy answered []), so the
      // job-detail dialog could not be opened by the sweep at all. The real
      // handler returns one job object or null (automation:job-get).
      jobGet: function (id) {
        var found = automationJobs.filter(function (j) { return j.id === id; })[0];
        return Promise.resolve(found ? clone(found) : null);
      },
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
  // R159: profile.cookies was missing → dialogs hit the miss proxy and always
  // rendered the empty state, hiding the cookie table from visual review.
  // Shape mirrors CookieInfo (types.ts): domain/name/value/path/expires
  // (epoch seconds | null = session)/secure/httpOnly/sameSite.
  var cookieInfos = [
    { domain: ".amazon.com", name: "session-id", value: "142-8339216-7412536", path: "/", expires: NOW / 1000 + DAY / 1000 * 30, secure: true, httpOnly: true, sameSite: 1 },
    { domain: ".amazon.com", name: "ubid-main", value: "133-7124731-8836204", path: "/", expires: NOW / 1000 + DAY / 1000 * 369, secure: true, httpOnly: false, sameSite: 1 },
    { domain: "sellercentral.amazon.com", name: "csrf", value: "gseed:9f21e0", path: "/", expires: null, secure: true, httpOnly: true, sameSite: 0 },
  ];
  def("profile", {
      list: function () { return Promise.resolve(clone(profiles)); },
      cookies: function (dirId, filter) {
        var f = (filter || "").toLowerCase();
        var rows = cookieInfos.filter(function (c) {
          return !f || c.domain.toLowerCase().indexOf(f) >= 0 || c.name.toLowerCase().indexOf(f) >= 0;
        });
        return Promise.resolve(clone(rows));
      },
  });
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
