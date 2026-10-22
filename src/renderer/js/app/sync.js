(function() {
  "use strict";

  var agentBrowser = window.agentBrowser;
  var api = agentBrowser.api;
  var helpers = agentBrowser.helpers;
  var toast = helpers.toast;
  var esc = helpers.esc;
  var escAttr = helpers.escAttr;

  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }

  // Reads belong to a view epoch, not just to their individual requests. A
  // mutation's start AND completion revoke every earlier read, including errors.
  var viewEpoch = 0;
  var statusSeq = 0;
  var previewSeq = 0;
  var syncDiffSeq = 0;
  var teamSeq = 0;
  var serverGeneration = -1;
  var serverPhase = 'idle';
  var serverOperationId = null;
  var activeOperation = null;
  var localOperation = null;
  var viewedComparison = null;
  var lastResult = null;
  var formBaseline = {};
  var formTouched = {};
  var formFields = ['sync-enabled', 'sync-endpoint-input', 'sync-bucket-input', 'sync-custody-consent', 'sync-history-consent', 'sync-include-history', 'sync-full-profile-consent', 'sync-ak-input', 'sync-sk-input'];
  var checkboxFields = { 'sync-enabled': true, 'sync-custody-consent': true, 'sync-history-consent': true, 'sync-include-history': true, 'sync-full-profile-consent': true };
  var fullProfilePassphraseSet = false;
  var savedFullProfileScope = false;
  var pullStrategyExplicit = false;
  var savedHistoryScope;
  var lastHistoryStatus = null;
  var historyObservations = {};
  var controls = [
    { cmd: 'syncPush', kind: 'push', key: 'sync.push', fallback: 'Push' },
    { cmd: 'syncPull', kind: 'pull', key: 'sync.pull', fallback: 'Pull' },
    { cmd: 'syncSave', kind: 'configure', key: 'common.save', fallback: 'Save' }
  ];

  function syncPanel(id) {
    var el = document.getElementById(id);
    var parent = document.getElementById('sync-status');
    if (!el && parent && typeof document.createElement === 'function') {
      el = document.createElement('div');
      el.id = id;
      el.style.marginTop = '8px';
      el.style.wordBreak = 'break-word';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      parent.appendChild(el);
    }
    return el;
  }

  function setControlLabel(btn, text) {
    // Preserve the hydrated SVG and any element label; never textContent an
    // icon host. Old standalone control fixtures may expose only textContent.
    if (!btn.childNodes || !btn.appendChild || !document.createTextNode) { btn.textContent = text; return; }
    var icons = Array.prototype.filter.call(btn.childNodes, function(node) { return node.nodeType === 1 && String(node.tagName).toLowerCase() === 'svg'; });
    btn.textContent = '';
    icons.forEach(function(node) { btn.appendChild(node); });
    btn.appendChild(document.createTextNode((icons.length ? ' ' : '') + text));
  }

  function operationKind(kind) {
    return kind === 'push' ? t('sync.operation.push', 'Push') : kind === 'pull' ? t('sync.operation.pull', 'Pull') : t('sync.operation.configure', 'Save sync configuration');
  }

  function renderOperationState() {
    var busy = !!(localOperation || activeOperation);
    controls.forEach(function(control) {
      var btn = document.querySelector('#tab-sync [data-cmd="' + control.cmd + '"]');
      if (!btn) return;
      if (busy && !control.owned) { control.wasDisabled = btn.disabled; control.owned = true; }
      if (busy) btn.disabled = true;
      else if (control.owned) { btn.disabled = !!control.wasDisabled; control.owned = false; }
      var label = t(control.key, control.fallback);
      if (localOperation && localOperation.kind === control.kind) {
        label = localOperation.stage === 'checking' ? t('sync.operation.checking', 'Checking…') : t('sync.operation.in-progress', 'Sync operation in progress…');
      }
      setControlLabel(btn, label);
    });
    var tab = document.getElementById('tab-sync');
    if (tab) tab.setAttribute('aria-busy', busy ? 'true' : 'false');
    var panel = syncPanel('sync-operation-state');
    if (!panel) return;
    var operation = activeOperation || localOperation;
    panel.className = busy ? 'health-text-watch' : '';
    if (!operation) { panel.textContent = ''; return; }
    var message = !activeOperation && localOperation && localOperation.serviceCompleted
      ? t('sync.operation.waiting-result', 'Waiting for the operation result; it has not been cancelled.')
      : localOperation && localOperation.stage === 'checking' && !activeOperation
        ? t('sync.operation.checking', 'Checking…')
        : t('sync.operation.in-progress', 'Sync operation in progress…');
    panel.textContent = operationKind(operation.kind) + ' · ' + message + (operation.operationId ? ' · ' + shortId(operation.operationId) : '');
  }

  function clearComparison(message) {
    viewedComparison = null;
    var list = document.getElementById('sync-diff');
    var label = document.getElementById('sync-diff-message');
    if (list) list.innerHTML = '';
    if (label) label.innerHTML = '<span class="health-text-watch">' + esc(message || t('sync.compare.required', 'Compare with remote before pulling; previous choices have been cleared.')) + '</span>';
  }

  function invalidateViews() {
    viewEpoch++; statusSeq++; previewSeq++; syncDiffSeq++; teamSeq++;
    historyObservations = {};
    clearComparison();
    var preview = document.getElementById('sync-preview');
    var label = document.getElementById('sync-preview-message');
    if (preview) preview.innerHTML = '';
    if (label) label.textContent = t('sync.operation.refreshing', 'Sync state changed; refreshing the preview…');
  }

  function invalidateSurfaceCaches() {
    ['invalidateProfilesForSync', 'invalidateAccountsForSync', 'invalidateProxiesForSync', 'invalidateExtensionsForSync'].forEach(function(name) {
      if (typeof agentBrowser[name] === 'function') agentBrowser[name]();
    });
  }

  function refreshSurfaces() {
    var epoch = viewEpoch;
    var loaders = [['loadProfiles', true], [typeof agentBrowser.agentLoadAccounts === 'function' ? 'agentLoadAccounts' : 'loadAccountsTab'], ['loadProxies'], ['loadExtensionsTab']];
    var extensionDialog = document.getElementById('dlg-extensions');
    if (extensionDialog && extensionDialog.open) loaders.push(['_extRefreshList']);
    return Promise.all(loaders.map(function(loader) {
      if (typeof agentBrowser[loader[0]] !== 'function') return null;
      return Promise.resolve().then(function() { return agentBrowser[loader[0]].apply(agentBrowser, loader.slice(1)); }).catch(function() {
        if (epoch === viewEpoch) toast(t('sync.refresh.failed', 'Sync result was received, but a view could not be refreshed. Reload that view before acting on it.'), 'warning');
      });
    }));
  }

  function captureForm() {
    var draft = {};
    formFields.forEach(function(id) { var el = document.getElementById(id); if (el) draft[id] = checkboxFields[id] ? el.checked : el.value; });
    return draft;
  }

  formFields.forEach(function(id) {
    var el = document.getElementById(id);
    if (el && typeof el.addEventListener === 'function') {
      var touch = function() { formTouched[id] = true; };
      el.addEventListener('input', touch); el.addEventListener('change', touch);
    }
  });

  var fullProfileBox = document.getElementById('sync-full-profile-consent');
  var pullStrategySelect = document.getElementById('sync-merge-strategy');
  if (pullStrategySelect && typeof pullStrategySelect.addEventListener === 'function') {
    pullStrategySelect.addEventListener('change', function() { pullStrategyExplicit = true; });
  }
  function defaultPullStrategy() {
    return savedFullProfileScope || fullProfileBox && fullProfileBox.checked ? 'remote' : 'local';
  }
  function applyPullStrategyDefault() {
    if (pullStrategySelect && !pullStrategyExplicit) pullStrategySelect.value = defaultPullStrategy();
    var note = document.getElementById('sync-full-profile-pull-note');
    if (note) {
      note.style.display = defaultPullStrategy() === 'remote' ? '' : 'none';
      note.textContent = t('sync.full-profile.pull-strategy', 'Full migration defaults to a complete remote restore; the original directory is kept as a backup. You can explicitly change the strategy.');
    }
  }
  if (fullProfileBox && typeof fullProfileBox.addEventListener === 'function') {
    fullProfileBox.addEventListener('change', function() {
      if (fullProfileBox.checked) ['sync-history-consent', 'sync-include-history'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) { el.checked = true; formTouched[id] = true; }
      });
      applyPullStrategyDefault();
    });
  }
  ['sync-history-consent', 'sync-include-history'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el && typeof el.addEventListener === 'function') el.addEventListener('change', function() {
      if (el.checked) return;
      if (fullProfileBox) { fullProfileBox.checked = false; formTouched['sync-full-profile-consent'] = true; }
      if (id === 'sync-history-consent') {
        var includeHistory = document.getElementById('sync-include-history');
        if (includeHistory) { includeHistory.checked = false; formTouched['sync-include-history'] = true; }
      }
      applyPullStrategyDefault();
    });
  });

  function hydrateField(id, value, requestedDraft, savedDraft) {
    var el = document.getElementById(id);
    if (!el) return;
    var current = checkboxFields[id] ? el.checked : el.value;
    var ownSavedValue = savedDraft && current === savedDraft[id];
    if (!ownSavedValue && (formTouched[id] || current !== requestedDraft[id] || (Object.prototype.hasOwnProperty.call(formBaseline, id) && current !== formBaseline[id]))) return;
    if (checkboxFields[id]) el.checked = value; else el.value = value;
    formBaseline[id] = value;
    formTouched[id] = false;
  }

  function comparisonToken(diff) {
    var token = diff && diff.comparisonToken;
    if (!token || ['targetId', 'localHash', 'remoteHash'].some(function(key) { return typeof token[key] !== 'string' || !token[key]; })) return null;
    return { targetId: token.targetId, localHash: token.localHash, remoteHash: token.remoteHash };
  }

  var OUTCOME = { complete: 'Complete in reported scope', partial: 'Partial completion', failed: 'Failed', cancelled: 'Cancelled', 'recovery-required': 'Recovery required' };
  var COMMIT = { none: 'No commit reported', committed: 'Committed', partial: 'Partially committed', unknown: 'Unknown' };
  var ITEM = { applied: 'Applied', uploaded: 'Uploaded', queued: 'Queued', preserved: 'Preserved', skipped: 'Skipped', failed: 'Failed', unknown: 'Unknown' };
  var SCOPE = { config: 'Configuration', profiles: 'Profiles', cookies: 'Cookies', localStorage: 'LocalStorage', preferences: 'Preferences', extensions: 'Extensions', history: 'History / Firefox bookmarks', fullProfile: 'Full environment artifact', credentials: 'Saved browser passwords', sidecar: 'Compatibility sidecars', baseline: 'Sync baseline' };
  var HISTORY_COVERAGE = { legacy: 'Legacy backup: history not covered', unselected: 'History not selected', absent: 'Source confirmed absent (not an empty database)', empty: 'Complete empty database snapshot', complete: 'Complete database snapshot', preserved: 'Previous snapshot preserved', failed: 'History capture failed' };
  var HISTORY_FRESHNESS = { captured: 'Captured at the recorded time', preserved: 'Not freshly captured', 'not-covered': 'Not covered', 'not-rechecked': 'Local content not rechecked' };
  var HISTORY_COMPARE = { synced: 'Semantic baseline matches', dirty: 'History has local changes', unknown: 'Local content not rechecked or unavailable', unselected: 'History not selected' };
  function historyLabel(coverage) {
    if (!coverage) return t('sync.history.coverage.legacy', HISTORY_COVERAGE.legacy);
    var state = coverage.coverage || coverage.state || 'legacy';
    return resultLabel('sync.history.coverage.', HISTORY_COVERAGE, state) + ' · ' + resultLabel('sync.history.freshness.', HISTORY_FRESHNESS, coverage.freshness || 'not-covered');
  }
  function identityLabel(identity) {
    var state = identity && identity.configuration && identity.configuration.state || 'not-verifiable';
    var labels = { retained: 'Configuration identity retained', changed: 'Configuration identity changed', 'not-verifiable': 'Configuration identity not verifiable', 'missing-seed': 'Legacy configuration has no identity seed' };
    return t('identity.config.' + state, labels[state] || labels['not-verifiable']) + ' · ' + t('identity.runtime.not-verified', 'Runtime fingerprint not re-verified');
  }
  function runtimeEffectHtml(item) {
    var effect = item && item.runtimeEffect;
    if (!effect || typeof effect !== 'object') return '';
    var note = effect.action === 'skipped-stop-required' && item.state === 'skipped'
      ? t('sync.result.runtime.stop-required', 'Stop this profile and wait for browser exit, then pull again. No profile data or settings were applied.')
      : effect.action === 'running-partial'
        ? t('sync.result.runtime.running-partial', 'A partial live merge was explicitly requested. Inspect per-item effects, stop this profile, wait for browser exit, then start a fresh browser and verify restored data.')
        : item.state === 'applied' && effect.state === 'stopped'
          ? t('sync.result.runtime.stopped', 'Changes were applied while the browser was confirmed stopped. Start the profile and verify restored data; this is not a runtime fingerprint pass.')
          : t('sync.result.runtime.incomplete', 'Profile restore did not finish. Review per-item effects before retrying; restored data still requires a fresh launch and verification.');
    var html = '<div class="status-note">' + esc(note) + '</div>';
    if (Number.isInteger(effect.queuedCookies) && effect.queuedCookies > 0) html += '<div class="status-note">' + esc(t('sync.result.runtime.queued', '{n} Cookie(s) queued, not yet applied; they will be attempted on the next launch.').replace('{n}', String(effect.queuedCookies))) + '</div>';
    if (Number.isInteger(effect.liveCookiesApplied) && effect.liveCookiesApplied > 0) html += '<div class="status-note">' + esc(t('sync.result.runtime.live-cookies', '{n} Cookie(s) applied to the live browser.').replace('{n}', String(effect.liveCookiesApplied))) + '</div>';
    if (effect.liveCookiesUnconfirmed === true) html += '<div class="health-text-watch">' + esc(t('sync.result.runtime.live-unconfirmed', 'Live Cookie changes are unconfirmed; do not retry automatically.')) + '</div>';
    return html;
  }
  function resultLabel(prefix, labels, value) { return t(prefix + value, labels[value] || labels.unknown || value); }
  function fullProfileFailureMessage(code) {
    switch (code) {
      case 'FULL_PROFILE_SELECTION_REQUIRED':
        return t('sync.full-profile.selection-required', 'No remote profiles selected. Compare again, then choose Remote wins or select remote entries before pulling.');
      case 'FULL_PROFILE_COOKIE_QUEUE_PENDING':
        return t('sync.full-profile.cookie-queue-pending', 'An existing Cookie import queue is pending. Start the profile normally and confirm the existing Cookie import, then stop it and wait for confirmed browser exit before retrying full push/pull. Existing data and queue are retained.');
      case 'FULL_PROFILE_COOKIE_QUEUE_UNAVAILABLE':
        return t('sync.full-profile.cookie-queue-unavailable', 'The Cookie import queue is unreadable or invalid. Check and repair the existing queue before retrying full push/pull. Existing data and queue are retained; this is not an empty queue or a successful migration.');
      default: return '';
    }
  }
  function resultOutcome(r) { return fullProfileFailureMessage(r.code) ? 'failed' : OUTCOME[r.outcome] ? r.outcome : r.success ? 'complete' : 'failed'; }
  function limitedResult(r) {
    return r.browserBackupIncomplete === true || resultOutcome(r) !== 'complete' || !r.success || (r.warnings || []).length ||
      r.localCommit === 'partial' || r.remoteCommit === 'partial' || !COMMIT[r.localCommit] || !COMMIT[r.remoteCommit] ||
      r.localCommit === 'unknown' || r.remoteCommit === 'unknown' || (r.recovery || []).length ||
      (r.items || []).some(function(item) { return ['queued', 'skipped', 'unknown', 'failed', 'preserved'].indexOf(item.state) >= 0; });
  }

  function renderResult(r) {
    if (!r) return;
    // Events intentionally contain only summary facts. Do not erase detail
    // already returned by the matching IPC promise with a later summary.
    if (lastResult && r.operationId && r.operationId === lastResult.operationId) r = Object.assign({}, lastResult, r);
    lastResult = r;
    var panel = syncPanel('sync-operation-result');
    if (!panel) return;
    var outcome = resultOutcome(r);
    var limited = limitedResult(r);
    var tone = limited ? 'health-text-watch' : 'health-text-good';
    if (outcome === 'failed' || outcome === 'recovery-required') tone = 'health-text-poor';
    var heading = outcome === 'complete' && limited ? t('sync.result.limited', 'Completed with limitations') : resultLabel('sync.result.outcome.', OUTCOME, outcome);
    if (r.browserBackupIncomplete === true) heading = r.remoteCommit === 'committed'
      ? t('sync.result.backup-incomplete', 'Configuration published; browser backup incomplete')
      : t('sync.result.backup-not-published', 'Browser backup incomplete');
    var local = COMMIT[r.localCommit] ? r.localCommit : 'unknown';
    var remote = COMMIT[r.remoteCommit] ? r.remoteCommit : 'unknown';
    var html = '<div class="' + tone + '"><strong>' + esc(t('sync.result.title', 'Last synchronization result')) + ' · ' + esc(heading) + '</strong></div>' +
      '<div>' + esc(t('sync.result.local-commit', 'Local changes')) + ': ' + esc(resultLabel('sync.result.commit.', COMMIT, local)) + ' · ' + esc(t('sync.result.remote-commit', 'Remote publication')) + ': ' + esc(resultLabel('sync.result.commit.', COMMIT, remote)) + '</div>';
    var staticFailure = fullProfileFailureMessage(r.code);
    var message = staticFailure || r.message;
    if (message) html += '<div>' + esc(message) + '</div>';
    if (r.code) html += '<div><code>' + esc(r.code) + '</code></div>';
    (r.items || []).forEach(function(item) {
      // Queue parser diagnostics may contain Cookie values. Known full-mode
      // failures use static instructions, never free-text error payloads.
      var itemMessage = fullProfileFailureMessage(item.code) || (staticFailure ? '' : item.message);
      html += '<div>' + esc(resultLabel('sync.result.scope.', SCOPE, item.scope)) + (item.id ? ' · ' + esc(item.id) : '') + ': <strong>' + esc(resultLabel('sync.result.item.', ITEM, item.state)) + '</strong>' +
        (typeof item.count === 'number' ? ' (' + esc(String(item.count)) + ')' : '') + (itemMessage ? ' · ' + esc(itemMessage) : '') + (item.code ? ' · ' + esc(item.code) : '') + '</div>';
      if (item.scope === 'history') html += '<div class="status-note">' + esc(historyLabel(item.history)) + '</div>';
      if (item.identity) html += '<div class="status-note">' + esc(identityLabel(item.identity)) + '</div>';
      html += runtimeEffectHtml(item);
    });
    if (!staticFailure && (r.warnings || []).length) html += '<div class="health-text-watch"><strong>' + esc(t('sync.result.warnings', 'Warnings')) + '</strong>' + (r.warnings || []).map(function(warning) { return '<div>' + esc(warning) + '</div>'; }).join('') + '</div>';
    if ((r.recovery || []).length || outcome === 'recovery-required') {
      html += '<div class="health-text-poor">' + esc(t('sync.result.recovery', 'Manual recovery is required. Inspect the retained paths before retrying.')) + '</div>';
      (r.recovery || []).forEach(function(recovery) { html += '<div><code>' + esc(recovery.resource + ' · ' + recovery.id) + '</code>' + (recovery.paths || []).map(function(file) { return '<div><code>' + esc(file) + '</code></div>'; }).join('') + (recovery.receiptPath ? '<div><code>' + esc(recovery.receiptPath) + '</code></div>' : '') + '</div>'; });
    }
    panel.innerHTML = html;
  }

  function operationBusy() {
    if (!localOperation && !activeOperation) return false;
    toast(t('sync.operation.in-progress', 'Sync operation in progress…'), 'warning');
    return true;
  }

  function beginOperation(kind) {
    var operation = { kind: kind, stage: 'checking', operationId: null, startGeneration: serverGeneration, invalidated: false, awaitingReply: false, serviceCompleted: false };
    localOperation = operation;
    invalidateViews(); invalidateSurfaceCaches(); renderOperationState();
    return operation;
  }

  function ownsOperation(operation) { return localOperation === operation && !operation.invalidated; }

  function dispatchOperation(operation, invoke) {
    if (!ownsOperation(operation)) { toast(t('sync.compare.stale', 'Sync content changed. Compare again and choose resolutions afresh.'), 'warning'); return Promise.resolve(null); }
    operation.stage = 'running'; operation.dispatched = true; operation.awaitingReply = true; operation.serviceCompleted = false; operation.operationId = null;
    invalidateViews(); invalidateSurfaceCaches(); renderOperationState();
    // These are owned long-running writes, NOT the generic 15-second IPC write
    // wrapper. A UI timeout must not release an operation that can still commit.
    return Promise.resolve().then(invoke).then(function(r) {
      operation.awaitingReply = false;
      if (r && r.operationId) operation.operationId = r.operationId;
      return r;
    });
  }

  function refreshAfterOperation(savedDraft) {
    return Promise.all([loadSyncConfig(savedDraft), refreshSurfaces()]);
  }

  function finishOperation(operation, savedDraft) {
    if (localOperation !== operation) return Promise.resolve();
    localOperation = null;
    renderOperationState();
    if (activeOperation && activeOperation.operationId !== operation.operationId) return Promise.resolve();
    invalidateViews(); invalidateSurfaceCaches();
    return refreshAfterOperation(savedDraft);
  }

  function applyStateEvent(event) {
    if (!event || !Number.isSafeInteger(event.generation) || event.generation < 0 || typeof event.operationId !== 'string' || !event.operationId ||
      ['push', 'pull', 'configure'].indexOf(event.kind) < 0 || ['started', 'completed'].indexOf(event.phase) < 0) return;
    if (event.generation < serverGeneration) return;
    if (event.generation === serverGeneration && serverOperationId) {
      if (event.operationId !== serverOperationId || serverPhase === event.phase || serverPhase === 'completed') return;
    }
    var own = localOperation && ((localOperation.operationId === event.operationId) || (localOperation.awaitingReply && !localOperation.operationId && localOperation.kind === event.kind));
    if (own) localOperation.operationId = event.operationId;
    else if (localOperation) localOperation.invalidated = true;
    serverGeneration = event.generation; serverOperationId = event.operationId; serverPhase = event.phase;
    if (event.phase === 'started') activeOperation = { kind: event.kind, operationId: event.operationId };
    else if (event.kind !== 'configure' && activeOperation && activeOperation.operationId === event.operationId) activeOperation = null;
    // A result-less configure completion invalidates reads, not a different
    // push/pull lease. Keep that owner until fresh status or its own completion.
    if (own && event.phase === 'completed') localOperation.serviceCompleted = true;
    invalidateViews(); invalidateSurfaceCaches(); renderOperationState();
    if (event.phase === 'completed') {
      if (event.result) renderResult(Object.assign({}, event.result, { operationId: event.operationId }));
      refreshAfterOperation();
    } else loadSyncConfig();
  }

  if (typeof api.on === 'function') api.on('sync:state-changed', applyStateEvent);

  function previewCountCard(label, value, detail) {
    var displayValue = value == null ? 0 : value;
    return '<div class="profile-card">' +
      '<div class="card-header card-head-inline"><span class="name">' + esc(label) + '</span><span class="status-badge status-done">' + esc(String(displayValue)) + '</span></div>' +
      '<div style="font-size:11px;color:var(--text-muted);line-height:1.35;">' + esc(detail || '') + '</div>' +
    '</div>';
  }

  function renderPreview(preview) {
    var messageEl = document.getElementById('sync-preview-message');
    var listEl = document.getElementById('sync-preview');
    if (!messageEl || !listEl) return;
    preview = preview || {};
    var running = preview.runningProfiles || [];
    // R132: the main process composes `preview.message` in its own hardcoded
    // Chinese, so it cannot follow the renderer's locale. When sync is not
    // configured the message is a fixed string, so build it here instead;
    // the configured case still carries live counts from the main process.
    var message = preview.configured
      ? preview.message
      : t('sync.preview.unconfigured', 'Sync is not configured — set endpoint, bucket, and enable it');
    // R127: the message color carries configured/not — no glyph prefix needed.
    messageEl.innerHTML = '<span class="' + (preview.configured ? 'health-text-good' : 'health-text-watch') + '">' + esc(message || t('sync.preview.unavailable', 'Preview unavailable')) + '</span>';
    listEl.innerHTML = [
      previewCountCard(t('sync.preview.title.profiles','Profiles'), preview.profiles || 0, running.length ? t('sync.preview.profiles.running', '{n} running or unconfirmed — Pull skips each whole profile until stopped').replace('{n}', String(running.length)) : t('sync.preview.profiles.no-skip', 'No active profile detected; stopped state is rechecked before restoring')),
      previewCountCard(t('sync.preview.title.proxies','Proxies'), preview.proxies || 0, t('sync.preview.proxies', 'Synced with the config snapshot (secrets redacted)')),
      previewCountCard(t('sync.preview.title.accounts','Accounts'), preview.accounts || 0, t('sync.preview.accounts', 'Platform account metadata; passwords not shown')),
      previewCountCard(t('sync.preview.title.extensions','Extensions'), preview.extensions || 0, t('sync.preview.extensions', 'Private extension repository entries')),
    ].join('') + (running.length ? '<div class="profile-card" style="border-color: var(--warning-text);">' +
      '<div class="card-header card-head-inline"><span class="name">' + esc(t('sync.preview.running-title','Running or unconfirmed profiles')) + '</span><span class="status-badge status-running">' + esc(t('sync.preview.skip-badge','Stop required')) + '</span></div>' +
      '<div style="font-family:var(--mono);font-size:11px;color:var(--text-muted);word-break:break-all;">' + running.map(esc).join('<br>') + '</div>' +
    '</div>' : '');
  }

  function fetchPreview() {
    var epoch = viewEpoch, seq = ++previewSeq;
    return api.sync.preview().then(function(preview) {
      if (epoch !== viewEpoch) return null;
      if (seq === previewSeq) renderPreview(preview);
      return preview;
    });
  }

  agentBrowser.loadSyncPreview = function() {
    var listEl = document.getElementById('sync-preview');
    var messageEl = document.getElementById('sync-preview-message');
    var loading = t('common.loading', 'Loading...');
    if (listEl && agentBrowser.renderViewState) agentBrowser.renderViewState(listEl,{loading:loading}); else if (listEl) listEl.innerHTML = '<div class="loading">' + esc(loading) + '</div>';
    if (messageEl) messageEl.textContent = loading;
    var epoch = viewEpoch, seq = previewSeq + 1;
    return fetchPreview().catch(function(e) {
      if (epoch !== viewEpoch || seq !== previewSeq) return null;
      if (listEl) listEl.innerHTML = '<div class="empty-state">' + esc(t('sync.preview.load-failed-prefix','Preview load failed: ')) + esc(e.message || e) + '</div>';
      if (messageEl) messageEl.textContent = t('sync.preview.load-failed','Preview load failed');
      toast(t('sync.preview.load-failed-prefix','Preview load failed: ') + (e.message || e), 'error');
      return null;
    });
  };

  function escTime(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts);
      return isNaN(d.getTime()) ? '' : d.toLocaleString();
    } catch (e) { return ''; }
  }

  function diffSectionCard(title, section, sectionName, conflictSelectable) {
    section = section || { localOnly: [], remoteOnly: [], changed: [] };
    var chips = [];
    var lines = [];
    if (section.localOnly.length) chips.push('<span class="status-badge status-done">' + esc(t('sync.local', 'Local')) + ' +' + section.localOnly.length + '</span>');
    if (section.remoteOnly.length) chips.push('<span class="status-badge status-running">' + esc(t('sync.remote', 'Remote')) + ' +' + section.remoteOnly.length + '</span>');
    if (section.changed.length) chips.push('<span class="status-badge" style="background:var(--warning-bg);color: var(--warning-text);">' + esc(t('sync.conflict', 'Conflict')) + ' ' + section.changed.length + '</span>');
    if (section.localOnly.length) {
      lines.push('<div style="font-size:11px;color:var(--text-muted);word-break:break-all;">' + esc(t('sync.local-only', 'Local only')) + ': ' + esc(section.localOnly.slice(0, 12).join(', ')) + (section.localOnly.length > 12 ? ' (+' + (section.localOnly.length - 12) + ')' : '') + '</div>');
    }
    if (section.remoteOnly.length) {
      lines.push('<div style="font-size:11px;color: var(--warning-text);word-break:break-all;">' + esc(t('sync.remote-only', 'Remote only')) + ': ' + esc(section.remoteOnly.slice(0, 12).join(', ')) + (section.remoteOnly.length > 12 ? ' (+' + (section.remoteOnly.length - 12) + ')' : '') + '</div>');
    }
    if (section.changed.length && conflictSelectable && sectionName) {
      lines.push('<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + esc(t('sync.per-item', 'Per-item conflict decisions (they default to the global strategy and apply to Pull only)')) + ':</div>');
      section.changed.forEach(function(c) {
        // Inherit is distinct from an explicit choice, even the old default.
        var opts = '<option value="" selected>' + esc(t('sync.use-global', 'Use global strategy')) + '</option>' + ['local', 'remote', 'newest'].map(function(v) {
          var label = v === 'local' ? t('sync.keep-local', 'Keep local') : (v === 'remote' ? t('sync.take-remote', 'Take remote') : t('sync.take-newest', 'Take newest'));
          return '<option value="' + v + '">' + esc(label) + '</option>';
        }).join('');
        lines.push('<div style="display:flex;align-items:center;gap:6px;font-size:11px;margin-top:4px;word-break:break-all;">' +
          '<select class="sync-entry-strategy" data-section="' + escAttr(sectionName) + '" data-id="' + escAttr(c.id) + '" style="flex:0 0 auto;font-size:11px;padding:2px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);">' + opts + '</select>' +
          '<span style="color:var(--text-muted);flex:1;">' + esc(c.id) + ' <span style="opacity:.7;">[' + esc((c.fields || []).join(', ')) + ']</span></span>' +
        '</div>');
      });
    } else if (section.changed.length) {
      var changedLines = section.changed.slice(0, 8).map(function(c) {
        return esc(c.id) + ' [' + esc((c.fields || []).join(', ')) + ']';
      });
      lines.push('<div style="font-size:11px;color:var(--text-muted);word-break:break-all;">' + esc(t('sync.changed', 'Changed')) + ': ' + esc(changedLines.join(' · ')) + (section.changed.length > 8 ? ' (+' + (section.changed.length - 8) + ')' : '') + '</div>');
    }
    if (!chips.length) lines.push('<div style="font-size:11px;color:var(--text-muted);">' + esc(t('sync.no-diff', 'No differences in the compared fields')) + '</div>');
    return '<div class="profile-card">' +
      '<div class="card-header card-head-inline"><span class="name">' + esc(title) + '</span><span>' + chips.join(' ') + '</span></div>' +
      lines.join('') +
    '</div>';
  }

  function renderSyncDiff(diff) {
    var messageEl = document.getElementById('sync-diff-message');
    var listEl = document.getElementById('sync-diff');
    if (!messageEl || !listEl) return;
    diff = diff || {};
    if (!diff.ok) {
      messageEl.innerHTML = '<span class="health-text-watch">' + esc(diff.message || t('sync.compare-failed', 'Comparison failed')) + '</span>';
      listEl.innerHTML = '<div class="empty-state">' + esc(diff.message || t('sync.compare-failed', 'Comparison failed')) + '</div>';
      return;
    }
    var timeHtml = diff.firstPush ? '  ·  ' + esc(t('sync.no-remote-yet', 'No remote data yet (first push)')) : (diff.remoteTimestamp ? '  ·  ' + esc(t('sync.remote-last-sync', 'Remote last synced')) + ': <strong class="num" title="' + escAttr(escTime(diff.remoteTimestamp)) + '">' + esc(helpers.relTime ? helpers.relTime(diff.remoteTimestamp) : escTime(diff.remoteTimestamp)) + '</strong>' : '');
    var coverage = diff.coverage;
    var covered = !!(coverage && Array.isArray(coverage.compared) && Array.isArray(coverage.notCompared) && Array.isArray(coverage.unverified));
    var unverified = covered ? coverage.unverified : [];
    var limited = !covered || unverified.length || !comparisonToken(diff);
    messageEl.innerHTML = '<span class="' + (limited ? 'health-text-watch' : 'health-text-good') + '">' + esc(limited ? t('sync.compare.unverified', 'Comparison contains unverified data') : t('sync.compare-done', 'Supported scope compared')) + '</span>' + timeHtml;
    var cards = ['<div class="profile-card"><div style="font-size:12px;line-height:1.5;">' + esc(t('sync.compare.scope', 'Compares portable profile settings and Preferences, proxy/account metadata and extension inventory only. Live Cookies, LocalStorage/History/Places databases and full profile files are not compared. History uses separate coverage and semantic rechecks.')) + '</div></div>'];
    if (limited) {
      cards.push('<div class="profile-card health-text-watch"><strong>' + esc(t('sync.compare.unverified', 'Comparison contains unverified data')) + '</strong>' +
        (!covered ? '<div>' + esc(t('sync.compare.coverage-unavailable', 'Coverage evidence is unavailable; no full-content match is claimed.')) + '</div>' : '') +
        (!comparisonToken(diff) ? '<div>' + esc(t('sync.compare.required', 'Compare with remote before pulling; previous choices have been cleared.')) + '</div>' : '') +
        unverified.map(function(item) { return '<div>' + esc(item.id) + ' · ' + esc(item.reason) + '</div>'; }).join('') + '</div>');
    }
    if ((diff.pushWarnings || []).length) {
      cards.push('<div class="profile-card" style="border-color: var(--danger-text);">' +
        '<div class="card-header card-head-inline"><span class="name" style="color: var(--danger-text);">' + esc(t('sync.push-will-remove', 'Push will remove remote data')) + '</span></div>' +
        (diff.pushWarnings || []).map(function(w) { return '<div style="font-size:11px;color: var(--danger-text);line-height:1.4;">' + esc(w) + '</div>'; }).join('') +
        '</div>');
    }
    if ((diff.pullNotes || []).length) {
      cards.push('<div class="profile-card">' +
        '<div class="card-header card-head-inline"><span class="name">' + esc(t('sync.pull-will-change', 'Pull will change local data')) + '</span></div>' +
        (diff.pullNotes || []).map(function(w) { return '<div style="font-size:11px;color:var(--text-muted);line-height:1.4;">' + esc(w) + '</div>'; }).join('') +
        '</div>');
    }
    var artifacts = diff.artifacts || {};
    cards.push('<div class="profile-card">' +
      '<div class="card-header card-head-inline"><span class="name">' + esc(t('sync.remote-artifacts', 'Remote data artifacts')) + '</span></div>' +
      '<div style="font-size:11px;color:var(--text-muted);">' + esc(t('sync.remote-cookies', 'Remote cookies')) + ': ' + esc(String((artifacts.cookies || []).length)) + ' · localStorage: ' + esc(String((artifacts.localStorage || []).length)) + ' · preferences: ' + esc(String((artifacts.preferences || []).length)) + '</div>' +
      '</div>');
    var selectable = !!comparisonToken(diff);
    cards.push(diffSectionCard(t('sync.preview.title.profiles','Profiles'), diff.profiles, 'profiles', selectable));
    cards.push(diffSectionCard(t('sync.preview.title.proxies','Proxies'), diff.proxies, 'proxies', selectable));
    cards.push(diffSectionCard(t('sync.preview.title.accounts','Accounts'), diff.accounts, 'accounts', selectable));
    cards.push(diffSectionCard(t('sync.preview.title.extensions','Extensions'), diff.extensions, 'extensions', false));
    listEl.innerHTML = cards.join('');
  }

  function fetchSyncDiff() {
    var epoch = viewEpoch, seq = ++syncDiffSeq;
    return api.sync.previewDiff().then(function(diff) {
      if (epoch !== viewEpoch) return null;
      if (seq === syncDiffSeq) {
        var token = comparisonToken(diff);
        viewedComparison = diff && diff.ok && token ? { token: token, epoch: epoch } : null;
        renderSyncDiff(diff);
      }
      // A Push checks its own warnings/token even if another Compare supersedes
      // its rendering. A mutation, unlike a newer read, revokes that preflight.
      return diff;
    });
  }

  agentBrowser.loadSyncDiff = function() {
    viewedComparison = null;
    var listEl = document.getElementById('sync-diff');
    var messageEl = document.getElementById('sync-diff-message');
    if (listEl) listEl.innerHTML = '<div class="loading">' + esc(t('common.loading', 'Loading…')) + '</div>';
    if (messageEl) messageEl.textContent = t('common.loading', 'Loading…');
    var epoch = viewEpoch, seq = syncDiffSeq + 1;
    return fetchSyncDiff().catch(function(e) {
      if (epoch !== viewEpoch || seq !== syncDiffSeq) return null;
      if (listEl) listEl.innerHTML = '<div class="empty-state">' + esc(e.message || e) + '</div>';
      if (messageEl) messageEl.textContent = t('sync.compare-failed', 'Comparison failed');
      toast(t('sync.compare-failed-prefix', 'Comparison failed: ') + (e.message || String(e)), 'error');
      return null;
    });
  };


  function stalePreview(r) { return !!(r && (r.code === 'SYNC_PREVIEW_STALE' || /\bSYNC_PREVIEW_STALE\b/.test(r.message || ''))); }

  function reportOperationResult(operation, r, fallback) {
    if (!r) return;
    // An old write may settle after another operation has already completed.
    // It may enrich its own last result, but must not replace a newer result.
    if (lastResult && r.operationId && lastResult.operationId && r.operationId !== lastResult.operationId &&
      serverGeneration > operation.startGeneration && r.operationId !== serverOperationId && (!activeOperation || activeOperation.operationId !== r.operationId)) return;
    renderResult(r);
    if (stalePreview(r)) {
      clearComparison(t('sync.compare.stale', 'Sync content changed. Compare again and choose resolutions afresh.'));
      toast(t('sync.compare.stale', 'Sync content changed. Compare again and choose resolutions afresh.'), 'warning');
      return;
    }
    toastSyncResult(r, fallback);
  }

  function reportOperationError(operation, e, fallback) {
    if (!ownsOperation(operation) && !operation.dispatched) return;
    if (operation.dispatched) {
      reportOperationResult(operation, { success: false, operationId: operation.operationId, outcome: 'partial', localCommit: 'unknown', remoteCommit: 'unknown',
        code: stalePreview(e) ? 'SYNC_PREVIEW_STALE' : 'SYNC_RESULT_UNAVAILABLE', message: t('sync.result.unavailable', 'The operation result is unavailable. Changes may already be committed; check the current operation state before retrying.') }, fallback);
    } else toast(fallback + ': ' + (e.message || String(e)), 'error');
  }

  agentBrowser.syncPush = function() {
    if (operationBusy()) return Promise.resolve(null);
    var operation = beginOperation('push');
    var token = null;
    function push(force) {
      var opts = { comparisonToken: token };
      if (typeof savedHistoryScope === 'boolean') opts.history = savedHistoryScope;
      if (force) opts.force = true;
      return dispatchOperation(operation, function() { return api.sync.push(opts); });
    }
    return fetchPreview().catch(function() {
      if (ownsOperation(operation)) toast(t('sync.preview.unavailable', 'Preview unavailable'), 'warning');
      return null;
    }).then(function() {
      return ownsOperation(operation) ? fetchSyncDiff() : null;
    }).then(function(diff) {
      if (!ownsOperation(operation)) return null;
      if (!diff || !diff.ok) throw new Error((diff && diff.message) || t('sync.compare-failed', 'Comparison failed'));
      token = comparisonToken(diff);
      if (!token) throw new Error(t('sync.compare.required', 'Compare with remote before pulling; previous choices have been cleared.'));
      if (!(diff.pushWarnings || []).length) return push(false);
      var removeMsg = t('sync.push-will-remove', 'Push will remove remote data') + ':\n\n' + diff.pushWarnings.join('\n') + '\n\n' + t('sync.continue-push', 'Continue pushing?');
      return agentBrowser.confirmAsync(removeMsg, { ackLabel: t('confirm.ack.permanent','我了解此操作会永久删除数据且不可撤销。') }).then(function(ok) { return ok ? push(false) : null; });
    }).then(function(r) {
      if (!r || stalePreview(r) || r.success || !/locked by another device/i.test(r.message || '')) return r;
      var lockMsg = t('sync.push-blocked-by-lock', 'Push blocked by lock protection') + ':\n\n' + r.message + '\n\n' + t('sync.force-override', 'Override and continue?');
      return agentBrowser.confirmAsync(lockMsg, { ackLabel: t('confirm.ack.permanent','我了解此操作会永久删除数据且不可撤销。') }).then(function(forceOk) {
        // Keep the acknowledged content token. Never silently rebind the force
        // decision to a fresh remote/local snapshot while this dialog is open.
        return forceOk ? push(true) : r;
      });
    }).then(function(r) {
      reportOperationResult(operation, r, t('sync.toast.push-failed', 'Push failed'));
      return r;
    }).catch(function(e) {
      reportOperationError(operation, e, t('sync.toast.push-failed', 'Push failed'));
      return null;
    }).finally(function() { return finishOperation(operation); });
  };

  agentBrowser.syncPull = function() {
    if (operationBusy()) return Promise.resolve(null);
    if (!viewedComparison || viewedComparison.epoch !== viewEpoch) {
      toast(t('sync.compare.required', 'Compare with remote before pulling; previous choices have been cleared.'), 'warning');
      return Promise.resolve(null);
    }
    var token = viewedComparison.token;
    var strategySel = document.getElementById('sync-merge-strategy');
    var strategy = strategySel ? strategySel.value : defaultPullStrategy();
    if (['local', 'remote', 'newest'].indexOf(strategy) < 0) strategy = defaultPullStrategy();
    var resolutions = {};
    Array.prototype.forEach.call(document.querySelectorAll('#sync-diff .sync-entry-strategy'), function(sel) {
      var section = sel.getAttribute('data-section'), id = sel.getAttribute('data-id'), value = sel.value;
      if (['profiles', 'proxies', 'accounts'].indexOf(section) >= 0 && id && ['local', 'remote', 'newest'].indexOf(value) >= 0) resolutions[section + ':' + id] = value;
    });
    // Capture the exact displayed proof/choices BEFORE invalidating the UI.
    var operation = beginOperation('pull');
    function pull() { return dispatchOperation(operation, function() {
      var opts = { strategy: strategy, resolutions: resolutions, comparisonToken: token };
      if (typeof savedHistoryScope === 'boolean') opts.history = savedHistoryScope;
      return api.sync.pull(opts);
    }); }
    return fetchPreview().then(function(preview) {
      if (!ownsOperation(operation) || !preview) return null;
      var running = preview.runningProfiles || [];
      if (!running.length) return pull();
      var runMsg = t('sync.confirm.pull-running','Detected {n} running or unconfirmed profile(s). Pull will skip their entire profile data and settings. Stop them and wait for browser exit before pulling those profiles. Continue with other selected data?').replace('{n}', String(running.length));
      return agentBrowser.confirmAsync(runMsg).then(function(ok) { return ok ? pull() : null; });
    }).then(function(r) {
      reportOperationResult(operation, r, t('sync.toast.pull-failed', 'Pull failed'));
      return r;
    }).catch(function(e) {
      reportOperationError(operation, e, t('sync.toast.pull-failed', 'Pull failed'));
      return null;
    }).finally(function() { return finishOperation(operation); });
  };

  // Sale-93: custody consent rides a SEPARATE checkbox. Enabling sync
  // without consent is refused by the main process; the UI also warns first.
  function custodyConsented() {
    var box = document.getElementById('sync-custody-consent');
    return !!(box && box.checked);
  }
  function renderCustodyState(status) {
    var el = document.getElementById('sync-custody-state');
    if (!el) return;
    if (status && status.custodyConsentAt) {
      el.textContent = t('sync.custody.on', 'Data-custody consent recorded {d}').replace('{d}', new Date(status.custodyConsentAt).toLocaleString());
    } else {
      el.textContent = t('sync.custody.off', 'No data-custody consent recorded — push/pull will refuse until you consent and save.');
    }
  }
  function renderHistoryState(status) {
    var panel = syncPanel('sync-history-coverage');
    if (!panel) return;
    lastHistoryStatus = status;
    var title = status && status.includeHistory ? t('sync.history.selected', 'History scope selected for saved automatic sync') : t('sync.history.unselected', 'History scope is not selected');
    var html = '<strong>' + esc(title) + '</strong><div class="status-note">' + esc(t('sync.history.proof-note', 'History has separate coverage and a semantic baseline. A configuration sync badge is not full browser restore or runtime fingerprint proof.')) + '</div>';
    Object.keys(status && status.history || {}).forEach(function(id) {
      var observed = historyObservations[id], coverage = observed || status.history[id];
      html += '<div>' + esc(id) + ' · ' + esc(historyLabel(coverage)) + ' · ' + esc(resultLabel('sync.history.compare.', HISTORY_COMPARE, observed ? observed.status : 'unknown'));
      if (coverage.capturedAt != null) html += ' · ' + esc(new Date(coverage.capturedAt).toLocaleString());
      html += '</div>';
    });
    panel.innerHTML = html;
  }
  agentBrowser.syncRecheckHistory = function() {
    if (operationBusy() || !lastHistoryStatus || typeof api.sync.historyState !== 'function') return Promise.resolve(null);
    var epoch = viewEpoch, status = lastHistoryStatus, observations = {};
    var ids = Object.keys(status.history || {});
    return ids.reduce(function(chain, id) {
      return chain.then(function() {
        if (epoch !== viewEpoch) return;
        return api.sync.historyState(id).then(function(state) { observations[id] = state; }, function() {
          observations[id] = Object.assign({}, status.history[id], { status: 'unknown', reason: 'history-read-or-runtime-unconfirmed' });
        });
      });
    }, Promise.resolve()).then(function() { if (epoch === viewEpoch) { historyObservations = observations; renderHistoryState(status); } return observations; });
  };
  function consentError(r) {
    return !!(r && (r.code === 'CUSTODY_CONSENT_REQUIRED' || /custody consent/i.test(r.message || '')));
  }
  function toastSyncResult(r, fallback) {
    var staticFailure = r && fullProfileFailureMessage(r.code);
    if (staticFailure) { toast(staticFailure, 'error'); return; }
    if (consentError(r)) { toast(t('sync.custody.required', 'Tick the data-custody consent box and save before pushing/pulling.'), 'error'); return; }
    if (!r) { toast(fallback, 'error'); return; }
    if (!r.outcome && !r.items && !r.warnings) { toast(r.message || fallback, r.success ? 'success' : 'error'); return; }
    var limited = limitedResult(r);
    var message = resultOutcome(r) === 'complete' && limited ? t('sync.result.limited', 'Completed with limitations') : resultLabel('sync.result.outcome.', OUTCOME, resultOutcome(r));
    message += ' · ' + t('sync.result.local-commit', 'Local changes') + ': ' + resultLabel('sync.result.commit.', COMMIT, COMMIT[r.localCommit] ? r.localCommit : 'unknown') +
      ' · ' + t('sync.result.remote-commit', 'Remote publication') + ': ' + resultLabel('sync.result.commit.', COMMIT, COMMIT[r.remoteCommit] ? r.remoteCommit : 'unknown');
    toast(message, limited ? 'warning' : 'success', { detail: r.message || fallback });
  }

  agentBrowser.syncSave = function() {
    if (operationBusy()) return Promise.resolve(null);
    var submitted = captureForm();
    var config = { enabled: !!submitted['sync-enabled'], endpoint: (submitted['sync-endpoint-input'] || '').trim(), bucket: (submitted['sync-bucket-input'] || '').trim() };
    var accessKey = (submitted['sync-ak-input'] || '').trim(), secretKey = (submitted['sync-sk-input'] || '').trim();
    if (accessKey) config.accessKey = accessKey;
    if (secretKey) config.secretKey = secretKey;
    if (config.enabled && !custodyConsented()) {
      toast(t('sync.custody.required', 'Tick the data-custody consent box and save before pushing/pulling.'), 'error');
      var box = document.getElementById('sync-custody-consent');
      if (box) box.focus();
      return Promise.resolve(null);
    }
    if (custodyConsented()) config.custodyConsent = true;
    if (document.getElementById('sync-include-history')) {
      config.includeHistory = !!submitted['sync-include-history'];
      config.historyConsent = !!submitted['sync-history-consent'];
    }
    // The passphrase never enters the ordinary form draft/baseline, and status
    // never hydrates it. Only an explicit Save reads this password input.
    var passphraseInput = document.getElementById('sync-full-profile-passphrase');
    var passphrase = passphraseInput ? passphraseInput.value : '';
    if (passphrase) config.fullProfilePassphrase = passphrase;
    if (document.getElementById('sync-full-profile-consent')) {
      config.includeFullProfile = !!submitted['sync-full-profile-consent'];
      config.fullProfileConsent = config.includeFullProfile;
      if (config.includeFullProfile) {
        if (!custodyConsented()) { toast(t('sync.custody.required', 'Tick the data-custody consent box and save before pushing/pulling.'), 'error'); return Promise.resolve(null); }
        if (!passphrase && !fullProfilePassphraseSet) { toast(t('sync.full-profile.required', 'Full environment migration needs a migration passphrase. Enter it and save first.'), 'error'); if (passphraseInput) passphraseInput.focus(); return Promise.resolve(null); }
        config.includeHistory = true;
        // The full checkbox explicitly includes History; ordinary custody or
        // History consent alone must never select password migration.
        config.historyConsent = true;
      }
    }
    if (config.includeHistory && !config.historyConsent) { toast(t('sync.history.consent-required', 'History scope includes Firefox bookmarks. Give separate consent and save before selecting it.'), 'error'); return Promise.resolve(null); }
    var operation = beginOperation('configure'), saved = null;
    return dispatchOperation(operation, function() { return api.sync.configure(config); }).then(function(r) {
      if (!r) return null;
      if (r.success) {
        saved = submitted;
        ['sync-ak-input', 'sync-sk-input'].forEach(function(id) {
          var el = document.getElementById(id);
          if (el && el.value === submitted[id]) { el.value = ''; formBaseline[id] = ''; formTouched[id] = false; }
        });
      }
      r = Object.assign({}, r, { message: r.message || r.error || (r.success ? t('toast.sync.saved', 'Sync config saved') : t('sync.toast.save-failed-default', 'Save failed')) });
      reportOperationResult(operation, r, t('sync.toast.save-failed-default', 'Save failed'));
      return r;
    }).catch(function(e) {
      reportOperationError(operation, e, t('sync.toast.save-failed-default', 'Save failed'));
      return null;
    }).finally(function() {
      if (passphraseInput && passphraseInput.value === passphrase) passphraseInput.value = '';
      passphrase = '';
      delete config.fullProfilePassphrase;
      return finishOperation(operation, saved);
    });
  };

  function hydrateOperation(operation) {
    if (!operation || !Number.isSafeInteger(operation.generation)) return true;
    if (operation.generation < serverGeneration) return false;
    var active = operation.active || null;
    if (active && operation.generation === serverGeneration && serverPhase === 'completed' && active.operationId === serverOperationId) return false;
    var changed = operation.generation !== serverGeneration || (active && active.operationId) !== (activeOperation && activeOperation.operationId);
    serverGeneration = operation.generation;
    if (changed) {
      if (localOperation && active && localOperation.operationId !== active.operationId && !localOperation.awaitingReply) localOperation.invalidated = true;
      activeOperation = active;
      if (active) { serverOperationId = active.operationId; serverPhase = 'started'; }
      else if (operation.last && operation.last.operationId) { serverOperationId = operation.last.operationId; serverPhase = 'completed'; }
      invalidateViews(); invalidateSurfaceCaches();
      refreshSurfaces();
    } else activeOperation = active;
    // A configure event has no result and can occur while push/pull still owns
    // the service. Only authoritative status (or that owner's completion) may
    // release it. status.last can enrich the privacy-minimal event summary.
    var last = operation.last;
    if (last && (!localOperation || localOperation.operationId === last.operationId || (lastResult && lastResult.operationId === last.operationId))) renderResult(last);
    renderOperationState();
    return true;
  }

  function loadSyncConfig(savedDraft) {
    var epoch = viewEpoch, seq = ++statusSeq, requestedDraft = captureForm();
    return api.sync.status().then(function(status) {
      if (epoch !== viewEpoch || seq !== statusSeq) return null;
      status = status || {};
      if (!hydrateOperation(status.operation)) return null;
      document.getElementById('sync-enabled-text').textContent = status.enabled ? t('sync.status.enabled', 'enabled') : t('sync.status.disabled', 'disabled');
      document.getElementById('sync-endpoint').textContent = status.endpoint || '--';
      document.getElementById('sync-bucket').textContent = status.bucket || '--';
      hydrateField('sync-enabled', !!status.enabled, requestedDraft, savedDraft);
      hydrateField('sync-endpoint-input', status.endpoint || '', requestedDraft, savedDraft);
      hydrateField('sync-bucket-input', status.bucket || '', requestedDraft, savedDraft);
      hydrateField('sync-custody-consent', !!status.custodyConsentAt, requestedDraft, savedDraft);
      hydrateField('sync-history-consent', !!status.historyConsentAt, requestedDraft, savedDraft);
      hydrateField('sync-include-history', status.includeHistory === true, requestedDraft, savedDraft);
      hydrateField('sync-full-profile-consent', status.includeFullProfile === true && !!status.fullProfileConsentAt, requestedDraft, savedDraft);
      savedFullProfileScope = status.includeFullProfile === true;
      applyPullStrategyDefault();
      fullProfilePassphraseSet = status.fullProfilePassphraseSet === true;
      var passphraseInput = document.getElementById('sync-full-profile-passphrase');
      if (passphraseInput) passphraseInput.placeholder = fullProfilePassphraseSet ? t('sync.credentials.saved', 'Saved; leave blank to keep') : '';
      var fullProfileState = document.getElementById('sync-full-profile-state');
      if (fullProfileState) fullProfileState.textContent = status.includeFullProfile === true
        ? t('sync.full-profile.selected', 'Saved scope: passphrase-encrypted full environment migration. Check per-item results for completeness.')
        : t('sync.full-profile.limited', 'Saved scope: limited sync only; saved browser passwords and full profile files are not included.');
      savedHistoryScope = typeof status.includeHistory === 'boolean' ? status.includeHistory : undefined;
      var ak = document.getElementById('sync-ak-input'), sk = document.getElementById('sync-sk-input');
      if (ak && !ak.value) ak.placeholder = status.accessKeyMasked || '';
      if (sk && !sk.value) sk.placeholder = status.configured ? t('sync.credentials.saved', 'Saved; leave blank to keep') : '';
      renderCustodyState(status);
      renderHistoryState(status);
      agentBrowser.loadSyncPreview();
      loadTeamPanel();
      return status;
    }).catch(function(e) {
      if (epoch !== viewEpoch || seq !== statusSeq) return null;
      toast(t('toast.sync.load-failed', 'Failed to load sync config') + ': ' + (e.message || String(e)), 'error');
      agentBrowser.loadSyncPreview();
      return null;
    });
  }
  agentBrowser.loadSyncConfig = loadSyncConfig;

  // ══════ Team Workspace (RBAC) ══════
  // R146: this was a plain English map that fed four render sites (role badges,
  // the local-device badge, and two <option> lists), so the zh UI showed
  // "Owner / Admin / Member / Viewer" in the default view. Kept as the English
  // source of truth for the `t()` fallback; roleLabel() is how it is displayed.
  var ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };
  var ROLE_ORDER_LIST = ['viewer', 'member', 'admin', 'owner'];
  var ROLE_CLASS = { owner: 'role-owner', admin: 'role-admin', member: 'role-member', viewer: 'role-viewer' };
  function roleLabel(role) { return t('team.role.' + role, ROLE_LABEL[role] || role); }

  // Colours live in style.css, not inline: the old version interpolated the
  // *fill* tokens (--success / --warning / --primary) as foreground text, which
  // measured 2.75:1, 2.26:1 and 4.33:1 against their own tinted plate. Those
  // tokens are tuned for fills; --*-text are the ones meant to sit on them.
  function roleBadge(role) {
    var cls = ROLE_CLASS[role] || 'role-viewer';
    return '<span class="status-badge ' + cls + '">' + esc(roleLabel(role)) + '</span>';
  }

  function shortId(id) {
    if (!id) return '';
    return id.length > 18 ? id.slice(0, 10) + '…' + id.slice(-6) : id;
  }

  function renderTeamPanel(status) {
    var panel = document.getElementById('team-panel');
    var badge = document.getElementById('team-local-badge');
    if (!panel) return;
    status = status || {};
    var team = status.team || null;
    var local = status.local || {};
    var me = local.role || 'owner';
    var canManage = me === 'owner' || me === 'admin';
    var isOwner = me === 'owner';

    if (badge) {
      badge.style.display = 'inline-block';
      // Never interpolate a raw field: a payload without `name` (older build,
      // REST peer, hand-edited config) would paint "undefined · Owner".
      var localLabel = local.name || shortId(local.deviceId) || t('team.this-device', 'This device');
      badge.textContent = localLabel + ' · ' + roleLabel(me);
    }

    if (!team) {
      panel.innerHTML =
        '<p style="font-size:12px;color:var(--text-muted);margin:0 0 8px;">' + esc(t("team.empty.desc", "No workspace initialized. Initialize one to manage member roles (owner / admin / member / viewer) and enforce read-only viewers on sync push and profile changes.")) + '</p>' +
        '<div class="form-row"><label for="team-workspace-name">' + esc(t("team.workspace.name", "Workspace name")) + '</label><input id="team-workspace-name" placeholder="' + escAttr(t("team.workspace.name-placeholder", "My Workspace")) + '"></div>' +
        '<div class="btn-row"><button class="btn btn-primary btn-sm" data-role="cmd" data-cmd="teamInit">' + esc(t("team.init", "Initialize Workspace")) + '</button></div>';
      return;
    }

    var rows = (team.members || []).map(function(m) {
      var isMe = m.deviceId === local.deviceId;
      var roleOptions = ROLE_ORDER_LIST.map(function(r) {
        var disabled = '';
        if (me !== 'owner' && (r === 'owner' || r === 'admin')) disabled = ' disabled';
        if (me !== 'owner' && (m.role === 'owner' || m.role === 'admin')) disabled = ' disabled';
        if (m.deviceId === team.ownerDeviceId) disabled = ' disabled';
        return '<option value="' + r + '"' + (m.role === r ? ' selected' : '') + disabled + '>' + esc(roleLabel(r)) + '</option>';
      }).join('');
      var actions = '';
      if (canManage && m.deviceId !== team.ownerDeviceId && !isMe) {
        // R180: this select is generated per member and has no id, so a
        // <label for> cannot point at it — an aria-label carrying the member
        // name is what gives it an accessible name. Without one, a screen
        // reader announced a bare "popup button" for every row.
        var memberName = m.name || shortId(m.deviceId);
        actions = '<select class="team-role-select" data-device-id="' + escAttr(m.deviceId) + '" aria-label="' + escAttr(memberName + ' · ' + t('team.role-label', 'Role')) + '" style="font-size:11px;height:24px;">' + roleOptions + '</select> ' +
          '<button class="btn btn-xs btn-danger" data-action="team-remove" data-device-id="' + escAttr(m.deviceId) + '">' + (window.i18n && window.i18n.t ? window.i18n.t('team.remove', 'Remove') : 'Remove') + '</button>';
      }
      // R146: this rendered `t('sync.owner', 'owner')` — a key that exists in
      // neither locale, so it always fell back to the English literal, in both
      // languages. It was also redundant: roleBadge() on the right already shows
      // the role prominently, so each row said "owner" twice, once lowercase.
      // The owner's identity is still unambiguous — the badge carries it.
      return '<div class="profile-card" style="padding:8px;margin:6px 0;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">' +
        '<div><span class="name">' + esc(m.name || m.deviceId) + (isMe ? ' <em style="font-size:10px;color: var(--primary-text);">' + esc(t('team.this-device', '(this device)')) + '</em>' : '') + '</span>' +
        '<div style="font-family:var(--mono);font-size:10px;color:var(--text-muted);">' + esc(shortId(m.deviceId)) + '</div></div>' +
        '<div style="display:flex;align-items:center;gap:6px;">' + roleBadge(m.role) + actions + '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    var addForm = '';
    if (canManage) {
      addForm =
        '<div class="form-row"><label for="team-add-device-id">' + esc(t('team.add.device-id', 'Device ID')) + '</label><input id="team-add-device-id" placeholder="' + escAttr(t('team.add.device-id-ph', 'device-id-from-another-install')) + '"></div>' +
        '<div class="form-row"><label for="team-add-name">' + esc(t('team.add.name', 'Name')) + '</label><input id="team-add-name" placeholder="' + escAttr(t('team.add.name-ph', 'Optional display name')) + '"></div>' +
        '<div class="form-row"><label for="team-add-role">' + esc(t('team.add.role', 'Role')) + '</label><select id="team-add-role">' +
          ROLE_ORDER_LIST.map(function(r) {
            var disabled = (!isOwner && (r === 'owner' || r === 'admin')) ? ' disabled' : '';
            return '<option value="' + r + '"' + disabled + '>' + esc(roleLabel(r)) + '</option>';
          }).join('') +
        '</select></div>' +
        '<div class="btn-row"><button class="btn btn-primary btn-sm" data-role="cmd" data-cmd="teamAddMember">' + esc(t("team.add-member", "Add Member")) + '</button></div>';
    }

    var renameControl = isOwner
      ? '<div class="form-row"><label for="team-workspace-rename">' + esc(t("team.rename-workspace", "Rename workspace")) + '</label><input id="team-workspace-rename" value="' + escAttr(team.name) + '" style="max-width:280px;"> <button class="btn btn-secondary btn-sm" data-role="cmd" data-cmd="teamRename">' + esc(t("team.rename", "Rename")) + '</button></div>'
      : '';
    var enableControl = canManage
      ? '<label style="display:flex;align-items:center;gap:6px;font-size:12px;"><input type="checkbox" id="team-enabled"' + (team.enabled !== false ? ' checked' : '') + '> ' + esc(t('team.enforce', 'Enforce team RBAC (viewers read-only, member+ push/delete, admin+ force push)')) + '</label>'
      : '';

    panel.innerHTML =
      '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">' +
        esc(t('team.summary.workspace', 'Workspace')) + ' <strong>' + esc(team.name) + '</strong> · ' +
        esc(t('team.summary.members', '{n} member(s)').replace('{n}', (team.members || []).length)) + ' · ' +
        esc(t('team.summary.enforcement', 'enforcement')) + ' ' +
        esc(t(team.enabled !== false ? 'team.summary.on' : 'team.summary.off', team.enabled !== false ? 'on' : 'off')) +
      '</div>' +
      renameControl +
      '<div style="margin:8px 0;">' + rows + '</div>' +
      addForm +
      enableControl;

    // Event delegation for member actions.
    panel.onclick = function (event) {
      var target = event.target.closest('[data-action="team-remove"]');
      if (!target || !panel.contains(target)) return;
      var deviceId = target.dataset.deviceId;
      if (!deviceId) return;
      agentBrowser.confirm(t('team.remove-confirm', 'Remove this member from the workspace?'), function() {
        api.team.removeMember(deviceId).then(function(r) {
          if (!r || !r.success) { toast((r && r.error) || 'Remove failed', 'error'); return; }
          toast(t('toast.sync.member-removed', 'Member removed'), 'success');
          loadTeamPanel();
        }).catch(function(e) { toast(e.message, 'error'); });
      });
    };
    panel.onchange = function (event) {
      var sel = event.target.closest('.team-role-select');
      if (!sel || !panel.contains(sel)) return;
      api.team.setRole(sel.dataset.deviceId, sel.value).then(function(r) {
        if (!r || !r.success) { toast((r && r.error) || 'Role update failed', 'error'); loadTeamPanel(); return; }
        toast(t('toast.sync.role-updated', 'Role updated'), 'success');
        loadTeamPanel();
      }).catch(function(e) { toast(e.message, 'error'); loadTeamPanel(); });
    };
    var enabledBox = document.getElementById('team-enabled');
    if (enabledBox) {
      enabledBox.onchange = function () {
        api.team.setEnabled(enabledBox.checked).then(function(r) {
          if (!r || !r.success) { toast((r && r.error) || 'Update failed', 'error'); }
          loadTeamPanel();
        }).catch(function(e) { toast(e.message, 'error'); loadTeamPanel(); });
      };
    }
  }

  function loadTeamPanel() {
    var epoch = viewEpoch, seq = ++teamSeq;
    return api.team.status().then(function(status) {
      if (epoch !== viewEpoch || seq !== teamSeq) return;
      renderTeamPanel(status);
    }).catch(function(e) {
      if (epoch !== viewEpoch || seq !== teamSeq) return;
      var panel = document.getElementById('team-panel');
      if (panel) panel.innerHTML = '<div class="empty-state">' + esc(t('team.panel.failed', 'Team panel failed: ') + (e.message || String(e))) + '</div>';
    });
  }
  agentBrowser.loadTeamPanel = loadTeamPanel;

  agentBrowser.teamInit = function() {
    var name = (document.getElementById('team-workspace-name') || {}).value || '';
    api.team.init(name).then(function(r) {
      if (!r || !r.success) { toast((r && r.error) || 'Init failed', 'error'); return; }
      toast(t('toast.sync.workspace-inited', 'Workspace initialized'), 'success');
      loadTeamPanel();
    }).catch(function(e) { toast(e.message, 'error'); });
  };

  agentBrowser.teamAddMember = function() {
    var deviceId = (document.getElementById('team-add-device-id') || {}).value || '';
    var name = (document.getElementById('team-add-name') || {}).value || '';
    var role = (document.getElementById('team-add-role') || {}).value || 'member';
    if (!deviceId) { toast(t('toast.sync.device-id-required', 'Device ID is required'), 'error'); return; }
    api.team.addMember(deviceId, name, role).then(function(r) {
      if (!r || !r.success) { toast((r && r.error) || 'Add failed', 'error'); return; }
      toast(t('toast.sync.member-added', 'Member added'), 'success');
      loadTeamPanel();
    }).catch(function(e) { toast(e.message, 'error'); });
  };

  agentBrowser.teamRename = function() {
    var name = (document.getElementById('team-workspace-rename') || {}).value || '';
    api.team.rename(name).then(function(r) {
      if (!r || !r.success) { toast((r && r.error) || 'Rename failed', 'error'); return; }
      toast(t('toast.sync.workspace-renamed', 'Workspace renamed'), 'success');
      loadTeamPanel();
    }).catch(function(e) { toast(e.message, 'error'); });
  };
})();
