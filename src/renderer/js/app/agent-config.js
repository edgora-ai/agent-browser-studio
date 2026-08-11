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
  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }
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
  // ── Theme toggle ──
  agentBrowser.toggleTheme = function() {
    var html = document.documentElement;
    var current = html.getAttribute('data-theme');
    var next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('agent-browser-studio-theme', next);
    agentBrowser._updateThemeUI(next);
  };

  agentBrowser._updateThemeUI = function(theme) {
    var toggle = document.getElementById('theme-toggle');
    var label = document.getElementById('theme-label');
    if (theme === 'dark') {
      toggle.classList.add('dark');
      label.textContent = window.i18n ? window.i18n.t('theme.dark') : 'Dark';
    } else {
      toggle.classList.remove('dark');
      label.textContent = window.i18n ? window.i18n.t('theme.light') : 'Light';
    }
  };

  // ── Language toggle ──
  agentBrowser.toggleLanguage = function() {
    if (!window.i18n) return;
    window.i18n.next();
    agentBrowser._updateLangUI();
    agentBrowser._updateThemeUI(document.documentElement.getAttribute('data-theme') || 'dark');
    // Refresh the currently visible tab so its dynamic strings re-render
    // in the new language. Falls back to agent skills if no tab is active.
    if (agentBrowser.reloadCurrentTab) agentBrowser.reloadCurrentTab();
    else agentBrowser.agentLoadSkills();
  };

  agentBrowser._updateLangUI = function() {
    if (!window.i18n) return;
    var langLabel = document.getElementById('lang-label');
    if (langLabel) {
      var l = window.i18n.get();
      langLabel.textContent = l === 'zh-CN' ? t('agent-config.lang-zh','中') : t('agent-config.lang-en','EN');
    }
    // Also update the theme label (it gets overridden by i18n after apply)
  };

  // Listen for language changes
  document.addEventListener('agent-browser-language-change', function() {
    agentBrowser._updateLangUI();
    if (agentBrowser.reloadCurrentTab) agentBrowser.reloadCurrentTab();
  });
  // ── LLM Config ──
  agentBrowser.agentLoadConfig = function() {
    R.agent.llmConfig().then(function(cfg) {
      if (cfg) {
        document.getElementById('agent-llm-provider').value = cfg.provider || 'openai';
        document.getElementById('agent-llm-apikey').value = '';
        document.getElementById('agent-llm-apikey').placeholder = cfg.hasApiKey ? 'saved — leave blank to keep' : 'API key';
        document.getElementById('agent-llm-model').value = cfg.model || '';
        document.getElementById('agent-llm-url').value = cfg.apiUrl || '';
      } else {
        // Try auto-detect
        agentBrowser.agentDetectConfig();
      }
    }).catch(function(){ agentBrowser.agentDetectConfig(); });
  };

  agentBrowser.agentDetectConfig = function() {
    R.agent.detectLlmConfig().then(function(cfg) {
      if (cfg) {
        document.getElementById('agent-llm-provider').value = cfg.provider || 'openai';
        document.getElementById('agent-llm-apikey').value = '';
        document.getElementById('agent-llm-apikey').placeholder = cfg.hasApiKey ? 'saved — leave blank to keep' : 'API key';
        document.getElementById('agent-llm-model').value = cfg.model || '';
        document.getElementById('agent-llm-url').value = cfg.apiUrl || '';
        toast((window.i18n ? window.i18n.t("toast.llm.auto-detected", "Auto-detected LLM config from ~/.claude/settings.json") : "Auto-detected LLM config from ~/.claude/settings.json"), 'success');
      } else {
        toast((window.i18n ? window.i18n.t("toast.llm.not-found", "No local LLM config found. Please enter your API key.") : "No local LLM config found. Please enter your API key."), 'error');
      }
    }).catch(function(e) { toast('Auto-detect failed: ' + e.message, 'error'); });
  };

  agentBrowser.agentProviderChanged = function() {
    var prov = document.getElementById('agent-llm-provider').value;
    var modelInput = document.getElementById('agent-llm-model');
    var urlInput = document.getElementById('agent-llm-url');
    if (prov === 'claude') {
      modelInput.placeholder = 'claude-sonnet-4-6';
      urlInput.placeholder = 'https://api.anthropic.com/v1/messages';
    } else {
      modelInput.placeholder = 'gpt-4o';
      urlInput.placeholder = 'https://api.openai.com/v1/chat/completions';
    }
  };

  agentBrowser.agentSaveConfig = function() {
    var config = {
      provider: document.getElementById('agent-llm-provider').value,
      apiKey: document.getElementById('agent-llm-apikey').value.trim(),
      model: document.getElementById('agent-llm-model').value.trim(),
      apiUrl: document.getElementById('agent-llm-url').value.trim() || undefined,
    };
    if (!config.apiKey && !document.getElementById('agent-llm-apikey').placeholder.match(/^saved/)) { toast((window.i18n ? window.i18n.t("toast.llm.key-required", "API Key is required") : "API Key is required"), 'error'); return; }
    R.agent.saveLlmConfig(config).then(function(r) {
      if (r.success) {
        var el = document.getElementById('agent-config-saved');
        el.style.display = 'inline';
        setTimeout(function(){ el.style.display = 'none'; }, 3000);
        toast((window.i18n ? window.i18n.t("toast.llm.saved", "LLM config saved! Go back to Chat to start.") : "LLM config saved! Go back to Chat to start."));
      }
    }).catch(function(e) { toast(e.message, 'error'); });
  };

  // ── Agent File Access config ──
  var fsAllowlist = [];

  function renderFsAllowlist() {
    var el = document.getElementById('agent-fs-allowlist');
    if (!el) return;
    if (fsAllowlist.length === 0) {
      el.innerHTML = '<span style="color:var(--text-muted);">' + esc(t('agent-config.no-accounts','(无)')) + '</span>';
      return;
    }
    el.innerHTML = fsAllowlist.map(function(d, i) {
      return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">' +
        '<span style="flex:1;font-family:var(--mono);font-size:11px;word-break:break-all;">' + esc(d) + '</span>' +
        '<button class="btn btn-danger btn-xs" data-role="cmd" data-cmd="agentFsRemoveDir" data-cmd-arg="' + escAttr(String(i)) + '">✕</button>' +
        '</div>';
    }).join('');
  }

  function updateFsVisibility() {
    var mode = document.getElementById('agent-fs-mode').value;
    document.getElementById('agent-fs-allowlist-row').style.display = (mode === 'allowlist') ? '' : 'none';
  }

  agentBrowser.agentFsModeChanged = function() { updateFsVisibility(); };

  agentBrowser.agentFsAddDir = function() {
    api.settings.pickDir().then(function(dir) {
      if (dir && fsAllowlist.indexOf(dir) < 0) { fsAllowlist.push(dir); renderFsAllowlist(); }
    }).catch(function() {});
  };

  agentBrowser.agentFsRemoveDir = function(idxStr) {
    var idx = parseInt(idxStr, 10);
    if (!isNaN(idx)) { fsAllowlist.splice(idx, 1); renderFsAllowlist(); }
  };

  agentBrowser.agentSaveFs = function() {
    var mode = document.getElementById('agent-fs-mode').value;
    api.settings.agentFsSet(mode, fsAllowlist).then(function(r) {
      if (r.success) {
        fsAllowlist = (r.agentFs && r.agentFs.allowlist) || [];
        renderFsAllowlist();
        var el = document.getElementById('agent-fs-saved');
        el.style.display = 'inline';
        setTimeout(function(){ el.style.display = 'none'; }, 3000);
        toast(t('agent-config.file-access-saved','文件访问设置已保存'), 'success');
      }
    }).catch(function(e) { toast(e.message, 'error'); });
  };

  // Load agentFs into the UI when config view opens.
  var origLoadConfig = agentBrowser.agentLoadConfig;
  agentBrowser.agentLoadConfig = function() {
    origLoadConfig && origLoadConfig();
    api.settings.agentFsGet().then(function(cfg) {
      var modeSel = document.getElementById('agent-fs-mode');
      if (modeSel) modeSel.value = (cfg && cfg.mode) || 'sandbox';
      fsAllowlist = (cfg && cfg.allowlist) || [];
      renderFsAllowlist();
      updateFsVisibility();
    }).catch(function(){});
  };
})();
