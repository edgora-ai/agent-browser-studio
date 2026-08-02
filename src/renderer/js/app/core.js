(function() {
  "use strict";

  var api = window.cloakLite;
  var R = api; // legacy alias retained for agent calls
  var currentTab = "profiles";
  var profileRefreshTimer = null;
  var profileRuntimeSeq = 0;

  function getSyncStatus(syncedAt, lastModified) {
    if (!syncedAt) return "never";
    if (lastModified && lastModified > syncedAt) return "dirty";
    return "synced";
  }

  function markProfileRuntime(dirId, running, pid) {
    window._profileRuntimeOverrides = window._profileRuntimeOverrides || {};
    var seq = ++profileRuntimeSeq;
    window._profileRuntimeOverrides[dirId] = { running: !!running, pid: pid || null, pending: true, seq: seq, expiresAt: Date.now() + 5000 };
    return seq;
  }

  function clearProfileRuntime(dirId, seq) {
    var current = window._profileRuntimeOverrides && window._profileRuntimeOverrides[dirId];
    if (current && (seq === undefined || current.seq === seq)) delete window._profileRuntimeOverrides[dirId];
  }

  function scheduleProfilesRefresh() {
    if (profileRefreshTimer) clearTimeout(profileRefreshTimer);
    profileRefreshTimer = setTimeout(function () {
      profileRefreshTimer = null;
      if (currentTab === "profiles") cloak.loadProfiles(true);
      else if (currentTab === "storage") cloak.loadStorage();
      else if (currentTab === "extensions") cloak.loadExtensionsTab();
    }, 120);
  }

  function getBrowserDisplay(browser, dirId) {
    return { icon: "🥷", name: "CloakBrowser" };
  }

  function chromeOsFromPlatform(platform) {
    var map = {
      "Win32": "windows",
      "MacIntel": "macos",
      "Linux x86_64": "linux",
      "Linux armv81": "android",
      "iPhone": "ios",
    };
    return map[platform] || "windows";
  }

  function uaPlatformFromPlatform(platform) {
    var map = {
      "Win32": "Windows NT 10.0; Win64; x64",
      "MacIntel": "Macintosh; Intel Mac OS X 10_15_7",
      "Linux x86_64": "X11; Linux x86_64",
      "Linux armv81": "Linux; Android 14; Pixel 8",
      "iPhone": "iPhone; CPU iPhone OS 17_0 like Mac OS X",
    };
    return map[platform] || map.Win32;
  }

  function platformFromOsName(osName) {
    var map = {
      "Windows": "Win32",
      "windows": "Win32",
      "macOS": "MacIntel",
      "macos": "MacIntel",
      "Linux": "Linux x86_64",
      "linux": "Linux x86_64",
      "Android": "Linux armv81",
      "android": "Linux armv81",
      "IOS": "iPhone",
      "iOS": "iPhone",
      "ios": "iPhone",
    };
    return map[osName] || "Win32";
  }

  function normalizeCloakPlatform(platform) {
    var value = String(platform || "windows").trim();
    var map = {
      "Win32": "windows",
      "Windows": "windows",
      "windows": "windows",
      "MacIntel": "macos",
      "macOS": "macos",
      "macos": "macos",
    };
    return map[value] || "windows";
  }

  function parseProxySelection(value, fallback) {
    var raw = String(value || fallback || "none");
    if (raw === "default") return { mode: "default", name: null };
    if (raw === "none" || raw === "") return { mode: "none", name: null };
    if (raw.indexOf("named:") === 0) return { mode: "named", name: raw.slice(6) || null };
    return { mode: "named", name: raw };
  }

  function proxySelectionValue(mode, name) {
    if (mode === "default") return "default";
    if (mode === "named" && name) return "named:" + name;
    return "none";
  }

  function profileProxySelectionValue(profile, fallback) {
    if (!profile) return fallback || "none";
    if (profile.proxyMode === "default") return "default";
    if (profile.proxyMode === "named" && profile.proxyName) return proxySelectionValue("named", profile.proxyName);
    if (!profile.proxyMode && profile.proxyName) return proxySelectionValue("named", profile.proxyName);
    return fallback || "none";
  }

  function renderProxyOptions(proxies, selectedValue, includeEndpoint) {
    selectedValue = selectedValue || "none";
    var options = [
      { value: "default", label: "Default proxy" },
      { value: "none", label: "No proxy" },
    ];
    (proxies || []).forEach(function (px) {
      var cfg = px.config || {};
      var label = px.name;
      if (includeEndpoint) {
        var endpoint = String(cfg.type || "") + "://" + String(cfg.host || "") + ":" + String(cfg.port || "");
        label += " (" + endpoint + ")" + (px.isDefault ? " ★" : "");
      }
      options.push({ value: proxySelectionValue("named", px.name), label: label });
    });
    return options.map(function (opt) {
      return '<option value="' + escAttr(opt.value) + '"' + (opt.value === selectedValue ? ' selected' : '') + '>' + esc(opt.label) + '</option>';
    }).join("");
  }

  function proxyDisplayLabel(profile) {
    if (profile.proxyMode === "default") return profile.proxy ? "default: " + profile.proxy.type + "://" + profile.proxy.host + ":" + profile.proxy.port : "default proxy (missing)";
    if (profile.proxyMode === "named") return profile.proxy ? profile.proxy.type + "://" + profile.proxy.host + ":" + profile.proxy.port : "proxy missing: " + (profile.proxyName || "unknown");
    return "no proxy";
  }

  var HARDWARE_FIELDS = [
    ["gpuVendor", "gpu-vendor", "text"],
    ["gpuRenderer", "gpu-renderer", "text"],
    ["hardwareConcurrency", "hardware-concurrency", "int"],
    ["deviceMemory", "device-memory", "int"],
    ["screenWidth", "screen-width", "int"],
    ["screenHeight", "screen-height", "int"],
    ["storageQuota", "storage-quota", "int"],
    ["taskbarHeight", "taskbar-height", "int"],
    ["fontsDir", "fonts-dir", "text"],
  ];

  function readHardwareFields(prefix) {
    var out = {};
    HARDWARE_FIELDS.forEach(function (field) {
      var el = document.getElementById(prefix + field[1]);
      if (!el) return;
      var raw = String(el.value || "").trim();
      if (!raw) { out[field[0]] = null; return; }
      if (field[2] === "int") {
        var n = Number(raw);
        if (!Number.isInteger(n)) throw new Error("Invalid hardware value for " + field[1]);
        out[field[0]] = n;
      } else {
        out[field[0]] = raw;
      }
    });
    return out;
  }

  function writeHardwareFields(prefix, data) {
    data = data || {};
    HARDWARE_FIELDS.forEach(function (field) {
      var el = document.getElementById(prefix + field[1]);
      if (el) el.value = data[field[0]] == null ? "" : data[field[0]];
    });
  }

  function hardwareSummary(data) {
    data = data || {};
    var parts = [];
    if (data.screenWidth && data.screenHeight) parts.push(data.screenWidth + "x" + data.screenHeight);
    if (data.hardwareConcurrency) parts.push(data.hardwareConcurrency + " cores");
    if (data.deviceMemory) parts.push(data.deviceMemory + "GB");
    if (data.gpuRenderer) parts.push(shortenGpu(data.gpuRenderer));
    var auto = window.i18n ? window.i18n.t("fp.hw.auto", "seed-generated hardware") : "seed-generated hardware";
    return parts.length ? parts.join(" · ") : auto;
  }

  function shortenGpu(s) {
    if (!s) return "";
    var v = String(s);
    // ANGLE (Vendor, ModelName, OpenGL ES) → ModelName
    var m = v.match(/ANGLE\s*\(([^)]+)\)/i);
    if (m) {
      var inner = m[1].split(",").map(function (x) { return x.trim(); });
      if (inner.length >= 2) return inner[1];
      return inner[0];
    }
    return v.length > 28 ? v.slice(0, 28) + "…" : v;
  }

  function fingerprintCompleteness(p) {
    // Score how thoroughly the user has overridden hardware fields.
    // 0 = pure seed-generated, 100 = all fields overridden.
    var fields = ["gpuVendor", "gpuRenderer", "hardwareConcurrency", "deviceMemory", "screenWidth", "screenHeight", "storageQuota", "taskbarHeight", "fontsDir"];
    var have = 0;
    for (var i = 0; i < fields.length; i++) {
      var v = p[fields[i]];
      if (v !== null && v !== undefined && v !== "") have++;
    }
    return Math.round((have / fields.length) * 100);
  }

  function platformIcon(platform) {
    if (platform === "macos") return "🍎";
    if (platform === "linux") return "🐧";
    return "🪟";
  }
  function toast(msg, type) {
    var t = document.querySelector(".toast");
    if (t) t.remove();
    t = document.createElement("div");
    t.className = "toast toast-" + (type || "success");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3000);
  }

  function esc(s) {
    if (!s) return "";
    var d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
  }

  function escAttr(s) {
    return esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function extractChromeExtensionId(raw) {
    var value = String(raw || "").trim();
    var match = value.match(/\/detail\/(?:[^\/]+\/)?([a-p]{32})(?:[/?#]|$)/i) || value.match(/(?:[?&]id=)([a-p]{32})(?:[&#]|$)/i);
    var extId = match ? match[1] : value;
    extId = extId.toLowerCase();
    return /^[a-p]{32}$/.test(extId) ? extId : "";
  }

  function parseTagInput(raw) {
    return String(raw || "").split(",").map(function (tag) {
      return tag.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 32);
    }).filter(Boolean).filter(function (tag, index, tags) { return tags.indexOf(tag) === index; }).slice(0, 12);
  }

  function parseListInput(raw, maxItems, maxLength) {
    return String(raw || "").split(",").map(function (item) {
      return item.trim().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, maxLength || 80);
    }).filter(Boolean).filter(function (item, index, items) { return items.indexOf(item) === index; }).slice(0, maxItems || 50);
  }

  function closeDialogIfOpen(id) {
    var dialog = document.getElementById(id);
    if (dialog && dialog.open) dialog.close();
  }

  function clearSkillEditor() {
    document.getElementById('skill-id').disabled = false;
    document.getElementById('skill-id').value = '';
    document.getElementById('skill-version').value = '1.0.0';
    document.getElementById('skill-title').value = '';
    document.getElementById('skill-description').value = '';
    document.getElementById('skill-tools').value = '';
    document.getElementById('skill-tags').value = '';
    document.getElementById('skill-author').value = '';
    document.getElementById('skill-homepage').value = '';
    document.getElementById('skill-prompt').value = '';
    document.getElementById('skill-enabled').checked = true;
    document.getElementById('skill-shared').checked = false;
    document.getElementById('skill-save-status').textContent = '';
  }

  function refreshSkillViews() {
    var skillsView = document.getElementById('agent-view-skills');
    if (skillsView && skillsView.style.display !== 'none') cloak.agentLoadSkills();
    var market = document.getElementById('dlg-skill-market');
    if (market && market.open) cloak.refreshSkillMarket();
  }

  function skillSourceLabel(skill) {
    if (skill.source === 'built-in') return 'Built-in';
    if (skill.source === 'shared-catalog') return 'Shared catalog';
    return 'Local';
  }

  function renderSkillTags(tags) {
    return (tags || []).map(function (tag) {
      return '<span style="background:var(--surface2);border:1px solid var(--border);padding:1px 6px;border-radius:4px;font-size:10px;">' + esc(tag) + '</span>';
    }).join(' ');
  }

  function renderSkillCard(skill, marketplace) {
    var tags = renderSkillTags(skill.tags || []);
    var tools = (skill.tools || []).join(', ');
    var source = skillSourceLabel(skill);
    var enabled = !!skill.enabled;
    var shared = !!skill.shared;
    var actions = '';
    if (marketplace) {
      actions += enabled
        ? '<button class="btn btn-secondary btn-sm" data-action="skill-disable">✓ Enabled</button> '
        : '<button class="btn btn-primary btn-sm" data-action="skill-install">Install / Enable</button> ';
    } else {
      actions += '<button class="btn btn-secondary btn-sm" data-action="skill-toggle">' + (enabled ? 'Disable' : 'Enable') + '</button> ';
    }
    if (skill.source !== 'built-in') actions += '<button class="btn btn-secondary btn-sm" data-action="skill-edit">Edit</button> ';
    actions += '<button class="btn btn-secondary btn-sm" data-action="skill-share">' + (shared ? 'Unshare' : 'Share') + '</button> ';
    actions += '<button class="btn btn-danger btn-sm" data-action="skill-remove">' + (skill.source === 'built-in' ? 'Disable' : 'Remove') + '</button>';
    return '<div class="skill-card" data-skill-id="' + escAttr(skill.id) + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">' +
        '<div style="min-width:0;flex:1;">' +
          '<h4>' + (skill.source === 'built-in' ? '📋 ' : '🧩 ') + esc(skill.title || skill.name || skill.id) + '</h4>' +
          '<p style="font-size:11px;color:var(--text-muted);margin-bottom:4px;line-height:1.35;">' + esc(skill.description || '') + '</p>' +
          '<div class="skill-meta">' +
            '<span>Source: ' + esc(source) + '</span>' +
            '<span>Status: ' + (enabled ? 'Enabled' : 'Disabled') + '</span>' +
            '<span>Share: ' + (shared ? 'Yes' : 'No') + '</span>' +
            '<span title="' + escAttr(tools) + '">Tools: ' + esc(tools ? tools.slice(0, 120) : 'none') + '</span>' +
          '</div>' +
          (tags ? '<div style="display:flex;gap:4px;flex-wrap:wrap;margin:8px 0 0;">' + tags + '</div>' : '') +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;min-width:180px;">' + actions + '</div>' +
      '</div>' +
    '</div>';
  }

  function bindSkillCardActions(container, skills) {
    container.onclick = function (event) {
      var target = event.target.closest('[data-action]');
      if (!target || !container.contains(target)) return;
      var card = target.closest('.skill-card');
      var id = card && card.dataset.skillId;
      if (!id) return;
      var skill = (skills || []).find(function (item) { return item.id === id; }) || {};
      var action = target.dataset.action;
      if (action === 'skill-install') cloak.installSkill(id);
      else if (action === 'skill-disable') cloak.setSkillEnabled(id, false);
      else if (action === 'skill-toggle') cloak.setSkillEnabled(id, !skill.enabled);
      else if (action === 'skill-edit') cloak.showSkillEditor(id);
      else if (action === 'skill-share') cloak.setSkillShared(id, !skill.shared, skill.tags || []);
      else if (action === 'skill-remove') cloak.removeSkill(id);
    };
  }

  function renderInlineMarkdown(text) {
    var code = [];
    var html = esc(text).replace(/`([^`]+)`/g, function(_, value) {
      code.push('<code>' + value + '</code>');
      return "@@ROXY_CODE_" + (code.length - 1) + "@@";
    });
    html = html
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/_([^_]+)_/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
    return html.replace(/@@ROXY_CODE_(\d+)@@/g, function(_, idx) { return code[Number(idx)] || ""; });
  }

  function safeCodeLanguage(value) {
    var lang = String(value || "").trim();
    return /^[A-Za-z0-9_-]{1,32}$/.test(lang) ? lang : "";
  }

  // ── Markdown rendering (via marked, with XSS sanitization) ──
  var ALLOWED_MD_TAGS = {
    p: true, br: true, hr: true, blockquote: true,
    h1: true, h2: true, h3: true, h4: true, h5: true, h6: true,
    ul: true, ol: true, li: true, pre: true, code: true,
    em: true, strong: true, del: true, s: true, mark: true, sub: true, sup: true,
    a: true, span: true, table: true, thead: true, tbody: true, tr: true, th: true, td: true,
    img: true, input: true,
  };
  var ALLOWED_MD_ATTRS = {
    a: { href: true, title: true, target: true, rel: true },
    img: { src: true, alt: true, title: true, width: true, height: true },
    code: { class: true },
    span: { class: true },
    th: { align: true }, td: { align: true },
    input: { type: true, checked: true, disabled: true },
  };

  // Sanitize an HTML string from markdown: drop unknown tags (unwrap text),
  // strip dangerous attributes, neutralize javascript:/data: URLs and event handlers.
  function sanitizeMdHtml(html) {
    if (typeof window === "undefined" || !window.DOMPurify) {
      // Fallback: minimal regex strip of <script>/<style>/on*= handlers/javascript: URLs
      return String(html || "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
        .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
        .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
        .replace(/(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, "$1=\"#\"");
    }
    return window.DOMPurify.sanitize(html, {
      ALLOWED_TAGS: Object.keys(ALLOWED_MD_TAGS),
      ALLOWED_ATTR: ["href", "title", "target", "rel", "src", "alt", "width", "height", "class", "align", "type", "checked", "disabled"],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|#|\/|data:image\/(?:png|jpeg|gif|webp);base64,)/i,
    });
  }

  function renderChatMarkdown(text) {
    var src = String(text || "");
    if (typeof window !== "undefined" && window.marked && window.marked.parse) {
      try {
        window.marked.setOptions({
          breaks: false,
          gfm: true,
          headerIds: false,
          mangle: false,
        });
        var html = window.marked.parse(src);
        return sanitizeMdHtml(html);
      } catch (e) {
        // fall through to minimal rendering
      }
    }
    // Fallback: minimal paragraph rendering when marked is unavailable.
    return '<p>' + esc(src).replace(/\n/g, '<br>') + '</p>';
  }


  function shortPath(value) {
    value = String(value || "");
    if (value.length <= 48) return value;
    return "..." + value.slice(-45);
  }

  function fmt(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    var units = ["B", "KB", "MB", "GB"];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    if (i >= units.length) i = units.length - 1;
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + units[i];
  }
  function updateCloakStatus() {
    api.cloak.binary().then(function (info) {
      var el = document.getElementById("sidebar-chrome-status");
      if (info && info.installed) {
        el.innerHTML = '🟢 Cloak v' + (info.version || "?");
        el.className = 'chrome-status-ok';
      } else {
        el.innerHTML = '🔴 No Cloak installed';
        el.className = 'chrome-status-err';
      }
    }).catch(function () {
      var el = document.getElementById("sidebar-chrome-status");
      el.innerHTML = '⚪ Cloak unknown';
      el.className = 'chrome-status-unknown';
    });
  }
  function renderCloakBinaryCard(info) {
    info = info || {};
    var status = info.installed ? "Installed" : "Not installed";
    var cls = info.installed ? "status-running" : "status-stopped";
    return '<div class="profile-card">' +
      '<div class="card-header"><span class="name">CloakBrowser Chromium</span><span class="status-badge ' + cls + '">' + status + '</span></div>' +
      '<div class="info-row"><span>Version</span><span>' + esc(info.version || "--") + '</span></div>' +
      '<div class="info-row"><span>Tier</span><span>' + esc(info.tier || "--") + '</span></div>' +
      '<div class="info-row"><span>Bundled</span><span>' + esc(info.bundledVersion || "--") + '</span></div>' +
      '<div class="info-row"><span>Platform</span><span>' + esc(info.platform || "--") + '</span></div>' +
      '<div class="info-row"><span>Installed builds</span><span>' + esc(((info.installedVersions || []).map(function(item) { return item.version; }).join(", ")) || "--") + '</span></div>' +
      '<div class="info-row"><span>Binary</span><span title="' + escAttr(info.path || "") + '">' + esc(shortPath(info.path || "--")) + '</span></div>' +
      '<div class="info-row"><span>Cache</span><span title="' + escAttr(info.cacheDir || "") + '">' + esc(shortPath(info.cacheDir || "--")) + '</span></div>' +
      '</div>';
  }

  var agentActiveConvId = null;
  var agentMessages = [];
  var _wizardDirId = null;
  var _wizardProfileName = null;

  window.cloak = {
    api: api,
    R: R,
    state: {
      get currentTab() { return currentTab; },
      set currentTab(value) { currentTab = value; },
      get profileRefreshTimer() { return profileRefreshTimer; },
      set profileRefreshTimer(value) { profileRefreshTimer = value; },
      get agentActiveConvId() { return agentActiveConvId; },
      set agentActiveConvId(value) { agentActiveConvId = value; },
      get agentMessages() { return agentMessages; },
      set agentMessages(value) { agentMessages = value; },
      get wizardDirId() { return _wizardDirId; },
      set wizardDirId(value) { _wizardDirId = value; },
      get wizardProfileName() { return _wizardProfileName; },
      set wizardProfileName(value) { _wizardProfileName = value; }
    },
    helpers: {}
  };

  var cloak = window.cloak;

  // Custom confirm dialog (#dlg-confirm). The dialog markup ships with
  // data-submit-cmd="doConfirm", but nothing wired cloak.confirm to open it —
  // so profile/proxy delete (which call cloak.confirm) threw "not a function".
  // cloak.confirm(msg, onOk) opens the modal; doConfirm() runs onOk on submit.
  var _confirmCallback = null;
  cloak.confirm = function (msg, onOk) {
    _confirmCallback = typeof onOk === "function" ? onOk : null;
    var msgEl = document.getElementById("dlg-confirm-msg");
    if (msgEl) msgEl.textContent = String(msg == null ? "" : msg);
    var dlg = document.getElementById("dlg-confirm");
    if (dlg && !dlg.open) dlg.showModal();
  };
  cloak.doConfirm = function () {
    var dlg = document.getElementById("dlg-confirm");
    if (dlg && dlg.open) dlg.close();
    var cb = _confirmCallback;
    _confirmCallback = null;
    if (cb) { try { cb(); } catch (e) { console.error("[confirm] callback failed:", e); } }
  };

  Object.assign(cloak.helpers, {
    toast: toast,
    esc: esc,
    escAttr: escAttr,
    renderInlineMarkdown: renderInlineMarkdown,
    renderChatMarkdown: renderChatMarkdown,
    safeCodeLanguage: safeCodeLanguage,
    shortPath: shortPath,
    fmt: fmt,
    hardwareSummary: hardwareSummary,
    shortenGpu: shortenGpu,
    fingerprintCompleteness: fingerprintCompleteness,
    platformIcon: platformIcon,
    parseTagInput: parseTagInput,
    parseListInput: parseListInput,
    closeDialogIfOpen: closeDialogIfOpen,
    clearSkillEditor: clearSkillEditor,
    refreshSkillViews: refreshSkillViews,
    skillSourceLabel: skillSourceLabel,
    renderSkillTags: renderSkillTags,
    renderSkillCard: renderSkillCard,
    bindSkillCardActions: bindSkillCardActions,
    readHardwareFields: readHardwareFields,
    writeHardwareFields: writeHardwareFields,
    renderProxyOptions: renderProxyOptions,
    proxySelectionValue: proxySelectionValue,
    profileProxySelectionValue: profileProxySelectionValue,
    proxyDisplayLabel: proxyDisplayLabel,
    parseProxySelection: parseProxySelection,
    extractChromeExtensionId: extractChromeExtensionId,
    getSyncStatus: getSyncStatus,
    markProfileRuntime: markProfileRuntime,
    clearProfileRuntime: clearProfileRuntime,
    scheduleProfilesRefresh: scheduleProfilesRefresh,
    getBrowserDisplay: getBrowserDisplay,
    chromeOsFromPlatform: chromeOsFromPlatform,
    uaPlatformFromPlatform: uaPlatformFromPlatform,
    platformFromOsName: platformFromOsName,
    normalizeCloakPlatform: normalizeCloakPlatform,
    updateCloakStatus: updateCloakStatus,
    renderCloakBinaryCard: renderCloakBinaryCard
  });
})();
