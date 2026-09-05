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

  // ── Conversation List ──
  agentBrowser.agentLoadConversations = function() {
    R.agent.conversations.list().then(function(list) {
      var el = document.getElementById('agent-conv-list');
      if (!list || list.length === 0) {
        el.innerHTML = '<div style="color:var(--text-muted);font-size:11px;text-align:center;padding:16px;">No chats yet</div>';
        agentBrowser.agentNewConv();
        return;
      }
      var html = '';
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        var isActive = c.id === state.agentActiveConvId;
        html += '<div data-role="cmd" data-cmd="agentSelectConv" data-cmd-arg="' + escAttr(c.id) + '" class="agent-conv-item" style="padding:10px 12px;cursor:pointer;' + (isActive ? 'background:var(--primary-bg);' : '') + '">';
        html += '<div style="font-weight:500;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(c.title || t('agent.chat-title', 'New Chat')) + '</div>';
        html += '<div style="color:var(--text-muted);font-size:10px;margin-top:2px;">' + (c.messageCount || 0) + ' msgs</div>';
        html += '</div>';
      }
      el.innerHTML = html;
      if (!state.agentActiveConvId && list.length > 0) {
        agentBrowser.agentSelectConv(list[0].id);
      }
    }).catch(function(e) {
      console.error('Load conversations:', e);
      document.getElementById('agent-conv-list').innerHTML = '<div style="color:var(--danger);font-size:11px;text-align:center;padding:16px;">' + esc(t('agent.load-failed', 'Failed to load conversations')) + '<br><button class="btn btn-xs btn-primary" data-role="cmd" data-cmd="agentLoadConversations" style="margin-top:8px;">' + esc(t('agent.retry', 'Retry')) + '</button></div>';
    });
  };

  agentBrowser.agentNewConv = function() {
    R.agent.conversations.create().then(function(c) {
      state.agentActiveConvId = c.id;
      state.agentMessages = [];
      document.getElementById('agent-chat-title').textContent = c.title || t('agent.chat-title', 'New Chat');
      document.getElementById('agent-chat-messages').innerHTML = '<div class="chat-empty"><div class="chat-empty-icon">✨</div><div class="chat-empty-title">' + esc(t('agent.empty-title', 'New conversation')) + '</div><div class="chat-empty-hint">' + esc(t('agent.empty-hint', 'Ask me anything!')) + '</div></div>';
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
      document.getElementById('agent-chat-title').textContent = conv.title || t('agent.chat-title', 'New Chat');
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
        document.getElementById('agent-chat-messages').innerHTML = '<div class="chat-empty"><div class="chat-empty-icon">💬</div><div class="chat-empty-title">' + esc(t('agent.no-conv-title', 'No conversation selected')) + '</div><div class="chat-empty-hint">' + esc(t('agent.no-conv-hint', 'Select one from the sidebar or create a new one')) + '</div></div>';
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
    var sendBtn = document.querySelector('#agent-view-chat .btn-primary');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '...'; }

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
      if (steps) for (var k = 0; k < steps.length; k++) steps[k].done = true;
      agentBrowser.agentRenderMessages();
      cleanup();
    };
    // Normalize an error payload to a human string. The main process sends
    // { error: "..." }; ipc may also wrap in Error or pass a bare object.
    // Without this, '❌ ' + { error: '...' } renders as "❌ [object Object]".
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
      state.agentMessages[assistantIdx].content = finalReply || ('❌ ' + why);
      agentBrowser.agentRenderMessages();
      cleanup();
    };
    var cleanup = function() {
      if (cleaned) return;
      cleaned = true;
      statusEl.textContent = '';
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '↑'; }
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
        html += '<div class="chat-msg chat-msg-agent"><div class="chat-bubble chat-bubble-agent">' + renderChatMarkdown(m.content) + '</div></div>';
        // Execution steps: ordered list of tool calls with arg summaries.
        var steps = m.steps || m.toolCalls || [];
        if (steps.length > 0) {
          html += '<div class="chat-tools">';
          for (var j = 0; j < steps.length; j++) {
            var s = steps[j];
            var label = s.name || (s.toolCalls && s.toolCalls.name) || 'tool';
            var argInfo = s.args ? '<span class="chat-tool-args"> ' + esc(s.args) + '</span>' : '';
            var spinner = s.done === false ? '<span class="chat-tool-spinner">●</span>' : '<span class="chat-tool-done">✓</span>';
            html += '<div class="chat-tool-step"><span class="chat-tool-num">' + (j + 1) + '.</span> ' + spinner + ' <span class="chat-tool-chip">' + esc(label) + '</span>' + argInfo + '</div>';
          }
          html += '</div>';
        }
      } else if (m.role === 'tool') {
        html += '<div style="padding:0 12px 4px;font-size:10px;color:var(--text-muted);">↳ ' + esc(m.content).slice(0, 160) + '</div>';
      }
    }
    el.innerHTML = html || '<div class="chat-empty"><div class="chat-empty-icon">💬</div><div class="chat-empty-title">' + esc(t('agent.start-title', 'Start a conversation')) + '</div><div class="chat-empty-hint">' + esc(t('agent.start-hint', 'Type a message below to begin')) + '</div></div>';
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
