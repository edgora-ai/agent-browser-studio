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

  agentBrowser.syncPush = function() {
    var reset = setButtonBusy('#tab-sync [data-cmd="syncPush"]', 'Checking...');
    fetchPreview().then(function() {
      api.sync.push().then(function(r) {
        toast(r.message, r.success ? 'success' : 'error');
        if (r.success) agentBrowser.loadSyncConfig();
        else agentBrowser.loadSyncPreview();
      }).catch(function(e) {
        toast(t('sync.toast.push-failed','Push failed: ') + (e.message || String(e)), 'error');
      }).finally(function() {
        if (reset) reset();
      });
    }).catch(function(e) {
      toast(t('sync.toast.preview-failed','Preview failed: ') + (e.message || String(e)), 'error');
      if (reset) reset();
    });
  };

  agentBrowser.syncPull = function() {
    var reset = setButtonBusy('#tab-sync [data-cmd="syncPull"]', 'Checking...');
    fetchPreview().then(function(preview) {
      var running = (preview && preview.runningProfiles) || [];
      if (running.length) {
        var ok = confirm(t('sync.confirm.pull-running','检测到 ') + running.length + t('sync.confirm.pull-running-mid',' 个运行中 profile。Pull 会跳过这些 profile 的 localStorage/preferences，继续?'));
        if (!ok) { if (reset) reset(); return; }
      }
      api.sync.pull().then(function(r) {
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
    }).catch(function(e) {
      toast((window.i18n ? window.i18n.t('toast.sync.load-failed', 'Failed to load sync config') : 'Failed to load sync config') + ': ' + e.message, 'error');
      agentBrowser.loadSyncPreview();
    });
  }
  agentBrowser.loadSyncConfig = loadSyncConfig;
})();
