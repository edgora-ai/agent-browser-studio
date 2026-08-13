(function() {
  "use strict";

  var agentBrowser = window.agentBrowser;
  var api = agentBrowser.api;
  var helpers = agentBrowser.helpers;
  var toast = helpers.toast;
  var esc = helpers.esc;
  var escAttr = helpers.escAttr;

  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }

  function setButtonBusy(selector, busyText) {
    var btn = document.querySelector(selector);
    if (!btn) return null;
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyText;
    return function() {
      btn.disabled = false;
      btn.textContent = old;
    };
  }

  function previewCountCard(label, value, detail) {
    var displayValue = value == null ? 0 : value;
    return '<div class="profile-card">' +
      '<div class="card-header"><span class="name">' + esc(label) + '</span><span class="status-badge status-done">' + esc(String(displayValue)) + '</span></div>' +
      '<div style="font-size:11px;color:var(--text-muted);line-height:1.35;">' + esc(detail || '') + '</div>' +
    '</div>';
  }

  function renderPreview(preview) {
    var messageEl = document.getElementById('sync-preview-message');
    var listEl = document.getElementById('sync-preview');
    if (!messageEl || !listEl) return;
    preview = preview || {};
    var running = preview.runningProfiles || [];
    messageEl.innerHTML = (preview.configured ? '✅ ' : '⚠️ ') + esc(preview.message || t('sync.preview.unavailable', 'Preview unavailable'));
    listEl.innerHTML = [
      previewCountCard('Profiles', preview.profiles || 0, running.length ? running.length + t('sync.preview.profiles.running', ' 个运行中；Pull 会跳过 localStorage/preferences') : t('sync.preview.profiles.no-skip', 'Pull 无运行中跳过项')),
      previewCountCard('Proxies', preview.proxies || 0, t('sync.preview.proxies', '将随配置快照同步（敏感字段脱敏）')),
      previewCountCard('Accounts', preview.accounts || 0, t('sync.preview.accounts', '平台账号元数据；密码不展示')),
      previewCountCard('Extensions', preview.extensions || 0, t('sync.preview.extensions', '私有扩展仓库条目')),
    ].join('') + (running.length ? '<div class="profile-card" style="border-color:var(--warning);">' +
      '<div class="card-header"><span class="name">' + esc(t('sync.preview.running-title','运行中 Profiles')) + '</span><span class="status-badge status-running">' + esc(t('sync.preview.skip-badge','Pull skip')) + '</span></div>' +
      '<div style="font-family:var(--mono);font-size:11px;color:var(--text-muted);word-break:break-all;">' + running.map(esc).join('<br>') + '</div>' +
    '</div>' : '');
  }

  function fetchPreview() {
    return api.sync.preview().then(function(preview) {
      renderPreview(preview);
      return preview;
    });
  }

  agentBrowser.loadSyncPreview = function() {
    var listEl = document.getElementById('sync-preview');
    var messageEl = document.getElementById('sync-preview-message');
    if (listEl) listEl.innerHTML = '<div class="loading">Loading...</div>';
    if (messageEl) messageEl.textContent = 'Loading...';
    return fetchPreview().catch(function(e) {
      if (listEl) listEl.innerHTML = '<div class="empty-state">' + esc(t('sync.preview.load-failed-prefix','Preview 加载失败: ')) + esc(e.message || e) + '</div>';
      if (messageEl) messageEl.textContent = t('sync.preview.load-failed','Preview 加载失败');
      toast(t('sync.preview.load-failed-prefix','Preview 加载失败: ') + (e.message || e), 'error');
      return null;
    });
  };

  function escTime(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts);
      return isNaN(d.getTime()) ? '' : d.toLocaleString();
    } catch (e) { return ''; }
  }

  function diffSectionCard(title, section, sectionName, globalStrategy, conflictSelectable) {
    section = section || { localOnly: [], remoteOnly: [], changed: [] };
    var chips = [];
    var lines = [];
    if (section.localOnly.length) chips.push('<span class="status-badge status-done">本地 +' + section.localOnly.length + '</span>');
    if (section.remoteOnly.length) chips.push('<span class="status-badge status-running">远端 +' + section.remoteOnly.length + '</span>');
    if (section.changed.length) chips.push('<span class="status-badge" style="background:var(--warning-bg);color:var(--warning);">冲突 ' + section.changed.length + '</span>');
    if (section.localOnly.length) {
      lines.push('<div style="font-size:11px;color:var(--text-muted);word-break:break-all;">本地独有: ' + esc(section.localOnly.slice(0, 12).join(', ')) + (section.localOnly.length > 12 ? ' (+' + (section.localOnly.length - 12) + ')' : '') + '</div>');
    }
    if (section.remoteOnly.length) {
      lines.push('<div style="font-size:11px;color:var(--warning);word-break:break-all;">远端独有: ' + esc(section.remoteOnly.slice(0, 12).join(', ')) + (section.remoteOnly.length > 12 ? ' (+' + (section.remoteOnly.length - 12) + ')' : '') + '</div>');
    }
    if (section.changed.length && conflictSelectable && sectionName) {
      lines.push('<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">逐条冲突决策（默认跟随全局策略，仅 Pull 生效）:</div>');
      section.changed.forEach(function(c) {
        var value = globalStrategy === 'remote' || globalStrategy === 'newest' ? globalStrategy : 'local';
        var opts = ['local', 'remote', 'newest'].map(function(v) {
          var label = v === 'local' ? '保留本地' : (v === 'remote' ? '采用远端' : '取较新');
          return '<option value="' + v + '"' + (v === value ? ' selected' : '') + '>' + label + '</option>';
        }).join('');
        lines.push('<div style="display:flex;align-items:center;gap:6px;font-size:11px;margin-top:4px;word-break:break-all;">' +
          '<select class="sync-entry-strategy" data-section="' + escAttr(sectionName) + '" data-id="' + escAttr(c.id) + '" style="flex:0 0 auto;font-size:11px;padding:2px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);">' + opts + '</select>' +
          '<span style="color:var(--text-muted);flex:1;">' + esc(c.id) + ' <span style="opacity:.7;">[' + esc((c.fields || []).join(', ')) + ']</span></span>' +
        '</div>');
      });
    } else if (section.changed.length) {
      var changedLines = section.changed.slice(0, 8).map(function(c) {
        return esc(c.id) + ' [' + esc((c.fields || []).join(', ')) + ']';
      });
      lines.push('<div style="font-size:11px;color:var(--text-muted);word-break:break-all;">有变更: ' + esc(changedLines.join(' · ')) + (section.changed.length > 8 ? ' (+' + (section.changed.length - 8) + ')' : '') + '</div>');
    }
    if (!chips.length) lines.push('<div style="font-size:11px;color:var(--text-muted);">无差异</div>');
    return '<div class="profile-card">' +
      '<div class="card-header"><span class="name">' + esc(title) + '</span><span>' + chips.join(' ') + '</span></div>' +
      lines.join('') +
    '</div>';
  }

  function renderSyncDiff(diff, globalStrategy) {
    var messageEl = document.getElementById('sync-diff-message');
    var listEl = document.getElementById('sync-diff');
    if (!messageEl || !listEl) return;
    diff = diff || {};
    if (!diff.ok) {
      messageEl.innerHTML = '⚠️ ' + esc(diff.message || '对比失败');
      listEl.innerHTML = '<div class="empty-state">' + esc(diff.message || '对比失败') + '</div>';
      return;
    }
    var timeHtml = diff.firstPush ? '  ·  远端尚无数据（首次推送）' : (diff.remoteTimestamp ? '  ·  远端最后同步: <strong>' + esc(escTime(diff.remoteTimestamp)) + '</strong>' : '');
    messageEl.innerHTML = '✅ 对比完成' + timeHtml;
    var cards = [];
    if ((diff.pushWarnings || []).length) {
      cards.push('<div class="profile-card" style="border-color:var(--danger);">' +
        '<div class="card-header"><span class="name" style="color:var(--danger);">⚠️ Push 会移除远端数据</span></div>' +
        (diff.pushWarnings || []).map(function(w) { return '<div style="font-size:11px;color:var(--danger);line-height:1.4;">' + esc(w) + '</div>'; }).join('') +
        '</div>');
    }
    if ((diff.pullNotes || []).length) {
      cards.push('<div class="profile-card">' +
        '<div class="card-header"><span class="name">ℹ️ Pull 会变更</span></div>' +
        (diff.pullNotes || []).map(function(w) { return '<div style="font-size:11px;color:var(--text-muted);line-height:1.4;">' + esc(w) + '</div>'; }).join('') +
        '</div>');
    }
    var artifacts = diff.artifacts || {};
    cards.push('<div class="profile-card">' +
      '<div class="card-header"><span class="name">远端数据工件</span></div>' +
      '<div style="font-size:11px;color:var(--text-muted);">远端 cookies: ' + esc(String((artifacts.cookies || []).length)) + ' · localStorage: ' + esc(String((artifacts.localStorage || []).length)) + ' · preferences: ' + esc(String((artifacts.preferences || []).length)) + '</div>' +
      '</div>');
    cards.push(diffSectionCard('Profiles', diff.profiles, 'profiles', globalStrategy, true));
    cards.push(diffSectionCard('Proxies', diff.proxies, 'proxies', globalStrategy, true));
    cards.push(diffSectionCard('Accounts', diff.accounts, 'accounts', globalStrategy, true));
    cards.push(diffSectionCard('Extensions', diff.extensions, 'extensions', globalStrategy, false));
    listEl.innerHTML = cards.join('');
  }

  function fetchSyncDiff() {
    var strategySel = document.getElementById('sync-merge-strategy');
    var strategy = strategySel ? strategySel.value : 'local';
    return api.sync.previewDiff().then(function(diff) {
      renderSyncDiff(diff, strategy);
      return diff;
    });
  }

  agentBrowser.loadSyncDiff = function() {
    var listEl = document.getElementById('sync-diff');
    var messageEl = document.getElementById('sync-diff-message');
    if (listEl) listEl.innerHTML = '<div class="loading">Loading...</div>';
    if (messageEl) messageEl.textContent = 'Loading...';
    return fetchSyncDiff().catch(function(e) {
      if (listEl) listEl.innerHTML = '<div class="empty-state">' + esc(e.message || e) + '</div>';
      if (messageEl) messageEl.textContent = '对比失败';
      toast('对比失败: ' + (e.message || String(e)), 'error');
      return null;
    });
  };


  agentBrowser.syncPush = function() {
    var reset = setButtonBusy('#tab-sync [data-cmd="syncPush"]', 'Checking...');
    fetchPreview().catch(function() { /* preview card is best-effort */ }).then(function() {
      return fetchSyncDiff().catch(function(e) {
        toast(t('sync.toast.preview-failed','Preview failed: ') + (e.message || String(e)), 'error');
        return null;
      });
    }).then(function(diff) {
      if (diff && (diff.pushWarnings || []).length) {
        var ok = confirm('⚠️ Push 会移除远端数据:\n\n' + (diff.pushWarnings || []).join('\n') + '\n\n继续 Push?');
        if (!ok) { if (reset) reset(); return null; }
      }
      return api.sync.push();
    }).then(function(r) {
      if (!r) return;
      if (!r.success && /locked by another device/i.test(r.message || '')) {
        var forceOk = confirm('Push 被锁定保护拦截:\n\n' + r.message + '\n\n强制覆盖并继续?');
        if (!forceOk) { if (reset) reset(); return null; }
        return api.sync.push({ force: true });
      }
      toast(r.message, r.success ? 'success' : 'error');
      if (r.success) agentBrowser.loadSyncConfig();
      else agentBrowser.loadSyncPreview();
      return null;
    }).then(function(r2) {
      if (!r2) return;
      toast(r2.message, r2.success ? 'success' : 'error');
      if (r2.success) agentBrowser.loadSyncConfig();
      else agentBrowser.loadSyncPreview();
    }).catch(function(e) {
      toast(t('sync.toast.push-failed','Push failed: ') + (e.message || String(e)), 'error');
    }).finally(function() {
      if (reset) reset();
    });
  };

  agentBrowser.syncPull = function() {
    var reset = setButtonBusy('#tab-sync [data-cmd="syncPull"]', 'Checking...');
    var strategySel = document.getElementById('sync-merge-strategy');
    var strategy = strategySel ? strategySel.value : 'local';
    var resolutions = {};
    Array.prototype.forEach.call(document.querySelectorAll('#sync-diff .sync-entry-strategy'), function(sel) {
      var section = sel.getAttribute('data-section');
      var id = sel.getAttribute('data-id');
      var value = sel.value;
      if (section && id && value && value !== strategy) resolutions[section + ':' + id] = value;
    });
    fetchPreview().then(function(preview) {
      var running = (preview && preview.runningProfiles) || [];
      if (running.length) {
        var ok = confirm(t('sync.confirm.pull-running','检测到 ') + running.length + t('sync.confirm.pull-running-mid',' 个运行中 profile。Pull 会跳过这些 profile 的 localStorage/preferences，继续?'));
        if (!ok) { if (reset) reset(); return; }
      }
      api.sync.pull({ strategy: strategy, resolutions: resolutions }).then(function(r) {
        toast(r.message, r.success ? 'success' : 'error');
        if (!r.success) { agentBrowser.loadSyncPreview(); return; }
        return api.app.reloadConfig().then(function() {
          agentBrowser.loadSyncConfig();
        }).catch(function(e) {
          toast(t('sync.toast.reload-failed','Reload config failed: ') + (e.message || String(e)), 'error');
          agentBrowser.loadSyncConfig();
        });
      }).catch(function(e) {
        toast(t('sync.toast.pull-failed','Pull failed: ') + (e.message || String(e)), 'error');
      }).finally(function() {
        if (reset) reset();
      });
    }).catch(function(e) {
      toast(t('sync.toast.preview-failed','Preview failed: ') + (e.message || String(e)), 'error');
      if (reset) reset();
    });
  };

  agentBrowser.syncSave = function() {
    var config = {
      enabled: document.getElementById('sync-enabled').checked,
      endpoint: document.getElementById('sync-endpoint-input').value.trim(),
      bucket: document.getElementById('sync-bucket-input').value.trim(),
    };
    var accessKey = document.getElementById('sync-ak-input').value.trim();
    var secretKey = document.getElementById('sync-sk-input').value.trim();
    if (accessKey) config.accessKey = accessKey;
    if (secretKey) config.secretKey = secretKey;
    api.sync.configure(config).then(function(r) {
      if (r.success) {
        toast((window.i18n ? window.i18n.t("toast.sync.saved", "Sync config saved") : "Sync config saved"), "success");
        document.getElementById('sync-enabled-text').textContent = config.enabled && config.endpoint && config.bucket ? 'enabled' : 'disabled';
        document.getElementById('sync-endpoint').textContent = config.endpoint || '--';
        document.getElementById('sync-bucket').textContent = config.bucket || '--';
        agentBrowser.loadSyncPreview();
      } else {
        toast(r.error || t('sync.toast.save-failed-default','Save failed'), 'error');
      }
    }).catch(function(e) {
      toast(t('sync.toast.save-failed-prefix','Save failed: ') + (e.message || String(e)), 'error');
    });
  };

  function loadSyncConfig() {
    api.sync.status().then(function(status) {
      status = status || {};
      document.getElementById('sync-enabled-text').textContent = status.enabled ? 'enabled' : 'disabled';
      document.getElementById('sync-endpoint').textContent = status.endpoint || '--';
      document.getElementById('sync-bucket').textContent = status.bucket || '--';
      document.getElementById('sync-enabled').checked = !!status.enabled;
      document.getElementById('sync-endpoint-input').value = status.endpoint || '';
      document.getElementById('sync-bucket-input').value = status.bucket || '';
      var ak = document.getElementById('sync-ak-input');
      if (!ak.value) ak.placeholder = status.accessKeyMasked || '';
      var sk = document.getElementById('sync-sk-input');
      if (!sk.value) sk.placeholder = status.configured ? 'saved' : '';
      agentBrowser.loadSyncPreview();
      agentBrowser.loadTeamPanel();
    }).catch(function(e) {
      toast((window.i18n ? window.i18n.t('toast.sync.load-failed', 'Failed to load sync config') : 'Failed to load sync config') + ': ' + e.message, 'error');
      agentBrowser.loadSyncPreview();
    });
  }
  agentBrowser.loadSyncConfig = loadSyncConfig;

  // ══════ Team Workspace (RBAC) ══════
  var ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };
  var ROLE_ORDER_LIST = ['viewer', 'member', 'admin', 'owner'];

  function roleBadge(role) {
    var color = role === 'owner' ? 'var(--success)' : role === 'admin' ? 'var(--primary)' : role === 'member' ? 'var(--warning)' : 'var(--text-muted)';
    return '<span class="status-badge" style="color:' + color + ';border:1px solid ' + color + ';">' + (ROLE_LABEL[role] || role) + '</span>';
  }

  function shortId(id) {
    if (!id) return '';
    return id.length > 18 ? id.slice(0, 10) + '…' + id.slice(-6) : id;
  }

  function renderTeamPanel(status) {
    var panel = document.getElementById('team-panel');
    var badge = document.getElementById('team-local-badge');
    if (!panel) return;
    status = status || {};
    var team = status.team || null;
    var local = status.local || {};
    var me = local.role || 'owner';
    var canManage = me === 'owner' || me === 'admin';
    var isOwner = me === 'owner';

    if (badge) {
      badge.style.display = 'inline-block';
      badge.textContent = local.name + ' · ' + (ROLE_LABEL[me] || me);
    }

    if (!team) {
      panel.innerHTML =
        '<p style="font-size:12px;color:var(--text-muted);margin:0 0 8px;">No workspace initialized. Initialize one to manage member roles (owner / admin / member / viewer) and enforce read-only viewers on sync push and profile changes.</p>' +
        '<div class="form-row"><label>Workspace name</label><input id="team-workspace-name" placeholder="My Workspace"></div>' +
        '<div class="btn-row"><button class="btn btn-primary btn-sm" data-role="cmd" data-cmd="teamInit" data-i18n="team.init">Initialize Workspace</button></div>';
      return;
    }

    var rows = (team.members || []).map(function(m) {
      var isMe = m.deviceId === local.deviceId;
      var roleOptions = ROLE_ORDER_LIST.map(function(r) {
        var disabled = '';
        if (me !== 'owner' && (r === 'owner' || r === 'admin')) disabled = ' disabled';
        if (me !== 'owner' && (m.role === 'owner' || m.role === 'admin')) disabled = ' disabled';
        if (m.deviceId === team.ownerDeviceId) disabled = ' disabled';
        return '<option value="' + r + '"' + (m.role === r ? ' selected' : '') + disabled + '>' + ROLE_LABEL[r] + '</option>';
      }).join('');
      var actions = '';
      if (canManage && m.deviceId !== team.ownerDeviceId && !isMe) {
        actions = '<select class="team-role-select" data-device-id="' + escAttr(m.deviceId) + '" style="font-size:11px;height:24px;">' + roleOptions + '</select> ' +
          '<button class="btn btn-xs btn-danger" data-action="team-remove" data-device-id="' + escAttr(m.deviceId) + '">' + (window.i18n && window.i18n.t ? window.i18n.t('team.remove', 'Remove') : 'Remove') + '</button>';
      }
      var ownerMark = m.deviceId === team.ownerDeviceId ? ' 👑' : '';
      return '<div class="profile-card" style="padding:8px;margin:6px 0;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">' +
        '<div><span class="name">' + esc(m.name || m.deviceId) + (isMe ? ' <em style="font-size:10px;color:var(--primary);">(this device)</em>' : '') + ownerMark + '</span>' +
        '<div style="font-family:var(--mono);font-size:10px;color:var(--text-muted);">' + esc(shortId(m.deviceId)) + '</div></div>' +
        '<div style="display:flex;align-items:center;gap:6px;">' + roleBadge(m.role) + actions + '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    var addForm = '';
    if (canManage) {
      addForm =
        '<div class="form-row"><label>Device ID</label><input id="team-add-device-id" placeholder="device-id-from-another-install"></div>' +
        '<div class="form-row"><label>Name</label><input id="team-add-name" placeholder="Optional display name"></div>' +
        '<div class="form-row"><label>Role</label><select id="team-add-role">' +
          ROLE_ORDER_LIST.map(function(r) {
            var disabled = (!isOwner && (r === 'owner' || r === 'admin')) ? ' disabled' : '';
            return '<option value="' + r + '"' + disabled + '>' + ROLE_LABEL[r] + '</option>';
          }).join('') +
        '</select></div>' +
        '<div class="btn-row"><button class="btn btn-primary btn-sm" data-role="cmd" data-cmd="teamAddMember" data-i18n="team.add-member">Add Member</button></div>';
    }

    var renameControl = isOwner
      ? '<div class="form-row"><label>Rename workspace</label><input id="team-workspace-rename" value="' + escAttr(team.name) + '" style="max-width:280px;"> <button class="btn btn-secondary btn-sm" data-role="cmd" data-cmd="teamRename" data-i18n="team.rename">Rename</button></div>'
      : '';
    var enableControl = canManage
      ? '<label style="display:flex;align-items:center;gap:6px;font-size:12px;"><input type="checkbox" id="team-enabled"' + (team.enabled !== false ? ' checked' : '') + '> Enforce team RBAC (viewers read-only, member+ push/delete, admin+ force push)</label>'
      : '';

    panel.innerHTML =
      '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">Workspace <strong>' + esc(team.name) + '</strong> · ' + (team.members || []).length + ' member(s) · enforcement ' + (team.enabled !== false ? 'on' : 'off') + '</div>' +
      renameControl +
      '<div style="margin:8px 0;">' + rows + '</div>' +
      addForm +
      enableControl;

    // Event delegation for member actions.
    panel.onclick = function (event) {
      var target = event.target.closest('[data-action="team-remove"]');
      if (!target || !panel.contains(target)) return;
      var deviceId = target.dataset.deviceId;
      if (!deviceId) return;
      if (!window.confirm('Remove this member from the workspace?')) return;
      api.team.removeMember(deviceId).then(function(r) {
        if (!r || !r.success) { toast((r && r.error) || 'Remove failed', 'error'); return; }
        toast('Member removed', 'success');
        loadTeamPanel();
      }).catch(function(e) { toast(e.message, 'error'); });
    };
    panel.onchange = function (event) {
      var sel = event.target.closest('.team-role-select');
      if (!sel || !panel.contains(sel)) return;
      api.team.setRole(sel.dataset.deviceId, sel.value).then(function(r) {
        if (!r || !r.success) { toast((r && r.error) || 'Role update failed', 'error'); loadTeamPanel(); return; }
        toast('Role updated', 'success');
        loadTeamPanel();
      }).catch(function(e) { toast(e.message, 'error'); });
    };
    var enabledBox = document.getElementById('team-enabled');
    if (enabledBox) {
      enabledBox.onchange = function () {
        api.team.setEnabled(enabledBox.checked).then(function(r) {
          if (!r || !r.success) { toast((r && r.error) || 'Update failed', 'error'); }
          loadTeamPanel();
        }).catch(function(e) { toast(e.message, 'error'); });
      };
    }
  }

  function loadTeamPanel() {
    api.team.status().then(function(status) {
      renderTeamPanel(status);
    }).catch(function(e) {
      var panel = document.getElementById('team-panel');
      if (panel) panel.innerHTML = '<div class="empty-state">Team panel failed: ' + esc(e.message || String(e)) + '</div>';
    });
  }
  agentBrowser.loadTeamPanel = loadTeamPanel;

  agentBrowser.teamInit = function() {
    var name = (document.getElementById('team-workspace-name') || {}).value || '';
    api.team.init(name).then(function(r) {
      if (!r || !r.success) { toast((r && r.error) || 'Init failed', 'error'); return; }
      toast('Workspace initialized', 'success');
      loadTeamPanel();
    }).catch(function(e) { toast(e.message, 'error'); });
  };

  agentBrowser.teamAddMember = function() {
    var deviceId = (document.getElementById('team-add-device-id') || {}).value || '';
    var name = (document.getElementById('team-add-name') || {}).value || '';
    var role = (document.getElementById('team-add-role') || {}).value || 'member';
    if (!deviceId) { toast('Device ID is required', 'error'); return; }
    api.team.addMember(deviceId, name, role).then(function(r) {
      if (!r || !r.success) { toast((r && r.error) || 'Add failed', 'error'); return; }
      toast('Member added', 'success');
      loadTeamPanel();
    }).catch(function(e) { toast(e.message, 'error'); });
  };

  agentBrowser.teamRename = function() {
    var name = (document.getElementById('team-workspace-rename') || {}).value || '';
    api.team.rename(name).then(function(r) {
      if (!r || !r.success) { toast((r && r.error) || 'Rename failed', 'error'); return; }
      toast('Workspace renamed', 'success');
      loadTeamPanel();
    }).catch(function(e) { toast(e.message, 'error'); });
  };
})();
