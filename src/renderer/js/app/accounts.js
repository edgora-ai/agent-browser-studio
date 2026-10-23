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
  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }
  var _role = null;
  var _rolePromise = null;
  var _roleGeneration = 0;
  var _listGeneration = 0;
  var _accountRequest = 0;
  var _accountReady = false;
  var _accountSaving = false;
  var _accountRef = null;
  var _accountIndex = -1;
  var _listRequests = {};
  var _bindRequest = 0;
  var _bindRef = null;
  var _bindIndex = -1;

  // A command carries the displayed snapshot, not an index resolved against a
  // later list. Delegation supplies its JSON form; direct callers may supply it.
  function captureAccountRef(value) {
    try {
      var ref = typeof value === 'string' ? JSON.parse(value) : value;
      if (!ref || !Number.isSafeInteger(ref.index) || ref.index < 0 || typeof ref.revision !== 'string' || !ref.revision) return null;
      return Object.freeze({ index: ref.index, revision: ref.revision });
    } catch (e) { return null; }
  }

  function sameAccountRef(a, b) {
    return a && b && a.index === b.index && a.revision === b.revision;
  }

  function isAccountConflict(e) {
    return /ACCOUNT_REFERENCE_(REQUIRED|INVALID|CONFLICT)|ACCOUNT_NOT_FOUND/.test((e && e.code) || '') ||
      /ACCOUNT_REFERENCE_(REQUIRED|INVALID|CONFLICT)|ACCOUNT_NOT_FOUND/.test((e && e.message) || '');
  }

  function readSelectedAccount(ref) {
    return R.agent.accounts.get(ref.index, ref).then(function(a) {
      // Check before touching any target fields, even if a provider returned a
      // response from a different snapshot. Never adopt its replacement ref.
      if (!a || !sameAccountRef(a.ref, ref)) {
        var e = new Error('ACCOUNT_REFERENCE_CONFLICT');
        e.code = 'ACCOUNT_REFERENCE_CONFLICT';
        throw e;
      }
      return a;
    });
  }

  function accountCommand(cmd, ref) {
    return ' data-role="cmd" data-cmd="' + cmd + '" data-cmd-arg="' + escAttr(JSON.stringify(ref)) + '"';
  }
  var _bindReady = false;
  var _bindSaving = false;

  function loadAccountRole() {
    if (_role) return Promise.resolve(_role);
    if (_rolePromise) return _rolePromise;
    var generation = _roleGeneration;
    _rolePromise = Promise.resolve().then(function() { return api.team.status(); }).then(function(st) {
      if (generation !== _roleGeneration) return 'viewer';
      var role = st && st.local && st.local.role;
      if (['owner', 'admin', 'member', 'viewer'].indexOf(role) === -1) throw new Error('Invalid team role response');
      _role = role;
      return role;
    }).catch(function() {
      if (generation !== _roleGeneration) return 'viewer';
      // Missing/malformed authority fails closed too. No workspace is a valid
      // main-process response with local.role=owner, not a missing role field.
      _role = 'viewer';
      try {
        toast((window.i18n ? window.i18n.t("toast.team.role-unknown", "Team role unavailable — showing read-only view") : "Team role unavailable — showing read-only view"), "error");
      } catch (e) { /* toast best-effort */ }
      return _role;
    });
    return _rolePromise;
  }

  function withAccountRole(action) {
    var generation = _roleGeneration;
    return loadAccountRole().then(function(role) {
      if (generation !== _roleGeneration || role === 'viewer') {
        toast(t('toast.account.read-only', 'Accounts are read-only for viewers'), 'error');
        return;
      }
      return action();
    });
  }

  function setAccountReady(ready) {
    _accountReady = ready;
    var btn = document.querySelector('#dlg-account button[type="submit"]');
    if (btn) btn.disabled = !ready || _accountSaving;
  }

  function setBindReady(ready) {
    _bindReady = ready;
    var btn = document.querySelector('#dlg-account-bind [data-cmd="agentSaveAccountBind"]');
    if (btn) btn.disabled = !ready || _bindSaving;
  }

  // Close/cancel invalidates pending reads/writes; they must not reopen or
  // close a later dialog. Already-dispatched backend writes are not cancelled.
  (function wireAccountDialogs() {
    var accountDlg = document.getElementById('dlg-account');
    var bindDlg = document.getElementById('dlg-account-bind');
    function clearAccount() {
      _accountRequest++;
      _accountRef = null;
      _accountIndex = -1;
      _accountSaving = false;
      setAccountReady(false);
    }
    function clearBind() {
      _bindRequest++;
      _bindRef = null;
      _bindIndex = -1;
      _bindSaving = false;
      setBindReady(false);
    }
    if (accountDlg) {
      accountDlg.addEventListener('cancel', clearAccount);
      accountDlg.addEventListener('close', function() { if (!accountDlg.open) clearAccount(); });
    }
    if (bindDlg) {
      bindDlg.addEventListener('cancel', clearBind);
      bindDlg.addEventListener('close', function() { if (!bindDlg.open) clearBind(); });
    }
    setAccountReady(false);
    setBindReady(false);
  })();

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
      return '<span class="chip chip-link" style="margin-right:4px;" title="' + escAttr(name) + '">' + icon("link", 12) + ' <span class="chip-label">' + esc(name) + '</span></span>';
    }).join('');
  }

  function loadAccountsTab() {
    applyAccountRoleToToolbar();
    renderAccountsList('accounts-tab-list');
  }
  agentBrowser.loadAccountsTab = loadAccountsTab;

  function renderAccountsList(targetId) {
    var el = document.getElementById(targetId);
    if (!el) return;
    var request = (_listRequests[targetId] || 0) + 1;
    var generation = _listGeneration;
    _listRequests[targetId] = request;
    Promise.all([R.agent.accounts.list(), profileNameById(), loadAccountRole()]).then(function(res) {
      if (generation !== _listGeneration || request !== _listRequests[targetId]) return;
      var accounts = res[0] || [];
      var nameById = res[1] || {};
      var role = res[2];
      var canManage = role !== 'viewer';
      if (!accounts || accounts.length === 0) { if(window.agentBrowser&&window.agentBrowser.renderViewState){ window.agentBrowser.renderViewState(el,{empty:t('acct.empty','No accounts saved yet.'), cta:canManage ? {label:t('acct.add','Add Account'),cmd:'agentAddAccount'} : null}); } else el.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;">' + esc(t('acct.empty','No accounts saved yet.')) + '</div>';
        return;
      }
      var html = '<div style="display:flex;flex-direction:column;gap:6px;">';
      for (var i = 0; i < accounts.length; i++) {
        var a = accounts[i];
        var ref = captureAccountRef(a.ref);
        var tagsHtml = (a.tags || []).map(function(t) { return '<span class="chip chip-info">' + esc(t) + '</span>'; }).join(' ');
        var chips = boundChips(a.profileIds, nameById);
        var passTip = t('accounts.copy-pass', 'Copy password');
        var bindTip = t('accounts.bind', 'Bind to profiles');
        var userTip = t('accounts.copy-user', 'Copy username');
        var passBtn = (ref && a.hasPassword && canManage)
          ? '<button class="btn btn-secondary btn-xs" ' + accountCommand('agentCopyAccountPassword', ref) + ' title="' + escAttr(passTip) + '" aria-label="' + escAttr(passTip) + '">' + icon("key", 12) + '</button> '
          : '';
        var bindBtn = ref && canManage ? '<button class="btn btn-secondary btn-xs" ' + accountCommand('agentBindAccounts', ref) + ' title="' + escAttr(bindTip) + '" aria-label="' + escAttr(bindTip) + '">' + icon("link", 12) + '</button> ' : '';
        html += '<div class="card" style="padding:10px;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">';
        html += '<div style="min-width:0;">';
        html += '<strong>' + esc(a.platformUserName || '?') + '</strong>';
        html += ' <span style="color:var(--text-muted);font-size:11px;">@ ' + esc(a.platformUrl || '') + '</span>';
        html += a.hasPassword ? ' <span class="hint-line" style="color: var(--success-text);">' + esc(t('accounts.password-saved', 'password saved')) + '</span>' : '';
        html += '</div>';
        html += '<div>' + tagsHtml + '</div>';
        html += '<div style="white-space:nowrap;">';
        if (ref) html += '<button class="btn btn-secondary btn-xs" ' + accountCommand('agentCopyAccountUsername', ref) + ' title="' + escAttr(userTip) + '" aria-label="' + escAttr(userTip) + '">' + icon("accounts", 12) + '</button> ';
        html += passBtn;
        html += bindBtn;
        if (ref && canManage) {
          html += '<button class="btn btn-secondary btn-sm" ' + accountCommand('agentEditAccount', ref) + ' style="margin-left:2px;">' + esc(window.i18n ? window.i18n.t("accounts.edit", "Edit") : "Edit") + '</button>';
          html += '<button class="btn btn-danger btn-sm" ' + accountCommand('agentDeleteAccount', ref) + '>' + esc(window.i18n ? window.i18n.t("accounts.delete", "Del") : "Del") + '</button>';
        }
        html += '</div>';
        html += '</div>';
        if (chips) html += '<div style="margin-top:6px;">' + chips + '</div>';
        html += '</div>';
      }
      html += '</div>';
      el.innerHTML = html;
    }).catch(function(e) {
      if (generation !== _listGeneration || request !== _listRequests[targetId]) return;
      var el = document.getElementById(targetId);
      if (el && window.agentBrowser&&window.agentBrowser.renderViewState){ window.agentBrowser.renderViewState(el,{error: e.message||String(e), retry:{cmd:'agentLoadAccounts'}}); } else if (el) el.innerHTML = '<div class="empty-state">Error: ' + esc(e.message || String(e)) + '</div>';
    });
  }

  agentBrowser.agentLoadAccounts = function() {
    renderAccountsList('agent-accounts-list');
    if (state.currentTab === 'accounts') renderAccountsList('accounts-tab-list');
    applyAccountRoleToToolbar();
  };

  function applyAccountToolbarRole(role) {
    var canManage = role === 'owner' || role === 'admin' || role === 'member';
    document.querySelectorAll('[data-cmd="agentAddAccount"]').forEach(function(btn) {
      btn.style.display = canManage ? '' : 'none';
    });
    var importBtn = document.getElementById('acct-bulk-import-btn');
    var exportBtn = document.getElementById('acct-export-btn');
    if (importBtn) importBtn.style.display = canManage ? '' : 'none';
    if (exportBtn) exportBtn.style.display = canManage ? '' : 'none';
  }

  function applyAccountRoleToToolbar() {
    var generation = _roleGeneration;
    // Both the standalone and Agent toolbar stay read-only while role loads.
    applyAccountToolbarRole(_role);
    loadAccountRole().then(function(role) {
      if (generation === _roleGeneration) applyAccountToolbarRole(role);
    });
  }

  agentBrowser.invalidateAccountsForSync = function() {
    ++_listGeneration;
    ++_roleGeneration;
    _role = null;
    _rolePromise = null;
    // Revoke visible authority synchronously, without fetching or touching any
    // open dialog's input/ref/readiness. The coordinator owns the next reload.
    applyAccountToolbarRole(null);
  };


  // R157: dialog title h3 hosts a hydrated svg — write the label span, not the
  // host (textContent on the host destroys the icon; see proxies.js setDlgTitle).
  function setDlgTitle(id, text) {
    var host = document.getElementById(id);
    if (!host) return;
    var span = host.querySelector("[data-i18n]");
    (span || host).textContent = text;
  }

  agentBrowser.agentAddAccount = function() {
    var request = ++_accountRequest;
    _accountRef = null;
    _accountIndex = -1;
    _accountSaving = false;
    setAccountReady(false);
    return withAccountRole(function() {
      if (request !== _accountRequest) return;
      setDlgTitle('dlg-account-title', t('acct.dlg.add', 'Add Account'));
      document.getElementById('acct-edit-index').value = '-1';
      document.getElementById('acct-url').value = '';
      document.getElementById('acct-username').value = '';
      document.getElementById('acct-password').value = '';
      document.getElementById('acct-tags').value = '';
      setAccountReady(true);
      var dlg = document.getElementById('dlg-account');
      if (!dlg.open) dlg.showModal();
    });
  };

  agentBrowser.saveAccount = function() {
    var request = _accountRequest;
    return withAccountRole(function() {
      var dlg = document.getElementById('dlg-account');
      if (request !== _accountRequest || !dlg.open || !_accountReady || _accountSaving) return;
      var index = Number(document.getElementById('acct-edit-index').value);
      var ref = _accountRef;
      if (index !== _accountIndex || (index >= 0 && !ref)) return;
      var account = {
        platformUrl: document.getElementById('acct-url').value.trim(),
        platformUserName: document.getElementById('acct-username').value.trim(),
        platformPassword: document.getElementById('acct-password').value.trim(),
        tags: document.getElementById('acct-tags').value.split(',').map(function(s) { return s.trim(); }).filter(Boolean),
      };
      if (!account.platformUrl || !account.platformUserName || (index < 0 && !account.platformPassword)) {
        toast((window.i18n ? window.i18n.t("toast.account.fields-required", "URL, username, and password are required") : "URL, username, and password are required"), 'error'); return;
      }
      _accountSaving = true;
      setAccountReady(true);
      var p = index >= 0 ? R.agent.accounts.update(index, account, ref) : R.agent.accounts.add(account);
      return p.then(function(r) {
        if (request !== _accountRequest || !dlg.open) return;
        _accountSaving = false;
        if (!r) { setAccountReady(false); staleAccountToast(); return; }
        dlg.close();
        toast(index >= 0 ? t('toast.account.updated', 'Account updated') : t('toast.account.added', 'Account added'), 'success');
        agentBrowser.agentLoadAccounts();
        // P2 (#109): the Accounts tab renders its own list — refresh it too.
        if (typeof agentBrowser.loadAccountsTab === "function") agentBrowser.loadAccountsTab();
      }).catch(function(e) {
        if (request !== _accountRequest || !dlg.open) return;
        _accountSaving = false;
        if (isAccountConflict(e)) { setAccountReady(false); staleAccountToast(); }
        else { setAccountReady(true); toast(e.message, 'error'); }
      });
    });
  };

  // P2 (#109): stale indexes used to dead-end silently — surface it.
  function staleAccountToast() {
    toast((window.i18n ? window.i18n.t("toast.account.reference-conflict", "Account changed — reselect it from the refreshed list and confirm again") : "Account changed — reselect it from the refreshed list and confirm again"), "error");
    agentBrowser.agentLoadAccounts();
    if (typeof agentBrowser.loadAccountsTab === "function") agentBrowser.loadAccountsTab();
  }
  agentBrowser.agentEditAccount = function(value) {
    var ref = captureAccountRef(value);
    if (!ref) { staleAccountToast(); return Promise.resolve(); }
    var index = ref.index;
    var request = ++_accountRequest;
    _accountRef = ref;
    _accountIndex = index;
    _accountSaving = false;
    setAccountReady(false);
    return withAccountRole(function() {
      if (request !== _accountRequest) return;
      return readSelectedAccount(ref).then(function(a) {
        if (request !== _accountRequest) return;
        // R157: was hardcoded 'Edit Account' — no key, English in the zh UI.
        setDlgTitle('dlg-account-title', t('acct.dlg.edit', 'Edit Account'));
        document.getElementById('acct-edit-index').value = index;
        document.getElementById('acct-url').value = a.platformUrl || '';
        document.getElementById('acct-username').value = a.platformUserName || '';
        document.getElementById('acct-password').value = '';
        document.getElementById('acct-password').placeholder = a.hasPassword ? 'saved — leave blank to keep' : 'password';
        document.getElementById('acct-tags').value = (a.tags || []).join(', ');
        setAccountReady(true);
        var dlg = document.getElementById('dlg-account');
        if (!dlg.open) dlg.showModal();
      }).catch(function(e) {
        if (request !== _accountRequest) return;
        if (isAccountConflict(e)) staleAccountToast();
        else toast(e.message, 'error');
      });
    });
  };

  agentBrowser.agentDeleteAccount = function(value) {
    var ref = captureAccountRef(value);
    if (!ref) { staleAccountToast(); return Promise.resolve(); }
    var index = ref.index;
    return withAccountRole(function() {
      agentBrowser.confirm((window.i18n ? window.i18n.t("acct.delete-confirm", "Delete this account?") : "Delete this account?"), function() {
        R.agent.accounts.delete(index, ref).then(function(r) {
          if (r) {
            toast((window.i18n ? window.i18n.t("toast.account.deleted", "Account deleted") : "Account deleted"));
            agentBrowser.agentLoadAccounts();
            if (typeof agentBrowser.loadAccountsTab === "function") agentBrowser.loadAccountsTab();
          }
        }).catch(function(e) {
          if (isAccountConflict(e)) staleAccountToast();
          else toast(e.message, 'error');
        });
      });
    });
  };

  // ── Quick copy (main process writes the clipboard; secrets never cross) ──
  agentBrowser.agentCopyAccountUsername = function(value) {
    var ref = captureAccountRef(value);
    if (!ref) { staleAccountToast(); return Promise.resolve(); }
    return R.agent.accounts.copyUsername(ref.index, ref).then(function(r) {
      if (r && r.ok) toast(t('toast.account.username-copied', 'Username copied to clipboard'), 'success');
      else toast((r && r.error) || t('toast.account.copy-failed', 'Copy failed'), 'error');
    }).catch(function(e) {
      if (isAccountConflict(e)) staleAccountToast();
      else toast(e.message, 'error');
    });
  };

  agentBrowser.agentCopyAccountPassword = function(value) {
    var ref = captureAccountRef(value);
    if (!ref) { staleAccountToast(); return Promise.resolve(); }
    return withAccountRole(function() {
      return R.agent.accounts.copyPassword(ref.index, ref).then(function(r) {
        if (r && r.ok) toast(t('toast.account.password-copied', 'Password copied to clipboard'), 'success');
        else toast((r && r.error) || t('toast.account.copy-failed', 'Copy failed'), 'error');
      }).catch(function(e) {
        if (isAccountConflict(e)) staleAccountToast();
        else toast(e.message, 'error');
      });
    });
  };

  // ── Account ↔ profile binding ──
  agentBrowser.agentBindAccounts = function(value) {
    var ref = captureAccountRef(value);
    if (!ref) { staleAccountToast(); return Promise.resolve(); }
    var index = ref.index;
    var request = ++_bindRequest;
    _bindRef = ref;
    _bindIndex = index;
    _bindSaving = false;
    setBindReady(false);
    return withAccountRole(function() {
      if (request !== _bindRequest) return;
      var dlg = document.getElementById('dlg-account-bind');
      var listEl = document.getElementById('acct-bind-list');
      document.getElementById('acct-bind-index').value = index;
      // R168: a failed lookup is an error, not an empty profile list. Keep
      // Save disabled until BOTH reads belong to this dialog and succeed.
      listEl.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px;">' + esc(t('acct.bind.loading', 'Loading profiles...')) + '</div>';
      if (!dlg.open) dlg.showModal();
      return readSelectedAccount(ref).then(function(a) {
        if (request !== _bindRequest || !dlg.open) return;
        return api.browser.list().then(function(profiles) {
          if (request !== _bindRequest || !dlg.open) return;
          var bound = a.profileIds || [];
          if (!profiles || profiles.length === 0) {
            listEl.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px;">' + esc(t('acct.bind.no-profiles', 'No profiles yet. Create a profile first.')) + '</div>';
          } else {
            listEl.innerHTML = profiles.map(function(p) {
              var checked = bound.indexOf(p.dirId) >= 0 ? ' checked' : '';
              return '<label style="display:block;padding:4px 0;font-size:13px;"><input type="checkbox" class="acct-bind-cb" value="' + escAttr(p.dirId) + '"' + checked + '> ' + esc(p.name || p.dirId) + ' <span class="hint-line">(' + esc(p.dirId) + ')</span></label>';
            }).join('');
          }
          setBindReady(true);
        });
      }).catch(function(e) {
        if (request !== _bindRequest || !dlg.open) return;
        setBindReady(false);
        if (isAccountConflict(e)) { staleAccountToast(); return; }
        if (window.agentBrowser && window.agentBrowser.renderViewState) {
          window.agentBrowser.renderViewState(listEl, { error: e.message || String(e), retry: { cmd: 'agentBindAccounts', arg: JSON.stringify(ref) } });
        } else {
          listEl.innerHTML = '<div class="empty-state" style="color:var(--danger-text);">' + esc(e.message || String(e)) + '</div>';
        }
      });
    });
  };

  agentBrowser.agentSaveAccountBind = function() {
    var request = _bindRequest;
    return withAccountRole(function() {
      var dlg = document.getElementById('dlg-account-bind');
      var index = Number(document.getElementById('acct-bind-index').value);
      var ref = _bindRef;
      if (request !== _bindRequest || !dlg.open || !_bindReady || _bindSaving || index !== _bindIndex || !ref) return;
      var cbs = document.querySelectorAll('#acct-bind-list .acct-bind-cb:checked');
      var profileIds = [];
      cbs.forEach(function(cb) { profileIds.push(cb.value); });
      _bindSaving = true;
      setBindReady(true);
      return R.agent.accounts.bind(index, profileIds, ref).then(function(r) {
        if (request !== _bindRequest || !dlg.open) return;
        _bindSaving = false;
        if (!r) { setBindReady(false); staleAccountToast(); return; }
        dlg.close();
        toast(t('toast.account.profiles-updated', 'Account profiles updated'), 'success');
        agentBrowser.agentLoadAccounts();
      }).catch(function(e) {
        if (request !== _bindRequest || !dlg.open) return;
        _bindSaving = false;
        if (isAccountConflict(e)) { setBindReady(false); staleAccountToast(); }
        else { setBindReady(true); toast(e.message, 'error'); }
      });
    });
  };

  // ── Bulk import (url, username, password, tags per line) ──
  agentBrowser.agentImportAccounts = function() {
    return withAccountRole(function() {
      document.getElementById('acct-import-text').value = '';
      document.getElementById('acct-import-status').innerHTML = '';
      var cb = document.getElementById('acct-import-create-profiles');
      if (cb) { cb.checked = false; document.getElementById('acct-import-create-options').style.display = 'none'; }
      var platformSelect = document.getElementById('acct-import-platform');
      if (platformSelect) platformSelect.value = '';
      document.getElementById('dlg-account-import').showModal();
    });
  };

  agentBrowser.agentRunAccountImport = function() {
    return withAccountRole(function() {
      var text = document.getElementById('acct-import-text').value || '';
      var statusEl = document.getElementById('acct-import-status');
      var createProfiles = document.getElementById('acct-import-create-profiles') ? document.getElementById('acct-import-create-profiles').checked : false;
      var platformSelect = document.getElementById('acct-import-platform');
      var platform = platformSelect ? platformSelect.value || undefined : undefined;
      statusEl.innerHTML = '<span style="color:var(--text-muted);">' + esc(t('acct.importing', 'Importing...')) + '</span>';
      var p = createProfiles
        ? R.agent.accounts.bulkCreate(text, { platform: platform })
        : R.agent.accounts.bulkAdd(text);
      return p.then(function(r) {
        var msg = 'Added ' + r.added + ' account' + (r.added === 1 ? '' : 's');
        if (createProfiles && r.created) msg += ', created ' + r.created + ' profile' + (r.created === 1 ? '' : 's');
        if (r.skipped) msg += ', skipped ' + r.skipped;
        statusEl.innerHTML = '<span style="color: var(--success-text);">' + esc(msg) + '</span>';
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
        statusEl.innerHTML = '<span style="color: var(--danger-text);">' + esc(e.message) + '</span>';
      });
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
    return withAccountRole(function() {
      return R.agent.accounts.list().then(function(accounts) {
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
    });
  };
})();
