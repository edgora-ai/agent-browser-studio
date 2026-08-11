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
  function loadAccountsTab() {
    renderAccountsList('accounts-tab-list');
  }
  agentBrowser.loadAccountsTab = loadAccountsTab;
  function renderAccountsList(targetId) {
    R.agent.accounts.list().then(function(accounts) {
      var el = document.getElementById(targetId);
      if (!el) return;
      if (!accounts || accounts.length === 0) {
        el.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;">No accounts saved yet.</div>';
        return;
      }
      var html = '<div style="display:flex;flex-direction:column;gap:6px;">';
      for (var i = 0; i < accounts.length; i++) {
        var a = accounts[i];
        var tagsHtml = (a.tags || []).map(function(t) { return '<span style="background:#e8f4fd;padding:1px 6px;border-radius:3px;font-size:10px;">' + esc(t) + '</span>'; }).join(' ');
        html += '<div class="card" style="padding:10px;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">';
        html += '<div style="min-width:0;">';
        html += '<strong>' + esc(a.platformUserName || '?') + '</strong>';
        html += ' <span style="color:var(--text-muted);font-size:11px;">@ ' + esc(a.platformUrl || '') + '</span>';
        html += a.hasPassword ? ' <span style="color:var(--success);font-size:10px;">password saved</span>' : '';
        html += '</div>';
        html += '<div>' + tagsHtml + '</div>';
        html += '<div style="white-space:nowrap;">';
        html += '<button class="btn btn-secondary btn-sm" onclick="agentBrowser.agentEditAccount(' + i + ')" style="margin-right:4px;">Edit</button>';
        html += '<button class="btn btn-danger btn-sm" onclick="agentBrowser.agentDeleteAccount(' + i + ')">Del</button>';
        html += '</div>';
        html += '</div></div>';
      }
      html += '</div>';
      el.innerHTML = html;
    }).catch(function(e) {
      var el = document.getElementById(targetId);
      if (el) el.innerHTML = '<div class="empty-state">Error: ' + esc(e.message || String(e)) + '</div>';
    });
  }

  agentBrowser.agentLoadAccounts = function() {
    renderAccountsList('agent-accounts-list');
    if (state.currentTab === 'accounts') renderAccountsList('accounts-tab-list');
  };

  agentBrowser.agentAddAccount = function() {
    document.getElementById('dlg-account-title').textContent = 'Add Account';
    document.getElementById('acct-edit-index').value = '-1';
    document.getElementById('acct-url').value = '';
    document.getElementById('acct-username').value = '';
    document.getElementById('acct-password').value = '';
    document.getElementById('acct-tags').value = '';
    document.getElementById('dlg-account').showModal();
  };

  agentBrowser.saveAccount = function() {
    var index = parseInt(document.getElementById('acct-edit-index').value);
    var account = {
      platformUrl: document.getElementById('acct-url').value.trim(),
      platformUserName: document.getElementById('acct-username').value.trim(),
      platformPassword: document.getElementById('acct-password').value.trim(),
      tags: document.getElementById('acct-tags').value.split(',').map(function(s) { return s.trim(); }).filter(Boolean),
    };
    if (!account.platformUrl || !account.platformUserName || (index < 0 && !account.platformPassword)) {
      toast((window.i18n ? window.i18n.t("toast.account.fields-required", "URL, username, and password are required") : "URL, username, and password are required"), 'error'); return;
    }
    var p;
    if (index >= 0) {
      p = R.agent.accounts.update(index, account);
    } else {
      p = R.agent.accounts.add(account);
    }
    p.then(function(r) {
      document.getElementById('dlg-account').close();
      toast(index >= 0 ? 'Account updated' : 'Account added', 'success');
      agentBrowser.agentLoadAccounts();
    }).catch(function(e) { toast(e.message, 'error'); });
  };

  agentBrowser.agentEditAccount = function(index) {
    R.agent.accounts.list().then(function(accounts) {
      var a = accounts[index];
      if (!a) return;
      document.getElementById('dlg-account-title').textContent = 'Edit Account';
      document.getElementById('acct-edit-index').value = index;
      document.getElementById('acct-url').value = a.platformUrl || '';
      document.getElementById('acct-username').value = a.platformUserName || '';
      document.getElementById('acct-password').value = '';
      document.getElementById('acct-password').placeholder = a.hasPassword ? 'saved — leave blank to keep' : 'password';
      document.getElementById('acct-tags').value = (a.tags || []).join(', ');
      document.getElementById('dlg-account').showModal();
    });
  };

  agentBrowser.agentDeleteAccount = function(index) {
    if (!confirm('Delete this account?')) return;
    R.agent.accounts.delete(index).then(function(r) {
      if (r) { toast((window.i18n ? window.i18n.t("toast.account.deleted", "Account deleted") : "Account deleted")); agentBrowser.agentLoadAccounts(); }
    }).catch(function(e) { toast(e.message, 'error'); });
  };
})();
