(function() {
  "use strict";

  var cloak = window.cloak;
  var api = cloak.api;
  var R = cloak.R;
  var state = cloak.state;
  var helpers = cloak.helpers;
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
  var normalizeCloakPlatform = helpers.normalizeCloakPlatform;
  var updateCloakStatus = helpers.updateCloakStatus;
  var renderCloakBinaryCard = helpers.renderCloakBinaryCard;
  Object.assign(cloak, {
  loadBrowserTab: function () { loadBrowserTab(); },

  verifyManagedChromium: function () { runCloakBinaryAction("Verifying managed Chromium...", api.cloak.verifyBinary, "Verified"); },

  checkUpdates: function () {
        updateCloakStatus();
        toast((window.i18n ? window.i18n.t("toast.browser.refreshed", "Managed Chromium status refreshed") : "Managed Chromium status refreshed"), "success");
      }
  });
  function loadBrowserTab() {
    var card = document.getElementById("cloak-binary-card");
    if (!card) return;
    card.innerHTML = '<div class="loading">Loading binary status...</div>';
    api.cloak.binary().then(function (info) {
      card.innerHTML = renderCloakBinaryCard(info);
      updateCloakStatus();
    }).catch(function (e) {
      card.innerHTML = '<div class="empty-state">Error: ' + esc(e.message || String(e)) + '</div>';
    });
  }

  function runCloakBinaryAction(loadingText, action, doneText) {
    var statusEl = document.getElementById("cloak-binary-action-status");
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
