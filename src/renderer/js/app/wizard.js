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
  // sale-93: terms gate — first launch shows the Terms dialog before
  // anything else (wizard included). Acceptance persists in localStorage.
  var TERMS_KEY = 'agent-browser-studio-terms-accepted-v1';
  function termsAccepted() {
    try { return localStorage.getItem(TERMS_KEY) === '1'; } catch (e) { return true; }
  }
  agentBrowser.termsAccepted = termsAccepted;
  function maybeShowTerms() {
    if (termsAccepted()) return false;
    var dlg = document.getElementById('dlg-terms');
    if (!dlg) return false;
    try {
      var box = document.getElementById('terms-ack');
      if (box) box.checked = false;
    } catch (e) { /* ok */ }
    if (!dlg.open) {
      dlg.showModal();
      if (typeof agentBrowser.focusDialogPrimary === "function") agentBrowser.focusDialogPrimary(dlg);
    }
    return true;
  }
  agentBrowser.termsAccept = function() {
    var box = document.getElementById('terms-ack');
    if (!box || !box.checked) {
      toast((window.i18n ? window.i18n.t("terms.ack-required", "Please tick the acknowledgement box first") : "Please tick the acknowledgement box first"), "error");
      if (box) box.focus();
      return;
    }
    try { localStorage.setItem(TERMS_KEY, '1'); } catch (e) { /* ok */ }
    var dlg = document.getElementById('dlg-terms');
    if (dlg && dlg.open) dlg.close();
    maybeShowWizard();
  };
  agentBrowser.termsDecline = function() {
    // No quit IPC exists — close the window; the app quits when its last
    // window closes. Re-shown on next launch until accepted (sale-93).
    try { window.close(); } catch (e) { /* ok */ }
  };
  function maybeShowWizard() {
    // Terms first (sale-93): no onboarding until accepted.
    if (maybeShowTerms()) return;
    // Don't show if previously dismissed
    if (window.wizardDismissed) return;
    try {
      var dismissed = localStorage.getItem('agent-browser-studio-wizard-dismissed') || localStorage.getItem('cloak-wizard-dismissed');
      if (dismissed) {
        localStorage.setItem('agent-browser-studio-wizard-dismissed', dismissed);
        return;
      }
    } catch (e) { /* localStorage disabled — show wizard */ }

    // Only show if no managed Chromium is installed or no profiles exist.
    var installed = false;
    try {
      installed = api.browser.binary().then(function(info) {
        if (info && info.installed) {
          // Check if there are already profiles
          return api.browser.list().then(function(profiles) {
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

  // R11 P2-3: wizard checkpoint — persist completed step + created profile so
  // a refresh/close mid-onboarding resumes instead of restarting from step 1.
  var WIZARD_PROGRESS_KEY = 'agent-browser-studio-wizard-progress';
  function saveWizardProgress(step) {
    try {
      localStorage.setItem(WIZARD_PROGRESS_KEY, JSON.stringify({
        step: step,
        dirId: state.wizardDirId || null,
        profileName: state.wizardProfileName || null,
      }));
    } catch (e) { /* storage disabled */ }
  }
  function loadWizardProgress() {
    try {
      var raw = localStorage.getItem(WIZARD_PROGRESS_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || typeof p.step !== "number") return null;
      return p;
    } catch (e) { return null; }
  }
  function clearWizardProgress() {
    try { localStorage.removeItem(WIZARD_PROGRESS_KEY); } catch (e) { /* ok */ }
  }

  function showWizard() {
    var dlg = document.getElementById('dlg-wizard');
    if (!dlg) return;
    // Resume from checkpoint when present (R11 P2-3).
    var saved = loadWizardProgress();
    if (saved && saved.step > 0) {
      state.wizardDirId = saved.dirId || null;
      state.wizardProfileName = saved.profileName || null;
      var steps = dlg.querySelectorAll('.wizard-step');
      for (var i = 0; i < steps.length; i++) {
        var s = steps[i];
        var num = Number(s.getAttribute("data-step")) || (i + 1);
        var done = num <= saved.step;
        s.style.opacity = done || num === saved.step + 1 ? '1' : '0.45';
        var btns = s.querySelectorAll('button');
        for (var j = 0; j < btns.length; j++) btns[j].disabled = !(done || num === saved.step + 1);
      }
      if (saved.profileName) {
        try { document.getElementById('wizard-profile-name').value = saved.profileName; } catch (e) { /* ok */ }
      }
      dlg.showModal();
      return;
    }
    // Reset wizard state
    state.wizardDirId = null;
    state.wizardProfileName = null;
    // Reset steps
    var steps0 = dlg.querySelectorAll('.wizard-step');
    for (var k = 0; k < steps0.length; k++) {
      var s0 = steps0[k];
      s0.style.opacity = k === 0 ? '1' : '0.45';
      var btns0 = s0.querySelectorAll('button');
      for (var m = 0; m < btns0.length; m++) btns0[m].disabled = k > 0;
    }
    document.getElementById('wizard-step1-status').textContent = '';
    document.getElementById('wizard-profile-name').value = '';
    document.getElementById('wizard-profile-name').disabled = true;
    document.getElementById('wizard-step2-status') && (document.getElementById('wizard-step2-status').textContent = '');
    dlg.showModal();
  }

  // Wizard step 1: verify the independently installed browser engine.
  agentBrowser.wizardVerifyBinary = function() {
    var statusEl = document.getElementById('wizard-step1-status');
    statusEl.innerHTML = '<span style="color:var(--primary);">' + (window.i18n ? window.i18n.t('wizard.step1.in-progress', 'Verifying managed Chromium…') : 'Verifying managed Chromium…') + '</span>';
    api.browser.verifyBinary().then(function(r) {
      if (r && r.success) {
        statusEl.innerHTML = '<span style="color:var(--success);">✓ ' + (window.i18n ? window.i18n.t('wizard.step1.done', 'Installed') : 'Installed') + '</span>';
        advanceWizardStep(1);
      } else {
        wizardEngineMissing(statusEl, (r && r.error) || (window.i18n ? window.i18n.t('wizard.step1.failed', 'Install failed') : 'Install failed'));
      }
    }).catch(function(e) {
      wizardEngineMissing(statusEl, e.message || 'Install failed');
    });
  };

  // Step-1 failure must never dead-end: point the user at the same escape
  // paths the Profiles banner offers (pick a local build, or open the guide).
  function wizardEngineMissing(statusEl, message) {
    var hint = (window.i18n ? window.i18n.t('wizard.step1.hint', 'No usable build found. Select a local Chromium build or open the install guide, then verify again.') : 'No usable build found. Select a local Chromium build or open the install guide, then verify again.');
    statusEl.innerHTML =
      '<span style="color:var(--danger);">✗ ' + esc(message) + '</span>' +
      '<div style="margin-top:6px;font-size:11px;color:var(--text-muted);">' + esc(hint) + '</div>' +
      '<div class="btn-row" style="margin-top:6px;">' +
      '<button type="button" class="btn btn-secondary btn-sm" data-role="cmd" data-cmd="selectChromiumBinary">' + esc(window.i18n ? window.i18n.t('engine.select', 'Select local build…') : 'Select local build…') + '</button>' +
      '<button type="button" class="btn btn-secondary btn-sm" data-role="cmd" data-cmd="showEngineGuide">' + esc(window.i18n ? window.i18n.t('engine.guide', 'Install guide') : 'Install guide') + '</button>' +
      '</div>';
  }

  // Wizard step 2: create first profile
  agentBrowser.wizardCreateProfile = function() {
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
    api.browser.create({ name: name }).then(function(r) {
      if (r && r.dirId) {
        state.wizardDirId = r.dirId;
        state.wizardProfileName = name;
        statusEl.innerHTML = '<span style="color:var(--success);">✓ ' + (window.i18n ? window.i18n.t('wizard.step2.done', 'Profile created') : 'Profile created') + '</span>';
        advanceWizardStep(2);
      } else {
        statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc((r && r.error) || (window.i18n ? window.i18n.t('wizard.step2.failed', 'Create failed') : 'Create failed')) + '</span>';
      }
    }).catch(function(e) {
      statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(e.message || 'Create failed') + '</span>';
    });
  };

  // Wizard step 3: launch + risk check.
  // R8 P2-5: this used to call api.browser.openRiskCheck directly, bypassing
  // both the external-site consent dialog and the launch confirmation. Route
  // through the shared gateway so the wizard obeys the same rules as cards.
  // R12 P2-1: double-click guard — confirm() is a singleton, so a second
  // click while the first dialog is undecided overwrote its callback.
  // Time-window (not a latch): cancel paths have no callback, so a latch
  // would wedge the button after a single Esc.
  var lastWizardCheckAt = 0;
  agentBrowser.wizardLaunchAndCheck = function() {
    var dirId = state.wizardDirId;
    if (!dirId) { advanceWizardStep(3); return; }
    var now = Date.now();
    if (now - lastWizardCheckAt < 1500) return;
    lastWizardCheckAt = now;
    if (typeof agentBrowser.ensureExternalRiskConsent === "function") {
      agentBrowser.ensureExternalRiskConsent(dirId, function () { wizardRiskCheckAfterConsent(dirId); });
      return;
    }
    wizardRiskCheckAfterConsent(dirId);
  };

  function wizardRiskCheckAfterConsent(dirId) {
    var btn = document.querySelector('.wizard-step[data-step="3"] button');
    if (btn) btn.disabled = true;
    api.browser.status(dirId).then(function (s) {
      if (s && s.running) { wizardOpenRiskCheck(dirId); return; }
      agentBrowser.confirm(
        window.i18n ? window.i18n.t("risk.launch.msg", "This check needs a running browser. Start the profile now?") : "This check needs a running browser. Start the profile now?",
        function () { wizardOpenRiskCheck(dirId, true); },
        { title: window.i18n ? window.i18n.t("risk.launch.title", "Start profile for check") : "Start profile for check" },
      );
      if (btn) btn.disabled = false;
    }).catch(function (e) {
      toast(e.message || "Error", "error");
      if (btn) btn.disabled = false;
    });
  }

  function wizardOpenRiskCheck(dirId, allowLaunch) {
    var btn = document.querySelector('.wizard-step[data-step="3"] button');
    if (btn) btn.disabled = true;
    api.browser.openRiskCheck(dirId, { allowLaunch: !!allowLaunch }).then(function(r) {
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
        statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc((r && r.error) || (window.i18n ? window.i18n.t('wizard.step3.failed', 'Launch failed') : 'Launch failed')) + '</span>';
        if (btn) btn.disabled = false;
      }
    }).catch(function(e) {
      var statusEl = document.getElementById('wizard-step3-status');
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(e.message || 'Error') + '</span>';
      if (btn) btn.disabled = false;
    });
  };

  function advanceWizardStep(completedStep) {
    var dlg = document.getElementById('dlg-wizard');
    if (!dlg) return;
    saveWizardProgress(completedStep);
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

  agentBrowser.wizardSkip = function() {
    document.getElementById('dlg-wizard').close();
    clearWizardProgress();
    // "Skip for now" only hides the wizard for the current session — it does
    // NOT persist dismissal, so the wizard can reappear on the next app launch
    // if the first-run conditions (no binary / no profiles) still hold.
    window.wizardDismissed = true;
  };

  agentBrowser.wizardNeverShow = function() {
    document.getElementById('dlg-wizard').close();
    clearWizardProgress();
    try { localStorage.setItem('agent-browser-studio-wizard-dismissed', '1'); } catch (e) { /* ok */ }
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
  agentBrowser.wizardConfigureAgent = function() {
    document.getElementById('dlg-wizard').close();
    clearWizardProgress();
    window.wizardDismissed = true;
    try { agentBrowser.switchTab('agent'); } catch (e) { /* ignore */ }
    try { agentBrowser.switchAgentSub('config'); } catch (e) { /* ignore */ }
  };

  agentBrowser.maybeShowWizard = maybeShowWizard;
  agentBrowser.showWizard = showWizard;
  agentBrowser.advanceWizardStep = advanceWizardStep;
  // Review item PL-08: "Don't show again" was permanent with no way back.
  // This clears the dismissal so onboarding can be re-run from the UI.
  agentBrowser.restartWizard = function() {
    try {
      localStorage.removeItem('agent-browser-studio-wizard-dismissed');
      localStorage.removeItem('cloak-wizard-dismissed');
    } catch (e) { /* storage disabled */ }
    window.wizardDismissed = false;
    showWizard();
  };

})();
