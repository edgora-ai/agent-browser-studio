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
  function navTabs() { return Array.from(document.querySelectorAll('.nav-item[role="tab"]')); }
  function focusNavTab(tab) {
    var tabs = navTabs();
    var idx = tabs.findIndex(function(t) { return t.dataset.tab === tab; });
    if (idx >= 0) tabs[idx].focus();
  }
  document.addEventListener('keydown', function(e) {
    var active = document.activeElement;
    if (!active || !active.classList.contains('nav-item') || active.getAttribute('role') !== 'tab') return;
    var tabs = navTabs();
    var idx = tabs.indexOf(active);
    if (idx === -1) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      var tab = active.dataset.tab;
      if (tab) { agentBrowser.switchTab(tab); focusNavTab(tab); }
      return;
    }
    var next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next !== -1) {
      e.preventDefault();
      tabs[next].focus();
      var tab2 = tabs[next].dataset.tab;
      if (tab2) agentBrowser.switchTab(tab2);
    }
  });
  function initEventDelegation() {
    document.addEventListener('click', function(e) {
      var el = e.target.closest('[data-role="cmd"]');
      if (!el) return;
      var cmd = el.getAttribute('data-cmd');
      if (!cmd) return;
      // Close any open overflow menu after an item is picked (UE-01 / UE-05).
      try {
        var openMenus = document.querySelectorAll('.card-menu[open]');
        Array.prototype.forEach.call(openMenus, function (m) { m.removeAttribute('open'); });
      } catch (menuErr) { /* menus are best effort */ }
      if (cmd === 'close-dialog') {
        var targetId = el.getAttribute('data-cmd-target');
        var d = null;
        if (targetId && targetId !== 'undefined' && targetId !== '') {
          d = document.getElementById(targetId);
        }
        // Fallback: close the nearest ancestor <dialog>
        if (!d || !d.close) {
          var node = el;
          while (node && node.tagName !== 'DIALOG') node = node.parentElement;
          if (node && node.close) d = node;
        }
        if (d && d.close) d.close();
        e.preventDefault();
        return;
      }
      if (cmd === 'random-seed') {
        var seedTarget = el.getAttribute('data-cmd-target');
        if (seedTarget) { var inp = document.getElementById(seedTarget); if (inp) inp.value = Math.floor(Math.random()*90000)+10000; }
        e.preventDefault();
        return;
      }
      if (cmd === 'ext-open-repo') {
        agentBrowser.switchTab('extensions');
        var dlg = document.getElementById('dlg-extensions');
        if (dlg && dlg.close) dlg.close();
        e.preventDefault();
        return;
      }
      if (typeof agentBrowser[cmd] === 'function') {
        var arg = el.getAttribute('data-cmd-arg');
        var a = el.getAttribute('data-cmd-a');
        var b = el.getAttribute('data-cmd-b');
        if (a !== null && b !== null) { agentBrowser[cmd](a, b); }
        else if (arg !== null && arg !== '' && arg !== 'undefined') { agentBrowser[cmd](arg); }
        else if (cmd === 'switchTab' && el.dataset.tab) { agentBrowser[cmd](el.dataset.tab); }
        else if (cmd === 'switchAgentSub' && el.dataset.sub) { agentBrowser[cmd](el.dataset.sub); }
        else { agentBrowser[cmd](); }
        e.preventDefault();
      }
    });
    document.addEventListener('input', function(e) {
      var el = e.target.closest('[data-role="input"]');
      if (!el) return;
      var cmd = el.getAttribute('data-input-cmd');
      if (cmd && typeof agentBrowser[cmd] === 'function') agentBrowser[cmd]();
    });
    document.addEventListener('change', function(e) {
      var el = e.target.closest('[data-role="change"]');
      if (!el) return;
      var cmd = el.getAttribute('data-change-cmd');
      if (cmd && typeof agentBrowser[cmd] === 'function') agentBrowser[cmd]();
    });
    document.addEventListener('submit', function(e) {
      var el = e.target.closest('[data-role="submit"]');
      if (!el) return;
      e.preventDefault();
      var cmd = el.getAttribute('data-submit-cmd');
      if (cmd && typeof agentBrowser[cmd] === 'function') agentBrowser[cmd]();
    });
    document.addEventListener('keydown', function(e) {
      var el = e.target.closest('[data-role="keydown"]');
      if (!el) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); agentBrowser.agentSend(); }
    });
    document.addEventListener('scroll', function(e) {
      var el = e.target.closest('[data-role="scroll"]');
      if (!el) return;
      var cmd = el.getAttribute('data-scroll-cmd');
      if (cmd && typeof agentBrowser[cmd] === 'function') agentBrowser[cmd]();
    }, true);
    // Return focus to the trigger when any dialog closes.
    document.addEventListener('close', function(e) {
      var dlg = e.target;
      if (!dlg || dlg.tagName !== 'DIALOG') return;
      var trigger = dlg._returnFocus;
      if (trigger && typeof trigger.focus === 'function') {
        try { trigger.focus(); } catch (_) {}
      }
      dlg._returnFocus = null;
    }, true);
    // Capture trigger for showModal() callers that don't set it explicitly.
    (function() {
      var origShowModal = HTMLDialogElement.prototype.showModal;
      HTMLDialogElement.prototype.showModal = function() {
        if (!this._returnFocus && document.activeElement instanceof HTMLElement) {
          this._returnFocus = document.activeElement;
        }
        // Auto-focus first focusable input inside the dialog.
        var self = this;
        var ret = origShowModal.call(this);
        setTimeout(function() {
          var first = self.querySelector('input:not([type="hidden"]), select, textarea, button[type="submit"]');
          if (first && typeof first.focus === 'function') {
            try { first.focus(); } catch (_) {}
            if (first.select) try { first.select(); } catch (_) {}
          }
        }, 0);
        return ret;
      };
    })();
  }

  document.addEventListener('DOMContentLoaded', function() { initEventDelegation(); });
})();
