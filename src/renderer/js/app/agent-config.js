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
  var icon = helpers.icon;
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
    // R181: keep the switch's announced state in step with its visual state —
    // a role=switch that never updates aria-checked reads as permanently off.
    if (toggle) toggle.setAttribute('aria-checked', theme === 'dark' ? 'true' : 'false');
    label.setAttribute('data-i18n', theme === 'dark' ? 'theme.dark' : 'theme.light');
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
    // next() dispatches the language-change event; refresh only in its listener.
    window.i18n.next();
  };

  agentBrowser._updateLangUI = function() {
    if (!window.i18n) return;
    var langLabel = document.getElementById('lang-label');
    if (langLabel) {
      var l = window.i18n.get();
      langLabel.textContent = l === 'zh-CN' ? t('agent-config.lang-zh','中') : t('agent-config.lang-en','EN');
    }
  };

  // Listen for language changes
  document.addEventListener('agent-browser-language-change', function() {
    agentBrowser._updateLangUI();
    agentBrowser._updateThemeUI(document.documentElement.getAttribute('data-theme') || 'light');
    updateBrowserStatus();
    // Loading the Agent tab navigates back to Chat and reloads config. A
    // locale change must retain the visible subview and unsaved form values.
    if (state.currentTab === 'agent') {
      var views = ['chat', 'config', 'accounts', 'skills', 'adapters'];
      for (var i = 0; i < views.length; i++) {
        var view = document.getElementById('agent-view-' + views[i]);
        if (!view || view.style.display === 'none') continue;
        if (views[i] === 'chat') {
          agentBrowser.agentRenderConvs();
          agentBrowser.agentRenderMessages({ preserveScroll: true });
          agentBrowser.agentRefreshEnvironments();
        } else if (views[i] === 'config') renderFsAllowlist();
        else if (views[i] === 'accounts') agentBrowser.agentLoadAccounts();
        else if (views[i] === 'skills') agentBrowser.agentLoadSkills();
        else if (views[i] === 'adapters') agentBrowser.agentLoadAdapters();
        break;
      }
    } else if (agentBrowser.reloadCurrentTab) agentBrowser.reloadCurrentTab();
  });
  // ── LLM Config ──
  var configReadSeq = 0;
  var configFieldIds = ['agent-llm-provider', 'agent-llm-apikey', 'agent-llm-model', 'agent-llm-url'];
  var configFields = Object.create(null);
  configFieldIds.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    var field = configFields[id] = { value: el.value, dirty: false, revision: 0 };
    function edited() { field.dirty = true; ++field.revision; }
    el.addEventListener('input', edited);
    el.addEventListener('change', edited);
  });

  function configSnapshot() {
    var snapshot = Object.create(null);
    configFieldIds.forEach(function(id) {
      var el = document.getElementById(id);
      var field = configFields[id];
      if (el && field) snapshot[id] = { value: el.value, revision: field.revision, dirty: field.dirty || el.value !== field.value };
    });
    return snapshot;
  }

  function applyConfig(cfg, snapshot) {
    var values = [cfg.provider || 'openai', '', cfg.model || '', cfg.apiUrl || ''];
    configFieldIds.forEach(function(id, index) {
      var el = document.getElementById(id);
      var field = configFields[id];
      var before = snapshot[id];
      // Keep each unsaved field, including intentional empty values, but still
      // hydrate untouched fields. A read is never authority over later edits.
      if (el && field && before && !before.dirty && field.revision === before.revision && el.value === before.value) {
        el.value = values[index];
        field.value = el.value;
        field.dirty = false;
      }
    });
    var key = document.getElementById('agent-llm-apikey');
    if (key) key.placeholder = cfg.hasApiKey ? 'saved — leave blank to keep' : 'API key';
  }

  function detectConfig(seq, snapshot) {
    return R.agent.detectLlmConfig().then(function(cfg) {
      if (seq !== configReadSeq) return;
      if (cfg) {
        applyConfig(cfg, snapshot);
        toast((window.i18n ? window.i18n.t("toast.llm.auto-detected", "Auto-detected LLM config from ~/.claude/settings.json") : "Auto-detected LLM config from ~/.claude/settings.json"), 'success');
      } else {
        toast((window.i18n ? window.i18n.t("toast.llm.not-found", "No local LLM config found. Please enter your API key.") : "No local LLM config found. Please enter your API key."), 'error');
      }
    }).catch(function(e) {
      if (seq === configReadSeq) toast(t('toast.agent.auto-detect-failed', 'Auto-detect failed: ') + e.message, 'error');
    });
  }

  agentBrowser.agentLoadConfig = function() {
    var seq = ++configReadSeq;
    var snapshot = configSnapshot();
    return R.agent.llmConfig().then(function(cfg) {
      if (seq !== configReadSeq) return;
      if (cfg) applyConfig(cfg, snapshot);
      else return detectConfig(seq, snapshot);
    }).catch(function() {
      if (seq === configReadSeq) return detectConfig(seq, snapshot);
    });
  };

  agentBrowser.agentDetectConfig = function() {
    return detectConfig(++configReadSeq, configSnapshot());
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
    // A save supersedes earlier reads; acknowledge only fields that have not
    // changed again while saving. The payload/blank-key contract stays intact.
    ++configReadSeq;
    var savedFields = configSnapshot();
    // R15 UX P1-2: surface backend refusal instead of silent no-op.
    R.agent.saveLlmConfig(config).then(function(r) {
      if (r && r.success) {
        configFieldIds.forEach(function(id) {
          var input = document.getElementById(id);
          var field = configFields[id];
          var saved = savedFields[id];
          if (input && field && saved && input.value === saved.value && field.revision === saved.revision) {
            field.value = input.value;
            field.dirty = false;
          }
        });
        var el = document.getElementById('agent-config-saved');
        el.style.display = 'inline';
        setTimeout(function(){ el.style.display = 'none'; }, 3000);
        toast((window.i18n ? window.i18n.t("toast.llm.saved", "LLM config saved! Go back to Chat to start.") : "LLM config saved! Go back to Chat to start."));
      } else {
        toast((r && r.error) || (window.i18n ? window.i18n.t("toast.failed", "Failed") : "Failed"), 'error');
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
        '<button class="btn btn-danger btn-xs" data-role="cmd" data-cmd="agentFsRemoveDir" data-cmd-arg="' + escAttr(String(i)) + '" aria-label="Remove">' + icon("close", 12) + '</button>' +
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
      // P2 (#109): cancelled picker resolves empty — only toast real errors.
    }).catch(function(e) { toast((e && e.message) || String(e), 'error'); });
  };

  agentBrowser.agentFsRemoveDir = function(idxStr) {
    var idx = parseInt(idxStr, 10);
    if (!isNaN(idx)) { fsAllowlist.splice(idx, 1); renderFsAllowlist(); }
  };

  agentBrowser.agentSaveFs = function() {
    var mode = document.getElementById('agent-fs-mode').value;
    api.settings.agentFsSet(mode, fsAllowlist).then(function(r) {
      if (r && r.success) {
        fsAllowlist = (r.agentFs && r.agentFs.allowlist) || [];
        renderFsAllowlist();
        var el = document.getElementById('agent-fs-saved');
        el.style.display = 'inline';
        setTimeout(function(){ el.style.display = 'none'; }, 3000);
        toast(t('agent-config.file-access-saved','文件访问设置已保存'), 'success');
      } else {
        toast((r && r.error) || t('toast.failed','保存失败'), 'error');
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
    }).catch(function(e){ toast((e && e.message) || String(e), 'error'); });
  };
})();
