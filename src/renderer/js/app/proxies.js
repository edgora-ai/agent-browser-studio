(function() {
  "use strict";

  var agentBrowser = window.agentBrowser;
  var api = agentBrowser.api;
  var R = agentBrowser.R;
  var state = agentBrowser.state;
  var helpers = agentBrowser.helpers;
  var toast = helpers.toast;
  var esc = helpers.esc;
  var escAttr = helpers.escAttr;
  var fmt = helpers.fmt;
  var shortPath = helpers.shortPath;
  var renderChatMarkdown = helpers.renderChatMarkdown;
  var renderInlineMarkdown = helpers.renderInlineMarkdown;
  var safeCodeLanguage = helpers.safeCodeLanguage;
  var hardwareSummary = helpers.hardwareSummary;
  var shortenGpu = helpers.shortenGpu;
  var fingerprintCompleteness = helpers.fingerprintCompleteness;
  var platformIcon = helpers.platformIcon;
  var parseTagInput = helpers.parseTagInput;
  var parseListInput = helpers.parseListInput;
  var closeDialogIfOpen = helpers.closeDialogIfOpen;
  var clearSkillEditor = helpers.clearSkillEditor;
  var refreshSkillViews = helpers.refreshSkillViews;
  var skillSourceLabel = helpers.skillSourceLabel;
  var renderSkillTags = helpers.renderSkillTags;
  var renderSkillCard = helpers.renderSkillCard;
  var bindSkillCardActions = helpers.bindSkillCardActions;
  var readHardwareFields = helpers.readHardwareFields;
  var writeHardwareFields = helpers.writeHardwareFields;
  var renderProxyOptions = helpers.renderProxyOptions;
  var proxySelectionValue = helpers.proxySelectionValue;
  var profileProxySelectionValue = helpers.profileProxySelectionValue;
  var proxyDisplayLabel = helpers.proxyDisplayLabel;
  var parseProxySelection = helpers.parseProxySelection;
  var extractChromeExtensionId = helpers.extractChromeExtensionId;
  var getSyncStatus = helpers.getSyncStatus;
  var markProfileRuntime = helpers.markProfileRuntime;
  var clearProfileRuntime = helpers.clearProfileRuntime;
  var scheduleProfilesRefresh = helpers.scheduleProfilesRefresh;
  var getBrowserDisplay = helpers.getBrowserDisplay;
  var chromeOsFromPlatform = helpers.chromeOsFromPlatform;
  var uaPlatformFromPlatform = helpers.uaPlatformFromPlatform;
  var platformFromOsName = helpers.platformFromOsName;
  var normalizeBrowserPlatform = helpers.normalizeBrowserPlatform;
  var updateBrowserStatus = helpers.updateBrowserStatus;
  var renderBrowserBinaryCard = helpers.renderBrowserBinaryCard;
  Object.assign(agentBrowser, {
  detectProxy: function (name) {
        var el = document.getElementById("detect-" + name);
        if (el) el.textContent = "⏳ Detecting...";
        api.proxy.get(name).then(function (cfg) {
          if (!cfg) { if (el) el.textContent = "❌ Not found"; return; }
          return api.detect.proxyByName(name);
        }).then(function (r) {
          if (!r) return;
          if (r.success) {
            var parts = [];
            if (r.exitIp) parts.push("IP:" + r.exitIp);
            if (r.country) parts.push(r.country);
            if (r.city) parts.push(r.city);
            if (r.latencyMs) parts.push(r.latencyMs + "ms");
            if (el) el.textContent = parts.join(" | ");
          } else {
            if (el) el.textContent = "❌ " + (r.error || "Failed");
          }
        }).catch(function (e) { if (el) el.textContent = "❌ " + e.message; });
      },

  setDefault: function (name) {
        api.proxy.setDefault(name).then(function (r) {
          if (r.success) { toast((window.i18n ? window.i18n.t("toast.proxy.default-set", "Default set") : "Default set"), "success"); agentBrowser.refresh(); }
          else toast(r.error || "Failed", "error");
        });
      },

  editProxy: function (name) {
        api.proxy.get(name).then(function (cfg) {
          if (!cfg) return;
          document.getElementById("dlg-proxy-title").textContent = "Edit: " + name;
          document.getElementById("dlg-proxy-old-name").value = name;
          document.getElementById("dlg-proxy-name").value = name;
          document.getElementById("dlg-proxy-type").value = cfg.type;
          document.getElementById("dlg-proxy-host").value = cfg.host;
          document.getElementById("dlg-proxy-port").value = cfg.port;
          document.getElementById("dlg-proxy-username").value = cfg.username || "";
          document.getElementById("dlg-proxy-password").value = "";
          document.getElementById("dlg-proxy-password").placeholder = cfg.hasAuth ? "saved — leave blank to keep" : "optional";
          document.getElementById("dlg-proxy-bypass").value = (cfg.bypassList || []).join(", ");
          document.getElementById("dlg-proxy").showModal();
        });
      },

  delProxy: function (name) {
        agentBrowser.confirm('Delete proxy "' + name + '"?', function () {
          api.proxy.delete(name).then(function (r) {
            if (r.success) { toast((window.i18n ? window.i18n.t("toast.deleted", "Deleted") : "Deleted"), "success"); agentBrowser.refresh(); }
            else toast(r.error || "Failed", "error");
          }).catch(function (e) { toast(e.message, "error"); });
        });
      },

  clearHealth: function (name) {
        api.proxy.healthClear(name).then(function (r) {
          if (r && r.success) { toast((window.i18n ? window.i18n.t("toast.proxy.health-cleared", "Health cleared") : "Health cleared"), "success"); agentBrowser.refresh(); }
          else toast((r && r.error) || "Failed", "error");
        }).catch(function (e) { toast(e.message, "error"); });
      },

  showImport: function () {
        toast("Disk import is disabled in the Browser-only build. Use Bulk Import to create Browser profiles.", "error");
      },

  doImport: function () {
        toast("Disk import is disabled in the Browser-only build.", "error");
      },

  newProxy: function () {
        document.getElementById("dlg-proxy-title").textContent = "Add Proxy";
        document.getElementById("dlg-proxy-old-name").value = "";
        document.getElementById("dlg-proxy-name").value = "";
        document.getElementById("dlg-proxy-type").value = "http";
        document.getElementById("dlg-proxy-host").value = "127.0.0.1";
        document.getElementById("dlg-proxy-port").value = "7890";
        document.getElementById("dlg-proxy-username").value = "";
        document.getElementById("dlg-proxy-password").value = "";
        document.getElementById("dlg-proxy-bypass").value = "";
        document.getElementById("dlg-proxy").showModal();
      },

  saveProxy: function () {
        var oldName = document.getElementById("dlg-proxy-old-name").value;
        var name = document.getElementById("dlg-proxy-name").value.trim();
        var username = document.getElementById("dlg-proxy-username").value.trim();
        var password = document.getElementById("dlg-proxy-password").value;
        var bypassList = document.getElementById("dlg-proxy-bypass").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        var config = {
          type: document.getElementById("dlg-proxy-type").value,
          host: document.getElementById("dlg-proxy-host").value.trim(),
          port: parseInt(document.getElementById("dlg-proxy-port").value, 10),
          username: username || undefined,
          password: username && password ? password : undefined,
          bypassList: bypassList.length ? bypassList : undefined
        };
        if (!name) { toast((window.i18n ? window.i18n.t("toast.name-required", "Name required") : "Name required"), "error"); return; }
        function done() { toast(oldName ? (window.i18n ? window.i18n.t("toast.proxy.updated", "Proxy updated") : "Proxy updated") : "Proxy added", "success"); document.getElementById("dlg-proxy").close(); agentBrowser.refresh(); }
        function fail(e) { toast((e && e.message) || "Failed", "error"); }
        if (oldName && oldName !== name) {
          api.proxy.rename(oldName, name, config).then(function (r) { if (r && r.success === false) fail(r); else done(); }).catch(fail);
        } else if (oldName) {
          api.proxy.update(oldName, config).then(function (r) { if (r && r.success === false) fail(r); else done(); }).catch(fail);
        } else {
          api.proxy.add(name, config).then(function (r) { if (r && r.success === false) fail(r); else done(); }).catch(fail);
        }
      }
  });
  function healthBadgeHtml(entry) {
    if (!entry) return '<span class="proxy-health-badge health-none">未检测</span>';
    var cls = entry.risk === "good" ? "health-good" : entry.risk === "watch" ? "health-watch" : "health-poor";
    var label = entry.risk === "good" ? "良好" : entry.risk === "watch" ? "需关注" : "较差";
    var cooldown = entry.cooldownUntil && entry.cooldownUntil > Date.now() ? " ⏸冷却" : "";
    return '<span class="proxy-health-badge ' + cls + '" title="' + escAttr(entry.suggestion || "") + '">' + label + ' · ' + entry.score + '分' + cooldown + '</span>';
  }

  function renderHealthSummary(health) {
    var summary = (health && health.summary) || null;
    if (!summary || !summary.total) return "";
    return '<div class="proxy-health-summary">' +
      '<span>代理健康 <b>' + summary.total + '</b></span>' +
      '<span style="color:var(--success)">良好 <b>' + summary.good + '</b></span>' +
      '<span style="color:var(--warning)">需关注 <b>' + summary.watch + '</b></span>' +
      '<span style="color:var(--danger)">较差 <b>' + summary.poor + '</b></span>' +
      (summary.inCooldown ? '<span>⏸ 冷却 <b>' + summary.inCooldown + '</b></span>' : '') +
      '</div>';
  }

  function findHealth(entries, name) {
    if (!entries) return null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].proxyName === name) return entries[i];
    }
    return null;
  }

  function healthRowsHtml(entry) {
    var html = '<div class="info-row"><span>健康</span><span class="proxy-health-row">' + healthBadgeHtml(entry) + '</span></div>';
    if (entry && entry.suggestion) html += '<div class="info-row proxy-health-suggestion-row"><span>建议</span><span class="proxy-health-suggestion">' + esc(entry.suggestion) + '</span></div>';
    if (entry && entry.bindings && entry.bindings.length) html += '<div class="info-row"><span>绑定</span><span>' + esc(entry.bindings.join(", ")) + '</span></div>';
    return html;
  }

  function loadProxyTab() {
    var container = document.getElementById("proxy-list");
    container.innerHTML = '<div class="loading">Loading proxies...</div>';
    api.proxy.healthGet().then(function (health) {
      window.__proxyHealth = health || { entries: [], summary: null };
    }).catch(function () {
      window.__proxyHealth = { entries: [], summary: null };
    }).then(function () {
      return api.proxy.list();
    }).then(function (proxies) {
      var health = window.__proxyHealth || { entries: [], summary: null };
      if (!proxies || proxies.length === 0) {
        container.innerHTML = '<div class="empty-state">No proxies configured.</div>';
        return;
      }
      container.innerHTML = renderHealthSummary(health) + proxies.map(function (p) {
        var cfg = p.config || {};
        var label = cfg.type + '://' + cfg.host + ':' + cfg.port;
        var entry = findHealth(health.entries, p.name);
        return '<div class="profile-card" data-proxy-name="' + escAttr(p.name) + '">' +
          '<div class="card-header"><span class="name">' + esc(p.name) + '</span><span class="status-badge ' + (p.isDefault ? 'status-running' : 'status-stopped') + '">' + (p.isDefault ? 'Default' : 'Proxy') + '</span></div>' +
          '<div class="info-row"><span>Endpoint</span><span>' + esc(label) + '</span></div>' +
          '<div class="info-row"><span>Detect</span><span class="proxy-detect-result">Not checked</span></div>' +
          healthRowsHtml(entry) +
          '<div class="card-actions">' +
            '<button class="btn btn-secondary btn-sm" data-action="detect-proxy">🔍 Detect</button> ' +
            '<button class="btn btn-secondary btn-sm" data-action="default-proxy">★ Default</button> ' +
            '<button class="btn btn-secondary btn-sm" data-action="clear-health">🧹 清除健康</button> ' +
            '<button class="btn btn-secondary btn-sm" data-action="edit-proxy">✎ Edit</button> ' +
            '<button class="btn btn-danger btn-sm" data-action="delete-proxy">🗑</button>' +
          '</div>' +
        '</div>';
      }).join("");
      attachProxyHandlers(container);
    }).catch(function (e) {
      container.innerHTML = '<div class="empty-state">Error: ' + esc(e.message || String(e)) + '</div>';
    });
  }
  function attachProxyHandlers(container) {
    container.onclick = function (event) {
      var target = event.target.closest("[data-action]");
      if (!target || !container.contains(target)) return;
      var card = target.closest(".profile-card");
      var name = card && card.dataset.proxyName;
      if (!name) return;
      var action = target.dataset.action;
      if (action === "detect-proxy") detectProxyIntoCard(name, card);
      else if (action === "default-proxy") agentBrowser.setDefault(name);
      else if (action === "clear-health") agentBrowser.clearHealth(name);
      else if (action === "edit-proxy") agentBrowser.editProxy(name);
      else if (action === "delete-proxy") agentBrowser.delProxy(name);
    };
  }

  function refreshHealthInCard(name, card) {
    api.proxy.healthGet().then(function (health) {
      var entry = findHealth((health && health.entries) || [], name);
      var row = card.querySelector(".proxy-health-row");
      if (row) row.innerHTML = healthBadgeHtml(entry);
      var sugRow = card.querySelector(".proxy-health-suggestion-row");
      if (sugRow) {
        if (entry && entry.suggestion) {
          var txt = sugRow.querySelector(".proxy-health-suggestion");
          if (txt) txt.textContent = entry.suggestion;
          sugRow.style.display = "";
        } else {
          sugRow.style.display = "none";
        }
      }
      var summaryEl = document.querySelector(".proxy-health-summary");
      if (summaryEl) summaryEl.outerHTML = renderHealthSummary(health);
    }).catch(function () {});
  }

  function detectProxyIntoCard(name, card) {
    var el = card.querySelector(".proxy-detect-result");
    if (el) el.textContent = "⏳ Detecting...";
    api.proxy.get(name).then(function (cfg) {
      if (!cfg) { if (el) el.textContent = "❌ Not found"; return null; }
      return api.detect.proxyByName(name);
    }).then(function (r) {
      if (!r) return;
      if (r.success) {
        var parts = [];
        if (r.exitIp) parts.push("IP:" + r.exitIp);
        if (r.country) parts.push(r.country);
        if (r.city) parts.push(r.city);
        if (r.latencyMs) parts.push(r.latencyMs + "ms");
        if (el) el.textContent = parts.join(" | ") || "✅ OK";
      } else if (el) {
        el.textContent = "❌ " + (r.error || "Failed");
      }
      refreshHealthInCard(name, card);
    }).catch(function (e) { if (el) el.textContent = "❌ " + e.message; });
  }
  agentBrowser.loadProxies = loadProxyTab;
  agentBrowser.detectProxyIntoCard = detectProxyIntoCard;

})();
