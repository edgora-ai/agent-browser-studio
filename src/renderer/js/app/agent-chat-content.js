(function() {
  "use strict";

  // Chat content affordances: message-level copy (hover foot) and the
  // auto-growing composer. Split from agent-chat.js, which is at the module
  // size guard threshold; everything here binds to static markup at load and
  // survives message re-renders via container-level delegation.

  var agentBrowser = window.agentBrowser;
  var helpers = agentBrowser.helpers;
  var toast = helpers.toast;
  var icon = helpers.icon;

  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }

  // ── Message copy ──
  // Foot buttons carry data-msg-copy="<render index>"; the index addresses
  // state.agentMessages, which agentRenderMessages always mirrors.
  function bindMessageCopy() {
    var container = document.getElementById("agent-chat-messages");
    if (!container || typeof container.addEventListener !== "function") return;
    container.addEventListener("click", function(e) {
      var target = e.target;
      var btn = target && typeof target.closest === "function" ? target.closest("[data-msg-copy]") : null;
      if (!btn) return;
      e.preventDefault();
      var idx = Number(btn.getAttribute("data-msg-copy"));
      var messages = agentBrowser.state.agentMessages || [];
      var message = messages[idx];
      if (!message) return;
      function markCopied() {
        btn.innerHTML = icon("check", 12);
        btn.classList.add("is-copied");
        setTimeout(function() {
          btn.classList.remove("is-copied");
          btn.innerHTML = icon("copy", 12);
        }, 1200);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(String(message.content || "")).then(markCopied, function() {
          toast(t("agent.action.copy-failed", "Copy failed"), "error");
        });
      } else {
        toast(t("agent.action.copy-failed", "Copy failed"), "error");
      }
    });
  }

  // ── Composer auto-grow ──
  // The textarea starts at one line and grows with content up to a cap,
  // instead of the fixed 38px strip. agent-chat.js calls the exposed resize
  // hook after programmatic value changes (send clears, draft restores).
  var MAX_INPUT_HEIGHT = 160;

  function bindComposer() {
    var input = document.getElementById("agent-chat-input");
    if (!input || typeof input.addEventListener !== "function") return;
    function resize() {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, MAX_INPUT_HEIGHT) + "px";
    }
    input.addEventListener("input", resize);
    agentBrowser.chatComposerResize = resize;
    resize();
  }

  bindMessageCopy();
  bindComposer();
})();
