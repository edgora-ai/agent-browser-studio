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
    // R132: the main process composes `preview.message` in its own hardcoded
    // Chinese, so it cannot follow the renderer's locale. When sync is not
    // configured the message is a fixed string, so build it here instead;
    // the configured case still carries live counts from the main process.
    var message = preview.configured
      ? preview.message
      : t('sync.preview.unconfigured', 'Sync is not configured — set endpoint, bucket, and enable it');
    // R127: the message color carries configured/not — no glyph prefix needed.
    messageEl.innerHTML = '<span class="' + (preview.configured ? 'health-text-good' : 'health-text-watch') + '">' + esc(message || t('sync.preview.unavailable', 'Preview unavailable')) + '</span>';
    listEl.innerHTML = [
      previewCountCard(t('sync.preview.title.profiles','Profiles'), preview.profiles || 0, running.length ? running.length + t('sync.preview.profiles.running', ' running — Pull skips localStorage/preferences') : t('sync.preview.profiles.no-skip', 'Pull has no running-profile skips')),
      previewCountCard(t('sync.preview.title.proxies','Proxies'), preview.proxies || 0, t('sync.preview.proxies', 'Synced with the config snapshot (secrets redacted)')),
      previewCountCard(t('sync.preview.title.accounts','Accounts'), preview.accounts || 0, t('sync.preview.accounts', 'Platform account metadata; passwords not shown')),
      previewCountCard(t('sync.preview.title.extensions','Extensions'), preview.extensions || 0, t('sync.preview.extensions', 'Private extension repository entries')),
    ].join('') + (running.length ? '<div class="profile-card" style="border-color: var(--warning-text);">' +
      '<div class="card-header"><span class="name">' + esc(t('sync.preview.running-title','Running Profiles')) + '</span><span class="status-badge status-running">' + esc(t('sync.preview.skip-badge','Pull skip')) + '</span></div>' +
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
    var loading = t('common.loading', 'Loading...');
    if (listEl && window.agentBrowser&&window.agentBrowser.renderViewState) window.agentBrowser.renderViewState(listEl,{loading:loading}); else if (listEl) listEl.innerHTML = '<div class="loading">' + esc(loading) + '</div>';
    if (messageEl) messageEl.textContent = loading;
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
    if (section.localOnly.length) chips.push('<span class="status-badge status-done">' + esc(t('sync.local', 'Local')) + ' +' + section.localOnly.length + '</span>');
    if (section.remoteOnly.length) chips.push('<span class="status-badge status-running">' + esc(t('sync.remote', 'Remote')) + ' +' + section.remoteOnly.length + '</span>');
    if (section.changed.length) chips.push('<span class="status-badge" style="background:var(--warning-bg);color: var(--warning-text);">' + esc(t('sync.conflict', 'Conflict')) + ' ' + section.changed.length + '</span>');
    if (section.localOnly.length) {
      lines.push('<div style="font-size:11px;color:var(--text-muted);word-break:break-all;">' + esc(t('sync.local-only', 'Local only')) + ': ' + esc(section.localOnly.slice(0, 12).join(', ')) + (section.localOnly.length > 12 ? ' (+' + (section.localOnly.length - 12) + ')' : '') + '</div>');
    }
    if (section.remoteOnly.length) {
      lines.push('<div style="font-size:11px;color: var(--warning-text);word-break:break-all;">' + esc(t('sync.remote-only', 'Remote only')) + ': ' + esc(section.remoteOnly.slice(0, 12).join(', ')) + (section.remoteOnly.length > 12 ? ' (+' + (section.remoteOnly.length - 12) + ')' : '') + '</div>');
    }
    if (section.changed.length && conflictSelectable && sectionName) {
      lines.push('<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + esc(t('sync.per-item', 'Per-item conflict decisions (they default to the global strategy and apply to Pull only)')) + ':</div>');
      section.changed.forEach(function(c) {
        var value = globalStrategy === 'remote' || globalStrategy === 'newest' ? globalStrategy : 'local';
        var opts = ['local', 'remote', 'newest'].map(function(v) {
          var label = v === 'local' ? t('sync.keep-local', 'Keep local') : (v === 'remote' ? t('sync.take-remote', 'Take remote') : t('sync.take-newest', 'Take newest'));
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
      lines.push('<div style="font-size:11px;color:var(--text-muted);word-break:break-all;">' + esc(t('sync.changed', 'Changed')) + ': ' + esc(changedLines.join(' · ')) + (section.changed.length > 8 ? ' (+' + (section.changed.length - 8) + ')' : '') + '</div>');
    }
    if (!chips.length) lines.push('<div style="font-size:11px;color:var(--text-muted);">' + esc(t('sync.no-diff', 'No differences')) + '</div>');
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
      messageEl.innerHTML = '<span class="health-text-watch">' + esc(diff.message || t('sync.compare-failed', 'Comparison failed')) + '</span>';
      listEl.innerHTML = '<div class="empty-state">' + esc(diff.message || t('sync.compare-failed', 'Comparison failed')) + '</div>';
      return;
    }
    var timeHtml = diff.firstPush ? '  ·  ' + esc(t('sync.no-remote-yet', 'No remote data yet (first push)')) : (diff.remoteTimestamp ? '  ·  ' + esc(t('sync.remote-last-sync', 'Remote last synced')) + ': <strong>' + esc(escTime(diff.remoteTimestamp)) + '</strong>' : '');
    messageEl.innerHTML = '<span class="health-text-good">' + esc(t('sync.compare-done', 'Comparison complete')) + '</span>' + timeHtml;
    var cards = [];
    if ((diff.pushWarnings || []).length) {
      cards.push('<div class="profile-card" style="border-color: var(--danger-text);">' +
        '<div class="card-header"><span class="name" style="color: var(--danger-text);">' + esc(t('sync.push-will-remove', 'Push will remove remote data')) + '</span></div>' +
        (diff.pushWarnings || []).map(function(w) { return '<div style="font-size:11px;color: var(--danger-text);line-height:1.4;">' + esc(w) + '</div>'; }).join('') +
        '</div>');
    }
    if ((diff.pullNotes || []).length) {
      cards.push('<div class="profile-card">' +
        '<div class="card-header"><span class="name">' + esc(t('sync.pull-will-change', 'Pull will change local data')) + '</span></div>' +
        (diff.pullNotes || []).map(function(w) { return '<div style="font-size:11px;color:var(--text-muted);line-height:1.4;">' + esc(w) + '</div>'; }).join('') +
        '</div>');
    }
    var artifacts = diff.artifacts || {};
    cards.push('<div class="profile-card">' +
      '<div class="card-header"><span class="name">' + esc(t('sync.remote-artifacts', 'Remote data artifacts')) + '</span></div>' +
      '<div style="font-size:11px;color:var(--text-muted);">' + esc(t('sync.remote-cookies', 'Remote cookies')) + ': ' + esc(String((artifacts.cookies || []).length)) + ' · localStorage: ' + esc(String((artifacts.localStorage || []).length)) + ' · preferences: ' + esc(String((artifacts.preferences || []).length)) + '</div>' +
      '</div>');
    cards.push(diffSectionCard(t('sync.preview.title.profiles','Profiles'), diff.profiles, 'profiles', globalStrategy, true));
    cards.push(diffSectionCard(t('sync.preview.title.proxies','Proxies'), diff.proxies, 'proxies', globalStrategy, true));
    cards.push(diffSectionCard(t('sync.preview.title.accounts','Accounts'), diff.accounts, 'accounts', globalStrategy, true));
    cards.push(diffSectionCard(t('sync.preview.title.extensions','Extensions'), diff.extensions, 'extensions', globalStrategy, false));
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
      if (messageEl) messageEl.textContent = t('sync.compare-failed', 'Comparison failed');
      toast(t('sync.compare-failed-prefix', 'Comparison failed: ') + (e.message || String(e)), 'error');
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
        var removeMsg = t('sync.push-will-remove', 'Push will remove remote data') + ':\n\n' + (diff.pushWarnings || []).join('\n') + '\n\n' + t('sync.continue-push', 'Continue pushing?');
        return agentBrowser.confirmAsync(removeMsg, { ackLabel: t('confirm.ack.permanent','我了解此操作会永久删除数据且不可撤销。') }).then(function(ok) {
          if (!ok) { if (reset) reset(); return null; }
          return api.sync.push();
        });
      }
      return api.sync.push();
    }).then(function(r) {
      if (!r) return;
      if (!r.success && /locked by another device/i.test(r.message || '')) {
        var lockMsg = t('sync.push-blocked-by-lock', 'Push blocked by lock protection') + ':\n\n' + r.message + '\n\n' + t('sync.force-override', 'Override and continue?');
        return agentBrowser.confirmAsync(lockMsg, { ackLabel: t('confirm.ack.permanent','我了解此操作会永久删除数据且不可撤销。') }).then(function(forceOk) {
          if (!forceOk) { if (reset) reset(); return null; }
          return api.sync.push({ force: true });
        });
      }
      toastSyncResult(r, t('sync.toast.push-failed', 'Push failed'));
      if (r.success) agentBrowser.loadSyncConfig();
      else agentBrowser.loadSyncPreview();
      return null;
    }).then(function(r2) {
      if (!r2) return;
      toastSyncResult(r2, t('sync.toast.push-failed', 'Push failed'));
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
      var proceed = function() {
        api.sync.pull({ strategy: strategy, resolutions: resolutions }).then(function(r) {
          toastSyncResult(r, t('sync.toast.pull-failed', 'Pull failed'));
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
      };
      if (running.length) {
        var runMsg = t('sync.confirm.pull-running','检测到 ') + running.length + t('sync.confirm.pull-running-mid',' 个运行中 profile。Pull 会跳过这些 profile 的 localStorage/preferences，继续?');
        agentBrowser.confirmAsync(runMsg).then(function(ok) {
          if (!ok) { if (reset) reset(); return; }
          proceed();
        });
        return;
      }
      proceed();
    }).catch(function(e) {
      toast(t('sync.toast.preview-failed','Preview failed: ') + (e.message || String(e)), 'error');
      if (reset) reset();
    });
  };

  // Sale-93: custody consent rides a SEPARATE checkbox. Enabling sync
  // without consent is refused by the main process; the UI also warns first.
  function custodyConsented() {
    var box = document.getElementById('sync-custody-consent');
    return !!(box && box.checked);
  }
  function renderCustodyState(status) {
    var el = document.getElementById('sync-custody-state');
    if (!el) return;
    if (status && status.custodyConsentAt) {
      el.textContent = t('sync.custody.on', 'Data-custody consent recorded {d}').replace('{d}', new Date(status.custodyConsentAt).toLocaleString());
    } else {
      el.textContent = t('sync.custody.off', 'No data-custody consent recorded — push/pull will refuse until you consent and save.');
    }
  }
  function consentError(r) {
    return !!(r && (r.code === 'CUSTODY_CONSENT_REQUIRED' || /custody consent/i.test(r.message || '')));
  }
  function toastSyncResult(r, okFallback) {
    if (r && r.success) { toast(r.message, 'success'); return; }
    if (consentError(r)) {
      toast(t('sync.custody.required', 'Tick the data-custody consent box and save before pushing/pulling.'), 'error');
      return;
    }
    toast((r && r.message) || okFallback, r && r.success ? 'success' : 'error');
  }
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
    // Enabling sync without the separate custody consent is a user error —
    // warn before the main process refuses (already-consented stays valid).
    if (config.enabled && !custodyConsented()) {
      toast(t('sync.custody.required', 'Tick the data-custody consent box and save before pushing/pulling.'), 'error');
      var box = document.getElementById('sync-custody-consent');
      if (box) box.focus();
      return;
    }
    if (custodyConsented()) config.custodyConsent = true;
    api.sync.configure(config).then(function(r) {
      if (r.success) {
        toast((window.i18n ? window.i18n.t("toast.sync.saved", "Sync config saved") : "Sync config saved"), "success");
        document.getElementById('sync-enabled-text').textContent = (config.enabled && config.endpoint && config.bucket) ? t('sync.status.enabled', 'enabled') : t('sync.status.disabled', 'disabled');
        document.getElementById('sync-endpoint').textContent = config.endpoint || '--';
        document.getElementById('sync-bucket').textContent = config.bucket || '--';
        // P2 (#109): team panel + custody state went stale behind the toast.
        agentBrowser.loadSyncPreview();
        agentBrowser.loadSyncConfig();
        if (typeof agentBrowser.loadTeamPanel === "function") agentBrowser.loadTeamPanel();
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
      document.getElementById('sync-enabled-text').textContent = status.enabled ? t('sync.status.enabled', 'enabled') : t('sync.status.disabled', 'disabled');
      document.getElementById('sync-endpoint').textContent = status.endpoint || '--';
      document.getElementById('sync-bucket').textContent = status.bucket || '--';
      document.getElementById('sync-enabled').checked = !!status.enabled;
      document.getElementById('sync-endpoint-input').value = status.endpoint || '';
      document.getElementById('sync-bucket-input').value = status.bucket || '';
      var ak = document.getElementById('sync-ak-input');
      if (!ak.value) ak.placeholder = status.accessKeyMasked || '';
      var sk = document.getElementById('sync-sk-input');
      if (!sk.value) sk.placeholder = status.configured ? 'saved' : '';
      // S9 (#108): rehydrate the custody checkbox from the recorded consent
      // — otherwise consented users are blocked by the save guard after a
      // tab reload until they re-tick.
      var cbox = document.getElementById('sync-custody-consent');
      if (cbox) cbox.checked = !!(status && status.custodyConsentAt);
      renderCustodyState(status);
      agentBrowser.loadSyncPreview();
      agentBrowser.loadTeamPanel();
    }).catch(function(e) {
      toast((window.i18n ? window.i18n.t('toast.sync.load-failed', 'Failed to load sync config') : 'Failed to load sync config') + ': ' + e.message, 'error');
      agentBrowser.loadSyncPreview();
    });
  }
  agentBrowser.loadSyncConfig = loadSyncConfig;

  // ══════ Team Workspace (RBAC) ══════
  // R146: this was a plain English map that fed four render sites (role badges,
  // the local-device badge, and two <option> lists), so the zh UI showed
  // "Owner / Admin / Member / Viewer" in the default view. Kept as the English
  // source of truth for the `t()` fallback; roleLabel() is how it is displayed.
  var ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };
  var ROLE_ORDER_LIST = ['viewer', 'member', 'admin', 'owner'];
  var ROLE_CLASS = { owner: 'role-owner', admin: 'role-admin', member: 'role-member', viewer: 'role-viewer' };
  function roleLabel(role) { return t('team.role.' + role, ROLE_LABEL[role] || role); }

  // Colours live in style.css, not inline: the old version interpolated the
  // *fill* tokens (--success / --warning / --primary) as foreground text, which
  // measured 2.75:1, 2.26:1 and 4.33:1 against their own tinted plate. Those
  // tokens are tuned for fills; --*-text are the ones meant to sit on them.
  function roleBadge(role) {
    var cls = ROLE_CLASS[role] || 'role-viewer';
    return '<span class="status-badge ' + cls + '">' + esc(roleLabel(role)) + '</span>';
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
      // Never interpolate a raw field: a payload without `name` (older build,
      // REST peer, hand-edited config) would paint "undefined · Owner".
      var localLabel = local.name || shortId(local.deviceId) || t('team.this-device', 'This device');
      badge.textContent = localLabel + ' · ' + roleLabel(me);
    }

    if (!team) {
      panel.innerHTML =
        '<p style="font-size:12px;color:var(--text-muted);margin:0 0 8px;">' + esc(t("team.empty.desc", "No workspace initialized. Initialize one to manage member roles (owner / admin / member / viewer) and enforce read-only viewers on sync push and profile changes.")) + '</p>' +
        '<div class="form-row"><label>' + esc(t("team.workspace.name", "Workspace name")) + '</label><input id="team-workspace-name" placeholder="' + escAttr(t("team.workspace.name-placeholder", "My Workspace")) + '"></div>' +
        '<div class="btn-row"><button class="btn btn-primary btn-sm" data-role="cmd" data-cmd="teamInit">' + esc(t("team.init", "Initialize Workspace")) + '</button></div>';
      return;
    }

    var rows = (team.members || []).map(function(m) {
      var isMe = m.deviceId === local.deviceId;
      var roleOptions = ROLE_ORDER_LIST.map(function(r) {
        var disabled = '';
        if (me !== 'owner' && (r === 'owner' || r === 'admin')) disabled = ' disabled';
        if (me !== 'owner' && (m.role === 'owner' || m.role === 'admin')) disabled = ' disabled';
        if (m.deviceId === team.ownerDeviceId) disabled = ' disabled';
        return '<option value="' + r + '"' + (m.role === r ? ' selected' : '') + disabled + '>' + esc(roleLabel(r)) + '</option>';
      }).join('');
      var actions = '';
      if (canManage && m.deviceId !== team.ownerDeviceId && !isMe) {
        actions = '<select class="team-role-select" data-device-id="' + escAttr(m.deviceId) + '" style="font-size:11px;height:24px;">' + roleOptions + '</select> ' +
          '<button class="btn btn-xs btn-danger" data-action="team-remove" data-device-id="' + escAttr(m.deviceId) + '">' + (window.i18n && window.i18n.t ? window.i18n.t('team.remove', 'Remove') : 'Remove') + '</button>';
      }
      // R146: this rendered `t('sync.owner', 'owner')` — a key that exists in
      // neither locale, so it always fell back to the English literal, in both
      // languages. It was also redundant: roleBadge() on the right already shows
      // the role prominently, so each row said "owner" twice, once lowercase.
      // The owner's identity is still unambiguous — the badge carries it.
      return '<div class="profile-card" style="padding:8px;margin:6px 0;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">' +
        '<div><span class="name">' + esc(m.name || m.deviceId) + (isMe ? ' <em style="font-size:10px;color: var(--primary-text);">' + esc(t('team.this-device', '(this device)')) + '</em>' : '') + '</span>' +
        '<div style="font-family:var(--mono);font-size:10px;color:var(--text-muted);">' + esc(shortId(m.deviceId)) + '</div></div>' +
        '<div style="display:flex;align-items:center;gap:6px;">' + roleBadge(m.role) + actions + '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    var addForm = '';
    if (canManage) {
      addForm =
        '<div class="form-row"><label>' + esc(t('team.add.device-id', 'Device ID')) + '</label><input id="team-add-device-id" placeholder="' + escAttr(t('team.add.device-id-ph', 'device-id-from-another-install')) + '"></div>' +
        '<div class="form-row"><label>' + esc(t('team.add.name', 'Name')) + '</label><input id="team-add-name" placeholder="' + escAttr(t('team.add.name-ph', 'Optional display name')) + '"></div>' +
        '<div class="form-row"><label>' + esc(t('team.add.role', 'Role')) + '</label><select id="team-add-role">' +
          ROLE_ORDER_LIST.map(function(r) {
            var disabled = (!isOwner && (r === 'owner' || r === 'admin')) ? ' disabled' : '';
            return '<option value="' + r + '"' + disabled + '>' + esc(roleLabel(r)) + '</option>';
          }).join('') +
        '</select></div>' +
        '<div class="btn-row"><button class="btn btn-primary btn-sm" data-role="cmd" data-cmd="teamAddMember">' + esc(t("team.add-member", "Add Member")) + '</button></div>';
    }

    var renameControl = isOwner
      ? '<div class="form-row"><label>' + esc(t("team.rename-workspace", "Rename workspace")) + '</label><input id="team-workspace-rename" value="' + escAttr(team.name) + '" style="max-width:280px;"> <button class="btn btn-secondary btn-sm" data-role="cmd" data-cmd="teamRename">' + esc(t("team.rename", "Rename")) + '</button></div>'
      : '';
    var enableControl = canManage
      ? '<label style="display:flex;align-items:center;gap:6px;font-size:12px;"><input type="checkbox" id="team-enabled"' + (team.enabled !== false ? ' checked' : '') + '> ' + esc(t('team.enforce', 'Enforce team RBAC (viewers read-only, member+ push/delete, admin+ force push)')) + '</label>'
      : '';

    panel.innerHTML =
      '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">' +
        esc(t('team.summary.workspace', 'Workspace')) + ' <strong>' + esc(team.name) + '</strong> · ' +
        esc(t('team.summary.members', '{n} member(s)').replace('{n}', (team.members || []).length)) + ' · ' +
        esc(t('team.summary.enforcement', 'enforcement')) + ' ' +
        esc(t(team.enabled !== false ? 'team.summary.on' : 'team.summary.off', team.enabled !== false ? 'on' : 'off')) +
      '</div>' +
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
      agentBrowser.confirm(t('team.remove-confirm', 'Remove this member from the workspace?'), function() {
        api.team.removeMember(deviceId).then(function(r) {
          if (!r || !r.success) { toast((r && r.error) || 'Remove failed', 'error'); return; }
          toast('Member removed', 'success');
          loadTeamPanel();
        }).catch(function(e) { toast(e.message, 'error'); });
      });
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
      if (panel) panel.innerHTML = '<div class="empty-state">' + esc(t('team.panel.failed', 'Team panel failed: ') + (e.message || String(e))) + '</div>';
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
