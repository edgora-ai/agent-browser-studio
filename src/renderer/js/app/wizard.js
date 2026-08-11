(function() {
  "use strict";

  var cloak = window.cloak;
  var api = cloak.api;
  var R = cloak.R;
  var state = cloak.state;
  var helpers = cloak.helpers;
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
  var normalizeCloakPlatform = helpers.normalizeCloakPlatform;
  var updateCloakStatus = helpers.updateCloakStatus;
  var renderCloakBinaryCard = helpers.renderCloakBinaryCard;
  function maybeShowWizard() {
    // Don't show if previously dismissed
    if (window.wizardDismissed) return;
    try {
      if (localStorage.getItem('cloak-wizard-dismissed')) return;
    } catch (e) { /* localStorage disabled — show wizard */ }

    // Only show if no managed Chromium is installed or no profiles exist.
    var installed = false;
    try {
      installed = api.cloak.binary().then(function(info) {
        if (info && info.installed) {
          // Check if there are already profiles
          return api.cloak.list().then(function(profiles) {
            if (profiles && profiles.length > 0) return; // already has profiles, skip
            showWizard();
          });
        } else {
          showWizard();
        }
      });
    } catch (e) {
      // Fallback: show wizard
      showWizard();
    }
  }

  function showWizard() {
    var dlg = document.getElementById('dlg-wizard');
    if (!dlg) return;
    // Reset wizard state
    state.wizardDirId = null;
    state.wizardProfileName = null;
    // Reset steps
    var steps = dlg.querySelectorAll('.wizard-step');
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      s.style.opacity = i === 0 ? '1' : '0.45';
      var btns = s.querySelectorAll('button');
      for (var j = 0; j < btns.length; j++) btns[j].disabled = i > 0;
    }
    document.getElementById('wizard-step1-status').textContent = '';
    document.getElementById('wizard-profile-name').value = '';
    document.getElementById('wizard-profile-name').disabled = true;
    document.getElementById('wizard-step2-status') && (document.getElementById('wizard-step2-status').textContent = '');
    dlg.showModal();
  }

  // Wizard step 1: verify the independently installed browser engine.
  cloak.wizardVerifyBinary = function() {
    var statusEl = document.getElementById('wizard-step1-status');
    statusEl.innerHTML = '<span style="color:var(--primary);">' + (window.i18n ? window.i18n.t('wizard.step1.in-progress', 'Verifying managed Chromium…') : 'Verifying managed Chromium…') + '</span>';
    api.cloak.verifyBinary().then(function(r) {
      if (r && r.success) {
        statusEl.innerHTML = '<span style="color:var(--success);">✓ ' + (window.i18n ? window.i18n.t('wizard.step1.done', 'Installed') : 'Installed') + '</span>';
        advanceWizardStep(1);
      } else {
        statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + ((r && r.error) || (window.i18n ? window.i18n.t('wizard.step1.failed', 'Install failed') : 'Install failed')) + '</span>';
      }
    }).catch(function(e) {
      statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + (e.message || 'Install failed') + '</span>';
    });
  };

  // Wizard step 2: create first profile
  cloak.wizardCreateProfile = function() {
    var nameInput = document.getElementById('wizard-profile-name');
    var name = nameInput.value.trim();
    if (!name) name = (window.i18n ? window.i18n.t('wizard.default-name', 'My First Profile') : 'My First Profile');
    var statusEl = document.getElementById('wizard-step2-status') || (function() {
      var el = document.createElement('div');
      el.id = 'wizard-step2-status';
      el.className = 'wizard-status';
      el.style.cssText = 'font-size:11px;color:var(--text-muted);margin-top:6px;';
      nameInput.parentNode.appendChild(el);
      return el;
    })();
    statusEl.innerHTML = '<span style="color:var(--primary);">' + (window.i18n ? window.i18n.t('wizard.step2.in-progress', 'Creating profile…') : 'Creating profile…') + '</span>';
    api.cloak.create({ name: name }).then(function(r) {
      if (r && r.dirId) {
        state.wizardDirId = r.dirId;
        state.wizardProfileName = name;
        statusEl.innerHTML = '<span style="color:var(--success);">✓ ' + (window.i18n ? window.i18n.t('wizard.step2.done', 'Profile created') : 'Profile created') + '</span>';
        advanceWizardStep(2);
      } else {
        statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + ((r && r.error) || (window.i18n ? window.i18n.t('wizard.step2.failed', 'Create failed') : 'Create failed')) + '</span>';
      }
    }).catch(function(e) {
      statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + (e.message || 'Create failed') + '</span>';
    });
  };

  // Wizard step 3: launch + risk check
  cloak.wizardLaunchAndCheck = function() {
    var dirId = state.wizardDirId;
    if (!dirId) { advanceWizardStep(3); return; }
    var btn = document.querySelector('.wizard-step[data-step="3"] button');
    if (btn) btn.disabled = true;
    api.cloak.openRiskCheck(dirId).then(function(r) {
      var statusEl = document.getElementById('wizard-step3-status') || (function() {
        var el = document.createElement('div');
        el.id = 'wizard-step3-status';
        el.className = 'wizard-status';
        el.style.cssText = 'font-size:11px;color:var(--text-muted);margin-top:6px;';
        document.querySelector('.wizard-step[data-step="3"] .btn-row').appendChild(el);
        return el;
      })();
      if (r && r.success) {
        statusEl.innerHTML = '<span style="color:var(--success);">✓ ' + (window.i18n ? window.i18n.t('wizard.step3.done', 'Launched & navigating to ping0.cc') : 'Launched & navigating to ping0.cc') + '</span>';
        scheduleProfilesRefresh();
        // Advance to the optional AI configuration step instead of auto-closing.
        advanceWizardStep(3);
      } else {
        statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + ((r && r.error) || (window.i18n ? window.i18n.t('wizard.step3.failed', 'Launch failed') : 'Launch failed')) + '</span>';
        if (btn) btn.disabled = false;
      }
    }).catch(function(e) {
      var statusEl = document.getElementById('wizard-step3-status');
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + (e.message || 'Error') + '</span>';
      if (btn) btn.disabled = false;
    });
  };

  function advanceWizardStep(completedStep) {
    var dlg = document.getElementById('dlg-wizard');
    if (!dlg) return;
    var nextStep = completedStep + 1;
    var thisStep = dlg.querySelector('.wizard-step[data-step="' + completedStep + '"]');
    var nextEl = dlg.querySelector('.wizard-step[data-step="' + nextStep + '"]');
    if (thisStep) {
      thisStep.style.opacity = '0.6';
      var btns = thisStep.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
    }
    if (nextEl) {
      nextEl.style.opacity = '1';
      var nextBtns = nextEl.querySelectorAll('button');
      for (var j = 0; j < nextBtns.length; j++) nextBtns[j].disabled = false;
      var input = nextEl.querySelector('input');
      if (input) input.disabled = false;
    }
  }

  cloak.wizardSkip = function() {
    document.getElementById('dlg-wizard').close();
    // "Skip for now" only hides the wizard for the current session — it does
    // NOT persist dismissal, so the wizard can reappear on the next app launch
    // if the first-run conditions (no binary / no profiles) still hold.
    window.wizardDismissed = true;
  };

  cloak.wizardNeverShow = function() {
    document.getElementById('dlg-wizard').close();
    try { localStorage.setItem('cloak-wizard-dismissed', '1'); } catch (e) { /* ok */ }
    window.wizardDismissed = true;
  };

  function dismissWizard() {
    // Used internally after a completed wizard run: hide for this session only.
    // Persisting dismissal would be wrong here — a completed onboarding should
    // not suppress a future re-onboarding if the user wipes their profiles.
    window.wizardDismissed = true;
  }

  // Step 4 (optional): jump to the Agent config view so the user can wire up
  // an LLM provider after their first profile is ready.
  cloak.wizardConfigureAgent = function() {
    document.getElementById('dlg-wizard').close();
    window.wizardDismissed = true;
    try { cloak.switchTab('agent'); } catch (e) { /* ignore */ }
    try { cloak.switchAgentSub('config'); } catch (e) { /* ignore */ }
  };

  cloak.maybeShowWizard = maybeShowWizard;
  cloak.showWizard = showWizard;
  cloak.advanceWizardStep = advanceWizardStep;

})();
