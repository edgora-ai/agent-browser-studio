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
  agentBrowser.agentLoadSkills = function() {
    var el = document.getElementById('agent-skills-list');
    el.innerHTML = '<div class="loading">' + esc(window.i18n ? window.i18n.t("skills.loading", "Loading skills...") : "Loading skills...") + '</div>';
    R.agent.skills.list().then(function(skills) {
      if (!skills || skills.length === 0) {
        el.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;">No skills in your marketplace. Add or import a skill to get started.</div>';
        return;
      }
      el.innerHTML = skills.map(function(s) { return renderSkillCard(s, false); }).join('');
      bindSkillCardActions(el, skills, false);
    }).catch(function(e) {
      el.innerHTML = '<div class="empty-state">Error: ' + esc(e.message || String(e)) + '</div>';
    });
  };

  agentBrowser.showSkillEditor = function(skillId) {
    closeDialogIfOpen('dlg-skill-market');
    clearSkillEditor();
    if (!skillId) {
      document.getElementById('skill-editor-title').textContent = window.i18n ? window.i18n.t("skills.editor.add", "Add Agent Skill") : "Add Agent Skill";
      document.getElementById('dlg-skill-editor').showModal();
      return;
    }
    R.agent.skills.list().then(function(skills) {
      var skill = (skills || []).find(function(s) { return s.id === skillId; });
      if (!skill) { toast((window.i18n ? window.i18n.t("toast.skill.not-found", "Skill not found") : "Skill not found"), 'error'); return; }
      if (skill.source === 'built-in') { toast(window.i18n ? window.i18n.t("skills.builtin-readonly", "Built-in skills can be enabled, disabled, or shared, but not edited.") : "Built-in skills can be enabled, disabled, or shared, but not edited.", 'error'); return; }
      document.getElementById('skill-editor-title').textContent = window.i18n ? window.i18n.t("skills.editor.edit", "Edit Agent Skill") : "Edit Agent Skill";
      document.getElementById('skill-id').value = skill.id || '';
      document.getElementById('skill-id').disabled = true;
      document.getElementById('skill-version').value = skill.version || '1.0.0';
      document.getElementById('skill-title').value = skill.title || skill.name || '';
      document.getElementById('skill-description').value = skill.description || '';
      document.getElementById('skill-tools').value = (skill.tools || []).join(', ');
      document.getElementById('skill-tags').value = (skill.tags || []).filter(function(tag) { return tag !== 'built-in'; }).join(', ');
      document.getElementById('skill-author').value = skill.author || '';
      document.getElementById('skill-homepage').value = skill.homepage || '';
      document.getElementById('skill-prompt').value = skill.prompt || '';
      document.getElementById('skill-enabled').checked = !!skill.enabled;
      document.getElementById('skill-shared').checked = !!skill.shared;
      document.getElementById('dlg-skill-editor').showModal();
    }).catch(function(e) { toast(e.message || String(e), 'error'); });
  };

  agentBrowser.saveSkill = function() {
    var id = document.getElementById('skill-id').value.trim().toLowerCase();
    var title = document.getElementById('skill-title').value.trim();
    var prompt = document.getElementById('skill-prompt').value.trim();
    var statusEl = document.getElementById('skill-save-status');
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) { toast(window.i18n ? window.i18n.t("toast.skill.invalid-id", "Invalid skill ID. Use lowercase letters, numbers, dot, underscore, or dash.") : "Invalid skill ID. Use lowercase letters, numbers, dot, underscore, or dash.", 'error'); return; }
    if (!title || !prompt) { toast((window.i18n ? window.i18n.t("toast.skill.fields-required", "Title and prompt are required") : "Title and prompt are required"), 'error'); return; }
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--primary);">' + esc(window.i18n ? window.i18n.t("skills.saving", "Saving skill...") : "Saving skill...") + '</span>';
    var skill = {
      id: id,
      name: id,
      title: title,
      version: document.getElementById('skill-version').value.trim() || '1.0.0',
      description: document.getElementById('skill-description').value.trim(),
      tools: parseListInput(document.getElementById('skill-tools').value, 50, 80),
      tags: parseTagInput(document.getElementById('skill-tags').value),
      author: document.getElementById('skill-author').value.trim() || undefined,
      homepage: document.getElementById('skill-homepage').value.trim() || undefined,
      prompt: prompt,
      enabled: document.getElementById('skill-enabled').checked,
      shared: document.getElementById('skill-shared').checked,
    };
    R.agent.skills.add(skill).then(function(r) {
      if (!r || !r.success) {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc((r && r.error) || 'Save failed') + '</span>';
        toast((r && r.error) || 'Save failed', 'error');
        return;
      }
      document.getElementById('dlg-skill-editor').close();
      toast((window.i18n ? window.i18n.t("toast.skill.saved", "Skill saved") : "Skill saved"), 'success');
      agentBrowser.agentLoadSkills();
      if (document.getElementById('dlg-skill-market').open) agentBrowser.refreshSkillMarket();
    }).catch(function(e) {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(e.message || String(e)) + '</span>';
      toast(e.message || String(e), 'error');
    });
  };

  agentBrowser.removeSkill = function(id) {
    var msg = (window.i18n ? window.i18n.t("skill.remove-confirm", 'Remove or disable skill "{id}"?') : 'Remove or disable skill "{id}"?').replace("{id}", id);
    agentBrowser.confirm(msg, function() {
      R.agent.skills.remove(id).then(function(r) {
        if (r && r.success) { toast((window.i18n ? window.i18n.t("toast.skill.removed", "Skill removed/disabled") : "Skill removed/disabled"), 'success'); refreshSkillViews(); }
        else toast((r && r.error) || 'Remove failed', 'error');
      }).catch(function(e) { toast(e.message || String(e), 'error'); });
    });
  };

  agentBrowser.setSkillEnabled = function(id, enabled) {
    R.agent.skills.setMeta(id, { enabled: !!enabled }).then(function(r) {
      if (r && r.success) { toast(enabled ? (window.i18n ? window.i18n.t("toast.skill.enabled", "Skill enabled") : "Skill enabled") : 'Skill disabled', 'success'); refreshSkillViews(); }
      else toast((r && r.error) || 'Update failed', 'error');
    }).catch(function(e) { toast(e.message || String(e), 'error'); });
  };

  agentBrowser.setSkillShared = function(id, shared, tags) {
    R.agent.skills.setMeta(id, { shared: !!shared, tags: tags || [] }).then(function(r) {
      if (r && r.success) { toast(shared ? 'Marked shareable' : 'Marked private', 'success'); refreshSkillViews(); }
      else toast((r && r.error) || 'Update failed', 'error');
    }).catch(function(e) { toast(e.message || String(e), 'error'); });
  };

  // ══════ Skill Marketplace ══════
  agentBrowser.skillMarket = function() {
    document.getElementById('skill-market-list').innerHTML = '<div class="loading">Loading marketplace...</div>';
    var search = document.getElementById('skill-market-search');
    if (search) search.value = '';
    document.getElementById('dlg-skill-market').showModal();
    agentBrowser.refreshSkillMarket();
  };

  agentBrowser.refreshSkillMarket = function() {
    var list = document.getElementById('skill-market-list');
    var search = document.getElementById('skill-market-search');
    var filter = search ? search.value.trim() : '';
    list.innerHTML = '<div class="loading">Loading marketplace...</div>';
    R.agent.skills.marketplace(filter).then(function(skills) {
      if (!skills || skills.length === 0) {
        list.innerHTML = '<div class="empty-state">No matching skills. Add a local skill or import a shared catalog.</div>';
        return;
      }
      list.innerHTML = skills.map(function(s) { return renderSkillCard(s, true); }).join('');
      bindSkillCardActions(list, skills, true);
    }).catch(function(e) {
      list.innerHTML = '<div class="empty-state">Error: ' + esc(e.message || String(e)) + '</div>';
    });
  };

  agentBrowser.installSkill = function(id) {
    R.agent.skills.install(id).then(function(r) {
      if (r && r.success) { toast((window.i18n ? window.i18n.t("toast.skill.enabled", "Skill enabled") : "Skill enabled"), 'success'); refreshSkillViews(); }
      else toast((r && r.error) || 'Install failed', 'error');
    }).catch(function(e) { toast(e.message || String(e), 'error'); });
  };

  agentBrowser.exportSharedSkills = function() {
    R.agent.skills.exportShared().then(function(entries) {
      var json = JSON.stringify(entries || [], null, 2);
      var fallback = function() { window.prompt('Shared skill catalog JSON:', json); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(function() {
          toast('Shared skill catalog copied to clipboard', 'success');
        }).catch(function() {
          fallback();
        });
      } else {
        fallback();
      }
    }).catch(function(e) { toast(e.message || String(e), 'error'); });
  };

  agentBrowser.showSkillImport = function() {
    closeDialogIfOpen('dlg-skill-market');
    document.getElementById('skill-import-json').value = '';
    document.getElementById('skill-import-status').textContent = '';
    document.getElementById('dlg-skill-import').showModal();
  };

  agentBrowser.importSharedSkills = function() {
    var statusEl = document.getElementById('skill-import-status');
    var entries;
    try { entries = JSON.parse(document.getElementById('skill-import-json').value); }
    catch (e) { toast('Invalid JSON catalog', 'error'); return; }
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--primary);">Importing catalog...</span>';
    R.agent.skills.importShared(entries).then(function(r) {
      if (!r || !r.success) {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc((r && r.error) || 'Import failed') + '</span>';
        toast((r && r.error) || 'Import failed', 'error');
        return;
      }
      document.getElementById('dlg-skill-import').close();
      var result = r.result || { added: 0, updated: 0, skipped: 0 };
      toast('Imported skills: +' + result.added + ', updated ' + result.updated + ', skipped ' + result.skipped, 'success');
      refreshSkillViews();
    }).catch(function(e) {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(e.message || String(e)) + '</span>';
      toast(e.message || String(e), 'error');
    });
  };
})();
