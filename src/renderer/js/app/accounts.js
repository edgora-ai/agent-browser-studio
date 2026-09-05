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

  var _role = null;
  var _rolePromise = null;

  function loadAccountRole() {
    if (_role) return Promise.resolve(_role);
    if (_rolePromise) return _rolePromise;
    _rolePromise = api.team.status().then(function(st) {
      _role = (st && st.local && st.local.role) || 'owner';
      return _role;
    }).catch(function() {
      // S11 (#108): never fail open to owner. A failed role lookup falls
      // back to viewer (read-only) with a one-shot toast — the main process
      // still enforces RBAC, this only gates which buttons render.
      _role = 'viewer';
      try {
        toast((window.i18n ? window.i18n.t("toast.team.role-unknown", "Team role unavailable — showing read-only view") : "Team role unavailable — showing read-only view"), "error");
      } catch (e) { /* toast best-effort */ }
      return _role;
    });
    return _rolePromise;
  }

  function profileNameById() {
    return api.browser.list().catch(function() { return []; }).then(function(profiles) {
      var m = {};
      (profiles || []).forEach(function(p) { if (p && p.dirId) m[p.dirId] = p.name || p.dirId; });
      return m;
    });
  }

  function boundChips(profileIds, nameById) {
    if (!profileIds || !profileIds.length) return '';
    return profileIds.map(function(id) {
      var name = nameById[id] || id;
      return '<span class="chip chip-link" style="margin-right:4px;" title="' + escAttr(id) + '">🔗 ' + esc(name) + '</span>';
    }).join('');
  }

  function loadAccountsTab() {
    renderAccountsList('accounts-tab-list');
  }
  agentBrowser.loadAccountsTab = loadAccountsTab;

  function renderAccountsList(targetId) {
    var el = document.getElementById(targetId);
    if (!el) return;
    Promise.all([R.agent.accounts.list(), profileNameById(), loadAccountRole()]).then(function(res) {
      var accounts = res[0] || [];
      var nameById = res[1] || {};
      var role = res[2];
      var canManage = role !== 'viewer';
      if (!accounts || accounts.length === 0) { if(window.agentBrowser&&window.agentBrowser.renderViewState){ window.agentBrowser.renderViewState(el,{empty:'No accounts saved yet.', cta:{label:'Add Account',cmd:'agentAddAccount'}}); } else el.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;">No accounts saved yet.</div>';
        return;
      }
      var html = '<div style="display:flex;flex-direction:column;gap:6px;">';
      for (var i = 0; i < accounts.length; i++) {
        var a = accounts[i];
        var tagsHtml = (a.tags || []).map(function(t) { return '<span class="chip chip-info">' + esc(t) + '</span>'; }).join(' ');
        var chips = boundChips(a.profileIds, nameById);
        var passBtn = (a.hasPassword && canManage)
          ? '<button class="btn btn-secondary btn-xs" onclick="agentBrowser.agentCopyAccountPassword(' + i + ')" title="Copy password">🔑</button> '
          : '';
        var bindBtn = canManage ? '<button class="btn btn-secondary btn-xs" onclick="agentBrowser.agentBindAccounts(' + i + ')" title="Bind to profiles">🔗</button> ' : '';
        html += '<div class="card" style="padding:10px;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">';
        html += '<div style="min-width:0;">';
        html += '<strong>' + esc(a.platformUserName || '?') + '</strong>';
        html += ' <span style="color:var(--text-muted);font-size:11px;">@ ' + esc(a.platformUrl || '') + '</span>';
        html += a.hasPassword ? ' <span style="color:var(--success);font-size:10px;">password saved</span>' : '';
        html += '</div>';
        html += '<div>' + tagsHtml + '</div>';
        html += '<div style="white-space:nowrap;">';
        html += '<button class="btn btn-secondary btn-xs" onclick="agentBrowser.agentCopyAccountUsername(' + i + ')" title="Copy username">👤</button> ';
        html += passBtn;
        html += bindBtn;
        html += '<button class="btn btn-secondary btn-sm" onclick="agentBrowser.agentEditAccount(' + i + ')" style="margin-left:2px;">' + esc(window.i18n ? window.i18n.t("accounts.edit", "Edit") : "Edit") + '</button>';
        html += '<button class="btn btn-danger btn-sm" onclick="agentBrowser.agentDeleteAccount(' + i + ')">' + esc(window.i18n ? window.i18n.t("accounts.delete", "Del") : "Del") + '</button>';
        html += '</div>';
        html += '</div>';
        if (chips) html += '<div style="margin-top:6px;">' + chips + '</div>';
        html += '</div>';
      }
      html += '</div>';
      el.innerHTML = html;
    }).catch(function(e) {
      var el = document.getElementById(targetId);
      if (el && window.agentBrowser&&window.agentBrowser.renderViewState){ window.agentBrowser.renderViewState(el,{error: e.message||String(e), retry:{cmd:'agentLoadAccounts'}}); } else if (el) el.innerHTML = '<div class="empty-state">Error: ' + esc(e.message || String(e)) + '</div>';
    });
  }

  agentBrowser.agentLoadAccounts = function() {
    renderAccountsList('agent-accounts-list');
    if (state.currentTab === 'accounts') renderAccountsList('accounts-tab-list');
    applyAccountRoleToToolbar();
  };

  function applyAccountRoleToToolbar() {
    loadAccountRole().then(function(role) {
      var canManage = role !== 'viewer';
      var addBtn = document.querySelector('#tab-accounts [data-cmd="agentAddAccount"]');
      var importBtn = document.getElementById('acct-bulk-import-btn');
      var exportBtn = document.getElementById('acct-export-btn');
      if (addBtn) addBtn.style.display = canManage ? '' : 'none';
      if (importBtn) importBtn.style.display = canManage ? '' : 'none';
      if (exportBtn) exportBtn.style.display = canManage ? '' : 'none';
    });
  }


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
      // P2 (#109): the Accounts tab renders its own list — refresh it too.
      if (typeof agentBrowser.loadAccountsTab === "function") agentBrowser.loadAccountsTab();
    }).catch(function(e) { toast(e.message, 'error'); });
  };

  // P2 (#109): stale indexes used to dead-end silently — surface it.
  function staleAccountToast() {
    toast((window.i18n ? window.i18n.t("toast.account.stale", "Account no longer exists — the list was refreshed") : "Account no longer exists — the list was refreshed"), "error");
    agentBrowser.agentLoadAccounts();
    if (typeof agentBrowser.loadAccountsTab === "function") agentBrowser.loadAccountsTab();
  }
  agentBrowser.agentEditAccount = function(index) {
    R.agent.accounts.list().then(function(accounts) {
      var a = accounts[index];
      if (!a) { staleAccountToast(); return; }
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
    agentBrowser.confirm((window.i18n ? window.i18n.t("acct.delete-confirm", "Delete this account?") : "Delete this account?"), function() {
      R.agent.accounts.delete(index).then(function(r) {
        if (r) {
          toast((window.i18n ? window.i18n.t("toast.account.deleted", "Account deleted") : "Account deleted"));
          agentBrowser.agentLoadAccounts();
          if (typeof agentBrowser.loadAccountsTab === "function") agentBrowser.loadAccountsTab();
        }
      }).catch(function(e) { toast(e.message, 'error'); });
    });
  };

  // ── Quick copy (main process writes the clipboard; secrets never cross) ──
  agentBrowser.agentCopyAccountUsername = function(index) {
    R.agent.accounts.copyUsername(index).then(function(r) {
      if (r && r.ok) toast('Username copied to clipboard', 'success');
      else toast((r && r.error) || 'Copy failed', 'error');
    }).catch(function(e) { toast(e.message, 'error'); });
  };

  agentBrowser.agentCopyAccountPassword = function(index) {
    R.agent.accounts.copyPassword(index).then(function(r) {
      if (r && r.ok) toast('Password copied to clipboard', 'success');
      else toast((r && r.error) || 'Copy failed', 'error');
    }).catch(function(e) { toast(e.message, 'error'); });
  };

  // ── Account ↔ profile binding ──
  agentBrowser.agentBindAccounts = function(index) {
    R.agent.accounts.list().then(function(accounts) {
      var a = accounts[index];
      if (!a) { staleAccountToast(); return; }
      document.getElementById('acct-bind-index').value = index;
      return api.browser.list().catch(function() { return []; }).then(function(profiles) {
        var listEl = document.getElementById('acct-bind-list');
        var bound = a.profileIds || [];
        if (!profiles || profiles.length === 0) {
          listEl.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px;">No profiles yet. Create a profile first.</div>';
        } else {
          listEl.innerHTML = profiles.map(function(p) {
            var checked = bound.indexOf(p.dirId) >= 0 ? ' checked' : '';
            return '<label style="display:block;padding:4px 0;font-size:13px;"><input type="checkbox" class="acct-bind-cb" value="' + escAttr(p.dirId) + '"' + checked + '> ' + esc(p.name || p.dirId) + '</label>';
          }).join('');
        }
        document.getElementById('dlg-account-bind').showModal();
      });
    }).catch(function(e) { toast(e.message, 'error'); });
  };

  agentBrowser.agentSaveAccountBind = function() {
    var index = parseInt(document.getElementById('acct-bind-index').value);
    var cbs = document.querySelectorAll('#acct-bind-list .acct-bind-cb:checked');
    var profileIds = [];
    cbs.forEach(function(cb) { profileIds.push(cb.value); });
    R.agent.accounts.bind(index, profileIds).then(function(r) {
      document.getElementById('dlg-account-bind').close();
      toast('Account profiles updated', 'success');
      agentBrowser.agentLoadAccounts();
    }).catch(function(e) { toast(e.message, 'error'); });
  };

  // ── Bulk import (url, username, password, tags per line) ──
  agentBrowser.agentImportAccounts = function() {
    document.getElementById('acct-import-text').value = '';
    document.getElementById('acct-import-status').innerHTML = '';
    var cb = document.getElementById('acct-import-create-profiles');
    if (cb) { cb.checked = false; document.getElementById('acct-import-create-options').style.display = 'none'; }
    document.getElementById('dlg-account-import').showModal();
  };

  agentBrowser.agentRunAccountImport = function() {
    var text = document.getElementById('acct-import-text').value || '';
    var statusEl = document.getElementById('acct-import-status');
    var createProfiles = document.getElementById('acct-import-create-profiles') ? document.getElementById('acct-import-create-profiles').checked : false;
    var platform = document.getElementById('acct-import-platform') ? document.getElementById('acct-import-platform').value : 'windows';
    statusEl.innerHTML = '<span style="color:var(--text-muted);">Importing...</span>';
    var p = createProfiles
      ? R.agent.accounts.bulkCreate(text, { platform: platform })
      : R.agent.accounts.bulkAdd(text);
    p.then(function(r) {
      var msg = 'Added ' + r.added + ' account' + (r.added === 1 ? '' : 's');
      if (createProfiles && r.created) msg += ', created ' + r.created + ' profile' + (r.created === 1 ? '' : 's');
      if (r.skipped) msg += ', skipped ' + r.skipped;
      statusEl.innerHTML = '<span style="color:var(--success);">' + esc(msg) + '</span>';
      toast(msg, r.added ? 'success' : 'error');
      // P2 (#109): close the dialog on success (like saveAccount/bind) and
      // refresh BOTH lists — the Accounts tab list went stale behind the toast.
      if (r.added) {
        agentBrowser.agentLoadAccounts();
        if (typeof agentBrowser.loadAccountsTab === "function") agentBrowser.loadAccountsTab();
        if (createProfiles && agentBrowser.loadProfiles) agentBrowser.loadProfiles(true);
        var imDlg = document.getElementById('dlg-account-import');
        if (imDlg && imDlg.open) imDlg.close();
      }
    }).catch(function(e) {
      statusEl.innerHTML = '<span style="color:var(--danger);">' + esc(e.message) + '</span>';
    });
  };


  (function wireImportCreateToggle() {
    var cb = document.getElementById('acct-import-create-profiles');
    if (!cb) return;
    cb.addEventListener('change', function() {
      var opts = document.getElementById('acct-import-create-options');
      if (opts) opts.style.display = cb.checked ? '' : 'none';
    });
  })();

  // ── Export CSV — metadata only; passwords never leave the vault ──
  agentBrowser.agentExportAccounts = function() {
    R.agent.accounts.list().then(function(accounts) {
      var rows = [['url', 'username', 'tags', 'profile_ids']];
      (accounts || []).forEach(function(a) {
        rows.push([a.platformUrl || '', a.platformUserName || '', (a.tags || []).join(';'), (a.profileIds || []).join(';')]);
      });
      var csv = rows.map(function(r) {
        return r.map(function(c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
      }).join('\n');
      var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "accounts-" + new Date().toISOString().slice(0, 10) + ".csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
      toast((window.i18n ? window.i18n.t("toast.account.exported", "Accounts exported (metadata only)") : "Accounts exported (metadata only)"), "success");
    }).catch(function(e) { toast(e.message, 'error'); });
  };
})();
