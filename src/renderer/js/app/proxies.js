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
  var t = function (k, fb) { return window.i18n ? window.i18n.t(k, fb) : fb; };
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
          document.getElementById("dlg-proxy-fallbacks").value = (cfg.fallbacks || []).join(", ");
          document.getElementById("dlg-proxy").showModal();
        });
      },

  delProxy: function (name) {
        agentBrowser.confirm(t('proxy.delete-confirm', 'Delete proxy "{name}"?').replace('{name}', name), function () {
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

  rotateProxy: function (name) {
        api.proxy.rotate(name).then(function (r) {
          if (r && r.info) {
            if (r.info.active && r.info.to) {
              toast(t('proxy.rotate.ok', 'Rotated to fallback proxy {name} ({reason})').replace('{name}', r.info.to).replace('{reason}', r.info.reason || t('proxy.rotate.reason-unhealthy', 'unhealthy')), "success");
            } else if (r.info.active) {
              toast(t('proxy.rotate.no-fallback', 'This proxy is unhealthy and no healthy fallback is configured'), "error");
            } else {
              toast(t('proxy.rotate.healthy', 'The current proxy is healthy — no rotation needed'), "success");
            }
            agentBrowser.refresh();
          } else {
            toast((r && r.error) || "Failed", "error");
          }
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
        document.getElementById("dlg-proxy-fallbacks").value = "";
        document.getElementById("dlg-proxy").showModal();
      },

  saveProxy: function () {
        var oldName = document.getElementById("dlg-proxy-old-name").value;
        var name = document.getElementById("dlg-proxy-name").value.trim();
        var username = document.getElementById("dlg-proxy-username").value.trim();
        var password = document.getElementById("dlg-proxy-password").value;
        var bypassList = document.getElementById("dlg-proxy-bypass").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        var fallbacks = document.getElementById("dlg-proxy-fallbacks").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        var config = {
          type: document.getElementById("dlg-proxy-type").value,
          host: document.getElementById("dlg-proxy-host").value.trim(),
          port: parseInt(document.getElementById("dlg-proxy-port").value, 10),
          username: username || undefined,
          password: username && password ? password : undefined,
          bypassList: bypassList.length ? bypassList : undefined,
          fallbacks: fallbacks.length ? fallbacks : undefined
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
      },

  importProxies: function () {
        document.getElementById("dlg-proxy-import-text").value = "";
        document.getElementById("dlg-proxy-import-replace").checked = false;
        document.getElementById("dlg-proxy-import-status").innerHTML = "";
        document.getElementById("dlg-proxy-import").showModal();
      },

  doImportProxies: function () {
        var text = document.getElementById("dlg-proxy-import-text").value.trim();
        var replace = document.getElementById("dlg-proxy-import-replace").checked;
        var statusEl = document.getElementById("dlg-proxy-import-status");
        if (!text) { toast((window.i18n ? window.i18n.t("proxy.import.need-text", "请输入代理列表") : "请输入代理列表"), "error"); return; }
        statusEl.innerHTML = (window.i18n ? window.i18n.t("proxy.import.progress", "导入中…") : "导入中…");
        api.proxy.importText(text, replace).then(function (r) {
          if (!r || r.success === false) { statusEl.innerHTML = "<span style='color:var(--danger)'>" + esc((r && r.error) || "Failed") + "</span>"; return; }
          var rep = r.report || {};
          var imported = (rep.imported || []).length;
          var skipped = (rep.skipped || []).length;
          var failed = (rep.failed || []).length;
          var html = "<span style='color:var(--success)'>" + (window.i18n ? window.i18n.t("proxy.import.done", "已导入 {n} 个代理").replace("{n}", imported) : ("已导入 " + imported + " 个代理")) + "</span>";
          if (skipped) html += "<br><span style='color:var(--warning)'>" + (window.i18n ? window.i18n.t("proxy.import.skipped", "跳过 {n}（重复或冲突）").replace("{n}", skipped) : ("跳过 " + skipped + "（重复或冲突）")) + "</span>";
          if (failed) html += "<br><span style='color:var(--danger)'>" + (window.i18n ? window.i18n.t("proxy.import.failed", "失败 {n}").replace("{n}", failed) : ("失败 " + failed)) + "</span>";
          statusEl.innerHTML = html;
          if (imported) { setTimeout(function () { document.getElementById("dlg-proxy-import").close(); agentBrowser.refresh(); }, 1200); }
        }).catch(function (e) { statusEl.innerHTML = "<span style='color:var(--danger)'>" + esc(e.message) + "</span>"; });
      },

  exportProxies: function () {
        api.proxy.exportCsv().then(function (r) {
          if (!r || r.success === false) { toast((r && r.error) || "Failed", "error"); return; }
          var blob = new Blob([r.csv], { type: "text/csv;charset=utf-8" });
          var url = URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = url;
          a.download = "proxies-" + new Date().toISOString().slice(0, 10) + ".csv";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          toast((window.i18n ? window.i18n.t("toast.proxy.exported", "Proxies exported") : "Proxies exported"), "success");
        }).catch(function (e) { toast(e.message, "error"); });
      },

  bindProxyToProfiles: function (proxyName) {
        api.browser.list().then(function (profiles) {
          var listEl = document.getElementById("dlg-proxy-bind-list");
          if (!listEl) return;
          var all = profiles || [];
          listEl.innerHTML = "";
          if (!all.length) {
            listEl.innerHTML = '<div class="empty-state">' + (window.i18n ? window.i18n.t("proxy.bind.no-profiles", "No profiles to bind") : "No profiles to bind") + '</div>';
          } else {
            all.forEach(function (p) {
              var current = p.proxyName || "";
              var label = document.createElement("label");
              label.className = "proxy-bind-item";
              label.innerHTML = '<input type="checkbox" data-dir-id="' + escAttr(p.dirId) + '"> <span>' + esc(p.name) + '</span>' +
                (current ? '<span class="proxy-bind-current">' + esc(t('proxy.bind.current', 'Current')) + ': ' + esc(current) + '</span>' : '');
              listEl.appendChild(label);
            });
          }
          var nameEl = document.getElementById("dlg-proxy-bind-proxy");
          if (nameEl) nameEl.textContent = proxyName;
          var dlg = document.getElementById("dlg-proxy-bind");
          if (dlg && !dlg.open) dlg.showModal();
        }).catch(function (e) { toast(e.message, "error"); });
      },

  doBindProxyToProfiles: function () {
        var nameEl = document.getElementById("dlg-proxy-bind-proxy");
        var proxyName = nameEl ? nameEl.textContent : "";
        if (!proxyName) { toast("Proxy name missing", "error"); return; }
        var boxes = document.querySelectorAll("#dlg-proxy-bind-list input[type=checkbox]:checked");
        var ids = [];
        Array.prototype.forEach.call(boxes, function (b) { ids.push(b.getAttribute("data-dir-id")); });
        if (!ids.length) {
          toast((window.i18n ? window.i18n.t("proxy.bind.none-selected", "请选择至少一个 profile") : "请选择至少一个 profile"), "error");
          return;
        }
        var done = 0;
        var failed = 0;
        ids.forEach(function (dirId) {
          api.proxy.setProfile(dirId, proxyName, "named").then(function (r) {
            done++;
            if (!r || r.success === false) failed++;
            finishBind();
          }).catch(function (e) { done++; failed++; finishBind(e.message); });
        });
        function finishBind(errMsg) {
          if (done < ids.length) return;
          var dlg = document.getElementById("dlg-proxy-bind");
          if (dlg && dlg.open) dlg.close();
          if (failed) {
            toast(errMsg ? ("绑定失败: " + errMsg) : ((window.i18n ? window.i18n.t("toast.proxy.bind-failed", "绑定完成，失败 {n} 个").replace("{n}", failed) : "绑定完成，失败 " + failed + " 个")), "error");
          } else {
            toast((window.i18n ? window.i18n.t("toast.proxy.bound", "已绑定 {n} 个 profile").replace("{n}", ids.length) : "已绑定 " + ids.length + " 个 profile"), "success");
          }
          agentBrowser.refresh();
          scheduleProfilesRefresh();
        }
      },

  qrcodeProxy: function (name) {
        var dlg = document.getElementById("dlg-proxy-qr");
        var img = document.getElementById("dlg-proxy-qr-img");
        var cap = document.getElementById("dlg-proxy-qr-uri");
        if (!dlg || !img) return;
        img.removeAttribute("src");
        img.style.display = "none";
        if (cap) cap.textContent = "";
        if (!dlg.open) dlg.showModal();
        api.proxy.qrcode(name).then(function (r) {
          if (!r || r.success === false) {
            if (cap) cap.textContent = (r && r.error) || "Failed";
            return;
          }
          img.src = r.dataUrl;
          img.style.display = "";
          if (cap) cap.textContent = r.uri || "";
        }).catch(function (e) { if (cap) cap.textContent = e.message; });
      }
  });
  function healthBadgeHtml(entry) {
    if (!entry) return '<span class="proxy-health-badge health-none">' + esc(t('proxy.health.not-checked', 'Not checked')) + '</span>';
    var cls = entry.risk === "good" ? "health-good" : entry.risk === "watch" ? "health-watch" : "health-poor";
    var label = entry.risk === "good" ? t('proxy.health.good', 'Good') : entry.risk === "watch" ? t('proxy.health.watch', 'Watch') : t('proxy.health.poor', 'Poor');
    var cooldown = entry.cooldownUntil && entry.cooldownUntil > Date.now() ? " ⏸" + t('proxy.health.cooldown', 'Cooldown') : "";
    var history = entry.history || [];
    var latest = history.length ? history[history.length - 1] : null;
    var riskBadges = "";
    if (latest && latest.success && latest.hosting === true) {
      riskBadges += ' <span class="proxy-idc-badge" title="' + escAttr(t('proxy.health.idc-title', 'Exit is a datacenter/IDC IP ({org})').replace('{org}', [latest.org, latest.as].filter(Boolean).join(" · ") || t('proxy.health.unknown-org', 'unknown owner'))) + '">🏭 IDC</span>';
    }
    if (latest && latest.success && latest.isProxy === true) {
      riskBadges += ' <span class="proxy-idc-badge" title="' + escAttr(t('proxy.health.proxy-title', 'Exit is flagged as a public proxy/VPN')) + '">⚠ ' + esc(t('proxy.health.proxy', 'Proxy')) + '</span>';
    }
    return '<span class="proxy-health-badge ' + cls + '" title="' + escAttr(entry.suggestion || "") + '">' + label + ' · ' + entry.score + ' ' + t('proxy.health.points', 'pts') + cooldown + '</span>' + riskBadges;
  }

  function renderHealthSummary(health) {
    var summary = (health && health.summary) || null;
    if (!summary || !summary.total) return "";
    return '<div class="proxy-health-summary">' +
      '<span>' + esc(t('proxy.health.summary', 'Proxy health')) + ' <b>' + summary.total + '</b></span>' +
      '<span style="color:var(--success)">' + esc(t('proxy.health.good', 'Good')) + ' <b>' + summary.good + '</b></span>' +
      '<span style="color:var(--warning)">' + esc(t('proxy.health.watch', 'Watch')) + ' <b>' + summary.watch + '</b></span>' +
      '<span style="color:var(--danger)">' + esc(t('proxy.health.poor', 'Poor')) + ' <b>' + summary.poor + '</b></span>' +
      (summary.inCooldown ? '<span>⏸ ' + esc(t('proxy.health.cooldown', 'Cooldown')) + ' <b>' + summary.inCooldown + '</b></span>' : '') +
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
    var html = '<div class="info-row"><span>' + esc(t('proxy.row.health', 'Health')) + '</span><span class="proxy-health-row">' + healthBadgeHtml(entry) + '</span></div>';
    if (entry && entry.suggestion) html += '<div class="info-row proxy-health-suggestion-row"><span>' + esc(t('proxy.row.suggestion', 'Suggestion')) + '</span><span class="proxy-health-suggestion">' + esc(entry.suggestion) + '</span></div>';
    if (entry && entry.bindings && entry.bindings.length) html += '<div class="info-row"><span>' + esc(t('proxy.row.bindings', 'Bindings')) + '</span><span>' + esc(entry.bindings.join(", ")) + '</span></div>';
    html += '<div class="info-row proxy-history-row" style="display:none"><span>' + esc(t('proxy.row.history', 'History')) + '</span><span class="proxy-history-text"></span></div>';
    return html;
  }

  function renderHistoryTimeline(entry) {
    if (!entry || !entry.history || !entry.history.length) {
      return '<span style="color:var(--text-muted);">No detections recorded yet — run Detect to start tracking.</span>';
    }
    var points = entry.history.slice().sort(function (a, b) { return b.at - a.at; }).slice(0, 8);
    var lines = points.map(function (h) {
      var when = new Date(h.at);
      var stamp = when.toLocaleDateString() + " " + when.toLocaleTimeString();
      if (h.success) {
        var bits = [];
        if (h.exitIp) bits.push(h.exitIp);
        if (h.countryCode) bits.push(h.countryCode);
        if (h.timezone) bits.push(h.timezone);
        if (h.provider) bits.push(h.provider);
        if (h.hosting === true) bits.push("🏭IDC");
        if (h.isProxy === true) bits.push("⚠" + t('proxy.health.proxy', 'Proxy'));
        if (typeof h.latencyMs === "number" && h.latencyMs !== null) bits.push(h.latencyMs + "ms");
        return '<div style="color:var(--success);">✅ ' + esc(stamp) + ' · ' + esc(bits.join(" | ") || "ok") + '</div>';
      }
      return '<div style="color:var(--danger);">❌ ' + esc(stamp) + ' · ' + esc(h.error || "failed") + '</div>';
    });
    return '<div style="font-size:11px;line-height:1.7;">' + lines.join("") + '</div>';
  }

  function renderHistoryIntoRow(entry, row, txt) {
    if (!row || !txt) return;
    if (entry && entry.history && entry.history.length) {
      txt.innerHTML = renderHistoryTimeline(entry);
      row.style.display = '';
    } else {
      txt.innerHTML = '<span style="color:var(--text-muted);">No detections recorded yet — run Detect to start tracking.</span>';
      row.style.display = '';
    }
  }

  function rotationRowsHtml(cfg) {
    var html = '';
    if (cfg.fallbacks && cfg.fallbacks.length) {
      html += '<div class="info-row"><span>' + esc(t('proxy.row.fallbacks', 'Fallbacks')) + '</span><span>' + esc(cfg.fallbacks.join(", ")) + '</span></div>' +
        '<div class="info-row proxy-rotation-row" style="display:none"><span>' + esc(t('proxy.row.rotation', 'Rotation')) + '</span><span class="proxy-rotation-text"></span></div>';
    }
    return html;
  }

  function loadRotationInfo(container) {
    var cards = container.querySelectorAll('.profile-card');
    Array.prototype.forEach.call(cards, function (card) {
      var name = card.dataset.proxyName;
      api.proxy.rotationInfo(name).then(function (r) {
        if (!r || !r.info) return;
        var row = card.querySelector('.proxy-rotation-row');
        var txt = card.querySelector('.proxy-rotation-text');
        if (!row || !txt || !r.info.active) return;
        if (r.info.to) {
          txt.textContent = '⚠ ' + name + ' → ' + r.info.to + ' (' + (r.info.reason || t('proxy.rotate.reason-unhealthy', 'unhealthy')) + ')';
        } else {
          txt.textContent = '⚠ ' + name + ' ' + t('proxy.rotate.row-no-fallback', 'is unhealthy and has no available fallback');
        }
        row.style.display = '';
      }).catch(function () {});
    });
  }

  function loadProxyTab() {
    var container = document.getElementById("proxy-list");
    agentBrowser.renderViewState(container, { loading: "Loading proxies..." });
    api.proxy.healthGet().then(function (health) {
      window.__proxyHealth = health || { entries: [], summary: null };
    }).catch(function () {
      window.__proxyHealth = { entries: [], summary: null };
    }).then(function () {
      return api.proxy.list();
    }).then(function (proxies) {
      var health = window.__proxyHealth || { entries: [], summary: null };
      if (!proxies || proxies.length === 0) {
        agentBrowser.renderViewState(container, { empty: "No proxies configured.", cta: { label: "Add Proxy", cmd: "newProxy" } });
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
          rotationRowsHtml(cfg) +
          '<div class="card-actions">' +
            '<button class="btn btn-secondary btn-sm" data-action="detect-proxy">🔍 Detect</button> ' +
            '<button class="btn btn-secondary btn-sm" data-action="default-proxy">★ Default</button> ' +
            '<button class="btn btn-secondary btn-sm" data-action="clear-health" title="' + escAttr(t('proxy.action.clear-health', 'Clear health')) + '">🧹 ' + esc(t('proxy.action.clear-health', 'Clear health')) + '</button> ' +
            '<button class="btn btn-secondary btn-sm" data-action="rotate-proxy" title="' + escAttr(t('proxy.action.rotate', 'Rotate')) + '">🔄 ' + esc(t('proxy.action.rotate', 'Rotate')) + '</button> ' +
            '<button class="btn btn-secondary btn-sm" data-action="toggle-history" title="' + escAttr(t('proxy.action.history', 'History')) + '">📈 ' + esc(t('proxy.action.history', 'History')) + '</button> ' +
            '<button class="btn btn-secondary btn-sm" data-action="bind-profiles" title="' + escAttr(t('proxy.action.bind', 'Bind')) + '">📎 ' + esc(t('proxy.action.bind', 'Bind')) + '</button> ' +
            '<button class="btn btn-secondary btn-sm" data-action="qrcode-proxy" title="' + escAttr(t('proxy.action.qrcode', 'QR code')) + '">📱 ' + esc(t('proxy.action.qrcode', 'QR code')) + '</button> ' +
            '<button class="btn btn-secondary btn-sm" data-action="edit-proxy">✎ Edit</button> ' +
            '<button class="btn btn-danger btn-sm" data-action="delete-proxy">🗑</button>' +
          '</div>' +
        '</div>';
      }).join("");
      attachProxyHandlers(container);
      loadRotationInfo(container);
    }).catch(function (e) {
      agentBrowser.renderViewState(container, { error: e.message || String(e), retry: { cmd: "loadProxies" } });
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
      else if (action === "rotate-proxy") agentBrowser.rotateProxy(name);
      else if (action === "toggle-history") {
        var row = card.querySelector(".proxy-history-row");
        var txt = card.querySelector(".proxy-history-text");
        if (!row) return;
        if (row.style.display !== "none") { row.style.display = "none"; return; }
        var health = window.__proxyHealth || { entries: [] };
        var entry = findHealth(health.entries, name);
        renderHistoryIntoRow(entry, row, txt);
      }
      else if (action === "edit-proxy") agentBrowser.editProxy(name);
      else if (action === "delete-proxy") agentBrowser.delProxy(name);
      else if (action === "bind-profiles") agentBrowser.bindProxyToProfiles(name);
      else if (action === "qrcode-proxy") agentBrowser.qrcodeProxy(name);
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
      var histRow = card.querySelector(".proxy-history-row");
      var histTxt = card.querySelector(".proxy-history-text");
      if (histRow && histRow.style.display !== "none" && histTxt) {
        renderHistoryIntoRow(entry, histRow, histTxt);
      }
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
        if (r.hosting === true) parts.push("🏭IDC");
        if (r.isProxy === true) parts.push("⚠" + t('proxy.health.proxy', 'Proxy'));
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
