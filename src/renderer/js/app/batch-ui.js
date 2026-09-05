/**
 * Batch operation UI (review items PL-01 / PL-02).
 *
 * Batch launch used to fire one `setTimeout` per profile and toast
 * "N profiles started" without looking at a single result. This module drives
 * the main-process batch runner instead and shows an honest tally: how many
 * actually started, which ones failed, why, and a way to retry just those.
 */
(function () {
  "use strict";

  var agentBrowser = window.agentBrowser;
  var api = agentBrowser.api;
  var toast = agentBrowser.helpers.toast;
  var esc = agentBrowser.helpers.esc;
  var t = function (k, fb) { return window.i18n ? window.i18n.t(k, fb) : fb; };

  // P3 (#110): ask the main process for the cap instead of hardcoding —
  // falls back to 4 when the channel is unavailable (older builds).
  var DEFAULT_CONCURRENCY = 4;
  try {
    if (api.browser.batchMaxConcurrency) {
      api.browser.batchMaxConcurrency().then(function (r) {
        if (r && Number.isFinite(Number(r.max))) DEFAULT_CONCURRENCY = Math.min(8, Math.max(1, Math.floor(Number(r.max))));
      }).catch(function () { /* keep fallback */ });
    }
  } catch (e) { /* keep fallback */ }

  var activeJob = null;
  var lastResult = null;

  function progressHost() {
    return document.getElementById("profile-list");
  }

  function showProgress(total, done) {
    var host = progressHost();
    if (!host) return;
    var el = document.getElementById("batch-progress");
    if (!el) {
      el = document.createElement("div");
      el.id = "batch-progress";
      el.className = "batch-progress";
      host.parentNode.insertBefore(el, host);
    }
    var label = document.getElementById("batch-progress-label");
    var bar = document.getElementById("batch-progress-bar");
    if (!label) {
      label = document.createElement("span");
      label.id = "batch-progress-label";
      el.appendChild(label);
    }
    if (!bar) {
      var wrap = document.createElement("span");
      wrap.className = "bar";
      bar = document.createElement("i");
      bar.id = "batch-progress-bar";
      wrap.appendChild(bar);
      el.appendChild(wrap);
    }
    // R8 P2-1: the old progress bar had no cancel — a 50-profile batch was
    // uninterruptible from the UI. The button calls cancelActive(), which
    // flips the cooperative flag so queued items stop starting.
    var cancelBtn = document.getElementById("batch-progress-cancel");
    if (!cancelBtn) {
      cancelBtn = document.createElement("button");
      cancelBtn.id = "batch-progress-cancel";
      cancelBtn.className = "btn btn-secondary btn-sm";
      cancelBtn.type = "button";
      cancelBtn.textContent = t("batch.cancel", "Cancel");
      cancelBtn.addEventListener("click", function () { cancelActive(); });
      el.appendChild(cancelBtn);
    }
    var pct = total ? Math.round((done / total) * 100) : 0;
    label.textContent = t("batch.progress", "Working…") + " " + done + "/" + total;
    bar.style.width = pct + "%";
    el.style.display = "";
  }

  function hideProgress() {
    var el = document.getElementById("batch-progress");
    if (el) el.style.display = "none";
  }

  function onBatchProgress(payload) {
    if (!activeJob || !payload || payload.jobId !== activeJob.jobId) return;
    showProgress(payload.total || activeJob.dirIds.length, payload.done || 0);
  }

  /**
   * Run a bounded-concurrency batch operation and show the aggregate result.
   * @param {{kind: "launch"|"stop", dirIds: string[], concurrency?: number}} opts
   */
  function run(opts) {
    var kind = opts.kind === "stop" ? "stop" : "launch";
    var dirIds = (opts.dirIds || []).filter(Boolean);
    if (!dirIds.length) return Promise.resolve(null);
    // R8 P2-2: batches used to overwrite activeJob, so two concurrent runs
    // each drove 4 Chromium launches (8 total) and scrambled progress.
    // Refuse a second batch while one is in flight.
    if (activeJob) {
      toast(t("batch.already-running", "A batch operation is already running — cancel it first"), "info");
      return Promise.resolve(null);
    }

    var concurrency = Math.min(8, Math.max(1, Number(opts.concurrency) || DEFAULT_CONCURRENCY));
    var jobId = agentBrowser.ipc.newTraceId();
    activeJob = { jobId: jobId, kind: kind, dirIds: dirIds, concurrency: concurrency };
    showProgress(dirIds.length, 0);

    var invoke = kind === "stop"
      ? function () { return api.browser.batchStop(dirIds, concurrency, jobId); }
      : function () { return api.browser.batchLaunch(dirIds, concurrency, jobId); };

    return agentBrowser.ipc.call("browser.batch." + kind, invoke, { kind: "write" })
      .then(function (result) {
        activeJob = null;
        hideProgress();
        showResult(result, kind);
        return result;
      })
      .catch(function (e) {
        activeJob = null;
        hideProgress();
        toast(e && e.message ? e.message : String(e), "error", { detail: e && e.traceId ? "traceId: " + e.traceId : undefined });
        throw e;
      });
  }

  function cancelActive() {
    if (!activeJob) return;
    try {
      api.browser.batchCancel(activeJob.jobId).catch(function () {});
    } catch (e) { /* ignore */ }
  }

  function locateCard(dirId) {
    var card = document.querySelector('#profile-list .profile-card[data-dir-id="' + String(dirId).replace(/"/g, "") + '"]');
    if (!card) return false;
    if (card.scrollIntoView) card.scrollIntoView({ block: "center", behavior: "smooth" });
    card.classList.add("highlight");
    setTimeout(function () { card.classList.remove("highlight"); }, 2000);
    return true;
  }

  function showResult(result, kind) {
    lastResult = { result: result, kind: kind };
    // Sale-90/92: when every failure is the license gate, skip the 50-row
    // failure list — open the paywall dialog once instead.
    if (kind === "launch" && result && result.failed > 0 && typeof agentBrowser.interceptLicenseGate === "function") {
      var items = result.results || [];
      var gated = items.filter(function (r) { return !r.ok && (r.code === "LICENSE_EXPIRED" || r.code === "PROFILE_LIMIT"); });
      if (gated.length && gated.length === result.failed) {
        var first = gated[0];
        agentBrowser.interceptLicenseGate({ success: false, code: first.code, error: first.error });
        return;
      }
    }
    var dlg = document.getElementById("dlg-batch-result");
    if (!dlg) {
      // No dialog in the DOM (e.g. unit test) — fall back to a toast.
      toast(summaryText(result, kind), result.failed ? "error" : "success");
      return;
    }
    var titleEl = document.getElementById("batch-result-title");
    var summaryEl = document.getElementById("batch-result-summary");
    var listEl = document.getElementById("batch-result-list");
    var retryBtn = document.getElementById("batch-result-retry");

    if (titleEl) {
      titleEl.textContent = kind === "stop"
        ? t("batch.result.title-stop", "Stop profiles")
        : t("batch.result.title-launch", "Start profiles");
    }
    if (summaryEl) summaryEl.innerHTML = summaryHtml(result, kind);
    if (listEl) listEl.innerHTML = failureListHtml(result);
    if (retryBtn) retryBtn.style.display = result.failed > 0 ? "" : "none";

    if (!dlg.open) dlg.showModal();
  }

  function summaryText(result, kind) {
    var verb = kind === "stop" ? t("batch.stopped", "stopped") : t("batch.started", "started");
    return t("batch.summary", "{ok} of {total} {verb}").replace("{ok}", result.succeeded).replace("{total}", result.total).replace("{verb}", verb);
  }

  function summaryHtml(result, kind) {
    var parts = [];
    parts.push('<div style="font-size:13px;">' + esc(summaryText(result, kind)) + "</div>");
    if (result.failed > 0) {
      parts.push('<div style="font-size:12px;color:var(--danger);margin-top:4px;">' +
        esc(t("batch.failed-count", "{n} failed").replace("{n}", result.failed)) + "</div>");
    }
    if (result.cancelled) {
      parts.push('<div style="font-size:12px;color:var(--warning);margin-top:4px;">' + esc(t("batch.cancelled", "Cancelled")) + "</div>");
    }
    parts.push('<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' +
      esc(t("batch.duration", "Took {ms}ms · concurrency {c}").replace("{ms}", result.durationMs).replace("{c}", result.concurrency)) + "</div>");
    return parts.join("");
  }

  function failureListHtml(result) {
    var failures = (result.results || []).filter(function (r) { return !r.ok; });
    if (!failures.length) return "";
    var rows = failures.map(function (r) {
      var name = (r.value && r.value.name) || r.item || "?";
      var reason = r.error || t("batch.unknown-error", "Unknown error");
      return '<div style="display:flex;align-items:flex-start;gap:8px;border-bottom:1px solid var(--border);padding:6px 0;">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:12.5px;font-weight:600;">' + esc(name) + "</div>" +
          '<div style="font-size:11.5px;color:var(--danger);word-break:break-word;">' + esc(reason) + "</div>" +
        "</div>" +
        '<button class="btn btn-secondary btn-sm" data-batch-locate="' + esc(String(r.item)) + '">' +
          esc(t("batch.locate", "Locate")) + "</button>" +
        "</div>";
    }).join("");
    return '<div style="margin-top:10px;max-height:260px;overflow:auto;">' + rows + "</div>";
  }

  function closeResult() {
    var dlg = document.getElementById("dlg-batch-result");
    if (dlg && dlg.open) dlg.close();
  }

  function retryFailed() {
    if (!lastResult) return;
    var failedIds = (lastResult.result.results || [])
      .filter(function (r) { return !r.ok; })
      .map(function (r) { return r.item; });
    if (!failedIds.length) return;
    closeResult();
    run({ kind: lastResult.kind, dirIds: failedIds, concurrency: lastResult.result.concurrency || DEFAULT_CONCURRENCY });
  }

  agentBrowser.batch = {
    run: run,
    cancelActive: cancelActive,
    locateCard: locateCard,
    showResult: showResult,
    closeResult: closeResult,
    retryFailed: retryFailed,
    onBatchProgress: onBatchProgress,
    DEFAULT_CONCURRENCY: DEFAULT_CONCURRENCY,
  };

  // Subscribe to main-process progress events.
  try {
    if (api && typeof api.on === "function") api.on("batch:progress", onBatchProgress);
  } catch (e) { /* progress is best effort */ }

  // Wire dialog actions (delegated so they survive re-renders).
  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var locate = target.closest("[data-batch-locate]");
    if (locate) {
      locateCard(locate.getAttribute("data-batch-locate"));
      return;
    }
    var cmd = target.closest("[data-batch-cmd]");
    if (!cmd) return;
    var name = cmd.getAttribute("data-batch-cmd");
    if (name === "retry") retryFailed();
    else if (name === "close") closeResult();
  });
})();
