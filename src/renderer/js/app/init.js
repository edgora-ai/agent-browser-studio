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
  var loadTab = agentBrowser.loadTab;
  var loadSyncConfig = agentBrowser.loadSyncConfig;
  var maybeShowWizard = agentBrowser.maybeShowWizard;
  function init() {
    // Restore saved theme
    var savedTheme = localStorage.getItem('agent-browser-studio-theme') || localStorage.getItem('cloak-theme') || 'light';
    try { localStorage.setItem('agent-browser-studio-theme', savedTheme); } catch (e) { /* storage disabled */ }
    document.documentElement.setAttribute('data-theme', savedTheme);
    agentBrowser._updateThemeUI(savedTheme);
    // Init language UI
    agentBrowser._updateLangUI();

    // Track event listeners for cleanup
    window._eventListeners = [];
    if (api && api.on) {
      var exitHandler = function (data) { if (data && data.dirId) markProfileRuntime(data.dirId, false, null); scheduleProfilesRefresh(); };
      api.on("browser:exited", exitHandler);
      window._eventListeners.push({ channel: "browser:exited", handler: exitHandler });
    }

    loadTab("profiles");
    loadSyncConfig();
    updateBrowserStatus();

    // First-run wizard — delay slightly so profiles list loads first
    setTimeout(function () { maybeShowWizard(); }, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
