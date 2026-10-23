// Fingerprint comparison is a snapshot viewer, not a safety verdict or a launch gate.
// Main owns classification, persistence, candidate trust and mutation authority.
(function () {
  "use strict";
  var app = window.agentBrowser;
  var api = app.api;
  var esc = app.helpers.esc;
  var escAttr = app.helpers.escAttr;
  var icon = app.helpers.icon;
  var view = { epoch: 0, contextSeq: 0, dirId: null, result: null, options: {}, running: null, metadata: null, loading: false, busy: false, saved: false, notice: null };
  var severities = ["risk", "review", "unavailable", "info", "unknown"];
  function t(key) { return window.i18n ? window.i18n.t(key) : key; }
  function el(id) { return document.getElementById(id); }
  function dialog() { return el("dlg-fingerprint-drift"); }
  function current(epoch, dirId) { return !!(dialog() && dialog().open) && view.epoch === epoch && view.dirId === dirId; }
  function own(obj, key) { return !!obj && Object.prototype.hasOwnProperty.call(obj, key); }
  function reportOf(result) {
    var report = result && (result.report || result.lastComparison);
    return report && report.schemaVersion === 1 && Array.isArray(report.changes) ? report : null;
  }
  function request(key, fn, epoch) {
    return app.ipc.call("fingerprint-view:" + key + ":" + view.dirId + ":" + epoch, fn, { kind: "list", dedupe: false });
  }
  function observationTime(at) {
    var date = typeof at === "number" && Number.isFinite(at) && at > 0 ? new Date(at) : null;
    return date && Number.isFinite(date.getTime()) ? date : null;
  }
  function valueText(value, present) {
    if (!present || value === undefined) return t("fingerprint.value.missing");
    if (value === null) return t("fingerprint.value.null");
    if (value === "") return t("fingerprint.value.empty");
    try {
      var text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return typeof text === "string" ? text : t("fingerprint.value.missing");
    } catch (error) { return t("fingerprint.value.unreadable"); }
  }
  var fieldLabels = {
    userAgent: "userAgent", platform: "platform", uaHighEntropy: "uaHighEntropy", workerIdentity: "workerIdentity", persona: "persona",
    architecture: "architecture", bitness: "bitness", platformVersion: "platformVersion", browserVersion: "browserVersion", uaFullVersion: "browserVersion", fullVersionList: "browserVersion", brands: "brands", mobile: "mobile", model: "model", wow64: "wow64",
    hardwareConcurrency: "hardwareConcurrency", deviceMemory: "deviceMemory", language: "language", languages: "languages", locale: "language", timezone: "timezone", timezoneOffset: "timezoneOffset",
    innerWidth: "innerWidth", innerHeight: "innerHeight", outerWidth: "outerWidth", outerHeight: "outerHeight", screenX: "screenX", screenY: "screenY", screenLeft: "screenX", screenTop: "screenY",
    screen: "screen", screenWidth: "screenWidth", screenHeight: "screenHeight", width: "width", height: "height", availWidth: "availWidth", availHeight: "availHeight", availLeft: "availLeft", availTop: "availTop", colorDepth: "colorDepth", pixelDepth: "colorDepth", devicePixelRatio: "devicePixelRatio",
    canvas: "canvas", canvasHash: "canvas", audio: "audio", audioHash: "audio", fonts: "fonts", fontHash: "fonts", webgl: "webgl", webglVendor: "webglVendor", webglRenderer: "webglRenderer", webglHash: "webgl", gpu: "gpu",
    colorScheme: "colorScheme", theme: "colorScheme", systemColors: "systemColors", mediaDevices: "mediaDevices", voices: "voices", permissions: "permissions", hash: "hash",
  };
  function fieldName(field) {
    var parts = field.split("."), root = fieldLabels[parts[0]], leaf = fieldLabels[parts[parts.length - 1]];
    if (parts.length === 1) return t("fingerprint.field." + (root || "unknown"));
    return t("fingerprint.field.path").replace("{root}", t("fingerprint.field." + (root || "unknown")))
      .replace("{leaf}", t("fingerprint.field." + (leaf || "unknown")));
  }
  // Legacy values are displayed, not classified. Split supplied nested objects
  // into leaves so an architecture change is readable; never invent absent data.
  function legacyRows(drift) {
    var rows = [];
    function add(field, before, after, hasBefore, hasAfter, depth) {
      var nested = function (value) { return value && typeof value === "object" && !Array.isArray(value); };
      if (depth < 3 && (nested(before) || nested(after))) {
        var keys = Object.keys(nested(before) ? before : {}).concat(Object.keys(nested(after) ? after : {}));
        keys.filter(function (key, index) { return keys.indexOf(key) === index; }).forEach(function (key) {
          add(field + "." + key, nested(before) ? before[key] : undefined, nested(after) ? after[key] : undefined, nested(before) && own(before, key), nested(after) && own(after, key), depth + 1);
        });
        if (keys.length) return;
      }
      rows.push({ field: field, baseline: before, current: after, hasBefore: hasBefore, hasAfter: hasAfter, severity: "unknown", reason: "unknown-field" });
    }
    (Array.isArray(drift) ? drift : []).forEach(function (row) {
      if (row && typeof row.field === "string") add(row.field, row.baseline, row.current, own(row, "baseline"), own(row, "current"), 0);
    });
    return rows;
  }
  function rowsOf(result) {
    var report = reportOf(result);
    if (report) return report.changes.filter(function (row) { return row && typeof row.field === "string"; }).map(function (row) {
      return { field: row.field, baseline: row.baseline, current: row.current, hasBefore: own(row, "baseline"), hasAfter: own(row, "current"),
        severity: severities.indexOf(row.severity) === -1 ? "unknown" : row.severity, reason: row.reason };
    });
    var rows = legacyRows(result && result.drift);
    if (!rows.length && result && result.lastBlocked && Array.isArray(result.lastBlocked.fields)) {
      result.lastBlocked.fields.filter(function (field) { return typeof field === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(field); }).forEach(function (field) {
        rows.push({ field: field, hasBefore: false, hasAfter: false, severity: "unknown", reason: "unknown-field" });
      });
    }
    return rows;
  }
  function countsOf(report) {
    var counts = {};
    severities.forEach(function (severity) {
      var n = report && report.counts && report.counts[severity];
      counts[severity] = typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
    });
    return counts;
  }
  function identityConflict(result) {
    return !!(result && result.code === "BASELINE_IDENTITY_CONFLICT") || rowsOf(result).some(function (row) {
      return /^persona(?:\.|$)/.test(row.field) && row.severity === "risk";
    });
  }
  function summaryKey(result) {
    var report = reportOf(result), counts = countsOf(report);
    if (view.saved) return "fingerprint.saved";
    if (result && result.code === "PROFILE_NOT_RUNNING" && !report) return "health.drift.stopped";
    if (result && result.outcome === "risk") return "fingerprint.summary.risk";
    if (result && result.outcome === "warn") return "fingerprint.summary.review";
    if (result && (result.error && result.code !== "PROFILE_NOT_RUNNING" || result.checked === false || result.outcome === "error" || result.outcome === "unavailable")) return "fingerprint.summary.unavailable";
    if (!report && result && result.hasBaseline === false || report && !report.hasBaseline) return "fingerprint.summary.no-baseline";
    if (!report) return rowsOf(result).length ? "fingerprint.summary.legacy" : "fingerprint.summary.empty";
    if (counts.risk > 0 || report.risky) return "fingerprint.summary.risk";
    if (counts.review > 0) return "fingerprint.summary.review";
    if (report.partial || counts.unavailable > 0 || report.comparedFields === 0 || rowsOf(result).some(function (row) { return row.severity === "unknown"; })) return "fingerprint.summary.partial";
    if (counts.info > 0) return "fingerprint.summary.info";
    return "fingerprint.summary.unchanged";
  }
  function reasonText(row) {
    var known = ["identity-changed", "browser-version", "window-geometry", "display-environment", "runtime-environment", "probe-unavailable", "baseline-missing", "probe-added", "unknown-field", "persona-identity-conflict"];
    return t("fingerprint.reason." + (known.indexOf(row.reason) === -1 ? "unknown-field" : row.reason));
  }
  function valueHtml(row, side, index) {
    var text = valueText(side === "before" ? row.baseline : row.current, side === "before" ? row.hasBefore : row.hasAfter);
    var label = t(side === "before" ? "health.baseline.previous" : "health.baseline.current");
    var expandable = text.length > 180 || text.split("\n").length > 3;
    var full = '<pre class="fingerprint-drift-value"' + (expandable ? ' tabindex="0"' : '') + '>' + esc(text) + '</pre>';
    return '<div class="fingerprint-drift-value-cell"><div class="fingerprint-drift-value-label">' + esc(label) + '</div>' +
      (expandable
        ? '<details data-fingerprint-expand="' + index + '-' + side + '"><summary><span class="fingerprint-drift-preview">' + esc(text.slice(0, 180)) + '…</span><span class="fingerprint-drift-expand">' + esc(t("fingerprint.value.expand").replace("{n}", text.length)) + '</span></summary>' + full + '</details>' : full) + '</div>';
  }
  function rowHtml(row, index) {
    return '<article class="fingerprint-drift-row" data-fingerprint-severity="' + row.severity + '"><header><div><h5>' + esc(fieldName(row.field)) + '</h5><code class="fingerprint-drift-key">' + esc(row.field) + '</code></div><span class="fingerprint-drift-severity">' + esc(t("fingerprint.severity." + row.severity)) + '</span></header>' +
      '<div class="fingerprint-drift-values">' + valueHtml(row, "before", index) + valueHtml(row, "after", index) + '</div><p class="fingerprint-drift-reason">' + esc(reasonText(row)) +
      (typeof row.reason === "string" ? ' <code>' + esc(row.reason) + '</code>' : '') + '</p></article>';
  }
  function metadataHtml(result, report) {
    var at = report ? report.observedAt : result && (result.observedAt || result.lastBlocked && result.lastBlocked.at);
    var date = observationTime(at), source = report ? report.source : view.options.source;
    var sourceKey = ["launch", "manual", "baseline"].indexOf(source) === -1 ? "unknown" : source;
    var html = '<dl class="fingerprint-drift-meta"><div><dt>' + esc(t("fingerprint.source")) + '</dt><dd>' + esc(t("fingerprint.source." + sourceKey)) + '</dd></div><div><dt>' + esc(t("fingerprint.observed-at")) + '</dt><dd>' +
      (date ? '<time datetime="' + escAttr(date.toISOString()) + '">' + esc(date.toLocaleString()) + '</time>' : esc(t("health.drift.time-unavailable"))) + '</dd></div>';
    if (report) {
      function count(key) { var n = report[key]; return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : t("common.unknown"); }
      html += '<div><dt>' + esc(t("fingerprint.coverage")) + '</dt><dd>' + esc(t("fingerprint.coverage.count").replace("{compared}", count("comparedFields")).replace("{available}", count("availableFields"))) + '</dd></div>' +
        '<div><dt>' + esc(t("fingerprint.surfaces")) + '</dt><dd>' + esc(t("fingerprint.surfaces.count").replace("{sampled}", count("fields")).replace("{baseline}", count("baselineFields"))) + '</dd></div>';
    }
    var accepted = report && observationTime(report.acceptedAt);
    if (accepted) html += '<div><dt>' + esc(t("fingerprint.accepted-at")) + '</dt><dd><time datetime="' + escAttr(accepted.toISOString()) + '">' + esc(accepted.toLocaleString()) + '</time></dd></div>';
    html += '</dl>';
    var historical = view.options.historical || source !== "manual" || result && result.code === "PROFILE_NOT_RUNNING";
    if (historical) html += '<p class="fingerprint-drift-boundary">' + icon("info", 14) + ' ' + esc(t("fingerprint.historical")) + '</p>';
    if (configChanged()) html += '<p class="fingerprint-drift-boundary fingerprint-drift-notice">' + esc(t("fingerprint.config-changed")) + '</p>';
    if (view.options.blocked) html += '<p class="fingerprint-drift-boundary">' + esc(t("health.drift.block-boundary")) + '</p>';
    return html;
  }
  function configChanged() {
    var report = reportOf(view.result), meta = view.metadata;
    return !!report && !!meta && !!meta.report && meta.report.id === report.id && meta.currentConfigMatches === false;
  }
  function canUpdate() {
    var report = reportOf(view.result), meta = view.metadata;
    return !view.saved && view.running === false && !!report && typeof report.id === "string" && !!report.id && report.dirId === view.dirId &&
      !!meta && meta.canUpdateBaseline === true && meta.currentConfigMatches === true && !!meta.report && meta.report.id === report.id && meta.report.dirId === view.dirId && !identityConflict(view.result);
  }
  function nextStepKey() {
    if (identityConflict(view.result) || view.notice && view.notice.code === "BASELINE_IDENTITY_CONFLICT") return "fingerprint.next.identity-conflict";
    if (configChanged()) return "fingerprint.next.config-changed";
    if (view.saved) return view.running === true ? "fingerprint.next.saved-running" : view.running === false ? "fingerprint.next.saved-stopped" : "fingerprint.next.status-unknown";
    if (canUpdate()) return "fingerprint.next.review-candidate";
    if (view.running === false) return "fingerprint.next.fresh-launch";
    if (view.running === true) return "fingerprint.next.running";
    return "fingerprint.next.status-unknown";
  }
  function renderControls() {
    var ready = !view.loading && !view.busy;
    el("fingerprint-drift-recheck").hidden = view.running !== true;
    el("fingerprint-drift-capture").hidden = view.running !== true;
    el("fingerprint-drift-update").hidden = !canUpdate();
    el("fingerprint-drift-launch").hidden = view.running !== false;
    el("fingerprint-drift-launch-label").textContent = t(view.saved ? "fingerprint.start-verify" : "fingerprint.retry-launch");
    ["recheck", "capture", "update", "launch"].forEach(function (action) { el("fingerprint-drift-" + action).disabled = !ready; });
    el("fingerprint-drift-reset").disabled = !ready || view.running !== false;
    el("fingerprint-drift-advanced").hidden = view.loading;
  }
  function render() {
    var body = el("fingerprint-drift-body"), status = el("fingerprint-drift-status");
    if (!body) return;
    var expanded = {};
    body.querySelectorAll("[data-fingerprint-expand]").forEach(function (details) { if (details.open) expanded[details.dataset.fingerprintExpand] = true; });
    el("fingerprint-drift-profile").textContent = view.dirId || "";
    body.setAttribute("aria-busy", view.loading || view.busy ? "true" : "false");
    if (view.loading) {
      body.innerHTML = '<p class="fingerprint-drift-empty">' + esc(t(view.options.readOnly ? "fingerprint.loading.saved" : "fingerprint.loading.check")) + '</p>';
      status.textContent = t(view.options.readOnly ? "fingerprint.loading.saved" : "fingerprint.loading.check");
      renderControls(); return;
    }
    var result = view.result || {}, report = reportOf(result), rows = rowsOf(result), counts = countsOf(report);
    var summary = t(summaryKey(result));
    var html = '<div class="fingerprint-drift-summary"><h4>' + esc(view.options.blocked ? t("health.drift.block-title") : summary) + '</h4>' +
      (view.options.blocked ? '<p>' + esc(summary) + '</p>' : '');
    if (report) html += '<ul class="fingerprint-drift-counts" aria-label="' + escAttr(t("fingerprint.severity-summary")) + '">' + severities.filter(function (severity) { return counts[severity] !== null; }).map(function (severity) {
      return '<li data-fingerprint-severity="' + severity + '">' + esc(t("fingerprint.severity." + severity)) + ' <b>' + counts[severity] + '</b></li>';
    }).join("") + '</ul>';
    html += '</div>' + metadataHtml(result, report);
    if (!report) html += '<p class="fingerprint-drift-boundary">' + esc(t("fingerprint.legacy")) + '</p>';
    if (report && !report.hasBaseline || !report && result.hasBaseline === false) html += '<p class="fingerprint-drift-boundary">' + esc(t("fingerprint.no-baseline")) + '</p>';
    if (report && (report.partial || counts.unavailable > 0)) html += '<p class="fingerprint-drift-boundary">' + esc(t("fingerprint.partial")) + '</p>';
    if (report && report.saved === false) html += '<p class="fingerprint-drift-notice">' + esc(t("fingerprint.not-saved")) + '</p>';
    [report && report.warning, result.warning, view.metadata && view.metadata.warning].filter(function (warning, index, all) { return typeof warning === "string" && warning && all.indexOf(warning) === index; }).forEach(function (warning) {
      html += '<p class="fingerprint-drift-notice">' + esc(warning) + '</p>';
    });
    if (result.error && result.code !== "PROFILE_NOT_RUNNING") html += '<p class="fingerprint-drift-notice">' + esc(String(result.error)) + '</p>';
    if (view.notice) html += '<p class="fingerprint-drift-notice" role="status">' + esc(view.notice.key ? t(view.notice.key) : view.notice.text) + '</p>';
    html += '<section class="fingerprint-drift-next"><h4>' + esc(t("fingerprint.next")) + '</h4><p>' + esc(t(nextStepKey())) + '</p></section>';
    if (rows.length) severities.forEach(function (severity) {
      var group = rows.filter(function (row) { return row.severity === severity; });
      if (group.length) html += '<section class="fingerprint-drift-group"><h4>' + esc(t("fingerprint.severity." + severity)) + ' · ' + group.length + '</h4>' + group.map(function (row) { return rowHtml(row, rows.indexOf(row)); }).join("") + '</section>';
    });
    else html += '<p class="fingerprint-drift-empty">' + esc(t(report && report.hasBaseline ? "fingerprint.empty.changes" : "fingerprint.empty.values")) + '</p>';
    body.innerHTML = html;
    body.querySelectorAll("[data-fingerprint-expand]").forEach(function (details) { details.open = !!expanded[details.dataset.fingerprintExpand]; });
    status.textContent = view.busy ? t("fingerprint.action.pending") : summary;
    renderControls();
  }
  function readContext(epoch, dirId, includeReport) {
    var contextSeq = ++view.contextSeq;
    function active() { return current(epoch, dirId) && contextSeq === view.contextSeq; }
    request("status:" + contextSeq, function () { return api.browser.status(dirId); }, epoch).then(function (result) {
      if (!active()) return;
      view.running = result && result.unknown !== true && result.stopping !== true && typeof result.running === "boolean" ? result.running : null;
      if (result && (result.unknown === true || result.stopping === true)) view.notice = { key: result.stopping ? "profile.runtime.stopping-help" : "profile.runtime.unconfirmed-help" };
      render();
    }).catch(function () { if (active()) { view.running = null; render(); } });
    return request("report:" + contextSeq, function () {
      if (typeof api.browser.driftReport !== "function") throw new Error(t("fingerprint.read-unavailable"));
      return api.browser.driftReport(dirId);
    }, epoch).then(function (result) {
      if (!active()) return;
      if (!result || result.ok !== true || result.error) throw new Error(result && result.error || t("fingerprint.read-unavailable"));
      view.metadata = result;
      if (includeReport) { view.result = { ok: true, report: result.report }; view.loading = false; view.saved = !!(result.report && observationTime(result.report.acceptedAt)); }
      render();
    }).catch(function (error) {
      if (!active()) return;
      view.metadata = null;
      if (includeReport) { view.result = { ok: false, error: error.message || t("fingerprint.read-unavailable") }; view.loading = false; }
      else view.notice = { key: "fingerprint.read-unavailable" };
      render();
    });
  }
  function retire() {
    view.epoch++;
    view.busy = false;
    // Closing is view retirement, not a cancellation request. A main check or
    // an already-confirmed commit can still finish; its late callback is ignored.
  }
  function bind() {
    var dlg = dialog();
    if (!dlg || dlg.dataset.fingerprintBound) return;
    dlg.dataset.fingerprintBound = "1";
    dlg.addEventListener("cancel", retire);
    dlg.addEventListener("close", function () { if (!dlg.open) retire(); });
    el("fingerprint-drift-close").addEventListener("click", function () { dlg.close(); });
    el("fingerprint-drift-recheck").addEventListener("click", function () { if (!view.busy && view.running === true) app.checkDrift(view.dirId); });
    el("fingerprint-drift-capture").addEventListener("click", function () {
      if (view.busy || view.running !== true) return;
      view.busy = true; view.notice = null; render();
      app.lockBaseline(view.dirId, view.epoch);
    });
    el("fingerprint-drift-update").addEventListener("click", reviewCandidate);
    el("fingerprint-drift-launch").addEventListener("click", function () {
      if (view.busy || view.running !== false) return;
      view.busy = true; view.notice = null; render();
      // UI-only epoch, never an option to bypass main's normal launch guards.
      app.launch(view.dirId, { fingerprintViewEpoch: view.epoch });
    });
    el("fingerprint-drift-reset").addEventListener("click", function () {
      if (view.busy || view.running !== false) return;
      var dirId = view.dirId;
      dlg.close();
      app.resetBaseline(dirId);
    });
  }
  function begin(dirId, options) {
    bind();
    view.epoch++;
    view.dirId = dirId; view.result = null; view.options = options || {}; view.running = null; view.metadata = null;
    view.loading = true; view.busy = false; view.saved = false; view.notice = null;
    render();
    var dlg = dialog();
    if (dlg && !dlg.open) dlg.showModal();
    // Viewing a comparison focuses its safe Close control, not a mutation.
    el("fingerprint-drift-close").focus();
    return view.epoch;
  }
  function show(dirId, result, options) {
    options = options || {};
    var epoch = options.epoch;
    if (epoch === undefined) epoch = begin(dirId, options);
    if (!current(epoch, dirId)) return;
    view.result = result || { ok: false, error: t("fingerprint.read-unavailable") };
    view.options = options; view.loading = false; view.busy = false; view.saved = false; view.notice = null; view.running = null; view.metadata = null;
    render();
    readContext(epoch, dirId, false);
  }
  function failureKey(code) {
    if (code === "BASELINE_CONFIRMATION_STALE") return "fingerprint.update.stale";
    if (code === "BASELINE_SNAPSHOT_EXPIRED") return "fingerprint.update.expired";
    if (code === "BASELINE_IDENTITY_CONFLICT") return "fingerprint.next.identity-conflict";
    if (code === "BASELINE_CAPTURE_UNAVAILABLE") return "fingerprint.update.capture-unavailable";
    return "fingerprint.update.failed";
  }
  function baselineOutcome(dirId, result, options) {
    if (!current(options.epoch, dirId)) return;
    view.busy = false;
    if (result && result.ok && (options.live || result.baselineCommitted === true)) {
      view.saved = true;
      view.contextSeq++;
      view.options.historical = true; // A reference commit is not another capture.
      view.metadata = null; // A committed reference invalidates the old candidate.
      view.notice = { key: "fingerprint.saved" };
      if (result.report) view.result = { ok: true, report: result.report };
      if (result.warning) view.notice = { text: t("fingerprint.saved") + " " + result.warning };
    } else if (result && result.code === "BASELINE_CONFIRMATION_REQUIRED") {
      if (result.report) { view.result = { report: result.report }; view.options.historical = true; view.contextSeq++; }
      view.notice = { key: "fingerprint.update.await-confirmation" };
    } else {
      if (result && result.report) { view.result = { ok: false, report: result.report, error: result.error, outcome: result.outcome }; view.options.historical = true; view.contextSeq++; }
      view.notice = { key: failureKey(result && result.code), code: result && result.code };
      if (result && result.code === "PROFILE_NOT_RUNNING") view.running = false;
      if (view.metadata) view.metadata = Object.assign({}, view.metadata, { canUpdateBaseline: false });
    }
    render();
  }
  function canonicalReviewedContent(report) {
    try {
      var content = Object.create(null);
      ["schemaVersion", "policyVersion", "id", "dirId", "observedAt", "source", "engine", "hasBaseline", "fields", "baselineFields", "availableFields", "comparedFields", "changes", "counts", "risky", "partial"].forEach(function (key) {
        if (own(report, key)) content[key] = report[key];
      });
      // Delivery/authority flags can change without changing the reviewed
      // evidence: saved, baselineCandidate, warning and acceptedAt are excluded.
      return JSON.stringify(content, function (_key, value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value;
        var sorted = Object.create(null);
        Object.keys(value).sort().forEach(function (key) { sorted[key] = value[key]; });
        return sorted;
      });
    } catch (error) { return null; }
  }
  function reviewCandidate() {
    if (view.busy || !canUpdate()) return;
    var epoch = view.epoch, dirId = view.dirId, reportId = reportOf(view.result).id;
    var reviewedContent = canonicalReviewedContent(reportOf(view.result));
    view.busy = true; view.notice = null; render();
    app.captureReviewedFingerprintBaseline(dirId, reportId, undefined, epoch).then(function (result) {
      if (!current(epoch, dirId)) return;
      if (!result || !reviewedContent || result.report && (result.report.id !== reportId || result.report.dirId !== dirId || canonicalReviewedContent(result.report) !== reviewedContent)) {
        // A report ID alone is not consent to unseen values. The trusted preview
        // must exactly match the content rendered before the user clicked.
        baselineOutcome(dirId, { ok: false, code: "BASELINE_CONFIRMATION_STALE" }, { epoch: epoch }); return;
      }
      if (result.code !== "BASELINE_CONFIRMATION_REQUIRED" || typeof result.confirmationToken !== "string" || !result.confirmationToken) {
        baselineOutcome(dirId, result.code === "BASELINE_CONFIRMATION_REQUIRED" ? { ok: false } : result, { epoch: epoch }); return;
      }
      // Native nested dialog leaves the comparison open underneath. Cancel/Esc
      // returns to it, and a consumed callback cannot be replayed after closure.
      var token = result.confirmationToken;
      return app.confirmAsync(t("fingerprint.update.confirm"), {
        title: t("fingerprint.update.title"), ackLabel: t("fingerprint.update.ack"),
        detailHtml: '<p>' + esc(t("fingerprint.update.scope")) + '</p><p>' + esc(t("health.baseline.bound-confirmation")) + '</p>',
      }).then(function (accepted) {
        if (!current(epoch, dirId)) return;
        if (!accepted) { view.busy = false; view.notice = { key: "fingerprint.update.cancelled" }; render(); return; }
        return app.captureReviewedFingerprintBaseline(dirId, reportId, token, epoch).then(function (committed) {
          baselineOutcome(dirId, committed || { ok: false, code: "BASELINE_CONFIRMATION_STALE" }, { epoch: epoch });
        });
      });
    }).catch(function () { baselineOutcome(dirId, { ok: false }, { epoch: epoch }); });
  }
  // Receipt copy consumes main's categories; a viewport/theme change is not
  // inferred from a hash, and an unknown legacy change is never called benign.
  app.fingerprintLaunchNotice = function (check) {
    var report = reportOf(check), counts = countsOf(report);
    if (!check) return { warning: false, detail: "", hasDetails: false };
    if (check.checked === false && !check.error && !check.report && !report && !check.risky) return { warning: false, detail: t("launch.drift-not-run"), hasDetails: false };
    if (check.checked === false || check.error) return { warning: true, detail: t("launch.drift-unavailable-warning") + (check.error ? " " + check.error : ""), hasDetails: true };
    if (report) {
      if (counts.risk > 0 || report.risky) return { warning: true, detail: t("launch.drift-risk-warning"), hasDetails: true };
      if (counts.review > 0) return { warning: true, detail: t("launch.drift-review-warning"), hasDetails: true };
      if (report.partial || counts.unavailable > 0) return { warning: true, detail: t("launch.drift-partial-warning"), hasDetails: true };
      return { warning: false, detail: counts.info > 0 ? t("launch.drift-info") : "", hasDetails: true };
    }
    if (check.risky) return { warning: true, detail: t("launch.drift-risk-warning"), hasDetails: true };
    return { warning: Array.isArray(check.drift) && check.drift.length > 0, detail: Array.isArray(check.drift) && check.drift.length ? t("launch.drift-legacy-warning") : "", hasDetails: !!(check.drift && check.drift.length) };
  };
  app.fingerprintComparisonSummary = function (result) {
    var report = reportOf(result), counts = countsOf(report);
    var detail = result && typeof result.error === "string" && result.error || rowsOf(result).map(function (row) { return row.field; }).slice(0, 6).join(", ") || t("fingerprint.scope");
    // Main's business outcome is authoritative, including ok:false risk or
    // unavailable receipts. Infer only for legacy replies with no outcome.
    if (result && typeof result.outcome === "string") {
      var known = ["pass", "warn", "risk", "error", "unavailable", "inconclusive", "cancelled", "baseline-established"];
      return { outcome: known.indexOf(result.outcome) !== -1 ? result.outcome : "inconclusive", detail: detail };
    }
    var outcome = "inconclusive";
    if (!result || !result.ok) outcome = "error";
    else if (report) {
      if (!report.hasBaseline) outcome = "inconclusive";
      else if (report.risky || counts.risk > 0) outcome = "risk";
      else if (counts.review > 0) outcome = "warn";
      else if (report.partial || counts.unavailable > 0) outcome = "inconclusive";
      else if (counts.info > 0) outcome = "inconclusive"; // Informational differences are not a whole-profile PASS.
    } else if (!result.hasBaseline) outcome = "inconclusive";
    else if (result.risky) outcome = "risk";
    else if (rowsOf(result).length) outcome = "inconclusive";
    return { outcome: outcome, detail: detail };
  };
  app.beginFingerprintComparison = begin;
  app.isFingerprintViewCurrent = current;
  app.showFingerprintComparison = show;
  app.showFingerprintBaselineOutcome = baselineOutcome;
  app.openFingerprintDetails = function (dirId) {
    var epoch = begin(dirId, { historical: true, readOnly: true });
    return readContext(epoch, dirId, true);
  };
  app.finishFingerprintLaunchView = function (dirId, result, epoch) {
    if (!current(epoch, dirId)) return;
    show(dirId, result && result.driftCheck || { ok: false, error: result && result.error || t("fingerprint.empty.values") },
      { epoch: epoch, source: "launch", historical: true, blocked: result && result.code === "fingerprint-drift" });
  };
  app.invalidateFingerprintComparison = function () {
    retire();
    view.loading = false; view.running = null; view.metadata = null;
    view.options.historical = true;
    view.notice = { key: "fingerprint.restored-boundary" };
    if (dialog() && dialog().open) render();
  };
  document.addEventListener("agent-browser-language-change", function () { if (dialog() && dialog().open) render(); });
})();
