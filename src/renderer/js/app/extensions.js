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
  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }
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
  Object.assign(agentBrowser, {
  _extDirId: null,

  showExtensions: function (dirId) {
        agentBrowser._extDirId = dirId;
        api.profile.get(dirId).then(function(info) {
          document.getElementById('ext-dlg-title').textContent = 'Extensions — ' + (info.name || dirId.slice(0,8));
        }).catch(function(){});
        document.getElementById('ext-dlg-status').textContent = '';
        agentBrowser._extRefreshList();
        document.getElementById('dlg-extensions').showModal();
      },

  _extRefreshList: function() {
        var dirId = agentBrowser._extDirId;
        if (!dirId) return;
        api.settings.extensions(dirId).then(function(exts) {
          var el = document.getElementById('ext-list');
          if (!exts || exts.length === 0) {
            el.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:24px;">No repository extensions available.<br><span style="font-size:11px;">Open the private repository from the Extensions menu to add Chrome extensions.</span></div>';
            return;
          }
          var html = '';
          for (var i = 0; i < exts.length; i++) {
            var e = exts[i];
            var enabled = e.enabled === true;
            var tags = (e.tags || []).map(function (tag) { return esc(tag); }).join(', ');
            html += '<div class="extension-row" data-ext-index="' + i + '" style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border-light);">';
            html += '<div style="width:36px;height:36px;border-radius:8px;background:var(--primary-bg);display:flex;align-items:center;justify-content:center;font-size:18px;">🧩</div>';
            html += '<div style="flex:1;min-width:0;">';
            html += '<div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(e.name || e.id) + '</div>';
            html += '<div style="font-size:10px;color:var(--text-muted);">v' + esc(e.version || '?') + ' · ' + esc(e.id).slice(0,16) + '…</div>';
            if (e.description) html += '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;line-height:1.3;">' + esc(e.description).slice(0,100) + '</div>';
            if (tags) html += '<div style="font-size:9px;color:var(--text-muted);margin-top:2px;">Tags: ' + tags + '</div>';
            if (e.manifestHash) html += '<div style="font-size:9px;color:var(--success);" title="Manifest SHA-512">✓ Manifest: ' + esc(e.manifestHash).slice(0,12) + '…</div>';
            html += '</div>';
            html += '<div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;">';
            html += '<label style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-muted);">';
            html += '<input type="checkbox" data-ext-action="toggle" ' + (enabled ? 'checked' : '') + '> Enabled';
            html += '</label>';
            html += '<button type="button" class="btn btn-xs" style="font-size:9px;" data-ext-action="update">Update Repository</button>';
            html += '<button type="button" class="btn btn-danger btn-xs" data-ext-action="disable">Disable</button>';
            html += '</div>';
            html += '</div>';
          }
          el.innerHTML = html;
          el.onchange = function (event) {
            var target = event.target;
            if (!target || target.dataset.extAction !== "toggle") return;
            var row = target.closest(".extension-row");
            var ext = row ? exts[Number(row.dataset.extIndex)] : null;
            if (ext) agentBrowser.extToggle(ext.id, target.checked);
          };
          el.onclick = function (event) {
            var target = event.target.closest("[data-ext-action]");
            if (!target || target.dataset.extAction === "toggle" || !el.contains(target)) return;
            var row = target.closest(".extension-row");
            var ext = row ? exts[Number(row.dataset.extIndex)] : null;
            if (!ext) return;
            if (target.dataset.extAction === "update") agentBrowser.extCheckUpdate(ext.id);
            else if (target.dataset.extAction === "disable") agentBrowser.extToggle(ext.id, false);
          };
        }).catch(function(e) { toast('Failed: ' + e.message, 'error'); });
      },

  extShowInstall: function() {
        document.getElementById('dlg-extensions').close();
        agentBrowser.switchTab('extensions');
      },

  extInstallTab: function() {
        agentBrowser.extShowInstall();
      },

  extInstallFromStore: function() {
        var input = document.getElementById('ext-store-input');
        var raw = input.value.trim();
        var extId = extractChromeExtensionId(raw);
        if (!extId) {
          toast('Invalid extension ID. Paste a Chrome Web Store URL or 32 lowercase letters (a-p).', 'error');
          return;
        }
        document.getElementById('dlg-extensions').close();
        agentBrowser.showRepositoryAdd(extId);
      },

  extInstallFromFile: function() {
        api.settings.pickExtensionFile().then(function(filePath) {
          if (!filePath) return;
          var statusEl = document.getElementById('ext-install-status');
          var name = filePath.split('/').pop();
          statusEl.innerHTML = '<span style="color:var(--primary);">Installing ' + esc(name) + '...</span>';
          api.settings.installLocalExtension(filePath).then(function(r) {
            if (r.success) {
              statusEl.innerHTML = '<span style="color:var(--success);">✓ Installed ' + esc((r.entry && r.entry.name) || name) + ' v' + esc((r.entry && r.entry.version) || '?') + '</span>';
              toast('Local extension installed', 'success');
              loadExtensionsTab();
              if (agentBrowser._extDirId) agentBrowser._extRefreshList();
            } else {
              statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(r.error || 'Install failed') + '</span>';
              toast(r.error || 'Install failed', 'error');
            }
          }).catch(function(e) {
            statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(e.message) + '</span>';
            toast(e.message, 'error');
          });
        }).catch(function(e) {
          toast('File picker failed: ' + e.message, 'error');
        });
      },

  extInstallFromDir: function() {
        api.settings.pickExtensionDir().then(function(dirPath) {
          if (!dirPath) return;
          var statusEl = document.getElementById('ext-install-status');
          var name = dirPath.split('/').pop();
          statusEl.innerHTML = '<span style="color:var(--primary);">Importing directory ' + esc(name) + '...</span>';
          api.settings.installLocalExtension(dirPath).then(function(r) {
            if (r.success) {
              statusEl.innerHTML = '<span style="color:var(--success);">✓ Imported ' + esc((r.entry && r.entry.name) || name) + ' v' + esc((r.entry && r.entry.version) || '?') + '</span>';
              toast('Directory extension imported', 'success');
              loadExtensionsTab();
              if (agentBrowser._extDirId) agentBrowser._extRefreshList();
            } else {
              statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(r.error || 'Import failed') + '</span>';
              toast(r.error || 'Import failed', 'error');
            }
          }).catch(function(e) {
            statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(e.message) + '</span>';
            toast(e.message, 'error');
          });
        }).catch(function(e) {
          toast('Directory picker failed: ' + e.message, 'error');
        });
      },

  extDelete: function(extId) {
        var msg = t('ext.confirm-delete','删除扩展 ') + esc(extId) + t('ext.confirm-delete-mid','?\n会从所有 profile 移除,磁盘文件也删除。');
        agentBrowser.confirm(msg, function() {
        var statusEl = document.getElementById('ext-install-status');
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--primary);">Deleting ' + esc(extId) + '...</span>';
        api.settings.deleteRepositoryExtension(extId).then(function(r) {
          if (r.success) {
            if (statusEl) statusEl.innerHTML = '<span style="color:var(--success);">✓ Deleted</span>';
            toast('Extension deleted', 'success');
            loadExtensionsTab();
            if (agentBrowser._extDirId) agentBrowser._extRefreshList();
          } else {
            if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(r.error || 'Delete failed') + '</span>';
            toast(r.error || 'Delete failed', 'error');
          }
        }).catch(function(e) { toast(e.message || String(e), 'error'); });
        }, { ackLabel: t('confirm.ack.permanent','我了解此操作会永久删除数据且不可撤销。') });
      },

  extCheckUpdate: function(extId) {
        var statusEl = document.getElementById('ext-dlg-status') || document.getElementById('ext-install-status');
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--primary);">Updating repository copy of ' + esc(extId) + '...</span>';
        api.settings.updateRepositoryExtension(extId).then(function(r) {
          if (r.success) {
            if (statusEl) statusEl.innerHTML = '<span style="color:var(--success);">✓ Repository updated to v' + esc((r.entry && r.entry.version) || '?') + '</span>';
            toast('Repository extension updated', 'success');
            agentBrowser._extRefreshList();
            loadExtensionsTab();
          } else {
            if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(r.error || 'Update failed') + '</span>';
            toast(r.error || 'Update failed', 'error');
          }
        }).catch(function(e) {
          if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(e.message) + '</span>';
          toast(e.message, 'error');
        });
      },

  extToggle: function(extId, enabled) {
        api.settings.toggleExtension(agentBrowser._extDirId, extId, enabled).then(function(r) {
          if (r.success) toast(enabled ? 'Enabled for profile' : 'Disabled for profile', 'success');
          else toast(r.error || 'Toggle failed', 'error');
        }).catch(function(e) { toast('Toggle error: ' + e.message, 'error'); });
      },

  showRepositoryAdd: function (initialValue) {
        var input = document.getElementById('repo-ext-input');
        var tags = document.getElementById('repo-ext-tags');
        var shared = document.getElementById('repo-ext-shared');
        var statusEl = document.getElementById('repo-ext-save-status');
        if (input) input.value = initialValue || '';
        if (tags) tags.value = '';
        if (shared) shared.checked = false;
        if (statusEl) statusEl.textContent = '';
        document.getElementById('dlg-extension-repo').showModal();
      },

  saveRepositoryExtension: function () {
        var input = document.getElementById('repo-ext-input');
        var tagsInput = document.getElementById('repo-ext-tags');
        var sharedInput = document.getElementById('repo-ext-shared');
        var statusEl = document.getElementById('repo-ext-save-status');
        var extId = extractChromeExtensionId(input ? input.value.trim() : '');
        if (!extId) { toast('Invalid Chrome extension URL or ID', 'error'); return; }
        var tags = parseTagInput(tagsInput ? tagsInput.value : '');
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--primary);">Downloading and validating extension...</span>';
        api.settings.addRepositoryExtension(extId, { shared: !!(sharedInput && sharedInput.checked), tags: tags }).then(function (r) {
          if (!r.success) {
            if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(r.error || 'Add failed') + '</span>';
            toast(r.error || 'Add failed', 'error');
            return;
          }
          if (statusEl) statusEl.innerHTML = '<span style="color:var(--success);">✓ Added v' + esc((r.entry && r.entry.version) || '?') + '</span>';
          document.getElementById('dlg-extension-repo').close();
          toast((window.i18n ? window.i18n.t("toast.ext.added", "Extension added to private repository") : "Extension added to private repository"), 'success');
          loadExtensionsTab();
          if (agentBrowser._extDirId) agentBrowser._extRefreshList();
        }).catch(function (e) {
          if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(e.message) + '</span>';
          toast(e.message, 'error');
        });
      },

  updateRepositoryExtension: function (extId) {
        toast('Updating extension repository...', 'info');
        api.settings.updateRepositoryExtension(extId).then(function (r) {
          if (r.success) { toast((window.i18n ? window.i18n.t("toast.ext.repo-updated", "Repository updated") : "Repository updated"), 'success'); loadExtensionsTab(); if (agentBrowser._extDirId) agentBrowser._extRefreshList(); }
          else toast(r.error || 'Update failed', 'error');
        }).catch(function (e) { toast(e.message, 'error'); });
      },

  setRepositoryShared: function (extId, shared, tags) {
        api.settings.setRepositoryExtensionMeta(extId, { shared: shared, tags: tags || [] }).then(function (r) {
          if (r.success) { toast(shared ? 'Marked shareable' : 'Marked private', 'success'); loadExtensionsTab(); }
          else toast(r.error || 'Update failed', 'error');
        }).catch(function (e) { toast(e.message, 'error'); });
      },

  exportSharedExtensions: function () {
        api.settings.exportSharedExtensionRepository().then(function (entries) {
          var json = JSON.stringify(entries || [], null, 2);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(json).then(function () { toast('Shared catalog copied to clipboard', 'success'); });
          } else {
            window.prompt('Shared extension catalog JSON:', json);
          }
        }).catch(function (e) { toast(e.message, 'error'); });
      },

  loadExtensionsTab: function () { loadExtensionsTab(); }
  });
  function loadExtensionsTab() {
    var container = document.getElementById("extension-repo-list");
    var statusEl = document.getElementById("extension-repo-status");
    if (!container) return;
    var searchEl = document.getElementById("extension-repo-search");
    var filter = searchEl ? searchEl.value.trim() : "";
    container.innerHTML = '<div class="loading">Loading extension repository...</div>';
    api.settings.extensionRepository(filter).then(function (entries) {
      if (statusEl) statusEl.textContent = (entries || []).length + ' extension(s) in private repository';
      if (!entries || entries.length === 0) {
        if(window.agentBrowser&&window.agentBrowser.renderViewState){ window.agentBrowser.renderViewState(container,{empty:'No extensions in the private repository.'}); } else container.innerHTML = '<div class="empty-state">No extensions in the private repository.<br>Click "+ Add Chrome Extension" to cache one from Chrome Web Store.</div>';
        return;
      }
      container.innerHTML = entries.map(function (e) {
        var tags = (e.tags || []).map(function (tag) { return '<span style="background:var(--surface2);border:1px solid var(--border);padding:1px 6px;border-radius:4px;font-size:10px;">' + esc(tag) + '</span>'; }).join(' ');
        return '<div class="profile-card" data-ext-id="' + escAttr(e.id) + '">' +
          '<div class="card-header"><span class="name">' + esc(e.name || e.id) + '</span><span class="status-badge ' + (e.shared ? 'status-running' : 'status-stopped') + '">' + (e.shared ? 'Shared' : 'Private') + '</span></div>' +
          '<div class="info-row"><span>Version</span><span>v' + esc(e.version || '?') + '</span></div>' +
          '<div class="info-row"><span>ID</span><span title="' + escAttr(e.id) + '">' + esc(e.id.slice(0, 16)) + '…</span></div>' +
          '<div class="info-row"><span>Source</span><span>' + (e.source === 'local' ? 'Local' : 'Chrome Web Store') + '</span></div>' +
          '<div class="info-row"><span>Hash</span><span title="' + escAttr(e.packageHash || '') + '">' + esc((e.packageHash || '').slice(0, 12)) + '…</span></div>' +
          (e.description ? '<div style="font-size:11px;color:var(--text-muted);line-height:1.35;margin:8px 0;">' + esc(e.description).slice(0, 160) + '</div>' : '') +
          (tags ? '<div style="display:flex;gap:4px;flex-wrap:wrap;margin:6px 0;">' + tags + '</div>' : '') +
          '<div class="card-actions">' +
            (e.source === 'local'
              ? '<button class="btn btn-secondary btn-sm" disabled title="' + escAttr(t('ext.local-no-update-title','本地扩展无法自动更新,请重新导入')) + '">Update</button> '
              : '<button class="btn btn-secondary btn-sm" data-action="repo-update">Update</button> ') +
            '<button class="btn btn-secondary btn-sm" data-action="repo-share">' + (e.shared ? 'Unshare' : 'Share') + '</button> ' +
            '<button class="btn btn-danger btn-sm" data-action="repo-delete">Delete</button>' +
          '</div>' +
        '</div>';
      }).join("");
      container.onclick = function (event) {
        var target = event.target.closest("[data-action]");
        if (!target || !container.contains(target)) return;
        var card = target.closest(".profile-card");
        var extId = card && card.dataset.extId;
        if (!extId) return;
        var action = target.dataset.action;
        if (action === "repo-update") agentBrowser.updateRepositoryExtension(extId);
        else if (action === "repo-share") {
          var entry = (entries || []).find(function (item) { return item.id === extId; });
          agentBrowser.setRepositoryShared(extId, !(entry && entry.shared), entry && entry.tags || []);
        } else if (action === "repo-delete") agentBrowser.extDelete(extId);
      };
    }).catch(function (e) {
      if(window.agentBrowser&&window.agentBrowser.renderViewState){ window.agentBrowser.renderViewState(container,{error:e.message||String(e), retry:{cmd:'loadExtensionsTab'}}); } else container.innerHTML = '<div class="empty-state">Error: ' + esc(e.message || String(e)) + '</div>';
    });
  }
})();
