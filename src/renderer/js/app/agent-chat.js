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
  var icon = helpers.icon;
  var renderChatMarkdown = helpers.renderChatMarkdown;

  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }
  function byId(id) { return document.getElementById(id); }
  function newId(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return prefix + "_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  function readCall(key, fn) {
    if (agentBrowser.ipc && typeof agentBrowser.ipc.call === "function") {
      return agentBrowser.ipc.call(key, fn, { kind: "list" });
    }
    return Promise.resolve().then(fn);
  }

  // Each conversation owns its message array and current request. The renderer's
  // state.agentMessages remains a compatibility view of only the selected
  // conversation; stream handlers never write through that global pointer.
  var sessions = Object.create(null);
  var sessionsByStream = Object.create(null);
  var sessionsByRun = Object.create(null);
  var viewIntent = 0;
  var environmentLoadSeq = 0;
  var environmentStartSeq = 0;
  var environmentProfiles = [];
  var _autoCreateConvTried = false;

  function ensureSession(conversationId) {
    if (!conversationId) return null;
    if (!sessions[conversationId]) {
      sessions[conversationId] = {
        conversationId: conversationId,
        title: "",
        loaded: false,
        messagesRef: [],
        draft: "",
        selectedProfileDirId: "",
        run: null,
        lastRun: null,
        renderPending: false,
      };
    }
    return sessions[conversationId];
  }

  function activeSession() {
    return state.agentActiveConvId ? ensureSession(state.agentActiveConvId) : null;
  }

  function isActiveSession(session) {
    return !!session && state.agentActiveConvId === session.conversationId;
  }

  function captureActiveDraft() {
    var session = activeSession();
    var input = byId("agent-chat-input");
    if (session && input && !session.run) session.draft = input.value || "";
  }

  function setSendIcon(btn, name) {
    if (!btn) return;
    var markup = icon(name, 16);
    if (markup) btn.innerHTML = markup;
  }

  function convTitle(conv) {
    var title = conv && conv.title;
    if (!title || title === "New Chat") return t("agent.chat-title", "New Chat");
    return title;
  }

  function emptyChatHtml(iconName, titleKey, titleFb, hintKey, hintFb, withSuggestions) {
    var h = '<div class="chat-empty"><div class="chat-empty-icon">' + icon(iconName, 40) + "</div>" +
      '<div class="chat-empty-title">' + esc(t(titleKey, titleFb)) + "</div>" +
      '<div class="chat-empty-hint' + (withSuggestions ? " is-wide" : "") + '">' + esc(t(hintKey, hintFb)) + "</div>";
    if (withSuggestions) {
      h += '<div class="chat-suggestions">';
      for (var i = 1; i <= 3; i++) {
        var prompt = t("agent.suggest." + i, "");
        if (!prompt) continue;
        h += '<button type="button" class="chat-suggestion" data-role="cmd" data-cmd="agentUseSuggestion" data-cmd-arg="' + escAttr(prompt) + '">' + icon("sparkle", 14) + "<span>" + esc(prompt) + "</span></button>";
      }
      h += "</div>";
    }
    return h + "</div>";
  }

  function welcomeHtml() {
    return emptyChatHtml("robot", "agent.welcome.title", "Hi, I'm your browser agent", "agent.welcome.sub", "Ask me to drive the browser, check proxies, or run an automation.", true);
  }

  function noConvHtml() {
    return emptyChatHtml("chat", "agent.no-conv-title", "No conversation selected", "agent.no-conv-hint", "Select one from the sidebar or create a new one", false);
  }

  function mergeMessages(serverMessages, localMessages, liveRun) {
    var merged = (serverMessages || []).map(function(message) { return Object.assign({}, message); });
    (localMessages || []).forEach(function(local) {
      if (!local || !local._local) return;
      var match = -1;
      for (var i = 0; i < merged.length; i++) {
        var saved = merged[i];
        if (saved.role !== local.role) continue;
        var runConflicts = local.runId && saved.runId && local.runId !== saved.runId;
        if (local.requestId && saved.requestId === local.requestId && !runConflicts) { match = i; break; }
        if (!local.requestId && local.runId && saved.runId === local.runId) { match = i; break; }
      }
      if (match === -1) {
        merged.push(local);
      } else if (liveRun && local.role === "assistant" && local.requestId === liveRun.requestId) {
        // The store can contain the user turn before the live assistant reply.
        // Preserve the longer in-memory stream until the terminal write lands.
        var fromStore = merged[match];
        merged[match] = Object.assign({}, fromStore, local, {
          content: String(local.content || "").length >= String(fromStore.content || "").length ? local.content : fromStore.content,
        });
      } else if (local.role === "assistant" && local.endReason) {
        // Conversation messages intentionally omit detailed run steps. A
        // terminal refresh must not erase real run-step events observed for this
        // exact request. Persisted content/endReason remain authoritative; only
        // fill the omitted trace from the identity-matched local message.
        var terminalFromStore = merged[match];
        var terminal = Object.assign({}, local, terminalFromStore);
        if ((!Array.isArray(terminalFromStore.steps) || !terminalFromStore.steps.length) &&
          Array.isArray(local.steps) && local.steps.length) {
          terminal.steps = local.steps.map(function(step) { return Object.assign({}, step); });
        }
        merged[match] = terminal;
      }
    });
    return merged;
  }

  function adoptConversation(session, conv) {
    session.title = convTitle(conv);
    session.messagesRef = mergeMessages(conv.messages || [], session.messagesRef, session.run);
    session.loaded = true;
  }

  function renderComposerHint() {
    var hint = document.querySelector("#agent-view-chat .agent-hint");
    if (hint) hint.textContent = t("agent.hint.send", "Enter to send · Shift+Enter for newline");
  }

  function displaySession(session) {
    if (!session) return;
    state.agentActiveConvId = session.conversationId;
    state.agentMessages = session.messagesRef;
    var title = byId("agent-chat-title");
    if (title) title.textContent = session.title || t("agent.chat-title", "New Chat");
    var input = byId("agent-chat-input");
    if (input && !session.run) input.value = session.draft || "";
    renderComposerHint();
    agentBrowser.agentRenderMessages();
    renderRunUi(session);
    renderEnvironmentUi(session);
  }

  function findMessage(session, role, requestId, runId) {
    for (var i = session.messagesRef.length - 1; i >= 0; i--) {
      var message = session.messagesRef[i];
      if (message.role !== role) continue;
      if (requestId && message.requestId === requestId) return message;
      if (runId && message.runId === runId) return message;
    }
    return null;
  }

  function ensureAssistantMessage(session, run) {
    var message = findMessage(session, "assistant", run.requestId, run.runId);
    if (!message) {
      message = {
        role: "assistant",
        content: run.reply || "",
        timestamp: Date.now(),
        requestId: run.requestId,
        runId: run.runId,
        toolCalls: run.toolCalls || [],
        steps: run.steps || [],
        _local: true,
      };
      session.messagesRef.push(message);
    }
    run.assistantMessage = message;
    return message;
  }

  function normalizeStep(step) {
    return {
      id: step.id,
      tool: step.tool || step.name || "tool",
      ok: step.ok === true,
      error: step.error,
      durationMs: typeof step.durationMs === "number" ? step.durationMs : 0,
      timestamp: typeof step.timestamp === "number" ? step.timestamp : Date.now(),
      pending: false,
    };
  }

  function registerRun(session, run) {
    if (run.streamId) sessionsByStream[run.streamId] = session;
    if (run.runId) sessionsByRun[run.runId] = session;
  }

  function unregisterRun(session, run) {
    if (run.streamId && sessionsByStream[run.streamId] === session) delete sessionsByStream[run.streamId];
    if (run.runId && sessionsByRun[run.runId] === session) delete sessionsByRun[run.runId];
  }

  function hydrateSnapshot(session, snapshot) {
    if (!snapshot || snapshot.conversationId !== session.conversationId) return;
    if (session.lastRun && session.lastRun.streamId === snapshot.streamId && session.lastRun.terminal) return;
    if (session.run && session.run.streamId !== snapshot.streamId) return;
    var existing = session.run;
    var run = existing && existing.streamId === snapshot.streamId ? existing : {
      conversationId: session.conversationId,
      requestId: snapshot.streamId,
      streamId: snapshot.streamId,
      submitted: true,
      terminal: false,
      cancelRequested: snapshot.state === "cancelling",
    };
    run.runId = snapshot.runId;
    run.profileDirId = snapshot.profileDirId || "";
    run.profileName = snapshot.profileName || "";
    run.state = snapshot.state;
    run.startedAt = snapshot.startedAt || Date.now();
    run.reply = String(snapshot.reply || "");
    run.toolCalls = (snapshot.toolCalls || []).map(function(call) { return { name: call.name, redacted: true }; });
    run.steps = (snapshot.steps || []).map(normalizeStep);
    run.currentTool = snapshot.currentTool || "";
    if (run.currentTool) {
      var hasPending = run.steps.some(function(step) { return step.pending; });
      if (!hasPending) run.steps.push({ tool: run.currentTool, pending: true, timestamp: Date.now() });
    }

    var linkedUser = findMessage(session, "user", null, run.runId);
    if (linkedUser && linkedUser.requestId) run.requestId = linkedUser.requestId;
    var assistant = ensureAssistantMessage(session, run);
    assistant.content = run.reply;
    assistant.runId = run.runId;
    assistant.requestId = run.requestId;
    assistant.toolCalls = run.toolCalls;
    assistant.steps = run.steps;
    if (linkedUser) linkedUser.requestId = linkedUser.requestId || run.requestId;

    session.run = run;
    session.lastRun = null;
    if (run.profileDirId) session.selectedProfileDirId = run.profileDirId;
    registerRun(session, run);
  }

  function restoreActiveRun(session) {
    if (!R.agent.activeRun) return Promise.resolve(null);
    return readCall("agent.activeRun:" + session.conversationId, function() {
      return R.agent.activeRun(session.conversationId);
    }).then(function(snapshot) {
      if (snapshot) hydrateSnapshot(session, snapshot);
      if (isActiveSession(session)) displaySession(session);
      return snapshot;
    }).catch(function(error) {
      // Conversation history is still usable if the recovery probe fails. This
      // is a read failure, not proof that no run exists, so keep local state.
      console.warn("[agent] active run recovery failed:", error);
      return null;
    });
  }

  // ── Agent sub-views ──
  agentBrowser.switchAgentSub = function(view) {
    var chat = byId("agent-view-chat");
    var config = byId("agent-view-config");
    var accounts = byId("agent-view-accounts");
    var skills = byId("agent-view-skills");
    var adapters = byId("agent-view-adapters");
    if (chat) chat.style.display = view === "chat" ? "flex" : "none";
    if (config) config.style.display = view === "config" ? "block" : "none";
    if (accounts) accounts.style.display = view === "accounts" ? "block" : "none";
    if (skills) skills.style.display = view === "skills" ? "block" : "none";
    if (adapters) adapters.style.display = view === "adapters" ? "block" : "none";
    if (view === "accounts") agentBrowser.agentLoadAccounts();
    if (view === "skills") agentBrowser.agentLoadSkills();
    if (view === "adapters") agentBrowser.agentLoadAdapters();
    if (view === "config") agentBrowser.agentLoadConfig();
    if (view === "chat") {
      agentBrowser.agentLoadConversations();
      agentBrowser.agentRefreshEnvironments();
      var session = activeSession();
      if (session) restoreActiveRun(session);
    }
  };

  // ── Conversation list ──
  agentBrowser.agentLoadConversations = function() {
    return R.agent.conversations.list().then(function(list) {
      state.agentConvList = list || [];
      agentBrowser.agentRenderConvs();
      return state.agentConvList;
    }).catch(function(error) {
      console.error("Load conversations:", error);
      var listEl = byId("agent-conv-list");
      if (listEl) {
        listEl.innerHTML = '<div class="agent-inline-error">' + esc(t("agent.load-failed", "Failed to load conversations")) + '<br><button class="btn btn-xs btn-primary" data-role="cmd" data-cmd="agentLoadConversations">' + esc(t("agent.retry", "Retry")) + "</button></div>";
      }
      return [];
    });
  };

  agentBrowser.agentFilterConvs = function() { agentBrowser.agentRenderConvs(); };

  agentBrowser.agentRenderConvs = function() {
    var el = byId("agent-conv-list");
    if (!el) return;
    var list = state.agentConvList || [];
    if (list.length === 0) {
      el.innerHTML = '<div class="agent-conv-empty">' + esc(t("agent.no-chats", "No chats yet")) + "</div>";
      if (!_autoCreateConvTried) {
        _autoCreateConvTried = true;
        agentBrowser.agentNewConv();
      }
      return;
    }
    _autoCreateConvTried = false;
    var searchEl = byId("agent-conv-search");
    var query = searchEl && searchEl.value ? searchEl.value.trim().toLowerCase() : "";
    var shown = query ? list.filter(function(conv) { return convTitle(conv).toLowerCase().indexOf(query) !== -1; }) : list;
    if (shown.length === 0) {
      el.innerHTML = '<div class="agent-conv-empty">' + esc(t("agent.conv.no-match", "No matching chats")) + "</div>";
      return;
    }
    var html = "";
    shown.forEach(function(conv) {
      var isActive = conv.id === state.agentActiveConvId;
      var rel = helpers.relTime ? helpers.relTime(conv.updatedAt || conv.createdAt) : "";
      var meta = (rel ? '<span class="num">' + esc(rel) + "</span> · " : "") + (conv.messageCount || 0) + " " + esc(t("agent.msgs", "msgs"));
      var deleteLabel = t("agent.conv.delete", "Delete chat");
      html += '<div data-role="cmd" data-cmd="agentSelectConv" data-cmd-arg="' + escAttr(conv.id) + '" class="agent-conv-item' + (isActive ? " is-active" : "") + '" role="button" tabindex="0" aria-current="' + (isActive ? "true" : "false") + '">';
      html += '<div class="agent-conv-title">' + esc(convTitle(conv)) + "</div>";
      html += '<div class="agent-conv-meta hint-line">' + meta + "</div>";
      html += '<button type="button" class="btn-icon btn btn-quiet btn-xs agent-conv-del" data-role="cmd" data-cmd="agentDeleteConvItem" data-cmd-arg="' + escAttr(conv.id) + '" title="' + escAttr(deleteLabel) + '" aria-label="' + escAttr(deleteLabel) + '">' + icon("trash", 13) + "</button>";
      html += "</div>";
    });
    el.innerHTML = html;
    if (!state.agentActiveConvId && list.length > 0) agentBrowser.agentSelectConv(list[0].id);
  };

  function activateNewConversation(conv, intent) {
    var session = ensureSession(conv.id);
    session.title = convTitle(conv);
    session.loaded = true;
    session.messagesRef = conv.messages || [];
    if (intent !== viewIntent) return session;
    displaySession(session);
    var status = byId("agent-chat-status");
    if (status) status.textContent = "";
    return session;
  }

  agentBrowser.agentNewConv = function() {
    captureActiveDraft();
    var intent = ++viewIntent;
    return R.agent.conversations.create().then(function(conv) {
      var session = activateNewConversation(conv, intent);
      void agentBrowser.agentLoadConversations();
      return session;
    }).catch(function(error) {
      if (intent === viewIntent) toast(t("agent.create-failed", "Failed to create conversation: ") + ((error && error.message) || error), "error");
      return null;
    });
  };

  agentBrowser.agentSelectConv = function(conversationId) {
    if (!conversationId) return Promise.resolve(null);
    captureActiveDraft();
    var intent = ++viewIntent;
    var session = ensureSession(conversationId);
    state.agentActiveConvId = conversationId;
    if (session.loaded || session.run) displaySession(session);

    var conversationPromise = R.agent.conversations.get(conversationId).then(function(conv) {
      if (!conv) {
        if (intent === viewIntent && state.agentActiveConvId === conversationId) {
          toast(t("agent.conv-missing", "Conversation not found — it may have been deleted"), "error");
          state.agentActiveConvId = null;
          state.agentMessages = [];
          var messages = byId("agent-chat-messages");
          if (messages) messages.innerHTML = noConvHtml();
          renderRunUi(null);
        }
        return null;
      }
      adoptConversation(session, conv);
      if (intent === viewIntent && state.agentActiveConvId === conversationId) displaySession(session);
      return conv;
    }).catch(function(error) {
      console.error("Load conversation:", error);
      if (intent === viewIntent && state.agentActiveConvId === conversationId) {
        toast((error && error.message) || t("agent.conv-load-failed", "Failed to load conversation"), "error");
        state.agentActiveConvId = null;
        state.agentMessages = [];
        var messages = byId("agent-chat-messages");
        if (messages) messages.innerHTML = noConvHtml();
        renderRunUi(null);
      }
      return null;
    });

    var activePromise = restoreActiveRun(session);
    void agentBrowser.agentLoadConversations();
    return Promise.all([conversationPromise, activePromise]).then(function() { return session; });
  };

  agentBrowser.agentDeleteConv = function() {
    if (!state.agentActiveConvId) return;
    var conversationId = state.agentActiveConvId;
    var session = sessions[conversationId];
    if (session && session.run) {
      toast(t("agent.run.delete-busy", "Stop the current task before deleting this conversation"), "info");
      return;
    }
    agentBrowser.confirm(t("agent.delete-confirm", "Delete this conversation? All messages will be lost."), function() {
      R.agent.conversations.delete(conversationId).then(function() {
        delete sessions[conversationId];
        if (state.agentActiveConvId === conversationId) {
          state.agentActiveConvId = null;
          state.agentMessages = [];
          var messages = byId("agent-chat-messages");
          if (messages) messages.innerHTML = noConvHtml();
          renderRunUi(null);
        }
        agentBrowser.agentLoadConversations();
      });
    });
  };

  agentBrowser.agentDeleteConvItem = function(conversationId) {
    if (!conversationId) return;
    var session = sessions[conversationId];
    if (session && session.run) {
      toast(t("agent.run.delete-busy", "Stop the current task before deleting this conversation"), "info");
      return;
    }
    agentBrowser.confirm(t("agent.delete-confirm", "Delete this conversation? All messages will be lost."), function() {
      R.agent.conversations.delete(conversationId).then(function() {
        delete sessions[conversationId];
        if (state.agentActiveConvId === conversationId) {
          state.agentActiveConvId = null;
          state.agentMessages = [];
          var title = byId("agent-chat-title");
          var messages = byId("agent-chat-messages");
          var status = byId("agent-chat-status");
          if (title) title.textContent = t("agent.chat-title", "New Chat");
          if (messages) messages.innerHTML = noConvHtml();
          if (status) status.textContent = "";
          renderRunUi(null);
        }
        agentBrowser.agentLoadConversations();
      });
    });
  };

  agentBrowser.agentUseSuggestion = function(prompt) {
    var input = byId("agent-chat-input");
    if (!input || !prompt) return;
    input.value = prompt;
    agentBrowser.agentSend();
  };

  // ── Browser environment scope ──
  function profileById(dirId) {
    for (var i = 0; i < environmentProfiles.length; i++) {
      if (environmentProfiles[i].dirId === dirId) return environmentProfiles[i];
    }
    return null;
  }

  function replaceEnvironmentOptions(session) {
    var select = byId("agent-env-select");
    if (!select) return;
    var desired = session && session.run ? session.run.profileDirId : (session ? session.selectedProfileDirId : "");
    desired = desired || "";
    var html = '<option value="">' + esc(t("agent.env.none", "No browser environment — browser actions disabled")) + "</option>";
    environmentProfiles.forEach(function(profile) {
      var stateLabel = profile.running ? t("agent.env.running", "running") : t("agent.env.stopped", "stopped");
      html += '<option value="' + escAttr(profile.dirId) + '">' + esc((profile.name || profile.dirId) + " · " + stateLabel) + "</option>";
    });
    if (desired && !profileById(desired)) {
      var frozenName = session && session.run && session.run.profileName ? session.run.profileName : desired;
      html += '<option value="' + escAttr(desired) + '">' + esc(frozenName) + "</option>";
    }
    select.innerHTML = html;
    select.value = desired;
  }

  function renderEnvironmentUi(session) {
    var select = byId("agent-env-select");
    var status = byId("agent-env-status");
    var start = byId("agent-env-start");
    if (!select) return;
    replaceEnvironmentOptions(session);
    var live = session && session.run;
    var selectedId = live ? (live.profileDirId || "") : (session ? session.selectedProfileDirId || "" : "");
    var profile = profileById(selectedId);
    select.disabled = !!live;
    if (start) {
      start.style.display = selectedId && (!profile || !profile.running) && !live ? "inline-flex" : "none";
      start.disabled = !selectedId || !!live;
    }
    if (!status) return;
    status.className = "agent-env-status";
    if (live) {
      status.textContent = live.profileDirId
        ? t("agent.env.frozen", "This task is locked to {name}").replace("{name}", live.profileName || live.profileDirId)
        : t("agent.env.frozen-none", "This task cannot perform browser actions; guarded database and file tools remain available.");
      status.className += " is-running";
    } else if (!selectedId) {
      status.textContent = t("agent.env.none-hint", "Browser actions are off. Guarded database and file tools remain available.");
    } else if (!profile) {
      status.textContent = t("agent.env.missing", "The selected environment is unavailable. Refresh or choose another one.");
      status.className += " is-error";
    } else if (profile.running) {
      status.textContent = t("agent.env.selected-running", "Browser actions will be limited to {name}.").replace("{name}", profile.name || profile.dirId);
      status.className += " is-ready";
    } else {
      status.textContent = t("agent.env.selected-stopped", "{name} is stopped. Start it explicitly before sending.").replace("{name}", profile.name || profile.dirId);
      status.className += " is-warning";
    }
  }

  agentBrowser.agentEnvironmentChanged = function() {
    var session = activeSession();
    var select = byId("agent-env-select");
    if (!session || !select || session.run) return;
    session.selectedProfileDirId = select.value || "";
    renderEnvironmentUi(session);
  };

  agentBrowser.agentRefreshEnvironments = function() {
    var seq = ++environmentLoadSeq;
    var status = byId("agent-env-status");
    if (status && !environmentProfiles.length) status.textContent = t("agent.env.loading", "Loading browser environments…");
    return readCall("browser.list:agent-scope", function() { return api.browser.list(); }).then(function(list) {
      if (seq !== environmentLoadSeq) return environmentProfiles;
      environmentProfiles = (list || []).map(function(profile) {
        return {
          dirId: profile.dirId,
          name: profile.name || profile.dirId,
          running: profile.running === true,
          pid: profile.pid || null,
          cdpPort: profile.cdpPort || null,
        };
      });
      renderEnvironmentUi(activeSession());
      return environmentProfiles;
    }).catch(function(error) {
      if (seq === environmentLoadSeq && status) {
        status.textContent = t("agent.env.load-failed", "Could not load browser environments: ") + ((error && error.message) || error);
        status.className = "agent-env-status is-error";
      }
      return environmentProfiles;
    });
  };

  function updateCachedProfile(dirId, patch) {
    var profile = profileById(dirId);
    if (profile) Object.assign(profile, patch || {});
  }

  function watchEnvironmentStart(dirId, seq, deadline) {
    if (seq !== environmentStartSeq) return;
    readCall("browser.status:agent-start:" + dirId, function() { return api.browser.status(dirId); }).then(function(status) {
      if (seq !== environmentStartSeq) return;
      if (status && status.running) {
        updateCachedProfile(dirId, { running: true, pid: status.pid || null, cdpPort: status.cdpPort || null });
        agentBrowser.agentRefreshEnvironments();
        return;
      }
      if (Date.now() >= deadline) {
        var statusEl = byId("agent-env-status");
        if (statusEl && activeSession() && activeSession().selectedProfileDirId === dirId) {
          statusEl.textContent = t("agent.env.start-pending", "Not running yet. Complete any start confirmation, then try again.");
          statusEl.className = "agent-env-status is-warning";
        }
        return;
      }
      setTimeout(function() { watchEnvironmentStart(dirId, seq, deadline); }, 750);
    }).catch(function() {
      if (Date.now() < deadline) setTimeout(function() { watchEnvironmentStart(dirId, seq, deadline); }, 1000);
    });
  }

  agentBrowser.agentStartSelectedEnvironment = function() {
    var session = activeSession();
    var select = byId("agent-env-select");
    var dirId = select ? select.value : "";
    if (!session || !dirId) {
      toast(t("agent.env.select-first", "Select a browser environment first"), "info");
      return;
    }
    if (session.run) return;
    var status = byId("agent-env-status");
    if (status) {
      status.textContent = t("agent.env.starting", "Start requested. Complete any engine, license, or proxy confirmation.");
      status.className = "agent-env-status is-warning";
    }
    // The existing launcher owns all engine/license/proxy confirmations and does
    // not return a Promise. Never treat this call as proof that the browser ran;
    // poll the real runtime status, and every send validates it again.
    agentBrowser.launch(dirId);
    var seq = ++environmentStartSeq;
    watchEnvironmentStart(dirId, seq, Date.now() + 45000);
  };

  function validateScope(profileDirId) {
    if (!profileDirId) return Promise.resolve({ profileDirId: "", profileName: "" });
    return readCall("browser.list:agent-send", function() { return api.browser.list(); }).then(function(list) {
      environmentProfiles = (list || []).map(function(item) {
        return {
          dirId: item.dirId,
          name: item.name || item.dirId,
          running: item.running === true,
          pid: item.pid || null,
          cdpPort: item.cdpPort || null,
        };
      });
      var profile = profileById(profileDirId);
      if (!profile) {
        var missing = new Error(t("agent.env.missing", "The selected environment is unavailable. Refresh or choose another one."));
        missing.code = "PROFILE_NOT_FOUND";
        throw missing;
      }
      return readCall("browser.status:agent-send:" + profileDirId, function() {
        return api.browser.status(profileDirId);
      }).then(function(runtime) {
        updateCachedProfile(profileDirId, {
          running: !!(runtime && runtime.running),
          pid: runtime && runtime.pid || null,
          cdpPort: runtime && runtime.cdpPort || null,
        });
        if (!runtime || !runtime.running) {
          var stopped = new Error(t("agent.env.not-running", "The selected environment is not running. Start it explicitly before sending."));
          stopped.code = "PROFILE_NOT_RUNNING";
          throw stopped;
        }
        return { profileDirId: profileDirId, profileName: profile.name || profileDirId };
      });
    });
  }

  // ── Run lifecycle ──
  function explainError(error) {
    if (error == null) return "";
    if (typeof error === "string") return error;
    if (error.message) return String(error.message);
    if (typeof error.error === "string") return error.error;
    if (error.error && error.error.message) return String(error.error.message);
    try { return JSON.stringify(error); } catch (_e) { return String(error); }
  }

  function endReasonLabel(reason) {
    var labels = {
      completed: ["agent.end.completed", "Execution finished"],
      user_cancelled: ["agent.end.user-cancelled", "Stopped by user"],
      timeout: ["agent.end.timeout", "Timed out"],
      round_limit: ["agent.end.round-limit", "Round limit reached"],
      interrupted: ["agent.end.interrupted", "Interrupted"],
      execution_error: ["agent.end.execution-error", "Execution failed"],
    };
    var entry = labels[reason] || ["agent.end.execution-error", "Execution failed"];
    return t(entry[0], entry[1]);
  }

  function runStateLabel(run) {
    if (!run) return "";
    if (run.state === "preparing") return t("agent.run.preparing", "Preparing");
    if (run.state === "cancelling") return t("agent.run.cancelling", "Stopping…");
    if (run.state === "running") return t("agent.run.running", "Running");
    return endReasonLabel(run.endReason);
  }

  function formatElapsed(ms) {
    var seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return seconds + "s";
    var minutes = Math.floor(seconds / 60);
    var remain = seconds % 60;
    return minutes + "m " + String(remain).padStart(2, "0") + "s";
  }

  function renderRunUi(session) {
    var strip = byId("agent-run-strip");
    var input = byId("agent-chat-input");
    var send = byId("agent-chat-send") || document.querySelector("#agent-view-chat .btn-primary");
    var stop = byId("agent-chat-stop");
    var status = byId("agent-chat-status");
    var live = session && session.run;
    var shown = live || (session && session.lastRun);

    if (input) input.disabled = !!live;
    if (send) {
      send.disabled = !!live;
      setSendIcon(send, live ? "loader" : "arrowUp");
    }
    if (!strip) return;
    if (!shown) {
      strip.style.display = "none";
      if (status) status.textContent = "";
      return;
    }

    strip.style.display = "flex";
    strip.className = "agent-run-strip" + (live ? " is-live" : " is-finished") + (shown.endReason && shown.endReason !== "completed" ? " is-error" : "");
    var stateEl = byId("agent-run-state");
    var actionEl = byId("agent-run-action");
    var elapsedEl = byId("agent-run-elapsed");
    var verifyEl = byId("agent-run-verification");
    if (stateEl) stateEl.textContent = runStateLabel(shown);
    if (actionEl) {
      if (live) {
        actionEl.style.display = "";
        var action = shown.currentTool || t("agent.run.waiting", "Waiting for the agent");
        actionEl.textContent = t("agent.run.current-action", "Current: {action}").replace("{action}", action);
      } else if (shown.code === "PERSISTENCE_ERROR") {
        actionEl.style.display = "";
        actionEl.textContent = t("agent.run.not-saved", "Final result was not saved");
      } else {
        // The state slot already shows the exact terminal reason. Repeating it
        // as the "current action" produces "Execution finished" twice.
        actionEl.style.display = "none";
        actionEl.textContent = "";
      }
    }
    if (elapsedEl) {
      var until = shown.finishedAt || Date.now();
      elapsedEl.textContent = formatElapsed(until - (shown.startedAt || until));
    }
    if (verifyEl) verifyEl.textContent = verifyLabel(shown.verification);
    if (stop) {
      stop.style.display = live ? "inline-flex" : "none";
      stop.disabled = !!(live && live.state === "cancelling");
      var stopLabel = byId("agent-chat-stop-label");
      if (stopLabel) stopLabel.textContent = live && live.state === "cancelling" ? t("agent.run.cancelling", "Stopping…") : t("agent.run.stop", "Stop");
    }
    if (status) status.textContent = "";
  }

  function finishLocalPreparation(session, run, reason, error) {
    if (session.run !== run) return;
    unregisterRun(session, run);
    session.run = null;
    session.lastRun = {
      state: "finished",
      startedAt: run.startedAt,
      finishedAt: Date.now(),
      endReason: reason,
      persisted: null,
      error: error || "",
    };
    if (isActiveSession(session)) {
      renderRunUi(session);
      renderEnvironmentUi(session);
      var input = byId("agent-chat-input");
      if (input) {
        input.disabled = false;
        if (reason !== "user_cancelled") input.focus();
      }
    }
  }

  function beginSend(session, message) {
    if (!session || !message) return Promise.resolve(null);
    if (session.run) {
      toast(t("agent.run.busy", "This conversation already has a task running"), "info");
      return Promise.resolve(null);
    }
    var select = byId("agent-env-select");
    var selectedProfileDirId = select ? select.value || "" : session.selectedProfileDirId || "";
    session.selectedProfileDirId = selectedProfileDirId;
    session.draft = message;

    var requestId = newId("request");
    var run = {
      conversationId: session.conversationId,
      // Main treats streamId/requestId as one idempotency identity. Keeping one
      // value also lets persisted messages reconnect to this exact request.
      requestId: requestId,
      streamId: requestId,
      runId: null,
      profileDirId: selectedProfileDirId,
      profileName: "",
      state: "preparing",
      startedAt: Date.now(),
      reply: "",
      toolCalls: [],
      steps: [],
      currentTool: "",
      submitted: false,
      terminal: false,
      cancelRequested: false,
    };
    session.run = run;
    session.lastRun = null;
    registerRun(session, run);
    if (isActiveSession(session)) {
      renderRunUi(session);
      renderEnvironmentUi(session);
    }

    return validateScope(selectedProfileDirId).then(function(scope) {
      if (run.cancelRequested || session.run !== run) {
        finishLocalPreparation(session, run, "user_cancelled", "");
        return null;
      }
      run.profileDirId = scope.profileDirId;
      run.profileName = scope.profileName;
      session.draft = "";

      var userMessage = {
        role: "user",
        content: message,
        timestamp: Date.now(),
        requestId: run.requestId,
        _local: true,
      };
      var assistantMessage = {
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        requestId: run.requestId,
        toolCalls: [],
        steps: run.steps,
        _local: true,
      };
      run.userMessage = userMessage;
      run.assistantMessage = assistantMessage;
      session.messagesRef.push(userMessage, assistantMessage);
      if (isActiveSession(session)) {
        var input = byId("agent-chat-input");
        if (input) input.value = "";
        state.agentMessages = session.messagesRef;
        agentBrowser.agentRenderMessages();
        renderEnvironmentUi(session);
      }

      run.submitted = true;
      var options = { requestId: run.requestId };
      if (run.profileDirId) options.profileDirId = run.profileDirId;
      return R.agent.chatStream(session.conversationId, message, run.streamId, options).then(function(result) {
        if (result && result.conversationId && result.streamId && result.status && !run.terminal) handleTerminal(result);
        else if (result && result.error && !run.terminal) {
          handleTerminal({
            conversationId: session.conversationId,
            streamId: run.streamId,
            runId: result.runId,
            reply: result.reply || "",
            toolCalls: result.toolCalls || [],
            status: "error",
            endReason: result.endReason || "execution_error",
            verification: result.verification || { status: "unverified" },
            persisted: result.persisted === true,
            error: explainError(result),
            code: result.code,
          });
        }
        return result;
      }).catch(function(error) {
        if (run.terminal) return null;
        var reason = run.cancelRequested ? "user_cancelled" : "execution_error";
        if (reason !== "user_cancelled") console.error("[agent] stream request failed:", error);
        handleTerminal({
          conversationId: session.conversationId,
          streamId: run.streamId,
          runId: run.runId,
          reply: run.reply || "",
          toolCalls: run.toolCalls || [],
          status: "error",
          endReason: reason,
          verification: { status: "unverified" },
          persisted: false,
          error: explainError(error) || t("agent.stream-error", "Stream error"),
        });
        return null;
      });
    }).catch(function(error) {
      if (run.cancelRequested) {
        finishLocalPreparation(session, run, "user_cancelled", "");
        return null;
      }
      var reason = explainError(error) || t("agent.stream-error", "Stream error");
      if (isActiveSession(session)) toast(reason, "error");
      finishLocalPreparation(session, run, "execution_error", reason);
      if (isActiveSession(session)) renderEnvironmentUi(session);
      return null;
    });
  }

  agentBrowser.agentSend = function() {
    var input = byId("agent-chat-input");
    var message = input ? input.value.trim() : "";
    if (!message) return Promise.resolve(null);
    var current = activeSession();
    if (current && current.run) return beginSend(current, message);
    if (current) return beginSend(current, message);

    var intent = ++viewIntent;
    if (input) input.disabled = true;
    return R.agent.conversations.create(message.slice(0, 40)).then(function(conv) {
      var session = activateNewConversation(conv, intent);
      void agentBrowser.agentLoadConversations();
      if (intent !== viewIntent) return null;
      return beginSend(session, message);
    }).catch(function(error) {
      if (intent === viewIntent && input) input.disabled = false;
      if (intent === viewIntent) toast((error && error.message) || t("agent.create-failed", "Failed to create conversation: "), "error");
      return null;
    });
  };

  // Kept as the programmatic entry used by existing E2E tests and suggestion
  // chips. It now goes through the same validation and per-conversation state.
  agentBrowser._doAgentSend = function(message) {
    return beginSend(activeSession(), String(message || "").trim());
  };

  function findSessionForPayload(payload) {
    if (!payload) return null;
    var session = payload.streamId && sessionsByStream[payload.streamId];
    if (!session && payload.runId) session = sessionsByRun[payload.runId];
    if (!session && payload.conversationId) session = sessions[payload.conversationId];
    if (!session || !session.run) return null;
    var run = session.run;
    if (payload.conversationId && payload.conversationId !== session.conversationId) return null;
    if (payload.streamId && run.streamId && payload.streamId !== run.streamId) return null;
    if (payload.runId && run.runId && payload.runId !== run.runId) return null;
    return session;
  }

  function annotateRunMessages(session, run) {
    if (run.userMessage) {
      run.userMessage.runId = run.runId;
      run.userMessage.requestId = run.requestId;
    } else {
      run.userMessage = findMessage(session, "user", run.requestId, run.runId);
      if (run.userMessage) {
        run.userMessage.runId = run.runId;
        run.userMessage.requestId = run.userMessage.requestId || run.requestId;
      }
    }
    var assistant = ensureAssistantMessage(session, run);
    assistant.runId = run.runId;
    assistant.requestId = run.requestId;
  }

  function handleStart(payload) {
    var session = findSessionForPayload(payload);
    if (!session) {
      if (!payload || !payload.conversationId || !payload.streamId) return;
      session = ensureSession(payload.conversationId);
      // A delayed start from an older request must not replace a newer live run
      // or resurrect a request whose terminal event was already observed.
      if (session.run) return;
      if (session.lastRun && (session.lastRun.streamId === payload.streamId ||
        (payload.runId && session.lastRun.runId === payload.runId) ||
        (payload.startedAt && session.lastRun.finishedAt && payload.startedAt <= session.lastRun.finishedAt))) return;
      var restored = {
        conversationId: payload.conversationId,
        requestId: payload.streamId,
        streamId: payload.streamId,
        runId: payload.runId || null,
        profileDirId: payload.profileDirId || "",
        profileName: payload.profileName || "",
        state: "running",
        startedAt: payload.startedAt || Date.now(),
        reply: "",
        toolCalls: [],
        steps: [],
        currentTool: "",
        submitted: true,
        terminal: false,
        cancelRequested: false,
      };
      session.run = restored;
      session.lastRun = null;
      registerRun(session, restored);
    }
    var run = session.run;
    if (run.terminal) return;
    run.runId = payload.runId || run.runId;
    run.profileDirId = payload.profileDirId || run.profileDirId || "";
    run.profileName = payload.profileName || run.profileName || "";
    run.startedAt = payload.startedAt || run.startedAt;
    run.state = run.cancelRequested ? "cancelling" : "running";
    registerRun(session, run);
    annotateRunMessages(session, run);
    if (isActiveSession(session)) {
      state.agentMessages = session.messagesRef;
      agentBrowser.agentRenderMessages();
      renderRunUi(session);
      renderEnvironmentUi(session);
    }
  }

  function isNearBottom(el) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function updateScrollAffordance() {
    var wrap = byId("agent-chat-messages");
    var button = byId("agent-scroll-bottom");
    if (!wrap || !button) return;
    var near = isNearBottom(wrap);
    button.style.display = near ? "none" : "block";
    if (near) {
      var badge = byId("agent-scroll-badge");
      if (badge) badge.style.display = "none";
    }
  }

  function scheduleSessionRender(session) {
    if (!isActiveSession(session) || session.renderPending) return;
    session.renderPending = true;
    (window.requestAnimationFrame || function(fn) { return setTimeout(fn, 16); })(function() {
      session.renderPending = false;
      if (!isActiveSession(session)) return;
      var container = byId("agent-chat-messages");
      var stick = isNearBottom(container);
      state.agentMessages = session.messagesRef;
      agentBrowser.agentRenderMessages({ preserveScroll: !stick });
      if (stick && container) container.scrollTop = container.scrollHeight;
      else {
        var badge = byId("agent-scroll-badge");
        if (badge) badge.style.display = "inline-flex";
      }
      updateScrollAffordance();
    });
  }

  function handleChunk(payload) {
    var session = findSessionForPayload(payload);
    if (!session || session.run.terminal) return;
    var run = session.run;
    var text = payload && payload.text != null ? String(payload.text) : "";
    run.reply += text;
    var assistant = ensureAssistantMessage(session, run);
    assistant.content = run.reply;
    scheduleSessionRender(session);
  }

  function handleToolCall(payload) {
    var session = findSessionForPayload(payload);
    if (!session || session.run.terminal) return;
    var run = session.run;
    var name = String(payload.name || "tool");
    run.currentTool = name;
    run.toolCalls.push({ name: name, redacted: true });
    run.steps.push({ tool: name, pending: true, timestamp: Date.now() });
    var assistant = ensureAssistantMessage(session, run);
    assistant.toolCalls = run.toolCalls;
    assistant.steps = run.steps;
    if (isActiveSession(session)) {
      agentBrowser.agentRenderMessages();
      renderRunUi(session);
    }
  }

  function handleRunStep(payload) {
    if (!payload || !payload.runId || !payload.step) return;
    var session = sessionsByRun[payload.runId];
    if (!session || !session.run || session.run.terminal) return;
    var run = session.run;
    var actual = normalizeStep(payload.step);
    var pendingIndex = -1;
    for (var i = 0; i < run.steps.length; i++) {
      if (run.steps[i].pending && run.steps[i].tool === actual.tool) { pendingIndex = i; break; }
    }
    if (pendingIndex === -1) run.steps.push(actual);
    else run.steps.splice(pendingIndex, 1, actual);
    var nextPending = run.steps.filter(function(step) { return step.pending; })[0];
    run.currentTool = nextPending ? nextPending.tool : "";
    var assistant = ensureAssistantMessage(session, run);
    assistant.steps = run.steps;
    if (isActiveSession(session)) {
      agentBrowser.agentRenderMessages();
      renderRunUi(session);
    }
  }

  function terminalAssistantContent(payload, run) {
    if (payload.reply) return String(payload.reply);
    if (run.reply) return run.reply;
    if (payload.endReason === "user_cancelled") return t("agent.end.user-cancelled", "Stopped by user");
    return explainError(payload.error) || endReasonLabel(payload.endReason);
  }

  function syncConversationAfterTerminal(session) {
    R.agent.conversations.get(session.conversationId).then(function(conv) {
      if (!conv) return;
      adoptConversation(session, conv);
      if (isActiveSession(session)) displaySession(session);
    }).catch(function(error) {
      // A failed read is not evidence that persistence was cleared; retain the
      // in-memory terminal result and let a later selection retry the read.
      console.warn("[agent] terminal conversation refresh failed:", error);
    });
  }

  function handleTerminal(payload) {
    var session = findSessionForPayload(payload);
    // On renderer reload a task can finish in the narrow window after history
    // was read but before activeRun() returned. Reconstruct only that exact
    // terminal identity; never attach it to a newer task in the conversation.
    if (!session && payload && payload.conversationId && payload.streamId) {
      session = sessions[payload.conversationId];
      if (session && !session.run && !session.lastRun) {
        var linkedUser = findMessage(session, "user", payload.streamId, payload.runId);
        var recoveredTerminal = {
          conversationId: payload.conversationId,
          requestId: linkedUser && linkedUser.requestId || payload.streamId,
          streamId: payload.streamId,
          runId: payload.runId || null,
          profileDirId: "",
          profileName: "",
          state: "running",
          startedAt: linkedUser && linkedUser.timestamp || Date.now(),
          reply: String(payload.reply || ""),
          toolCalls: [],
          steps: [],
          currentTool: "",
          submitted: true,
          terminal: false,
          cancelRequested: payload.endReason === "user_cancelled",
          userMessage: linkedUser || null,
        };
        session.run = recoveredTerminal;
        registerRun(session, recoveredTerminal);
      } else {
        session = null;
      }
    }
    if (!session) return;
    var run = session.run;
    if (run.terminal) return;
    run.terminal = true;
    run.runId = payload.runId || run.runId;
    run.reply = payload.reply != null ? String(payload.reply) : run.reply;
    run.toolCalls = (payload.toolCalls || run.toolCalls || []).map(function(call) { return { name: call.name, redacted: true }; });
    run.endReason = payload.endReason || (payload.status === "done" ? "completed" : "execution_error");
    run.verification = payload.verification || { status: "unverified" };
    run.persisted = payload.persisted === true;
    run.code = payload.code || "";
    run.error = explainError(payload.error);
    run.finishedAt = Date.now();
    run.state = "finished";
    run.steps.forEach(function(step) {
      if (step.pending) { step.pending = false; step.unknown = true; }
    });

    annotateRunMessages(session, run);
    var assistant = run.assistantMessage;
    assistant.content = terminalAssistantContent(payload, run);
    assistant.toolCalls = run.toolCalls;
    assistant.steps = run.steps;
    assistant.runId = run.runId || undefined;
    assistant.requestId = run.requestId;
    assistant.endReason = run.endReason;
    assistant.verification = run.verification;
    assistant.persisted = run.persisted;
    assistant.code = run.code;
    if (run.userMessage && run.runId) run.userMessage.runId = run.runId;

    unregisterRun(session, run);
    session.run = null;
    session.lastRun = run;
    if (run.endReason !== "user_cancelled" && payload.status === "error") {
      // Log the normalized failure text, not the terminal payload: DevTools
      // truncates large payloads (especially replies) before the useful provider
      // error, making genuine failures impossible to identify.
      console.error("[agent] task ended:", run.error || endReasonLabel(run.endReason));
    }
    if (run.runId && typeof agentBrowser.approvalDiscardRun === "function") agentBrowser.approvalDiscardRun(run.runId);

    if (isActiveSession(session)) {
      state.agentMessages = session.messagesRef;
      agentBrowser.agentRenderMessages();
      renderRunUi(session);
      renderEnvironmentUi(session);
      var input = byId("agent-chat-input");
      if (input) {
        input.disabled = false;
        input.focus();
      }
    }
    void agentBrowser.agentLoadConversations();
    if (run.persisted) syncConversationAfterTerminal(session);
  }

  function stopSession(target) {
    var session = target && target.session ? target.session : null;
    if (!session && target && target.conversationId) session = sessions[target.conversationId];
    if (!session && target && target.runId) session = sessionsByRun[target.runId];
    if (!session) session = activeSession();
    var run = session && session.run;
    if (!run) return Promise.resolve({ accepted: false, state: "not_found" });
    if (target && target.runId && run.runId && target.runId !== run.runId) return Promise.resolve({ accepted: false, state: "not_found" });
    if (run.terminal) return Promise.resolve({ accepted: false, state: "finished", endReason: run.endReason });
    if (run.stopPromise) return run.stopPromise;

    run.cancelRequested = true;
    run.state = "cancelling";
    if (isActiveSession(session)) renderRunUi(session);

    // Validation and profile-status reads happen before the chat RPC is
    // submitted. A local stop must prevent that future submission.
    if (!run.submitted) {
      finishLocalPreparation(session, run, "user_cancelled", "");
      return Promise.resolve({ accepted: true, state: "finished", streamId: run.streamId, endReason: "user_cancelled" });
    }

    run.stopPromise = R.agent.cancelRun({
      conversationId: session.conversationId,
      runId: run.runId || undefined,
      streamId: run.streamId || undefined,
    }).then(function(result) {
      run.stopPromise = null;
      if (!result || (result.accepted === false && result.state === "not_found")) {
        // Do not invent a terminal result. The owner-only active snapshot or the
        // terminal event remains authoritative.
        return result || { accepted: false, state: "not_found" };
      }
      return result;
    }).catch(function(error) {
      run.stopPromise = null;
      if (session.run === run && !run.terminal) {
        run.state = "running";
        run.cancelRequested = false;
        if (isActiveSession(session)) renderRunUi(session);
      }
      toast(t("agent.run.stop-failed", "Could not stop the task: ") + explainError(error), "error");
      return { accepted: false, state: "not_found", error: explainError(error) };
    });
    return run.stopPromise;
  }

  agentBrowser.agentStopRun = function() {
    return stopSession({ session: activeSession() });
  };

  function findOwnedRun(runId) {
    var session = runId && sessionsByRun[runId];
    if (!session || !session.run) return null;
    return {
      session: session,
      conversationId: session.conversationId,
      runId: session.run.runId || undefined,
      streamId: session.run.streamId || undefined,
    };
  }

  function resolveOwnedRun(req) {
    var local = req && req.runId ? findOwnedRun(req.runId) : null;
    if (local) return Promise.resolve(local);
    if (!req || !req.runId || !api.agentRuns || !R.agent.activeRun) return Promise.resolve(null);
    return readCall("agentRuns.get:approval:" + req.runId, function() {
      return api.agentRuns.get(req.runId);
    }).then(function(record) {
      var conversationId = record && record.source && record.source.type === "chat" ? record.source.conversationId : "";
      if (!conversationId) return null;
      return readCall("agent.activeRun:approval:" + conversationId, function() {
        return R.agent.activeRun(conversationId);
      }).then(function(snapshot) {
        if (!snapshot || snapshot.runId !== req.runId) return null;
        var session = ensureSession(conversationId);
        hydrateSnapshot(session, snapshot);
        return findOwnedRun(req.runId);
      });
    }).catch(function() { return null; });
  }

  agentBrowser.agentChatController = {
    findByRunId: findOwnedRun,
    resolveOwnedRun: resolveOwnedRun,
    stop: stopSession,
    getSession: function(conversationId) { return sessions[conversationId] || null; },
  };
  // Exposed for diagnostics/tests; callers must not replace message arrays.
  agentBrowser.agentChatSessions = sessions;

  function bindLifecycleEvents() {
    if (state.agentChatEventsBound) return;
    state.agentChatEventsBound = true;
    api.on("agent:stream-start", handleStart);
    api.on("agent:stream-chunk", handleChunk);
    api.on("agent:stream-tool-call", handleToolCall);
    api.on("agent:run-step", handleRunStep);
    api.on("agent:stream-done", handleTerminal);
    api.on("agent:stream-error", handleTerminal);
    api.on("browser:exited", function(payload) {
      if (payload && payload.dirId) updateCachedProfile(payload.dirId, { running: false, pid: null, cdpPort: null });
      agentBrowser.agentRefreshEnvironments();
    });
    api.on("profile:updated", function() { agentBrowser.agentRefreshEnvironments(); });
  }
  bindLifecycleEvents();
  document.addEventListener("agent-browser-language-change", renderComposerHint);

  setInterval(function() {
    var session = activeSession();
    if (!document.hidden && session && (session.run || session.lastRun)) renderRunUi(session);
  }, 1000);

  // ── Message rendering ──
  function stepDuration(step) {
    if (!step) return "";
    if (typeof step.durationMs === "number" && isFinite(step.durationMs) && step.durationMs >= 0) {
      var seconds = step.durationMs / 1000;
      return seconds < 10 ? seconds.toFixed(1) + "s" : Math.round(seconds) + "s";
    }
    return "";
  }

  function runLink(runId) {
    if (!runId) return "";
    return '<button type="button" class="chat-run-link" data-role="cmd" data-cmd="agentOpenRun" data-cmd-arg="' + escAttr(runId) + '">' + icon("link", 12) + "<span>" + esc(t("agent.run.open", "Run details")) + "</span></button>";
  }

  /** Verification label via the shared runs.js view model, so a five-state
   *  badge cannot drift between the two surfaces. Falls back to the
   *  conservative default when runs.js has not loaded yet. */
  function verifyLabel(verification) {
    var view = agentBrowser.verificationView;
    if (view) {
      var meta = view.meta[verification && verification.status];
      if (meta) return t(meta.key, meta.label);
    }
    return t("agent.run.unverified", "Unverified");
  }

  function messageRunMeta(message, showLink) {
    if (!message.runId && !message.endReason && !message.verification) return "";
    var reason = message.endReason ? '<span class="chat-run-reason">' + esc(endReasonLabel(message.endReason)) + "</span>" : "";
    // M2: render the run's real verification (five states). Chat runs are
    // never template-graded so this is normally "unverified", but a graded run
    // surfaced in a conversation must not contradict the Runs page.
    var verification = '<span class="chat-run-verification">' +
      esc(verifyLabel(message.verification)) + "</span>";
    var saveFailed = message.code === "PERSISTENCE_ERROR"
      ? '<span class="chat-run-unsaved">' + esc(t("agent.run.not-saved", "Final result was not saved")) + "</span>"
      : "";
    var link = showLink && message.runId && message.persisted !== false ? runLink(message.runId) : "";
    return '<div class="chat-run-meta">' + link + reason + verification + saveFailed + "</div>";
  }

  function renderTrace(message) {
    var steps = message.steps && message.steps.length ? message.steps : [];
    if (!steps.length && message.toolCalls && message.toolCalls.length) {
      steps = message.toolCalls.map(function(call) { return { tool: call.name, unknown: true }; });
    }
    if (!steps.length) return "";
    var hasPending = steps.some(function(step) { return step.pending; });
    var html = '<details class="chat-trace"' + (hasPending ? " open" : "") + "><summary>" + icon("zap", 12) + "<span>" + esc(t("agent.trace.title", "Tool calls")) + '</span><span class="chat-trace-count">· ' + steps.length + "</span>" + (hasPending ? '<span class="chat-tool-spinner chat-trace-live">' + icon("clock", 12) + "</span>" : "") + "</summary>";
    html += '<div class="chat-tools">';
    steps.forEach(function(step, index) {
      var statusClass;
      var statusIcon;
      var statusLabel;
      if (step.pending) {
        statusClass = "chat-tool-pending";
        statusIcon = icon("clock", 12);
        statusLabel = t("agent.step.running", "Running");
      } else if (step.ok === true) {
        statusClass = "chat-tool-done";
        statusIcon = icon("check", 12);
        statusLabel = t("agent.step.succeeded", "Succeeded");
      } else if (step.ok === false) {
        statusClass = "chat-tool-failed";
        statusIcon = icon("close", 12);
        statusLabel = t("agent.step.failed", "Failed");
      } else {
        statusClass = "chat-tool-unknown";
        statusIcon = icon("info", 12);
        statusLabel = t("agent.step.unknown", "Result available in run details");
      }
      var duration = stepDuration(step);
      html += '<div class="chat-tool-step" data-step-status="' + escAttr(statusClass.replace("chat-tool-", "")) + '">';
      html += '<span class="chat-tool-num">' + (index + 1) + ".</span>";
      html += '<span class="' + statusClass + '" title="' + escAttr(statusLabel) + '" aria-label="' + escAttr(statusLabel) + '">' + statusIcon + "</span>";
      html += '<span class="chat-tool-chip">' + esc(step.tool || step.name || "tool") + "</span>";
      if (step.error) html += '<span class="chat-tool-error" title="' + escAttr(step.error) + '">' + esc(step.error) + "</span>";
      if (duration) html += '<span class="chat-tool-dur">' + esc(duration) + "</span>";
      html += "</div>";
    });
    return html + "</div></details>";
  }

  agentBrowser.agentRenderMessages = function(opts) {
    var el = byId("agent-chat-messages");
    if (!el) return;
    var preserveScroll = !!(opts && opts.preserveScroll);
    var previousTop = el.scrollTop;
    var messages = state.agentMessages || [];
    var assistantRuns = Object.create(null);
    messages.forEach(function(message) {
      if (message.role === "assistant" && message.runId) assistantRuns[message.runId] = true;
    });

    var html = "";
    messages.forEach(function(message) {
      if (message.role === "user") {
        html += '<div class="chat-msg chat-msg-user"><div class="chat-bubble chat-bubble-user">' + esc(message.content) + "</div></div>";
        if (message.runId && !assistantRuns[message.runId]) html += messageRunMeta(message, true);
      } else if (message.role === "assistant") {
        var content = message.content
          ? renderChatMarkdown(message.content)
          : '<span class="chat-thinking">' + esc(t("agent.thinking", "Thinking…")) + "</span>";
        html += '<div class="chat-msg chat-msg-agent"><div class="chat-avatar">' + icon("robot", 14) + '</div><div class="chat-bubble chat-bubble-agent">' + content + "</div></div>";
        html += renderTrace(message);
        if (message.runId || message.endReason || message.verification) html += messageRunMeta(message, true);
      } else if (message.role === "tool") {
        html += '<div class="chat-tool-legacy"><span class="icon-text">' + icon("arrowRight", 11) + " " + esc(String(message.content).slice(0, 160)) + "</span></div>";
      }
    });
    el.innerHTML = html || welcomeHtml();
    if (preserveScroll) el.scrollTop = previousTop;
    else el.scrollTop = el.scrollHeight;
    updateScrollAffordance();
  };

  agentBrowser.agentOpenRun = function(runId) {
    if (!runId || typeof agentBrowser.runsOpen !== "function") return;
    return agentBrowser.runsOpen(runId);
  };

  agentBrowser.agentScrollBottom = function() {
    var el = byId("agent-chat-messages");
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    var badge = byId("agent-scroll-badge");
    var button = byId("agent-scroll-bottom");
    if (badge) badge.style.display = "none";
    if (button) button.style.display = "none";
  };

  agentBrowser.onAgentScroll = updateScrollAffordance;
})();
