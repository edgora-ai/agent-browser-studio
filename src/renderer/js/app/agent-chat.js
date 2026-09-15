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
  var fmt = helpers.fmt;
  // i18n helper: returns the translated string, falling back to the given
  // English default when the runtime is unavailable.
  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }
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
  // Sub-view switcher (chat, config, accounts, skills, adapters)
  agentBrowser.switchAgentSub = function(view) {
    document.getElementById('agent-view-chat').style.display = (view === 'chat') ? 'flex' : 'none';
    document.getElementById('agent-view-config').style.display = (view === 'config') ? 'block' : 'none';
    document.getElementById('agent-view-accounts').style.display = (view === 'accounts') ? 'block' : 'none';
    document.getElementById('agent-view-skills').style.display = (view === 'skills') ? 'block' : 'none';
    document.getElementById('agent-view-adapters').style.display = (view === 'adapters') ? 'block' : 'none';
    if (view === 'accounts') agentBrowser.agentLoadAccounts();
    if (view === 'skills') agentBrowser.agentLoadSkills();
    if (view === 'adapters') agentBrowser.agentLoadAdapters();
    if (view === 'config') agentBrowser.agentLoadConfig();
    if (view === 'chat') agentBrowser.agentLoadConversations();
  };

  // R128: the send button shows one icon at a time (arrow / loader). Replacing
  // the whole innerHTML keeps the aria-label attribute on the button itself.
  function setSendIcon(btn, name) {
    if (!btn) return;
    var markup = icon(name, 16);
    if (markup) btn.innerHTML = markup;
  }

  // ── Conversation List ──
  //
  // Empty-list autorescue is one-shot. agentLoadConversations() used to call
  // agentNewConv() unconditionally whenever the list came back empty, and
  // agentNewConv() re-enters agentLoadConversations() when it is done — so a
  // store that accepts create() but keeps returning [] (read-only profile dir,
  // failed write, IPC returning an empty page) spun forever on the microtask
  // queue and froze the whole renderer: the tab never painted and no error was
  // ever logged. The flag makes the renderer fall back to the "No chats yet"
  // state instead of retrying indefinitely.
  var _autoCreateConvTried = false;

  agentBrowser.agentLoadConversations = function() {
    R.agent.conversations.list().then(function(list) {
      state.agentConvList = list || [];
      agentBrowser.agentRenderConvs();
    }).catch(function(e) {
      console.error('Load conversations:', e);
      document.getElementById('agent-conv-list').innerHTML = '<div style="color: var(--danger-text);font-size:11px;text-align:center;padding:16px;">' + esc(t('agent.load-failed', 'Failed to load conversations')) + '<br><button class="btn btn-xs btn-primary" data-role="cmd" data-cmd="agentLoadConversations" style="margin-top:8px;">' + esc(t('agent.retry', 'Retry')) + '</button></div>';
    });
  };

  // S2-15: rendering is split from loading so the search box filters
  // client-side without an IPC round-trip.
  agentBrowser.agentFilterConvs = function() { agentBrowser.agentRenderConvs(); };

  agentBrowser.agentRenderConvs = function() {
    var el = document.getElementById('agent-conv-list');
    var list = state.agentConvList || [];
    if (list.length === 0) {
      el.innerHTML = '<div style="color:var(--text-muted);font-size:var(--fs-micro);text-align:center;padding:16px;">' + esc(t('agent.no-chats', 'No chats yet')) + '</div>';
      if (!_autoCreateConvTried) {
        _autoCreateConvTried = true;
        agentBrowser.agentNewConv();
      }
      return;
    }
    _autoCreateConvTried = false;
    var searchEl = document.getElementById('agent-conv-search');
    var q = searchEl && searchEl.value ? searchEl.value.trim().toLowerCase() : '';
    var shown = q ? list.filter(function(c) { return convTitle(c).toLowerCase().indexOf(q) !== -1; }) : list;
    if (shown.length === 0) {
      el.innerHTML = '<div style="color:var(--text-muted);font-size:var(--fs-micro);text-align:center;padding:16px;">' + esc(t('agent.conv.no-match', 'No matching chats')) + '</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < shown.length; i++) {
      var c = shown[i];
      var isActive = c.id === state.agentActiveConvId;
      // R181: this row is the only way to switch conversations and was a
      // bare <div> with a click handler — unreachable by keyboard and
      // absent from the accessibility tree. role=button + tabindex + an
      // aria-current marker for the active row (colour alone does not
      // convey selection to a screen reader).
      var rel = helpers.relTime ? helpers.relTime(c.updatedAt || c.createdAt) : '';
      var meta = (rel ? '<span class="num">' + esc(rel) + '</span> · ' : '') + (c.messageCount || 0) + ' ' + esc(t('agent.msgs', 'msgs'));
      var delLabel = t('agent.conv.delete', 'Delete chat');
      html += '<div data-role="cmd" data-cmd="agentSelectConv" data-cmd-arg="' + escAttr(c.id) + '" class="agent-conv-item' + (isActive ? ' is-active' : '') + '" role="button" tabindex="0" aria-current="' + (isActive ? 'true' : 'false') + '">';
      html += '<div class="agent-conv-title">' + esc(convTitle(c)) + '</div>';
      html += '<div class="agent-conv-meta hint-line">' + meta + '</div>';
      html += '<button type="button" class="btn-icon btn btn-quiet btn-xs agent-conv-del" data-role="cmd" data-cmd="agentDeleteConvItem" data-cmd-arg="' + escAttr(c.id) + '" title="' + escAttr(delLabel) + '" aria-label="' + escAttr(delLabel) + '">' + icon('trash', 13) + '</button>';
      html += '</div>';
    }
    el.innerHTML = html;
    if (!state.agentActiveConvId && list.length > 0) {
      agentBrowser.agentSelectConv(list[0].id);
    }
  };

  // R131: the main process stores the literal "New Chat" as an untitled
  // conversation's title (local-agent.ts auto-titles it on the first message),
  // so `c.title || t(...)` never falls back — the English sentinel renders
  // verbatim. Map the sentinel to the localized label for display only; the
  // stored value stays untouched so auto-titling keeps working.
  function convTitle(conv) {
    var title = conv && conv.title;
    if (!title || title === 'New Chat') return t('agent.chat-title', 'New Chat');
    return title;
  }

  // S2-14: the chat's empty states share one anatomy (icon plate + title +
  // hint). The welcome variants add suggestion chips — real prompts, click
  // sends them (agentSend auto-creates the conversation when none is active).
  function emptyChatHtml(iconName, titleKey, titleFb, hintKey, hintFb, withSuggestions) {
    var h = '<div class="chat-empty"><div class="chat-empty-icon">' + icon(iconName, 40) + '</div>' +
      '<div class="chat-empty-title">' + esc(t(titleKey, titleFb)) + '</div>' +
      '<div class="chat-empty-hint' + (withSuggestions ? ' is-wide' : '') + '">' + esc(t(hintKey, hintFb)) + '</div>';
    if (withSuggestions) {
      h += '<div class="chat-suggestions">';
      for (var i = 1; i <= 3; i++) {
        var prompt = t('agent.suggest.' + i, '');
        if (!prompt) continue;
        h += '<button type="button" class="chat-suggestion" data-role="cmd" data-cmd="agentUseSuggestion" data-cmd-arg="' + escAttr(prompt) + '">' + icon('sparkle', 14) + '<span>' + esc(prompt) + '</span></button>';
      }
      h += '</div>';
    }
    return h + '</div>';
  }
  function welcomeHtml() {
    return emptyChatHtml('robot', 'agent.welcome.title', "Hi, I'm your browser agent", 'agent.welcome.sub', 'Ask me to drive the browser, check proxies, or run an automation.', true);
  }
  function noConvHtml() {
    return emptyChatHtml('chat', 'agent.no-conv-title', 'No conversation selected', 'agent.no-conv-hint', 'Select one from the sidebar or create a new one', false);
  }

  agentBrowser.agentUseSuggestion = function(prompt) {
    var input = document.getElementById('agent-chat-input');
    if (!input || !prompt) return;
    input.value = prompt;
    agentBrowser.agentSend();
  };

  agentBrowser.agentNewConv = function() {
    R.agent.conversations.create().then(function(c) {
      state.agentActiveConvId = c.id;
      state.agentMessages = [];
      document.getElementById('agent-chat-title').textContent = convTitle(c);
      document.getElementById('agent-chat-messages').innerHTML = welcomeHtml();
      document.getElementById('agent-chat-status').textContent = '';
      agentBrowser.agentLoadConversations();
    }).catch(function(e) { toast(t('agent.create-failed', 'Failed to create conversation: ') + e.message, 'error'); });
  };

  // R15 UX P1-3: failure toasts + clears stale messages instead of
  // silently keeping the previous conversation on screen.
  agentBrowser.agentSelectConv = function(convId) {
    R.agent.conversations.get(convId).then(function(conv) {
      if (!conv) { toast(t('agent.conv-missing', 'Conversation not found — it may have been deleted'), 'error'); return; }
      state.agentActiveConvId = convId;
      state.agentMessages = conv.messages || [];
      document.getElementById('agent-chat-title').textContent = convTitle(conv);
      agentBrowser.agentRenderMessages();
      agentBrowser.agentLoadConversations();
    }).catch(function(e) {
      console.error('Load conversation:', e);
      toast((e && e.message) || t('agent.conv-load-failed', 'Failed to load conversation'), 'error');
      state.agentActiveConvId = null;
      state.agentMessages = [];
      agentBrowser.agentRenderMessages();
    });
  };

  agentBrowser.agentDeleteConv = function() {
    if (!state.agentActiveConvId) return;
    agentBrowser.confirm(t('agent.delete-confirm', 'Delete this conversation? All messages will be lost.'), function() {
      R.agent.conversations.delete(state.agentActiveConvId).then(function() {
        state.agentActiveConvId = null;
        state.agentMessages = [];
        document.getElementById('agent-chat-messages').innerHTML = noConvHtml();
        agentBrowser.agentLoadConversations();
      });
    });
  };

  // S2-15: per-row delete (hover-reveal in the conversation list). Deleting
  // the active conversation falls back to the no-conversation state;
  // deleting any other just refreshes the list.
  agentBrowser.agentDeleteConvItem = function(convId) {
    if (!convId) return;
    agentBrowser.confirm(t('agent.delete-confirm', 'Delete this conversation? All messages will be lost.'), function() {
      R.agent.conversations.delete(convId).then(function() {
        if (state.agentActiveConvId === convId) {
          state.agentActiveConvId = null;
          state.agentMessages = [];
          document.getElementById('agent-chat-title').textContent = t('agent.chat-title', 'New Chat');
          document.getElementById('agent-chat-messages').innerHTML = noConvHtml();
          document.getElementById('agent-chat-status').textContent = '';
        }
        agentBrowser.agentLoadConversations();
      });
    });
  };

  // ── Chat ──
  // R15 UX P1-4: disable input while creating the conversation (double-clicks
  // created duplicate conversations) and keep the draft on failure.
  agentBrowser.agentSend = function() {
    var input = document.getElementById('agent-chat-input');
    var msg = input.value.trim();
    if (!msg) return;
    if (input.disabled) return;
    if (!state.agentActiveConvId) {
      // Create conversation first
      input.disabled = true;
      R.agent.conversations.create(msg.slice(0, 40)).then(function(c) {
        state.agentActiveConvId = c.id;
        agentBrowser.agentLoadConversations();
        agentBrowser._doAgentSend(msg);
      }).catch(function(e) {
        input.disabled = false;
        toast((e && e.message) || t('agent.create-failed', 'Failed to create conversation: '), 'error');
      });
      return;
    }
    agentBrowser._doAgentSend(msg);
  };

  agentBrowser._doAgentSend = function(msg) {
    var input = document.getElementById('agent-chat-input');
    input.value = '';
    input.disabled = true;
    var statusEl = document.getElementById('agent-chat-status');
    statusEl.textContent = t('agent.thinking', 'Thinking...');
    // R128: the send button is icon-only — swap the glyph, not the text, or
    // the arrow disappears for the rest of the session.
    var sendBtn = document.querySelector('#agent-view-chat .btn-primary');
    if (sendBtn) { sendBtn.disabled = true; setSendIcon(sendBtn, 'loader'); }

    // Add user message locally for immediate display
    state.agentMessages.push({ role: 'user', content: msg, timestamp: Date.now() });
    agentBrowser.agentRenderMessages();

    // Streaming assistant message placeholder
    var assistantIdx = state.agentMessages.length;
    state.agentMessages.push({ role: 'assistant', content: '', timestamp: Date.now() });
    agentBrowser.agentRenderMessages();

    // Correlate this request's stream events. Only payloads whose streamId
    // matches are applied — this prevents stale listeners or concurrent sends
    // from mutating the wrong assistant bubble.
    var streamId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ('stream_' + Math.random().toString(36).slice(2) + Date.now().toString(36));
    var matchStream = function(payload) { return payload && payload.streamId === streamId; };

    var lastToolCalls = [];
    var finalReply = '';
    var gotDone = false;
    var cleaned = false;
    var rafPending = false;
    var lastRendered = '';

    var isNearBottom = function(el) {
      if (!el) return true;
      return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    var updateScrollAffordance = function() {
      var wrap = document.getElementById('agent-chat-messages');
      var btn = document.getElementById('agent-scroll-bottom');
      if (!wrap || !btn) return;
      var near = isNearBottom(wrap);
      btn.style.display = near ? 'none' : 'block';
      if (near) {
        var badge = document.getElementById('agent-scroll-badge');
        if (badge) badge.style.display = 'none';
      }
    };
    // Throttled incremental render: only re-render the active assistant bubble,
    // and at most once per animation frame, so long Markdown responses don't
    // thrash the whole message list on every token.
    var scheduleRender = function() {
      if (rafPending) return;
      rafPending = true;
      (window.requestAnimationFrame || function(fn) { setTimeout(fn, 16); })(function() {
        rafPending = false;
        var cont = document.getElementById('agent-chat-messages');
        var shouldStick = isNearBottom(cont);
        agentBrowser.agentRenderMessages({ preserveScroll: !shouldStick });
        var node = document.querySelector('#agent-chat-messages .chat-msg-agent:last-child .chat-bubble-agent');
        if (node && state.agentMessages[assistantIdx]) {
          node.innerHTML = renderChatMarkdown(state.agentMessages[assistantIdx].content);
        }
        if (shouldStick && cont) cont.scrollTop = cont.scrollHeight;
        else if (cont) {
          var badge = document.getElementById('agent-scroll-badge');
          if (badge) badge.style.display = 'inline-flex';
        }
        updateScrollAffordance();
      });
    };
    var onChunk = function(payload) {
      if (!matchStream(payload)) return;
      var text = (payload && typeof payload === 'object') ? payload.text : payload;
      if (text == null) text = '';
      finalReply += String(text);
      state.agentMessages[assistantIdx].content = finalReply;
      if (finalReply !== lastRendered) { lastRendered = finalReply; scheduleRender(); }
    };
    var onToolCall = function(tc) {
      if (!matchStream(tc)) return;
      lastToolCalls.push(tc);
      // Maintain both the redacted toolCalls (persisted) and a live steps log
      // (rendered with order + arg summary + a "running" indicator).
      state.agentMessages[assistantIdx].toolCalls = lastToolCalls.map(function(t) { return { name: t.name, redacted: true }; });
      var steps = state.agentMessages[assistantIdx].steps || [];
      // S2-13: the stream only emits call-starts, so a step's wall time is
      // stamped when the NEXT call arrives (and the last one at stream-done).
      if (steps.length > 0) {
        var prev = steps[steps.length - 1];
        if (prev.done === false) { prev.done = true; prev.doneAt = Date.now(); }
      }
      var argSummary = '';
      try { argSummary = tc.arguments ? JSON.stringify(JSON.parse(tc.arguments)) : ''; } catch (e) { argSummary = String(tc.arguments || ''); }
      if (argSummary.length > 120) argSummary = argSummary.slice(0, 120) + '…';
      steps.push({ name: tc.name, args: argSummary, at: Date.now(), done: false });
      state.agentMessages[assistantIdx].steps = steps;
      agentBrowser.agentRenderMessages();
    };
    var onDone = function(payload) {
      if (!matchStream(payload)) return;
      gotDone = true;
      // Mark every step as finished so spinners become checkmarks.
      var steps = state.agentMessages[assistantIdx] && state.agentMessages[assistantIdx].steps;
      if (steps) for (var k = 0; k < steps.length; k++) {
        steps[k].done = true;
        if (typeof steps[k].doneAt !== 'number') steps[k].doneAt = Date.now();
      }
      agentBrowser.agentRenderMessages();
      cleanup();
    };
    // Normalize an error payload to a human string. The main process sends
    // { error: "..." }; ipc may also wrap in Error or pass a bare object.
    // Without this, a bare object renders as "[object Object]".
    var explainError = function(err) {
      if (err == null) return '';
      if (typeof err === 'string') return err;
      if (err.message) return String(err.message);
      if (typeof err.error === 'string') return err.error;
      if (err.error && err.error.message) return String(err.error.message);
      try { return JSON.stringify(err); } catch (e) { return String(err); }
    };
    var onError = function(err) {
      // Stream-error payloads carry streamId; bare catch errors don't.
      if (err && err.streamId && !matchStream(err)) return;
      if (gotDone || cleaned) return;
      var why = explainError(err) || t('agent.stream-error', 'Stream error');
      console.error('[agent] stream error:', err);
      state.agentMessages[assistantIdx].content = finalReply || why;
      agentBrowser.agentRenderMessages();
      cleanup();
    };
    var cleanup = function() {
      if (cleaned) return;
      cleaned = true;
      statusEl.textContent = '';
      if (sendBtn) { sendBtn.disabled = false; setSendIcon(sendBtn, 'arrowUp'); }
      input.disabled = false;
      input.focus();
      // Always remove this request's listeners — done, error, and the promise
      // result all funnel here, so no listeners leak across sends.
      api.removeListener('agent:stream-chunk', onChunk);
      api.removeListener('agent:stream-tool-call', onToolCall);
      api.removeListener('agent:stream-done', onDone);
      api.removeListener('agent:stream-error', onError);
      agentBrowser.agentRenderMessages({ scrollOnly: true });
      agentBrowser.agentLoadConversations();
    };

    // Subscribe to stream events
    api.on('agent:stream-chunk', onChunk);
    api.on('agent:stream-tool-call', onToolCall);
    api.on('agent:stream-done', onDone);
    api.on('agent:stream-error', onError);

    R.agent.chatStream(state.agentActiveConvId, msg, streamId).then(function(r) {
      // The main process resolves after the stream completes. If it returned an
      // error without ever sending a stream-error event, surface it here.
      if (r && r.error && !gotDone) { onError(r); return; }
      // Ensure cleanup even on a clean resolve that did not emit stream-done.
      if (!gotDone) cleanup();
    }).catch(function(e) {
      if (!gotDone) onError(e.message || String(e));
      else cleanup();
    });
  };

  agentBrowser.agentScrollBottom = function() {
    var el = document.getElementById('agent-chat-messages');
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    var badge = document.getElementById('agent-scroll-badge');
    if (badge) badge.style.display = 'none';
    var btn = document.getElementById('agent-scroll-bottom');
    if (btn) btn.style.display = 'none';
  };
  agentBrowser.onAgentScroll = function() {
    var wrap = document.getElementById('agent-chat-messages');
    var btn = document.getElementById('agent-scroll-bottom');
    if (!wrap || !btn) return;
    var near = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
    btn.style.display = near ? 'none' : 'block';
    if (near) {
      var badge = document.getElementById('agent-scroll-badge');
      if (badge) badge.style.display = 'none';
    }
  };
  // S2-13: per-step wall time (stamped at next-call / stream-done). Persisted
  // steps from older sessions have no stamps and render without a duration.
  function stepDuration(s) {
    if (!s || typeof s.at !== 'number' || typeof s.doneAt !== 'number') return '';
    var ms = s.doneAt - s.at;
    if (!isFinite(ms) || ms < 0) return '';
    var sec = ms / 1000;
    return sec < 10 ? sec.toFixed(1) + 's' : Math.round(sec) + 's';
  }

  agentBrowser.agentRenderMessages = function(opts) {
    var el = document.getElementById('agent-chat-messages');
    var preserveScroll = !!(opts && opts.preserveScroll);
    var prevTop = el ? el.scrollTop : 0;
    var html = '';
    for (var i = 0; i < state.agentMessages.length; i++) {
      var m = state.agentMessages[i];
      if (m.role === 'user') {
        html += '<div class="chat-msg chat-msg-user"><div class="chat-bubble chat-bubble-user">' + esc(m.content) + '</div></div>';
      } else if (m.role === 'assistant') {
        // S2-12: the brand robot rides every assistant message on a 24px tint
        // plate — agent output is identifiable at a glance, no label row.
        html += '<div class="chat-msg chat-msg-agent"><div class="chat-avatar">' + icon('robot', 14) + '</div><div class="chat-bubble chat-bubble-agent">' + renderChatMarkdown(m.content) + '</div></div>';
        // Execution steps: collapsible trace card (S2-13). Open while any
        // step is still running so the spinner stays on screen; collapses to
        // a one-line summary once the run finishes.
        var steps = m.steps || m.toolCalls || [];
        if (steps.length > 0) {
          var running = false;
          for (var j0 = 0; j0 < steps.length; j0++) { if (steps[j0].done === false) { running = true; break; } }
          html += '<details class="chat-trace"' + (running ? ' open' : '') + '><summary>' + icon('zap', 12) + '<span>' + esc(t('agent.trace.title', 'Tool calls')) + '</span><span class="chat-trace-count">· ' + steps.length + '</span>' + (running ? '<span class="chat-tool-spinner" style="margin-left:auto;">' + icon('clock', 12) + '</span>' : '') + '</summary>';
          html += '<div class="chat-tools">';
          for (var j = 0; j < steps.length; j++) {
            var s = steps[j];
            var label = s.name || (s.toolCalls && s.toolCalls.name) || 'tool';
            var argInfo = s.args ? '<span class="chat-tool-args"> ' + esc(s.args) + '</span>' : '';
            var spinner = s.done === false ? '<span class="chat-tool-spinner">' + icon("clock", 12) + '</span>' : '<span class="chat-tool-done">' + icon("check", 12) + '</span>';
            var dur = stepDuration(s);
            var durHtml = dur ? '<span class="chat-tool-dur">' + dur + '</span>' : '';
            html += '<div class="chat-tool-step"><span class="chat-tool-num">' + (j + 1) + '.</span> ' + spinner + ' <span class="chat-tool-chip">' + esc(label) + '</span>' + argInfo + durHtml + '</div>';
          }
          html += '</div></details>';
        }
      } else if (m.role === 'tool') {
        // R142: the trace line is icon + text, so it needs a flex row to centre
        // the glyph (it used to sit 1.4px below the text baseline). The wrapper
        // stays a plain block so a long trace still wraps inside the bubble.
        html += '<div style="padding:0 12px 4px 40px;font-size:10px;color:var(--text-muted);"><span class="icon-text">' + icon("arrowRight", 11) + ' ' + esc(String(m.content).slice(0, 160)) + '</span></div>';
      }
    }
    el.innerHTML = html || welcomeHtml();
    if (preserveScroll) el.scrollTop = prevTop;
    else el.scrollTop = el.scrollHeight;
    // Keep the affordance in sync even for non-stream renders.
    var wrap = document.getElementById('agent-chat-messages');
    var btn = document.getElementById('agent-scroll-bottom');
    if (wrap && btn) {
      var near = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
      btn.style.display = near ? 'none' : 'block';
      if (near) {
        var badge = document.getElementById('agent-scroll-badge');
        if (badge) badge.style.display = 'none';
      }
    }
  };
})();
