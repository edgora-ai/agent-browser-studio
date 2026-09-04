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

  agentBrowser.switchTab = function (tab) {
    state.currentTab = tab;
    document.querySelectorAll('.nav-item').forEach(function (n) {
      var isActive = n.dataset.tab === tab;
      n.classList.toggle('active', isActive);
      n.setAttribute('aria-selected', isActive ? 'true' : 'false');
      n.setAttribute('tabindex', isActive ? '0' : '-1');
    });
    document.querySelectorAll('.tab-content').forEach(function (c) {
      var isActive = c.id === 'tab-' + tab;
      c.classList.toggle('active', isActive);
      c.setAttribute('aria-hidden', isActive ? 'false' : 'true');
    });
    agentBrowser.loadTab(tab);
  };

  agentBrowser.loadTab = function (tab) {
    if (tab === "profiles") agentBrowser.loadProfiles();
    else if (tab === "proxy") agentBrowser.loadProxies();
    else if (tab === "storage") agentBrowser.loadStorage();
    else if (tab === "sync") agentBrowser.loadSyncConfig();
    else if (tab === "browser") agentBrowser.loadBrowserTab();
    else if (tab === "extensions") agentBrowser.loadExtensionsTab();
    else if (tab === "accounts") agentBrowser.loadAccountsTab();
    else if (tab === "agent") { agentBrowser.switchAgentSub('chat'); agentBrowser.agentLoadConversations(); agentBrowser.agentLoadConfig(); }
    else if (tab === "automation") agentBrowser.loadAutomationTab();
    else if (tab === "runs") agentBrowser.loadRunsTab();
    else if (tab === "db") agentBrowser.loadDbTab();
    else if (tab === "activity") agentBrowser.loadActivity();
  };

  agentBrowser.reloadCurrentTab = function () {
    agentBrowser.applyI18n && agentBrowser.applyI18n();
    if (window.i18n && window.i18n.apply) window.i18n.apply();
    agentBrowser.loadTab(state.currentTab);
  };

  agentBrowser.applyI18n = function () {
    if (window.i18n && window.i18n.apply) { try { window.i18n.apply(); } catch (e) {} }
  };

  agentBrowser.renderViewState = function(el, state) {
    if (!el) return;
    if (state.loading) { el.innerHTML = '<div class="loading">' + esc(state.loading) + '</div>'; return; }
    if (state.error) {
      var friendly = agentBrowser.helpers && agentBrowser.helpers.friendlyError;
      var errText = typeof friendly === "function" ? friendly(state.error) : state.error;
      var msg = esc(errText);
      var retry = state.retry ? '<button class="btn btn-primary btn-sm" data-role="cmd" data-cmd="' + escAttr(state.retry.cmd) + '"' + (state.retry.arg ? ' data-cmd-arg="' + escAttr(state.retry.arg) + '"' : '') + ' style="margin-top:8px;">Retry</button>' : '';
      el.innerHTML = '<div class="empty-state" style="color:var(--danger);">' + msg + '<br>' + retry + '</div>';
      return;
    }
    if (state.empty) {
      var cta = state.cta ? '<button class="btn btn-primary btn-sm" data-role="cmd" data-cmd="' + escAttr(state.cta.cmd) + '" style="margin-top:8px;">' + esc(state.cta.label) + '</button>' : '';
      // Empty-state copy may carry <br> line breaks from translations (#14);
      // render through the shared allowlist sanitizer instead of esc() so the
      // breaks work but no other markup can execute.
      var sanitize = agentBrowser.helpers && agentBrowser.helpers.sanitizeMdHtml;
      var emptyHtml = typeof sanitize === "function" ? sanitize(String(state.empty)) : esc(state.empty);
      el.innerHTML = '<div class="empty-state">' + emptyHtml + '<br>' + cta + '</div>';
      return;
    }
  };

  agentBrowser.clearCache = function (dirId) { api.storage.clearCache(dirId).then(function (r) { toast(r.message || "Cache cleared", "success"); agentBrowser.loadStorage(); }); };

  agentBrowser.clearAllCaches = function () { api.storage.clearCache().then(function (r) { toast(r.message || "Caches cleared", "success"); agentBrowser.loadStorage(); }); };

  agentBrowser.loadStorage = function () {
    var list = document.getElementById("storage-profile-list");
    agentBrowser.renderViewState(list, { loading: "Loading storage..." });
    api.storage.info().then(function (info) {
      document.getElementById("stat-profile-total").textContent = fmt(info.totalProfileBytes || 0);
      document.getElementById("stat-disk-available").textContent = fmt(info.availableDiskBytes || 0);
      document.getElementById("stat-disk-usage").textContent = (info.diskUsagePercent || 0) + "%";
      var profiles = info.profiles || [];
      if (profiles.length === 0) {
        agentBrowser.renderViewState(list, { empty: "No profile storage yet.", cta: { label: "Create profile", cmd: "newProfile" } });
        return;
      }
      list.innerHTML = profiles.map(function (p) {
        return '<div class="profile-card" data-dir-id="' + escAttr(p.dirId) + '">' +
          '<div class="card-header"><span class="name">' + esc(p.name) + '</span><span class="status-badge status-stopped">' + esc(p.browser) + '</span></div>' +
          '<div class="info-row"><span>Size</span><span>' + fmt(p.sizeBytes || 0) + '</span></div>' +
          '<div class="info-row"><span>Modified</span><span>' + (p.lastModified ? new Date(p.lastModified).toLocaleString() : '?') + '</span></div>' +
          '<div class="card-actions"><button class="btn btn-secondary btn-sm" data-action="clear-cache">Clear Cache</button></div>' +
        '</div>';
      }).join("");
      list.onclick = function (event) {
        var target = event.target.closest("[data-action='clear-cache']");
        if (!target || !list.contains(target)) return;
        var card = target.closest(".profile-card");
        if (card && card.dataset.dirId) agentBrowser.clearCache(card.dataset.dirId);
      };
    }).catch(function (e) {
      agentBrowser.renderViewState(list, { error: e.message || String(e), retry: { cmd: "loadStorage" } });
    });
  };
})();
