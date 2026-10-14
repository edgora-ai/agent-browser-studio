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

  // R185: localize a control's constraint message. The field's own label (via
  // the `for=` association fixed in R180) is what names it, so the message
  // reads "Port must be between 1 and 65535" rather than "this field…".
  function fieldErrorText(el) {
    var label = document.querySelector('label[for="' + (el.id || "").replace(/"/g, '\\"') + '"]');
    var name = (label && label.textContent.trim()) || el.getAttribute("aria-label") || el.name || el.placeholder || "";
    // A trailing "*" is the form's required marker (see acct.field.username).
    name = name.replace(/\s*\*+\s*$/, "").trim();
    var v = el.validity || {};
    if (v.valueMissing) return t("form.err.required", "{field} is required").replace("{field}", name);
    if (v.rangeUnderflow || v.rangeOverflow || v.stepMismatch) {
      var msg = t("form.err.range", "{field} must be between {min} and {max}")
        .replace("{field}", name).replace("{min}", el.min).replace("{max}", el.max);
      return el.min && el.max ? msg : t("form.err.number", "{field} must be a number").replace("{field}", name);
    }
    if (v.badInput || v.typeMismatch) return t("form.err.number", "{field} must be a number").replace("{field}", name);
    return el.validationMessage;
  }
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
  function closestEventTarget(event, selector) {
    var target = event && event.target;
    return target && typeof target.closest === 'function' ? target.closest(selector) : null;
  }
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
  // Keep overflow panels in their original details/card for action delegation,
  // but paint them in the native top layer, outside scroll/transform clipping.
  var openCardMenu = null;
  var cardMenuObserver = null;

  function cardMenuSummary(menu) { return menu.querySelector('summary'); }
  function cardMenuPanel(menu) { return menu.querySelector('.card-menu-list'); }
  function usableCardMenuSummary(summary) {
    if (!summary || !summary.isConnected || summary.closest('[hidden]') || !summary.getClientRects().length) return false;
    var style = window.getComputedStyle(summary);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
  }
  function cardMenuAvailable(menu) {
    return usableCardMenuSummary(cardMenuSummary(menu)) &&
      !menu.closest('.busy, [aria-busy="true"]');
  }
  function prepareCardMenu(menu) {
    var panel = cardMenuPanel(menu);
    if (panel && panel.getAttribute('popover') !== 'manual') panel.setAttribute('popover', 'manual');
    return panel;
  }

  // CSS-pixel positioning: constrain width before measuring wrapped height.
  // Kept separate from the details lifecycle so another custom panel can reuse
  // this arithmetic without taking on a new widget/keyboard protocol.
  function positionFloatingPanel(anchor, panel) {
    var viewport = window.visualViewport;
    var left = viewport ? viewport.offsetLeft : 0;
    var top = viewport ? viewport.offsetTop : 0;
    var width = Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth);
    var height = window.innerHeight;
    if (viewport) { width = Math.min(width, viewport.width); height = Math.min(height, viewport.height); }
    var edge = 8;
    var gap = 6;
    var availableWidth = Math.max(0, width - edge * 2);
    panel.style.minWidth = Math.min(200, availableWidth) + 'px';
    panel.style.maxWidth = availableWidth + 'px';
    panel.style.maxHeight = 'none';
    var trigger = anchor.getBoundingClientRect();
    var box = panel.getBoundingClientRect();
    var below = Math.max(0, top + height - edge - trigger.bottom - gap);
    var above = Math.max(0, trigger.top - gap - top - edge);
    var down = box.height <= below || (box.height > above && below >= above);
    var space = down ? below : above;
    var panelHeight = Math.min(box.height, space);
    panel.style.maxHeight = space + 'px';
    panel.style.left = Math.max(left + edge, Math.min(trigger.right - box.width, left + width - edge - box.width)) + 'px';
    panel.style.top = Math.max(top + edge, Math.min(down ? trigger.bottom + gap : trigger.top - gap - panelHeight,
      top + height - edge - panelHeight)) + 'px';
  }

  function dismissCardMenus() { closeCardMenus(document, false); }
  function cardMenuScroll(event) {
    var panel = openCardMenu && cardMenuPanel(openCardMenu);
    if (panel && panel.contains(event.target)) return; // Internal scrolling must keep actions reachable.
    dismissCardMenus();
  }
  function stopCardMenuWatch(menu) {
    if (openCardMenu !== menu) return;
    openCardMenu = null;
    if (cardMenuObserver) cardMenuObserver.disconnect();
    document.removeEventListener('scroll', cardMenuScroll, true);
    window.removeEventListener('scroll', dismissCardMenus);
    window.removeEventListener('resize', dismissCardMenus);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('scroll', dismissCardMenus);
      window.visualViewport.removeEventListener('resize', dismissCardMenus);
    }
  }
  function watchCardMenu(menu) {
    if (openCardMenu === menu) return;
    openCardMenu = menu;
    document.addEventListener('scroll', cardMenuScroll, true);
    window.addEventListener('scroll', dismissCardMenus);
    window.addEventListener('resize', dismissCardMenus);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('scroll', dismissCardMenus);
      window.visualViewport.addEventListener('resize', dismissCardMenus);
    }
    if (!cardMenuObserver) {
      cardMenuObserver = new MutationObserver(function() {
        var current = openCardMenu;
        if (current && (!current.open || !cardMenuAvailable(current))) closeCardMenu(current, false);
      });
    }
    cardMenuObserver.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['hidden', 'style', 'class', 'aria-busy', 'open']
    });
  }
  function hideCardMenuPanel(menu) {
    stopCardMenuWatch(menu);
    var panel = cardMenuPanel(menu);
    if (panel && panel.hasAttribute('popover') && panel.matches(':popover-open')) panel.hidePopover();
  }
  function closeCardMenu(menu, restoreFocus) {
    var panel = cardMenuPanel(menu);
    var summary = cardMenuSummary(menu);
    var returnFocus = restoreFocus !== false && panel && panel.contains(document.activeElement) && usableCardMenuSummary(summary);
    // A closed details can still retain :popover-open with a zero rect. Hide
    // the native state first, not just menus selected by the open attribute.
    hideCardMenuPanel(menu);
    menu.open = false;
    if (returnFocus) summary.focus({ preventScroll: true });
  }
  function closeCardMenus(scope, restoreFocus) {
    scope = scope || document;
    var menus = Array.prototype.slice.call(scope.querySelectorAll('.card-menu'));
    if (scope.matches && scope.matches('.card-menu')) menus.unshift(scope);
    // Detached owners are no longer found by document.querySelectorAll.
    if (openCardMenu && (scope === document || scope.contains(openCardMenu)) && menus.indexOf(openCardMenu) === -1) menus.push(openCardMenu);
    menus.forEach(function(menu) { closeCardMenu(menu, restoreFocus); });
  }
  function syncCardMenu(menu) {
    var panel = prepareCardMenu(menu);
    if (!menu.open || !panel || !cardMenuAvailable(menu)) { closeCardMenu(menu, false); return; }
    if (openCardMenu && openCardMenu !== menu) closeCardMenu(openCardMenu, true);
    if (!panel.matches(':popover-open')) {
      panel.showPopover();
      panel.scrollTop = 0;
    }
    positionFloatingPanel(cardMenuSummary(menu), panel);
    watchCardMenu(menu);
  }
  function initCardMenus() {
    document.addEventListener('click', function(event) {
      var summary = closestEventTarget(event, '.card-menu > summary');
      if (summary) {
        var menu = summary.closest('.card-menu');
        prepareCardMenu(menu); // Lazy preparation covers dynamically rebuilt cards.
        if (!cardMenuAvailable(menu)) {
          event.preventDefault();
          closeCardMenu(menu, false);
        } else if (menu.open) {
          // Hide now, but let the native summary default clear details.open.
          hideCardMenuPanel(menu);
        } else {
          closeCardMenus(document, false);
        }
      } else if (openCardMenu && !openCardMenu.contains(event.target)) {
        dismissCardMenus(); // An outside click must never steal its new focus.
      }
    }, true);
    document.addEventListener('toggle', function(event) {
      var target = event.target;
      if (!target || !target.matches) return;
      if (target.matches('.card-menu')) {
        // toggle tasks coalesce: use the actual state, never a stale newState.
        syncCardMenu(target);
      } else if (target.matches('.card-menu-list[popover]') && !target.matches(':popover-open')) {
        var menu = target.closest('.card-menu');
        if (menu && menu === openCardMenu && menu.open) closeCardMenu(menu, false);
      }
    }, true);
    document.addEventListener('keydown', function(event) {
      if (event.key !== 'Escape' || !openCardMenu) return;
      closeCardMenus();
      event.preventDefault();
      event.stopPropagation();
    }, true);
    Array.prototype.forEach.call(document.querySelectorAll('.card-menu'), function(menu) {
      prepareCardMenu(menu);
      if (menu.open) syncCardMenu(menu);
    });
  }
  agentBrowser.closeCardMenus = closeCardMenus;

  /**
   * Give a dialog a visible way out.
   *
   * Esc and the Cancel buttons already closed dialogs, but there was no visible
   * close affordance anywhere — ~30 dialogs are authored by hand in
   * index.html, so adding one per dialog would drift immediately. Injecting it
   * from the single place every dialog must pass through (showModal) keeps the
   * affordance identical everywhere.
   */
  function ensureDialogClose(dlg) {
    if (!dlg || dlg.querySelector(':scope > .dialog-close')) return;
    // Dialogs that already ship their own header control (or ask for none)
    // opt out with data-no-close.
    if (dlg.hasAttribute('data-no-close')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dialog-close';
    var label = (window.i18n && window.i18n.t('common.close', 'Close')) || 'Close';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
    btn.innerHTML = helpers.icon ? helpers.icon('close', 15) : '\u00d7';
    btn.addEventListener('click', function() { dlg.close(); });
    // Anchor to the dialog itself, ahead of any <form> wrapper.
    dlg.insertBefore(btn, dlg.firstChild);
  }

  // Markdown code-block cards (renderChatMarkdown wraps every fenced block)
  // carry a copy affordance in their header. Handled ahead of the generic
  // data-cmd dispatch because the text lives in the sibling <pre>, not in an
  // attribute — copying needs the DOM context of the clicked button.
  function copyCodeBlock(btn) {
    var block = btn.closest ? btn.closest('.md-codeblock') : null;
    var codeEl = block && block.querySelector ? block.querySelector('pre code') : null;
    var text = codeEl ? String(codeEl.textContent || '') : '';
    var copyLabel = t('agent.action.copy', 'Copy');
    var doneLabel = t('agent.action.copied', 'Copied');
    function paint(iconName, label) {
      btn.innerHTML = (helpers.icon ? helpers.icon(iconName, 12) : '') + '<span>' + esc(label) + '</span>';
    }
    function markCopied() {
      paint('check', doneLabel);
      btn.classList.add('is-copied');
      setTimeout(function () {
        btn.classList.remove('is-copied');
        paint('copy', copyLabel);
      }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(markCopied, function () {
        toast(t('agent.action.copy-failed', 'Copy failed'), 'error');
      });
    } else {
      toast(t('agent.action.copy-failed', 'Copy failed'), 'error');
    }
  }

  function initEventDelegation() {
    initCardMenus();
    document.addEventListener('click', function(e) {
      var codeBtn = closestEventTarget(e,'[data-code-copy]');
      if (codeBtn) {
        copyCodeBlock(codeBtn);
        e.preventDefault();
        return;
      }
      var el = closestEventTarget(e,'[data-role="cmd"]');
      if (!el) return;
      var cmd = el.getAttribute('data-cmd');
      if (!cmd) return;
      // Close any open overflow menu after an item is picked (UE-01 / UE-05).
      closeCardMenus();
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
      } else {
        // P2 (#109): a typo'd data-cmd used to dead-end with zero feedback.
        try { console.warn("[cmd] unknown command: " + cmd); } catch (warnErr) { /* logging best-effort */ }
      }
    });
    // P2 (#109): warn on unresolvable handlers so future typos surface in
    // devtools instead of silently doing nothing.
    function warnUnknown(kind, cmd) {
      try { console.warn("[" + kind + "] unknown handler: " + cmd); } catch (warnErr) { /* logging best-effort */ }
    }
    document.addEventListener('input', function(e) {
      var el = closestEventTarget(e,'[data-role="input"]');
      if (!el) return;
      var cmd = el.getAttribute('data-input-cmd');
      if (cmd && typeof agentBrowser[cmd] === 'function') agentBrowser[cmd]();
      else if (cmd) warnUnknown('input', cmd);
    });
    document.addEventListener('change', function(e) {
      var el = closestEventTarget(e,'[data-role="change"]');
      if (!el) return;
      var cmd = el.getAttribute('data-change-cmd');
      if (cmd && typeof agentBrowser[cmd] === 'function') agentBrowser[cmd]();
      else if (cmd) warnUnknown('change', cmd);
    });
    // R185: Chromium's constraint messages follow the OS locale, not the UI
    // language — with a Chinese macOS and an English UI, submitting a bad port
    // said "值必须小于或等于 65535。". Replace them with our own localized
    // text. `invalid` fires per control before submit; we set a custom message
    // so the bubble and any programmatic read both carry the translated text.
    document.addEventListener('invalid', function(e) {
      var el = e.target;
      if (!el || !el.validity || !el.setCustomValidity) return;
      if (!el.validity.customError) el.setCustomValidity(fieldErrorText(el));
    }, true);
    // Clearing is required: a custom message makes the field permanently
    // invalid, so it must be reset the moment the value becomes acceptable.
    document.addEventListener('input', function(e) {
      var el = e.target;
      if (el && el.setCustomValidity && el.validity && el.validity.customError) el.setCustomValidity('');
    }, true);
    document.addEventListener('change', function(e) {
      var el = e.target;
      if (el && el.setCustomValidity && el.validity && el.validity.customError) el.setCustomValidity('');
    }, true);
    document.addEventListener('submit', function(e) {
      var el = closestEventTarget(e,'[data-role="submit"]');
      if (!el) return;
      e.preventDefault();
      var cmd = el.getAttribute('data-submit-cmd');
      if (cmd && typeof agentBrowser[cmd] === 'function') agentBrowser[cmd]();
      else if (cmd) warnUnknown('submit', cmd);
    });
    document.addEventListener('keydown', function(e) {
      var el = closestEventTarget(e,'[data-role="keydown"]');
      if (!el) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); agentBrowser.agentSend(); }
    });
    // R181: [data-role="cmd"] is wired for clicks only, and several of them
    // are not <button> — the theme switch is a <div role="switch">, the nav
    // items are <li role="tab">, the conversation rows are <div role="button">.
    // A real <button> activates on Enter/Space natively; these do not, so they
    // took focus and then ignored the key. Delegate the same activation here
    // rather than hand-wiring each one.
    document.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      var el = closestEventTarget(e,'[data-role="cmd"]');
      if (!el) return;
      if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'SUMMARY') return; // native activation
      if (el.getAttribute('role') === 'tab') return; // nav tabs have their own handler
      e.preventDefault();
      el.click();
    });
    document.addEventListener('scroll', function(e) {
      var el = closestEventTarget(e,'[data-role="scroll"]');
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
        closeCardMenus(); // Restore the summary before capturing the dialog's return target.
        if (!this._returnFocus && document.activeElement instanceof HTMLElement) {
          this._returnFocus = document.activeElement;
        }
        ensureDialogClose(this);
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

  // A renderer reload can evaluate this module after DOMContentLoaded has
  // already fired. Bind immediately in that case so the composer and other
  // delegated controls do not become inert after a reload.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEventDelegation);
  } else {
    initEventDelegation();
  }
})();
