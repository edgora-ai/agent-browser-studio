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
  var termsQuitPending = false;
  agentBrowser.termsDecline = async function() {
    if (termsQuitPending) return;
    termsQuitPending = true;
    var button = document.querySelector('#dlg-terms [data-cmd="termsDecline"]');
    var errorEl = document.getElementById('terms-quit-error');
    if (button) button.disabled = true;
    if (errorEl) { errorEl.hidden = true; errorEl.textContent = ''; }
    try {
      var result = await api.app.quit();
      // The IPC reply only acknowledges the request; keep the terms dialog
      // open until Electron actually exits, and never persist acceptance here.
      if (!result || result.success !== true) throw new Error('Exit request refused');
    } catch (e) {
      var message = window.i18n ? window.i18n.t('terms.quit-failed', 'Unable to quit the app. Please try again.') : 'Unable to quit the app. Please try again.';
      // A body-level toast is behind a showModal() dialog's top layer.
      if (errorEl) { errorEl.textContent = message; errorEl.hidden = false; }
      else toast(message, 'error');
    } finally {
      termsQuitPending = false;
      if (button) button.disabled = false;
    }
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

    // A real checkpoint takes precedence over first-run detection. Without
    // one, established installs still skip onboarding as before.
    if (loadWizardProgress()) { showWizard(); return; }
    var generation = wizardGeneration;
    Promise.resolve().then(function() { return api.browser.binary(); }).then(function(info) {
      if (info && info.installed) {
        return api.browser.list().then(function(profiles) {
          if (profiles && profiles.length > 0) return;
          if (generation === wizardGeneration && !window.wizardDismissed) showWizard();
        });
      }
      if (generation === wizardGeneration && !window.wizardDismissed) showWizard();
    }).catch(function() {
      if (generation === wizardGeneration && !window.wizardDismissed) showWizard();
    });
  }

  // R11 P2-3: wizard checkpoint — persist completed step + created profile so
  // a refresh/close mid-onboarding resumes instead of restarting from step 1.
  var WIZARD_PROGRESS_KEY = 'agent-browser-studio-wizard-progress';
  var wizardGeneration = 0;
  var wizardCreatePending = false;
  // Dialog generations own UI; an onboarding epoch owns checkpoint writes.
  // A committed create receipt survives close/reopen and explicit dismissal,
  // but dismissal must not resurrect the removed checkpoint.
  var wizardEpoch = 0;
  var wizardCreateReceipt = null;
  var wizardCompletedStep = 0;
  function saveWizardProgress(step, profile) {
    try {
      localStorage.setItem(WIZARD_PROGRESS_KEY, JSON.stringify({
        step: step,
        dirId: (profile ? profile.dirId : state.wizardDirId) || null,
        profileName: (profile ? profile.profileName : state.wizardProfileName) || null,
      }));
    } catch (e) { /* storage disabled */ }
  }
  function loadWizardProgress() {
    try {
      var raw = localStorage.getItem(WIZARD_PROGRESS_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || !Number.isInteger(p.step) || p.step < 1 || p.step > 3) return null;
      return {
        step: p.step,
        dirId: typeof p.dirId === 'string' && p.dirId ? p.dirId : null,
        profileName: typeof p.profileName === 'string' ? p.profileName : null,
      };
    } catch (e) { return null; }
  }
  function clearWizardProgress() {
    try { localStorage.removeItem(WIZARD_PROGRESS_KEY); } catch (e) { /* ok */ }
  }

  function showWizard() {
    var dlg = document.getElementById('dlg-wizard');
    if (!dlg) return;
    var generation = ++wizardGeneration;
    var saved = loadWizardProgress();
    if (wizardCreateReceipt && (!saved || saved.step === 1)) {
      saved = { step: 2, dirId: wizardCreateReceipt.dirId, profileName: wizardCreateReceipt.profileName };
    }
    state.wizardDirId = null;
    state.wizardProfileName = null;
    for (var k = 1; k <= 3; k++) {
      var statusEl = document.getElementById('wizard-step' + k + '-status');
      if (statusEl) statusEl.textContent = '';
    }
    renderWizardProgress(saved && saved.step === 1 ? 1 : 0);
    if (!dlg.open) dlg.showModal();
    if (!saved) return;
    if (saved.step === 1) return;
    // Never restore a launch target from localStorage alone: profiles may
    // have been deleted, trashed or renamed while the wizard was closed.
    renderWizardProgress(-1);
    Promise.resolve().then(function() { return api.browser.list(); }).then(function(profiles) {
      if (generation !== wizardGeneration || !dlg.open) return;
      if (!Array.isArray(profiles)) throw new Error('Profile list unavailable');
      var profile = profiles.find(function(p) { return p.dirId === saved.dirId; });
      if (!profile) {
        if (wizardCreateReceipt && wizardCreateReceipt.dirId === saved.dirId) wizardCreateReceipt = null;
        renderWizardProgress(1);
        saveWizardProgress(1);
        return;
      }
      state.wizardDirId = profile.dirId;
      state.wizardProfileName = profile.name || saved.profileName;
      renderWizardProgress(saved.step);
      saveWizardProgress(saved.step);
    }).catch(function(e) {
      if (generation !== wizardGeneration || !dlg.open) return;
      // Lookup failure is not proof of deletion. Keep the checkpoint and
      // disable creation/launch; Verify remains a safe retry entry point.
      renderWizardProgress(0);
      var statusEl = document.getElementById('wizard-step1-status');
      if (statusEl) statusEl.innerHTML = '<span style="color: var(--danger-text);">' + esc(e.message || 'Error') + '</span>';
    });
  }

  function renderWizardProgress(completedStep) {
    wizardCompletedStep = completedStep;
    var dlg = document.getElementById('dlg-wizard');
    var steps = dlg.querySelectorAll('.wizard-step');
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      var num = Number(s.getAttribute('data-step')) || (i + 1);
      var active = num === completedStep + 1;
      s.style.opacity = active ? '1' : num <= completedStep ? '0.6' : '0.45';
      var btns = s.querySelectorAll('button');
      for (var j = 0; j < btns.length; j++) btns[j].disabled = !active || (num === 2 && wizardCreatePending);
    }
    var input = document.getElementById('wizard-profile-name');
    if (input) {
      input.value = state.wizardProfileName || '';
      input.disabled = completedStep !== 1 || wizardCreatePending;
    }
  }

  // Wizard step 1: verify the independently installed browser engine.
  agentBrowser.wizardVerifyBinary = function() {
    var generation = wizardGeneration;
    var dlg = document.getElementById('dlg-wizard');
    var statusEl = document.getElementById('wizard-step1-status');
    statusEl.innerHTML = '<span style="color: var(--primary-text);">' + (window.i18n ? window.i18n.t('wizard.step1.in-progress', 'Verifying managed Chromium…') : 'Verifying managed Chromium…') + '</span>';
    api.browser.verifyBinary().then(function(r) {
      if (generation !== wizardGeneration || !dlg || !dlg.open) return;
      if (r && r.success) {
        statusEl.innerHTML = '<span style="color: var(--success-text);">' + (window.i18n ? window.i18n.t('wizard.step1.done', 'Installed') : 'Installed') + '</span>';
        var saved = loadWizardProgress();
        if (wizardCreateReceipt || (saved && saved.step >= 2)) showWizard();
        else advanceWizardStep(1);
      } else {
        wizardEngineMissing(statusEl, (r && r.error) || (window.i18n ? window.i18n.t('wizard.step1.failed', 'Install failed') : 'Install failed'));
      }
    }).catch(function(e) {
      if (generation !== wizardGeneration || !dlg || !dlg.open) return;
      wizardEngineMissing(statusEl, e.message || 'Install failed');
    });
  };

  // Step-1 failure must never dead-end: point the user at the same escape
  // paths the Profiles banner offers (pick a local build, or open the guide).
  function wizardEngineMissing(statusEl, message) {
    var hint = (window.i18n ? window.i18n.t('wizard.step1.hint', 'No usable build found. Select a local Chromium build or open the install guide, then verify again.') : 'No usable build found. Select a local Chromium build or open the install guide, then verify again.');
    statusEl.innerHTML =
      '<span style="color: var(--danger-text);">' + esc(message) + '</span>' +
      '<div style="margin-top:6px;font-size:11px;color:var(--text-muted);">' + esc(hint) + '</div>' +
      '<div class="btn-row" style="margin-top:6px;">' +
      '<button type="button" class="btn btn-secondary btn-sm" data-role="cmd" data-cmd="selectChromiumBinary">' + esc(window.i18n ? window.i18n.t('engine.select', 'Select local build…') : 'Select local build…') + '</button>' +
      '<button type="button" class="btn btn-secondary btn-sm" data-role="cmd" data-cmd="showEngineGuide">' + esc(window.i18n ? window.i18n.t('engine.guide', 'Install guide') : 'Install guide') + '</button>' +
      '</div>';
  }

  // Wizard step 2: create first profile
  agentBrowser.wizardCreateProfile = function() {
    var dlg = document.getElementById('dlg-wizard');
    if (!dlg || !dlg.open || wizardCompletedStep !== 1 || wizardCreatePending || wizardCreateReceipt || state.wizardDirId) return;
    var generation = wizardGeneration;
    var epoch = wizardEpoch;
    var btn = document.querySelector('#dlg-wizard [data-cmd="wizardCreateProfile"]');
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
    statusEl.innerHTML = '<span style="color: var(--primary-text);">' + (window.i18n ? window.i18n.t('wizard.step2.in-progress', 'Creating profile…') : 'Creating profile…') + '</span>';
    wizardCreatePending = true;
    if (btn) btn.disabled = true;
    nameInput.disabled = true;
    Promise.resolve().then(function() { return api.browser.create({ name: name }); }).then(function(r) {
      if (r && r.dirId) {
        wizardCreateReceipt = { dirId: r.dirId, profileName: name };
        // Closing is not cancellation of a committed backend mutation. Save
        // the receipt without touching old DOM/state; Skip is different.
        if (epoch === wizardEpoch) saveWizardProgress(2, wizardCreateReceipt);
        if (generation !== wizardGeneration || !dlg.open) {
          if (epoch === wizardEpoch && dlg.open) showWizard();
          return;
        }
      }
      if (generation !== wizardGeneration || !dlg.open || epoch !== wizardEpoch) return;
      // Round 3 follow-up: a trial-exhausted first run opens the paywall
      // instead of a red ✗ the user cannot act on.
      if (r && typeof agentBrowser.interceptLicenseGate === "function") {
        try { if (agentBrowser.interceptLicenseGate(r)) return; } catch (gateErr) { /* fall through */ }
      }
      if (r && r.dirId) {
        state.wizardDirId = r.dirId;
        state.wizardProfileName = name;
        statusEl.innerHTML = '<span style="color: var(--success-text);">' + (window.i18n ? window.i18n.t('wizard.step2.done', 'Profile created') : 'Profile created') + '</span>';
        advanceWizardStep(2);
      } else {
        statusEl.innerHTML = '<span style="color: var(--danger-text);">' + esc((r && r.error) || (window.i18n ? window.i18n.t('wizard.step2.failed', 'Create failed') : 'Create failed')) + '</span>';
      }
    }).catch(function(e) {
      if (generation !== wizardGeneration || !dlg || !dlg.open) return;
      statusEl.innerHTML = '<span style="color: var(--danger-text);">' + esc(e.message || 'Create failed') + '</span>';
    }).finally(function() {
      wizardCreatePending = false;
      if (dlg.open && wizardCompletedStep === 1 && !state.wizardDirId && !wizardCreateReceipt) {
        if (btn) btn.disabled = false;
        nameInput.disabled = false;
      }
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
    if (!dirId) return;
    var now = Date.now();
    if (now - lastWizardCheckAt < 1500) return;
    lastWizardCheckAt = now;
    var generation = wizardGeneration;
    if (typeof agentBrowser.ensureExternalRiskConsent === "function") {
      agentBrowser.ensureExternalRiskConsent(dirId, function () { wizardRiskCheckAfterConsent(dirId, generation); });
      return;
    }
    wizardRiskCheckAfterConsent(dirId, generation);
  };

  function wizardRiskCurrent(dirId, generation) {
    var dlg = document.getElementById('dlg-wizard');
    return generation === wizardGeneration && dlg && dlg.open && state.wizardDirId === dirId;
  }

  function wizardRiskCheckAfterConsent(dirId, generation) {
    if (!wizardRiskCurrent(dirId, generation)) return;
    var btn = document.querySelector('.wizard-step[data-step="3"] button');
    if (btn) btn.disabled = true;
    api.browser.status(dirId).then(function (s) {
      if (!wizardRiskCurrent(dirId, generation)) return;
      if (s && s.running) { wizardOpenRiskCheck(dirId, generation); return; }
      agentBrowser.confirm(
        window.i18n ? window.i18n.t("risk.launch.msg", "This check needs a running browser. Start the profile now?") : "This check needs a running browser. Start the profile now?",
        function () { wizardOpenRiskCheck(dirId, generation, true); },
        { title: window.i18n ? window.i18n.t("risk.launch.title", "Start profile for check") : "Start profile for check" },
      );
      if (btn) btn.disabled = false;
    }).catch(function (e) {
      if (!wizardRiskCurrent(dirId, generation)) return;
      toast(e.message || "Error", "error");
      if (btn) btn.disabled = false;
    });
  }

  function wizardOpenRiskCheck(dirId, generation, allowLaunch) {
    if (!wizardRiskCurrent(dirId, generation)) return;
    var btn = document.querySelector('.wizard-step[data-step="3"] button');
    if (btn) btn.disabled = true;
    api.browser.openRiskCheck(dirId, { allowLaunch: !!allowLaunch }).then(function(r) {
      if (!wizardRiskCurrent(dirId, generation)) return;
      var statusEl = document.getElementById('wizard-step3-status') || (function() {
        var el = document.createElement('div');
        el.id = 'wizard-step3-status';
        el.className = 'wizard-status';
        el.style.cssText = 'font-size:11px;color:var(--text-muted);margin-top:6px;';
        document.querySelector('.wizard-step[data-step="3"] .btn-row').appendChild(el);
        return el;
      })();
      if (r && r.success) {
        statusEl.innerHTML = '<span style="color: var(--success-text);">' + (window.i18n ? window.i18n.t('wizard.step3.done', 'Launched & navigating to ping0.cc') : 'Launched & navigating to ping0.cc') + '</span>';
        scheduleProfilesRefresh();
        // Advance to the optional AI configuration step instead of auto-closing.
        advanceWizardStep(3);
      } else {
        statusEl.innerHTML = '<span style="color: var(--danger-text);">' + esc((r && r.error) || (window.i18n ? window.i18n.t('wizard.step3.failed', 'Launch failed') : 'Launch failed')) + '</span>';
        if (btn) btn.disabled = false;
      }
    }).catch(function(e) {
      if (!wizardRiskCurrent(dirId, generation)) return;
      var statusEl = document.getElementById('wizard-step3-status');
      if (statusEl) statusEl.innerHTML = '<span style="color: var(--danger-text);">' + esc(e.message || 'Error') + '</span>';
      if (btn) btn.disabled = false;
    });
  };

  function advanceWizardStep(completedStep) {
    var dlg = document.getElementById('dlg-wizard');
    if (!dlg) return;
    wizardCompletedStep = completedStep;
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
    wizardGeneration++;
    wizardEpoch++;
    document.getElementById('dlg-wizard').close();
    clearWizardProgress();
    // "Skip for now" only hides the wizard for the current session — it does
    // NOT persist dismissal, so the wizard can reappear on the next app launch
    // if the first-run conditions (no binary / no profiles) still hold.
    window.wizardDismissed = true;
  };

  agentBrowser.wizardNeverShow = function() {
    wizardGeneration++;
    wizardEpoch++;
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
    wizardGeneration++;
    wizardEpoch++;
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
