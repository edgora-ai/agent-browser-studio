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

  // Hover foot under each message: timestamp + copy-raw action, the pattern
  // dedicated chat tools (WorkBuddy) use instead of always-on chrome. Keep the
  // render index and delegated copy lookup together; neither writes history.
  function msgTime(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  agentBrowser.chatMessageFootHtml = function(message, idx, isUser) {
    var time = message.timestamp ? msgTime(message.timestamp) : "";
    var hasContent = !!String(message.content || "").trim();
    if (!time && !hasContent) return "";
    var copyLabel = t("agent.action.copy", "Copy");
    return '<div class="chat-msg-foot' + (isUser ? " is-user" : "") + '">' +
      (time ? '<span class="chat-msg-time num">' + helpers.esc(time) + "</span>" : "") +
      (hasContent ? '<button type="button" class="chat-msg-copy" data-msg-copy="' + idx + '" title="' + helpers.escAttr(copyLabel) + '" aria-label="' + helpers.escAttr(copyLabel) + '">' + icon("copy", 12) + "</button>" : "") +
      "</div>";
  };

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

  // Titles stay raw in the session cache. The chat's single display function
  // localizes only a consistent positive default, never authored/unknown text.
  // No selection (or an unread session) is chrome, not an existing empty title.
  function renderChatTitle() {
    var controller = agentBrowser.agentChatController;
    var session = controller && controller.getSession(agentBrowser.state.agentActiveConvId);
    var title = document.getElementById("agent-chat-title");
    if (title) title.textContent = agentBrowser.chatTitleDisplay(session && (session.loaded || session.titleReady) ? session : null);
  }
  agentBrowser.chatRenderTitle = renderChatTitle;

  var renamedTitles = Object.create(null);
  function copyTitle(target, source) {
    target.title = source.title;
    if (Object.prototype.hasOwnProperty.call(source, "titleKind")) target.titleKind = source.titleKind;
    else delete target.titleKind;
  }
  // A list started before a committed rename can return the obsolete marker.
  // Overlay only newer committed title metadata for that exact ID; later fresh
  // reads remain authoritative. This does not reorder rows or infer provenance.
  agentBrowser.chatAdoptListTitles = function(list, observedRevision) {
    list.forEach(function(item) {
      var committed = renamedTitles[item.id];
      if (committed && committed.revision > observedRevision) copyTitle(item, committed);
    });
    Object.keys(renamedTitles).forEach(function(id) {
      if (renamedTitles[id].revision <= observedRevision) delete renamedTitles[id];
    });
    return list;
  };

  // Consume the committed response, including a same-text default→literal
  // rename. Never guess provenance from the requested title or another record.
  // This programmatic entry needs no history reload and adds no rename chrome.
  agentBrowser.agentRenameConv = function(conversationId, title) {
    return agentBrowser.R.agent.conversations.rename(conversationId, title).then(function(conv) {
      if (!conv || conv.id !== conversationId) return conv;
      var revision = (agentBrowser.chatTitleRevision || 0) + 1;
      agentBrowser.chatTitleRevision = revision;
      var committed = { revision: revision };
      copyTitle(committed, conv);
      renamedTitles[conversationId] = committed;
      var controller = agentBrowser.agentChatController;
      var session = controller && controller.getSession(conversationId);
      if (session) {
        copyTitle(session, conv);
        // Fence title adoption only: an older read must still hydrate messages
        // and complete loading without undoing this newer committed metadata.
        session.titleRevision = revision;
        session.titleReady = true;
      }
      (agentBrowser.state.agentConvList || []).forEach(function(item) {
        if (item.id !== conversationId) return;
        copyTitle(item, conv);
      });
      renderChatTitle();
      agentBrowser.agentRenderConvs();
      return conv;
    });
  };

  // Repaint from raw records with the current locale, including an active
  // filter and inactive caches. Do not select/load history, reset drafts or
  // issue any conversation API calls just to change the display language.
  document.addEventListener("agent-browser-language-change", function() {
    renderChatTitle();
    agentBrowser.agentRenderConvs();
  });
  renderChatTitle();

  bindMessageCopy();
  bindComposer();
})();
