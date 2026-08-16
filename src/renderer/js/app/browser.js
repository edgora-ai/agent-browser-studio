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
  loadBrowserTab: function () { loadBrowserTab(); },

  verifyManagedChromium: function () { runBrowserBinaryAction("Verifying managed Chromium...", api.browser.verifyBinary, "Verified"); },

  checkUpdates: function () {
        updateBrowserStatus();
        toast((window.i18n ? window.i18n.t("toast.browser.refreshed", "Managed Chromium status refreshed") : "Managed Chromium status refreshed"), "success");
      },

  refreshDrmStatus: function () { loadDrmStatus(true); },

  saveDrmCdmPath: function () {
        var input = document.getElementById("drm-cdm-path-input");
        var value = input ? input.value.trim() : "";
        api.drm.setCdmPath(value || null).then(function (r) {
          if (r && r.success === false) { toast((r.error) || "Failed", "error"); return; }
          toast((window.i18n ? window.i18n.t("toast.drm.cdm-path-saved", "CDM path saved") : "CDM path saved"), "success");
          loadDrmStatus(true);
        }).catch(function (e) { toast(e.message, "error"); });
      },

  refreshUpdatesStatus: function () { loadUpdates(true); },
  refreshUpdates: function () { loadUpdates(false); }
  });

  var lastAvailableUpdates = [];

  function loadBrowserTab() {
    var card = document.getElementById("agent-browser-binary-card");
    if (!card) return;
    card.innerHTML = '<div class="loading">Loading binary status...</div>';
    api.browser.binary().then(function (info) {
      card.innerHTML = renderBrowserBinaryCard(info);
      updateBrowserStatus();
    }).catch(function (e) {
      card.innerHTML = '<div class="empty-state">Error: ' + esc(e.message || String(e)) + '</div>';
    });
    loadLaunchGates();
    wireLaunchGateEvents();
    loadDrmStatus(false);
    loadUpdates(false);
  }

  function loadUpdates(forceCheck) {
    var card = document.getElementById("app-updates-card");
    if (!card) return;
    var statusEl = document.getElementById("updates-status");
    var t = function (key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; };
    var doRender = function (state) {
      if (!state) { card.innerHTML = '<div class="empty-state">No update state.</div>'; return; }
      var rows = '';
      rows += '<div class="info-row"><span>' + esc(t("browser.updates.current", "Current version")) + '</span><span>' + esc(state.currentVersion || '?') + '</span></div>';
      rows += '<div class="info-row"><span>' + esc(t("browser.updates.active", "Active version")) + '</span><span>' + esc(state.activeVersion || '?') + '</span></div>';
      rows += '<div class="info-row"><span>' + esc(t("browser.updates.previous", "Previous known-good")) + '</span><span>' + esc(state.previousVersion || '—') + '</span></div>';
      rows += '<div class="info-row"><span>' + esc(t("browser.updates.channel", "Channel")) + '</span><span>' + esc(state.channel || 'stable') + '</span></div>';
      var installed = (state.installed || []).slice().sort(function (a, b) { return b.installedAt - a.installedAt; });
      if (installed.length) {
        rows += '<div class="info-row"><span>' + esc(t("browser.updates.installed", "Installed releases")) + '</span><span>' + esc(installed.map(function (i) { return i.version + ' (' + i.status + ')'; }).join(', ')) + '</span></div>';
      }
      if (lastAvailableUpdates && lastAvailableUpdates.length) {
        rows += '<div class="info-row" style="align-items:flex-start;"><span>' + esc(t("browser.updates.available", "Available updates")) + '</span><span>';
        lastAvailableUpdates.forEach(function (rel) {
          rows += '<div style="margin:2px 0;">' + esc(rel.version) + ' <button type="button" class="btn btn-primary btn-sm" data-upd-action="install" data-upd-version="' + escAttr(rel.version) + '">' + esc(t("browser.updates.install", "Stage")) + '</button></div>';
        });
        rows += '</span></div>';
      }
      var history = state.history || [];
      if (history.length) {
        rows += '<div class="info-row" style="align-items:flex-start;"><span>' + esc(t("browser.updates.history", "History")) + '</span><span style="font-size:11px;color:var(--text-muted);">' + esc(history.slice(-6).map(function (h) { return h.action + (h.version ? ' ' + h.version : '') + (h.from ? ' ← ' + h.from : ''); }).join(' · ')) + '</span></div>';
      }
      var actionRow = '';
      if (state.previousVersion) {
        actionRow += '<button type="button" class="btn btn-secondary btn-sm" data-upd-action="rollback">' + esc(t("browser.updates.rollback", "Roll back")) + '</button> ';
      }
      card.innerHTML = '<div class="info-list">' + rows + '</div>' + (actionRow ? '<div class="btn-row">' + actionRow + '</div>' : '');
      card.onclick = function (event) {
        var target = event.target;
        if (!target || !card.contains(target)) return;
        var action = target.getAttribute && target.getAttribute("data-upd-action");
        if (!action) return;
        var version = target.getAttribute && target.getAttribute("data-upd-version");
        runUpdateAction(action, version, statusEl);
      };
    };
    api.updates.status().then(function (r) {
      if (!r || r.success === false) { card.innerHTML = '<div class="empty-state">' + esc((r && r.error) || 'Failed') + '</div>'; return; }
      var state = r.state || {};
      state.currentVersion = state.currentVersion || (r.currentVersion) || '?';
      if (forceCheck) {
        api.updates.check().then(function (cr) {
          if (cr && cr.success === false) {
            if (statusEl) statusEl.textContent = 'Check failed: ' + esc(cr.error || 'unknown');
          } else if (cr) {
            lastAvailableUpdates = cr.available || [];
            if (statusEl) statusEl.textContent = lastAvailableUpdates.length ? 'Found ' + lastAvailableUpdates.length + ' update(s).' : t("browser.updates.none", "You are up to date.");
          }
          doRender(state);
        }).catch(function (e) { if (statusEl) statusEl.textContent = 'Check failed: ' + e.message; doRender(state); });
      } else {
        doRender(state);
      }
    }).catch(function (e) {
      card.innerHTML = '<div class="empty-state">Error: ' + esc(e.message || String(e)) + '</div>';
    });
  }

  function runUpdateAction(action, version, statusEl) {
    var t = function (key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; };
    var done = function (r) {
      if (r && r.success === false) { if (statusEl) statusEl.textContent = 'Failed: ' + esc(r.error || 'unknown'); return; }
      if (action === "install") { if (statusEl) statusEl.textContent = t("browser.updates.installed-ok", "Staged — ready to activate."); }
      else if (action === "activate") { if (statusEl) statusEl.textContent = t("browser.updates.activated", "Activated — takes effect on next launch."); }
      else if (action === "rollback") { if (statusEl) statusEl.textContent = t("browser.updates.rolled-back", "Rolled back to the previous version."); }
      loadUpdates(false);
    };
    if (action === "install") api.updates.install(version).then(done).catch(function (e) { if (statusEl) statusEl.textContent = 'Failed: ' + e.message; });
    else if (action === "activate") api.updates.activate(version).then(done).catch(function (e) { if (statusEl) statusEl.textContent = 'Failed: ' + e.message; });
    else if (action === "rollback") api.updates.rollback().then(done).catch(function (e) { if (statusEl) statusEl.textContent = 'Failed: ' + e.message; });
  }

  function loadDrmStatus(forceRescan) {
    var card = document.getElementById("agent-browser-drm-card");
    if (!card) return;
    var statusEl = document.getElementById("drm-status");
    var doRender = function (status) {
      if (!status) return;
      var cdm = status.cdm || null;
      var availHtml = cdm
        ? '<span style="color:var(--success);">✅ Widevine CDM available</span>'
        : '<span style="color:var(--warning);">⚠ No Widevine CDM found (install Chrome or set a path)</span>';
      var versionHtml = cdm ? '<div class="info-row"><span>Version</span><span>' + esc(cdm.version) + '</span></div>' : '';
      var sourceHtml = cdm ? '<div class="info-row"><span>Source</span><span>' + esc(cdm.source) + '</span></div>' : '';
      var pathHtml = cdm ? '<div class="info-row"><span>Path</span><span title="' + escAttr(cdm.path) + '">' + esc(shortPath(cdm.path)) + '</span></div>' : '';
      var profilesHtml = (status.profilesWithDrm && status.profilesWithDrm.length)
        ? '<div class="info-row"><span>DRM profiles</span><span>' + esc(status.profilesWithDrm.length + '') + '</span></div>' : '';
      card.innerHTML = '<div class="info-row"><span>Status</span><span>' + availHtml + '</span></div>' + versionHtml + sourceHtml + pathHtml + profilesHtml;
      var input = document.getElementById("drm-cdm-path-input");
      if (input && input.value === "") input.value = status.configuredPath || "";
      if (statusEl) statusEl.textContent = "";
    };
    var p = forceRescan ? api.drm.ensure() : api.drm.status();
    p.then(function (r) {
      if (!r || r.success === false) { card.innerHTML = '<div class="empty-state">' + esc((r && r.error) || "Failed") + '</div>'; return; }
      doRender(r.status || r);
    }).catch(function (e) {
      card.innerHTML = '<div class="empty-state">' + esc(e.message || String(e)) + '</div>';
    });
  }

  function gateEl(id) { return document.getElementById(id); }
  function currentGates() {
    return {
      blockOnConsistencyConflict: gateEl("gate-consistency") ? gateEl("gate-consistency").checked : false,
      blockOnProxyRisk: gateEl("gate-proxy-risk") ? gateEl("gate-proxy-risk").checked : false,
      blockOnFingerprintDrift: gateEl("gate-drift") ? gateEl("gate-drift").checked : true,
      blockOnEnvironmentRisk: gateEl("gate-env-risk") ? gateEl("gate-env-risk").checked : false,
    };
  }
  function loadLaunchGates() {
    if (!api.settings || !api.settings.launchGates) return;
    api.settings.launchGates().then(function (g) {
      if (!g) return;
      if (gateEl("gate-consistency")) gateEl("gate-consistency").checked = g.blockOnConsistencyConflict === true;
      if (gateEl("gate-proxy-risk")) gateEl("gate-proxy-risk").checked = g.blockOnProxyRisk === true;
      if (gateEl("gate-drift")) gateEl("gate-drift").checked = g.blockOnFingerprintDrift !== false;
      if (gateEl("gate-env-risk")) gateEl("gate-env-risk").checked = g.blockOnEnvironmentRisk === true;
    }).catch(function () { /* ignore */ });
  }
  function saveGates() {
    if (!api.settings || !api.settings.setLaunchGates) return;
    var gates = currentGates();
    api.settings.setLaunchGates(gates).then(function (r) {
      var statusEl = gateEl("gate-status");
      if (!statusEl) return;
      if (r && r.success === false) {
        statusEl.innerHTML = '<span style="color:var(--danger);">' + esc(r.error || "save failed") + '</span>';
      } else {
        statusEl.innerHTML = '<span style="color:var(--success);">' + (window.i18n ? window.i18n.t("browser.gate.saved", "saved") : "saved") + '</span>';
        setTimeout(function () { statusEl.textContent = ""; }, 2500);
      }
    }).catch(function () { /* ignore */ });
  }
  function wireLaunchGateEvents() {
    ["gate-consistency", "gate-proxy-risk", "gate-drift", "gate-env-risk"].forEach(function (id) {
      var el = gateEl(id);
      if (el && !el.dataset.gateWired) {
        el.dataset.gateWired = "1";
        el.onchange = function () { saveGates(); };
      }
    });
  }

  function runBrowserBinaryAction(loadingText, action, doneText) {
    var statusEl = document.getElementById("agent-browser-binary-action-status");
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--primary);">' + esc(loadingText) + '</span>';
    action().then(function (r) {
      var msg = typeof doneText === "function" ? doneText(r) : doneText;
      if (r && r.success === false) {
        msg = r.error || "Action failed";
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">' + esc(msg) + '</span>';
        toast(msg, "error");
      } else {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--success);">' + esc(msg) + '</span>';
        toast(msg, "success");
      }
      loadBrowserTab();
    }).catch(function (e) {
      var msg = e.message || String(e);
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">' + esc(msg) + '</span>';
      toast(msg, "error");
    });
  }
})();
