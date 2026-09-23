// Agent Runs tab — inspectable trace of each agent task execution.
(function() {
  "use strict";
  var agentBrowser = window.agentBrowser;
  var api = agentBrowser.api;
  var helpers = agentBrowser.helpers;
  var toast = helpers.toast;
  var esc = helpers.esc;
  var escAttr = helpers.escAttr;

  var icon = helpers.icon;
  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }

  // R189: reads were bare `api.*.then()` with no timeout, so a hung main
  // process left the list on "加载中…" permanently (measured: unchanged after
  // 12s, no error, no retry). ipc.call already carries a per-kind budget.
  function lcall(key, fn) {
    return agentBrowser.ipc.call(key, fn, { kind: "list" });
  }

  // S2-18: error wore the gray stopped tint — a crashed run and a paused one
  // were indistinguishable at a glance. Failed is danger, not idle.
  var STATUS_CLS = { running: "status-running", done: "status-done", error: "status-failed" };
  var openRunSeq = 0;

  function endReasonLabel(reason) {
    var labels = {
      completed: ["agent.end.completed", "Execution finished"],
      user_cancelled: ["agent.end.user-cancelled", "Stopped by user"],
      timeout: ["agent.end.timeout", "Timed out"],
      round_limit: ["agent.end.round-limit", "Round limit reached"],
      interrupted: ["agent.end.interrupted", "Interrupted"],
      execution_error: ["agent.end.execution-error", "Execution failed"],
    };
    var entry = labels[reason];
    return entry ? t(entry[0], entry[1]) : "";
  }

  // M2: verification is a five-state union. Anything unrecognized — a legacy
  // record, a foreign config, a partial write — falls back to unverified,
  // which is the only honest answer when no verifier graded the run.
  // Shared with agent-chat.js via agentBrowser.verificationView so the two
  // surfaces cannot drift.
  var VERIFICATION_META = {
    unverified: { cls: "status-stopped", key: "agent.run.unverified", label: "Unverified" },
    passed: { cls: "status-done", key: "agent.run.passed", label: "Passed" },
    partial: { cls: "status-warn", key: "agent.run.partial", label: "Partial" },
    failed: { cls: "status-failed", key: "agent.run.failed", label: "Failed" },
    manual_review: { cls: "status-warn", key: "agent.run.manual-review", label: "Needs review" },
  };

  function verificationStatus(run) {
    var status = run && run.verification && run.verification.status;
    return Object.prototype.hasOwnProperty.call(VERIFICATION_META, status) ? status : "unverified";
  }

  function verificationLabel(run) {
    var meta = VERIFICATION_META[verificationStatus(run)];
    return t(meta.key, meta.label);
  }

  function verificationBadge(run) {
    var status = verificationStatus(run);
    var meta = VERIFICATION_META[status];
    return '<span class="status-badge ' + meta.cls + ' run-verification" data-verification="' + escAttr(status) + '">' +
      esc(t(meta.key, meta.label)) + "</span>";
  }

  // Exposed so agent-chat.js renders the same five states.
  agentBrowser.verificationView = {
    status: verificationStatus,
    label: verificationLabel,
    badgeHtml: verificationBadge,
    meta: VERIFICATION_META,
  };

  function statusBadge(run) {
    var cls = STATUS_CLS[run.status] || "status-stopped";
    // R158: the fallback used to be run.status itself — undefined for a
    // partial record printed the raw key "runs.status.undefined". The dict
    // keys are enumerated; a status outside them renders as the status badge
    // equivalent of "?" instead of leaking internals.
    var known = { running: true, done: true, error: true };
    var label = known[run.status] ? t("runs.status." + run.status, run.status) : t("runs.status.unknown", "?");
    return '<span class="status-badge ' + cls + '">' + esc(label) + "</span>";
  }

  function sourceLabel(src) {
    if (!src) return "?";
    if (src.type === "automation") {
      // R146: the separator used to live inside the fallback string
      // ("Scheduled "). The zh entry is "定时" with no trailing space, so
      // switching language silently glued the label to the rule name
      // ("定时Nightly price sweep"). Join explicitly instead — a translator
      // cannot be expected to encode layout in a trailing space.
      var head = t("runs.source.schedule", "Scheduled");
      var label = esc(head) + ' · ' + esc(src.ruleName || src.ruleId || "");
      if (src.jobId) label += ' <span style="font-family:var(--mono);color:var(--text-muted);">' + esc(src.jobId) + '</span>';
      return label;
    }
    return t("runs.source.chat", "Chat");
  }

  // R174: was a private copy; batch-ui.js now owns the shared version so the
  // batch dialog and the run timeline cannot drift apart.
  var fmtDuration = helpers.fmtDuration;

  // R158: the duration slot used to print "运行中…" for live runs — the same
  // word the status badge right next to it already shows. Show elapsed time
  // instead; finished runs keep the total duration.
  //
  // R176: the elapsed value was computed once at render time and then froze —
  // refreshes only arrive on agent:run-step, so a run sitting in a long LLM
  // call showed a stale "已运行 1m 32s" for minutes while its wording promised
  // a live reading. Live entries now carry data-live-since and a low-frequency
  // tick (below) rewrites just those nodes, so the list is not re-rendered
  // under the user's cursor.
  function durationText(run) {
    if (run.finishedAt) return fmtDuration(run.finishedAt - run.startedAt);
    if (run.startedAt) return t("runs.elapsed-prefix", "已运行 ") + fmtDuration(Date.now() - run.startedAt);
    return t("runs.running-hint", "运行中…");
  }

  // Wraps a duration string in a span the ticker can find, but only while the
  // run is still live; finished runs get a plain span.
  function durationHtml(run) {
    var text = durationText(run);
    if (!run.finishedAt && run.startedAt) {
      return '<span data-live-since="' + escAttr(String(run.startedAt)) + '">' + esc(text) + "</span>";
    }
    return "<span>" + esc(text) + "</span>";
  }

  // 1s is the resolution fmtDuration prints below 60s; above that most ticks
  // are no-ops, so throttle to a coarser cadence once the span is minutes.
  var liveTickTimer = null;
  function tickLiveDurations() {
    var nodes = document.querySelectorAll("[data-live-since]");
    if (!nodes.length) return;
    var now = Date.now();
    nodes.forEach(function (el) {
      var since = Number(el.getAttribute("data-live-since"));
      if (!since) return;
      var next = t("runs.elapsed-prefix", "已运行 ") + fmtDuration(now - since);
      if (el.textContent !== next) el.textContent = next;
    });
  }
  function ensureLiveTicker() {
    if (liveTickTimer) return;
    liveTickTimer = setInterval(function () {
      if (document.hidden) return;              // no point while backgrounded
      if (!document.querySelector("[data-live-since]")) return;
      tickLiveDurations();
    }, 1000);
  }

  // JSON for <pre>, safely (we escape on insert via textContent in detail rendering)
  function jsonPreview(val, max) {
    try {
      var s = typeof val === "string" ? val : JSON.stringify(val);
      if (!s) return t("runs.empty-json", "(空)");
      return s.length > (max || 200) ? s.slice(0, max || 200) + "…" : s;
    } catch (e) { return String(val); }
  }

  // ── Filters ──
  // Everything is client-side over the ≤200 summaries the list IPC returns;
  // there is no server-side query. Filter state survives live refreshes (the
  // events re-run loadRunsTab, so the values must live outside the render).
  var filters = {
    name: "",
    range: "all",            // all | 1h | 24h | 7d | 30d
    source: "all",           // all | chat | automation
    profile: "all",          // all | <dirId>
    endReason: "all",        // all | <endReason> | none
    verification: "all",     // all | <five states>
  };
  var lastList = [];

  function readFilters() {
    var get = function(id) { var el = document.getElementById(id); return el ? el.value : ""; };
    filters.name = get("run-filter-name") || "";
    filters.range = get("run-filter-range") || "all";
    filters.source = get("run-filter-source") || "all";
    filters.profile = get("run-filter-profile") || "all";
    filters.endReason = get("run-filter-endReason") || "all";
    filters.verification = get("run-filter-verification") || "all";
  }

  var RANGE_MS = { "1h": 3600e3, "24h": 86400e3, "7d": 7 * 86400e3, "30d": 30 * 86400e3 };

  function matchesFilters(run) {
    if (filters.name) {
      var needle = filters.name.toLowerCase();
      var hay = ((run.name || "") + " " + ((run.source && run.source.ruleName) || "")).toLowerCase();
      if (hay.indexOf(needle) === -1) return false;
    }
    if (filters.range !== "all") {
      var span = RANGE_MS[filters.range];
      if (span && (!run.startedAt || Date.now() - run.startedAt > span)) return false;
    }
    if (filters.source !== "all") {
      var type = run.source && run.source.type;
      if (type !== filters.source) return false;
    }
    if (filters.profile !== "all" && run.dirId !== filters.profile) return false;
    if (filters.endReason !== "all") {
      var reason = run.endReason || "none";
      if (reason !== filters.endReason) return false;
    }
    if (filters.verification !== "all" && verificationStatus(run) !== filters.verification) return false;
    return true;
  }

  /** Rebuild the profile dropdown from the current list so it only ever
   *  offers values that exist. The previous selection is kept when still
   *  present. */
  function syncProfileOptions(list) {
    var sel = document.getElementById("run-filter-profile");
    if (!sel) return;
    var ids = [];
    var seen = {};
    list.forEach(function(r) {
      if (r.dirId && !seen[r.dirId]) { seen[r.dirId] = true; ids.push(r.dirId); }
    });
    ids.sort();
    var wanted = filters.profile !== "all" && seen[filters.profile] ? filters.profile : "all";
    var html = '<option value="all">' + esc(t("runs.filter.any-profile", "全部浏览器配置")) + "</option>" +
      ids.map(function(id) { return '<option value="' + escAttr(id) + '">' + esc(id) + "</option>"; }).join("");
    if (sel.dataset.signature !== html) {
      sel.innerHTML = html;
      sel.dataset.signature = html;
    }
    sel.value = wanted;
    filters.profile = wanted;
  }

  function updateFilterSummary(total, shown) {
    var el = document.getElementById("run-filter-summary");
    if (!el) return;
    if (shown === total) {
      el.textContent = t("runs.filter.all-shown", "共 {n} 条").replace("{n}", String(total));
    } else {
      el.textContent = t("runs.filter.filtered", "筛选出 {shown} / {total} 条")
        .replace("{shown}", String(shown)).replace("{total}", String(total));
    }
  }

  agentBrowser.loadRunsTab = function() {
    readFilters();
    lcall("agentRuns.list", function () { return api.agentRuns.list(); }).then(function(list) {
      var el = document.getElementById("agent-run-list");
      lastList = list || [];
      syncProfileOptions(lastList);
      if (!lastList || lastList.length === 0) {
        updateFilterSummary(0, 0);
        if (window.agentBrowser && window.agentBrowser.renderViewState) window.agentBrowser.renderViewState(el,{empty:t("runs.empty-state","暂无记录")}); else el.innerHTML = '<div class="empty-state">' + t("runs.empty-state", "还没有运行记录。<br>在 Agent 里发一条消息,或让定时任务跑一次,记录会出现在这里。") + '</div>';
        return;
      }
      var visible = lastList.filter(matchesFilters);
      updateFilterSummary(lastList.length, visible.length);
      if (visible.length === 0) {
        // A filter that matches nothing is not an empty history — say so, and
        // keep the controls on screen so the user can undo it.
        el.innerHTML = '<div class="empty-state">' + esc(t("runs.filter.no-match", "没有符合当前筛选条件的运行记录。")) + "</div>";
        return;
      }
      el.innerHTML = groupRuns(visible).map(function(item) {
        return item.group ? renderGroupCard(item.group) : renderRunCard(item.single);
      }).join("");
      ensureLiveTicker();
      el.onclick = function(event) {
        var btn = event.target.closest("[data-run-action], [data-group-action]");
        if (!btn || !el.contains(btn)) return;
        if (btn.dataset.groupAction === "retry-failed") {
          var gcard = btn.closest("[data-group-id]");
          if (gcard) agentBrowser.runsRetryJob(gcard.dataset.groupId);
          return;
        }
        var card = btn.closest("[data-run-id]");
        if (!card) return;
        var runId = card.dataset.runId;
        if (btn.dataset.runAction === "open") agentBrowser.runsOpen(runId);
        else if (btn.dataset.runAction === "delete") agentBrowser.runsDelete(runId);
        else if (btn.dataset.runAction === "retry") agentBrowser.runsRetry(runId);
      };
    }).catch(function(e) { var _el=document.getElementById("agent-run-list"); if(window.agentBrowser&&window.agentBrowser.renderViewState&&_el) window.agentBrowser.renderViewState(_el,{error:e.message||String(e), retry:{cmd:"loadRunsTab"}}); toast(t("runs.toast.load-failed", "加载失败: ") + (e.message || e), "error"); });
  };

  // Batch runs from one automation job share source.jobId (one job = one batch
  // execution). Group those into a single expandable card; everything else
  // renders as its own card. The list is newest-first, so each group is placed
  // at the position of its newest run.
  function groupRuns(list) {
    var byJob = {};
    list.forEach(function(run) {
      var jobId = run.source && run.source.type === "automation" && run.source.jobId ? run.source.jobId : "";
      if (jobId) (byJob[jobId] = byJob[jobId] || []).push(run);
    });
    var isGroup = {};
    Object.keys(byJob).forEach(function(jobId) {
      if (byJob[jobId].length >= 2) isGroup[jobId] = true;
    });
    var items = [];
    var seen = {};
    list.forEach(function(run) {
      var jobId = run.source && run.source.type === "automation" && run.source.jobId ? run.source.jobId : "";
      if (jobId && isGroup[jobId]) {
        if (seen[jobId]) return;
        seen[jobId] = true;
        items.push({ group: byJob[jobId] });
      } else {
        items.push({ single: run });
      }
    });
    return items;
  }

  // M2: any TERMINAL automation run is re-runnable (a passed run may be
  // refreshed, not only a failed one). A live run is never offered — the
  // resolver rejects it anyway, but the button should not lie. Chat runs are
  // excluded: they have no rule action to re-issue.
  function canRetryRun(run) {
    return !!run && run.status !== "running" && !!run.dirId && !!run.source &&
      run.source.type === "automation" && !!run.source.ruleId;
  }

  function retryButton(run) {
    return canRetryRun(run)
      ? '<button class="btn btn-primary btn-sm" data-run-action="retry">' +
          esc(t("runs.btn.rerun", "再次运行")) + "</button>"
      : "";
  }

  function groupRetryButton(runs) {
    var n = runs.filter(canRetryRun).length;
    return n > 0
      ? '<button class="btn btn-primary btn-sm" data-group-action="retry-failed">' + t("runs.btn.retry-all", "重试全部失败") + " (" + n + ")</button>"
      : "";
  }

  function renderRunCard(run) {
    var name = esc(run.name);
    if (run.source && run.source.retryOf) {
      name += ' <span class="status-badge status-warn">' + esc(t("runs.retry-tag", "重试")) + '</span>';
    }
    return '<div class="profile-card" data-run-id="' + escAttr(run.id) + '">' +
      '<div class="card-header card-head-inline"><span class="name">' + name + "</span>" + statusBadge(run) + "</div>" +
      '<div class="info-row"><span>' + t("runs.row.source", "来源") + '</span><span>' + sourceLabel(run.source) + "</span></div>" +
      (run.dirId ? '<div class="info-row"><span>' + t("runs.row.profile", "Profile") + '</span><span style="font-family:var(--mono);font-size:11px;">' + esc(run.dirId) + "</span></div>" : "") +
      '<div class="info-row"><span>' + t("runs.row.steps", "步骤") + '</span><span>' + esc(t("runs.row.steps-n", "{n} steps").replace("{n}", String(run.stepCount))) + "</span></div>" +
      '<div class="info-row"><span>' + t("runs.row.duration", "耗时") + '</span>' + durationHtml(run) + "</div>" +
      (run.startedAt ? '<div class="info-row"><span>' + t("runs.row.started", "开始") + '</span><span class="num" title="' + escAttr(new Date(run.startedAt).toLocaleString()) + '">' + esc(helpers.relTime ? helpers.relTime(run.startedAt) : new Date(run.startedAt).toLocaleString()) + "</span></div>" : "") +
      '<div class="card-actions">' +
        '<button class="btn btn-secondary btn-sm" data-run-action="open">' + t("runs.btn.view", "查看") + '</button>' +
        retryButton(run) +
        '<button class="btn btn-danger btn-sm" data-run-action="delete">' + t("runs.btn.delete", "删除") + '</button>' +
      "</div>" +
    "</div>";
  }

  function groupSummary(runs) {
    var ok = runs.filter(function(r) { return r.status === "done"; }).length;
    var failed = runs.filter(function(r) { return r.status === "error"; }).length;
    var running = runs.filter(function(r) { return r.status === "running"; }).length;
    var parts = [];
    // R147: "ok" was a bare English literal while its two siblings went through
    // t(), so the zh UI rendered "1 ok / 1 失败" — half-translated inside one
    // badge. All three counts now come from the same table.
    if (ok > 0) parts.push(ok + " " + t("runs.group.ok", "ok"));
    if (failed > 0) parts.push(failed + " " + t("runs.group.failed", "failed"));
    if (running > 0) parts.push(running + " " + t("runs.group.running", "running"));
    return parts.join(" / ") || "—";
  }

  function groupBadge(runs) {
    var running = runs.some(function(r) { return r.status === "running"; });
    var failed = runs.some(function(r) { return r.status === "error"; });
    // S2-18: failed groups wore the stopped gray — same mis-mapping as single runs.
    var cls = running ? "status-running" : (failed ? "status-failed" : "status-done");
    return '<span class="status-badge ' + cls + '">' + esc(groupSummary(runs)) + "</span>";
  }

  function renderGroupCard(runs) {
    var first = runs[0];
    var rows = runs.map(function(run) {
      var durRowHtml = durationHtml(run);
      var err = run.error
        ? '<div style="color: var(--danger-text);font-size:11px;word-break:break-word;margin-top:4px;">' + esc(run.error).slice(0, 160) + "</div>"
        : "";
      return '<div class="run-group-row" data-run-id="' + escAttr(run.id) + '" style="border-top:1px solid var(--border);padding:8px 0;">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          '<span style="font-family:var(--mono);font-size:11px;word-break:break-all;">' + esc(run.dirId || "—") + "</span>" +
          statusBadge(run) +
          '<span style="color:var(--text-muted);font-size:11px;">' + esc(t("runs.row.steps-n", "{n} steps").replace("{n}", String(run.stepCount))) + " · " + durRowHtml + "</span>" +
          '<span style="margin-left:auto;display:inline-flex;gap:6px;">' +
            '<button class="btn btn-secondary btn-sm" data-run-action="open">' + t("runs.btn.view", "查看") + '</button>' +
            retryButton(run) +
            '<button class="btn btn-danger btn-sm" data-run-action="delete">' + t("runs.btn.delete", "删除") + '</button>' +
          "</span>" +
        "</div>" + err +
      "</div>";
    }).join("");
    return '<div class="profile-card run-group-card" data-group-id="' + escAttr(first.source && first.source.jobId ? first.source.jobId : "") + '">' +
      '<div class="card-header card-head-inline"><span class="name">' + esc(first.name) +
        ' <span class="run-group-count">× ' + runs.length + ' ' + t("runs.group.profiles", "profiles") + '</span></span>' +
        // R197: was an anonymous <span> with inline flex styles. The header is
        // a flex row now, and an unclassed child gets no `margin-left: auto`,
        // so the retry button and badge wrapped *above* the title — the name
        // truncated to "Nightly price …" and the profile count was clipped.
        // `.card-status` is the class the header CSS already knows: it takes
        // the slack and wraps as a unit.
        // S2-19: the retry-all button moved to the card's footer — a primary
        // action is the card's exit, not part of its title.
        '<span class="card-status">' + groupBadge(runs) + "</span></div>" +
      '<div class="info-row"><span>' + t("runs.row.source", "来源") + '</span><span>' + sourceLabel(first.source) + "</span></div>" +
      (first.startedAt ? '<div class="info-row"><span>' + t("runs.row.started", "开始") + '</span><span class="num" title="' + escAttr(new Date(first.startedAt).toLocaleString()) + '">' + esc(helpers.relTime ? helpers.relTime(first.startedAt) : new Date(first.startedAt).toLocaleString()) + "</span></div>" : "") +
      '<details class="run-group-detail" open>' +
        '<summary style="cursor:pointer;font-size:12px;color:var(--text-muted);padding:6px 0;">' +
          esc(t("runs.group.expand-n", "展开/收起 {n} 个 profile 结果").replace("{n}", String(runs.length))) + "</summary>" +
        '<div class="run-group-rows">' + rows + "</div>" +
      "</details>" +
      (groupRetryButton(runs) ? '<div class="card-actions" style="justify-content:flex-end;">' + groupRetryButton(runs) + "</div>" : "") +
    "</div>";
  }

  // Bound once per dialog: the buttons inside are re-rendered on every open,
  // so the handler is delegated from a stable ancestor.
  var detailActionsBound = false;
  function bindDetailActions() {
    if (detailActionsBound) return;
    var dlg = document.getElementById("dlg-agent-run");
    if (!dlg) return;
    detailActionsBound = true;
    dlg.addEventListener("click", function(event) {
      var detailBtn = event.target.closest("[data-detail-action]");
      if (detailBtn && dlg.contains(detailBtn)) {
        var action = detailBtn.dataset.detailAction;
        if (action === "export-summary") exportArtifact(previewState.runId, undefined, "summary-json");
        else if (action === "retry") agentBrowser.runsRetry(previewState.runId);
        return;
      }
      var btn = event.target.closest("[data-artifact-action], [data-preview-page]");
      if (!btn || !dlg.contains(btn)) return;
      var runId = previewState.runId;
      if (btn.dataset.artifactAction) {
        var card = btn.closest("[data-artifact-id]");
        var artifactId = card ? card.dataset.artifactId : "";
        if (btn.dataset.artifactAction === "preview") loadPreview(runId, artifactId, 0);
        else if (btn.dataset.artifactAction === "export") {
          // Datasets export as CSV; the summary JSON is a separate button.
          var ref = (lastDetailRun && lastDetailRun.artifacts || []).filter(function(a) { return a.id === artifactId; })[0];
          exportArtifact(runId, artifactId, ref && ref.kind === "dataset" ? "dataset-csv" : "file");
        }
        return;
      }
      var page = btn.dataset.previewPage;
      if (page === "prev") loadPreview(runId, previewState.artifactId, Math.max(0, previewState.offset - PREVIEW_PAGE));
      else if (page === "next") loadPreview(runId, previewState.artifactId, previewState.offset + PREVIEW_PAGE);
    });
  }

  var lastDetailRun = null;

  agentBrowser.runsRetry = function(runId) {
    agentBrowser.confirm(t("runs.confirm.retry", "按当前规则新建一次执行?（会重新启动浏览器并按规则提示词再跑一次;原记录与成果保持不变）"), function() {
    api.automation.retryRun(runId).then(function(r) {
      if (!r.ok) {
        toast(t("runs.toast.retry-failed", "重试失败: ") + (r.error || "unknown"), "error");
        return;
      }
      toast(t("runs.toast.retried", "已重试") + (r.runId ? " · " + r.runId : ""), "success");
      agentBrowser.loadRunsTab();
    }).catch(function(e) {
      toast(t("runs.toast.retry-failed", "重试失败: ") + (e.message || String(e)), "error");
    });
    });
  };

  agentBrowser.runsRetryJob = function(jobId) {
    agentBrowser.confirm(t("runs.confirm.retry-all", "重试这个批次所有失败的 profile?（会按顺序重新启动浏览器并逐个重跑失败的任务）"), function() {
    api.automation.retryJob(jobId).then(function(r) {
      if (!r || typeof r.attempted !== "number") {
        toast(t("runs.toast.retry-failed", "重试失败: ") + ((r && r.error) || "unknown"), "error");
        return;
      }
      if (r.attempted === 0) {
        toast(t("runs.toast.retry-none", "没有可重试的失败记录"), "info");
        return;
      }
      if (r.failed.length === 0) {
        toast(t("runs.toast.retried-all", "已重试全部失败 profile") + " (" + r.succeeded + "/" + r.attempted + ")", "success");
      } else {
        toast(t("runs.toast.retry-partial", "部分重试失败") + " (" + r.succeeded + "/" + r.attempted + "): " +
          r.failed.map(function(f) { return f.error; }).join("; ").slice(0, 200), "error");
      }
      agentBrowser.loadRunsTab();
    }).catch(function(e) {
      toast(t("runs.toast.retry-failed", "重试失败: ") + (e.message || String(e)), "error");
    });
    });
  };

  agentBrowser.runsOpen = function(runId) {
    if (!runId) return Promise.resolve(null);
    var seq = ++openRunSeq;
    return lcall("agentRuns.get:" + runId, function() { return api.agentRuns.get(runId); }).then(function(run) {
      if (seq !== openRunSeq) return null;
      if (!run) {
        // A fulfilled null is authoritative: this specific linked record was
        // cleared. Rejections/timeouts below are transport failures instead.
        toast(t("runs.toast.record-cleared", "This run record was cleared"), "info");
        return null;
      }
      renderDetail(run);
      var dlg = document.getElementById("dlg-agent-run");
      if (dlg && !dlg.open) dlg.showModal();
      ensureLiveTicker();
      return run;
    }).then(function(run) {
      // The click handler lives on the dialog, not the list: the artifact and
      // pager buttons only exist inside an open detail.
      bindDetailActions();
      return run;
    }).catch(function(error) {
      if (seq === openRunSeq) {
        toast(t("runs.toast.detail-load-failed", "Could not load run details: ") + ((error && error.message) || error), "error");
      }
      return null;
    });
  };

  // R15 UX P1-1/P1-13: single delete gets a confirm like clear does, and
  // both paths check the result + catch transport errors.
  agentBrowser.runsDelete = function(runId) {
    agentBrowser.confirm(t("runs.confirm.delete-one", "删除这条运行记录?"), function() {
      api.agentRuns.delete(runId).then(function(r) {
        if (r && r.success === false) { toast(r.error || t("toast.failed", "Failed"), "error"); return; }
        toast(t("runs.toast.deleted", "已删除"), "success");
        agentBrowser.loadRunsTab();
      }).catch(function(e) { toast(e.message || String(e), "error"); });
    });
  };

  agentBrowser.runsClear = function() {
    agentBrowser.confirm(t("runs.confirm.clear-all", "清空所有运行记录?"), function() {
      api.agentRuns.clear().then(function(r) {
        if (r && r.success === false) { toast(r.error || t("toast.failed", "Failed"), "error"); return; }
        toast(t("runs.toast.cleared-n", "Cleared {n} record(s)").replace("{n}", String((r && r.deleted) || 0)), "success");
        agentBrowser.loadRunsTab();
      }).catch(function(e) { toast(e.message || String(e), "error"); });
    }, { ackLabel: t("confirm.ack.permanent","我了解此操作会永久删除数据且不可撤销。") });
  };

  // ── Layer 1: conclusion ──
  function renderConclusion(run) {
    var status = verificationStatus(run);
    var v = run.verification || {};
    // NOTE: the id is -block, not -verification. The live agent strip in
    // index.html owns `agent-run-verification` (a <span> agent-chat.js writes
    // textContent into); sharing the id made both writers resolve to the same
    // first-in-tree element, so opening a detail clobbered the live strip.
    var el = document.getElementById("agent-run-verification-block");
    if (!el) return;

    var rows = [
      // Execution layer and business layer are labelled as such: "the task
      // finished" and "the data is good" are different claims.
      '<div class="info-row"><span>' + esc(t("runs.conclusion.exec-status", "执行状态")) + "</span><span>" +
        statusBadge(run) + (endReasonLabel(run.endReason) ? " " + esc(endReasonLabel(run.endReason)) : "") + "</span></div>",
      '<div class="info-row"><span>' + esc(t("runs.conclusion.business-status", "业务验收")) + "</span><span>" +
        verificationBadge(run) + "</span></div>",
    ];
    if (v.verifierId) {
      rows.push('<div class="info-row"><span>' + esc(t("runs.conclusion.verifier", "验收器")) + "</span><span>" +
        esc(v.verifierId) + (v.verifierVersion ? " v" + esc(String(v.verifierVersion)) : "") + "</span></div>");
    }
    if (v.checkedAt) {
      rows.push('<div class="info-row"><span>' + esc(t("runs.conclusion.checked-at", "验收时间")) + "</span><span>" +
        esc(new Date(v.checkedAt).toLocaleString()) + "</span></div>");
    }
    if (status === "manual_review" && v.reasonCode) {
      rows.push('<div class="info-row"><span>' + esc(t("runs.conclusion.reason", "待人工原因")) + "</span><span>" +
        esc(t("runs.manual." + v.reasonCode, v.reasonCode)) + "</span></div>");
    }
    el.innerHTML = rows.join("");

    // Counts: only auto verdicts carry them.
    var countsEl = document.getElementById("agent-run-verification-counts");
    if (countsEl) {
      var c = v.counts;
      if (status === "passed" || status === "partial" || status === "failed") {
        if (c) {
          var pairs = [
            ["expected", t("runs.counts.expected", "应有")],
            ["observed", t("runs.counts.observed", "实写")],
            ["accepted", t("runs.counts.accepted", "有效")],
            ["rejected", t("runs.counts.rejected", "无效")],
            ["missing", t("runs.counts.missing", "缺失")],
            ["extra", t("runs.counts.extra", "多余")],
          ];
          countsEl.innerHTML = pairs.map(function(p) {
            return '<div class="run-count"><span class="run-count-label">' + esc(p[1]) + '</span><span class="run-count-value num">' + esc(String(c[p[0]])) + "</span></div>";
          }).join("");
        } else {
          countsEl.innerHTML = "";
        }
      } else {
        countsEl.innerHTML = "";
      }
    }

    var issuesEl = document.getElementById("agent-run-verification-issues");
    if (issuesEl) {
      var issues = Array.isArray(v.issues) ? v.issues : [];
      if (issues.length === 0) {
        issuesEl.innerHTML = "";
      } else {
        // Every field is untrusted text from the scrape — textContent only.
        issuesEl.innerHTML = '<details class="run-issues-details"><summary>' +
          esc(t("runs.issues.title", "验收问题 ({n})").replace("{n}", String(issues.length))) + "</summary><div class=\"run-issue-list\">" +
          issues.map(function(issue) {
            return '<div class="run-issue"><span class="run-issue-code">' + esc(String(issue.code || "?")) + "</span>" +
              (issue.field ? '<span class="run-issue-field">' + esc(String(issue.field)) + "</span>" : "") +
              (issue.detail ? '<span class="run-issue-detail">' + esc(String(issue.detail)) + "</span>" : "") + "</div>";
          }).join("") + "</div>" +
          (v.issuesTruncated ? '<div class="run-issue-more">' + esc(t("runs.issues.truncated", "仅显示前若干条")) + "</div>" : "") +
          "</details>";
      }
    }
  }

  /** Dialog-level actions: export the summary, or re-run a terminal run. */
  function renderDetailActions(run) {
    var el = document.getElementById("agent-run-detail-actions");
    if (!el) return;
    var canSummary = Array.isArray(run.artifacts) && run.artifacts.length > 0;
    el.innerHTML =
      (canSummary ? '<button class="btn btn-secondary btn-sm" data-detail-action="export-summary">' +
        esc(t("runs.artifact.export-summary", "导出摘要 (JSON)")) + "</button>" : "") +
      (canRetryRun(run) ? '<button class="btn btn-primary btn-sm" data-detail-action="retry">' +
        esc(t("runs.btn.rerun", "再次运行")) + "</button>" : "");
  }

  // ── Layer 2: results ──
  var previewSeq = 0;
  var previewState = { runId: "", artifactId: "", offset: 0, total: 0, columns: [] };
  var PREVIEW_PAGE = 100;

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return "—";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KiB";
    return (n / (1024 * 1024)).toFixed(1) + " MiB";
  }

  function shortHash(h) {
    return typeof h === "string" && h.length >= 12 ? h.slice(0, 12) + "…" : (h || "—");
  }

  function renderResults(run) {
    var el = document.getElementById("agent-run-artifacts");
    var previewEl = document.getElementById("agent-run-preview");
    if (!el) return;
    var refs = Array.isArray(run.artifacts) ? run.artifacts : [];
    previewState = { runId: run.id, artifactId: "", offset: 0, total: 0, columns: [] };
    if (previewEl) previewEl.innerHTML = "";

    if (refs.length === 0) {
      el.innerHTML = '<div class="run-layer-note">' + esc(t("runs.results.none", "这次运行没有留存成果(未机器验收或运行未产出数据)。")) + "</div>";
      return;
    }
    el.innerHTML = refs.map(function(a) {
      var bits = [
        t("runs.artifact.rows", "{n} 行").replace("{n}", String(a.rowCount != null ? a.rowCount : "—")),
        fmtBytes(a.bytes),
        shortHash(a.sha256),
      ];
      var flags = [];
      if (a.truncated) flags.push('<span class="status-badge status-warn">' + esc(t("runs.artifact.truncated", "已截断")) + "</span>");
      if (a.completeness === "partial" && !a.truncated) flags.push('<span class="status-badge status-warn">' + esc(t("runs.artifact.partial", "不完整")) + "</span>");
      if (Array.isArray(a.redactedColumns) && a.redactedColumns.length) {
        flags.push('<span class="status-badge status-stopped">' + esc(t("runs.artifact.redacted", "含脱敏列")) + "</span>");
      }
      var canPreview = a.kind === "dataset";
      return '<div class="run-artifact" data-artifact-id="' + escAttr(a.id) + '">' +
        '<div class="run-artifact-head"><span class="run-artifact-name">' + esc(a.name) + "</span> " + flags.join(" ") + "</div>" +
        '<div class="run-artifact-meta">' + esc(bits.join(" · ")) + "</div>" +
        '<div class="run-artifact-actions">' +
          (canPreview ? '<button class="btn btn-secondary btn-sm" data-artifact-action="preview">' + esc(t("runs.artifact.preview", "预览")) + "</button>" : "") +
          '<button class="btn btn-secondary btn-sm" data-artifact-action="export">' + esc(t("runs.artifact.export", "导出")) + "</button>" +
        "</div>" +
      "</div>";
    }).join("");
  }

  /** Load one page of a dataset preview. A stale response (the user opened a
   *  different run) is dropped rather than painted into the new dialog. */
  function loadPreview(runId, artifactId, offset) {
    var seq = ++previewSeq;
    var el = document.getElementById("agent-run-preview");
    if (!el) return;
    el.innerHTML = '<div class="run-layer-note">' + esc(t("runs.preview.loading", "加载中…")) + "</div>";
    lcall("agentRuns.resultsPreview:" + runId, function() {
      return api.agentRuns.resultsPreview({ runId: runId, artifactId: artifactId, offset: offset, limit: PREVIEW_PAGE });
    }).then(function(res) {
      if (seq !== previewSeq) return;
      if (!res || !res.ok) {
        // An integrity failure shows the error and NO rows — never a stale or
        // partial table that would read as the committed result.
        el.innerHTML = '<div class="run-preview-error">' + esc(t("runs.preview.error", "无法读取成果: ")) + esc((res && res.error) || "unknown") + "</div>";
        return;
      }
      previewState.offset = offset;
      previewState.total = res.total;
      previewState.columns = res.columns;
      // The pager needs the artifact id on the NEXT request; record it here so
      // a page turn targets the same artifact the user opened.
      previewState.artifactId = artifactId;
      var head = "<tr>" + res.columns.map(function(c) { return "<th>" + esc(c) + "</th>"; }).join("") + "</tr>";
      // Cell contents come from scraped pages: textContent via esc() only.
      var body = res.rows.map(function(row) {
        return "<tr>" + row.map(function(cell) { return "<td>" + esc(String(cell)) + "</td>"; }).join("") + "</tr>";
      }).join("");
      var pager = "";
      if (res.total > PREVIEW_PAGE) {
        var from = offset + 1;
        var to = Math.min(offset + res.rows.length, res.total);
        pager = '<div class="run-preview-pager">' +
          '<button class="btn btn-secondary btn-sm" data-preview-page="prev"' + (offset <= 0 ? " disabled" : "") + ">" + esc(t("common.prev", "上一页")) + "</button>" +
          '<span class="num">' + esc(t("runs.preview.range", "{from}-{to} / {total}").replace("{from}", String(from)).replace("{to}", String(to)).replace("{total}", String(res.total))) + "</span>" +
          '<button class="btn btn-secondary btn-sm" data-preview-page="next"' + (to >= res.total ? " disabled" : "") + ">" + esc(t("common.next", "下一页")) + "</button>" +
        "</div>";
      }
      var note = '<div class="run-preview-note">' +
        esc(res.truncated
          ? t("runs.preview.truncated", "成果已截断,表中仅为留存部分。")
          : t("runs.preview.rejected", "失败行未纳入成果。")) +
        (res.rejectedRowCount > 0 ? " " + esc(t("runs.preview.rejected-n", "已剔除 {n} 行").replace("{n}", String(res.rejectedRowCount))) : "") +
        "</div>";
      el.innerHTML = '<div class="run-preview-wrap"><table class="run-preview-table"><thead>' + head + "</thead><tbody>" + body + "</tbody></table></div>" + pager + note;
    }).catch(function(e) {
      if (seq !== previewSeq) return;
      el.innerHTML = '<div class="run-preview-error">' + esc(t("runs.preview.error", "无法读取成果: ")) + esc(e.message || String(e)) + "</div>";
    });
  }

  /** Two-phase export: the plan is fetched and shown, and only a confirmed
   *  dialog reaches the write path (which opens the native save dialog). */
  function exportArtifact(runId, artifactId, kind) {
    lcall("agentRuns.exportPlan:" + runId, function() {
      return api.agentRuns.exportPlan({ runId: runId, artifactId: artifactId, kind: kind });
    }).then(function(res) {
      if (!res || !res.ok) {
        toast(t("runs.export.failed", "导出失败: ") + ((res && res.error) || "unknown"), "error");
        return;
      }
      var plan = res.plan;
      var lines = [];
      if (plan.columns) lines.push(t("runs.export.columns", "列: ") + plan.columns.join(", "));
      if (plan.rowCount != null) lines.push(t("runs.export.rows", "行数: {n}").replace("{n}", String(plan.rowCount)));
      if (plan.bytes != null) lines.push(t("runs.export.bytes", "大小: {n}").replace("{n}", fmtBytes(plan.bytes)));
      if (plan.warnings && plan.warnings.length) lines.push(plan.warnings.join("\n"));
      var msg = t("runs.export.confirm", "将导出为 {name}。").replace("{name}", plan.suggestedName) +
        (lines.length ? "\n\n" + lines.join("\n") : "");
      agentBrowser.confirm(msg, function() {
        api.agentRuns.exportWrite({ runId: runId, artifactId: artifactId, kind: kind }).then(function(w) {
          if (!w || !w.ok) {
            if (w && w.reasonCode === "cancelled") return;
            toast(t("runs.export.failed", "导出失败: ") + ((w && w.error) || "unknown"), "error");
            return;
          }
          toast(t("runs.export.done", "已导出") + " · " + fmtBytes(w.bytes), "success");
        }).catch(function(e) { toast(t("runs.export.failed", "导出失败: ") + (e.message || String(e)), "error"); });
      });
    }).catch(function(e) {
      toast(t("runs.export.failed", "导出失败: ") + (e.message || String(e)), "error");
    });
  }

  agentBrowser.runsExportSummary = function(runId) {
    exportArtifact(runId, undefined, "summary-json");
  };

  function renderDetail(run) {
    // R158: a run without a name left the title's " — " separator dangling
    // after the localized fallback ("运行详情 — "). Hide the separator when
    // there's no run name (markup: <span id="agent-run-title-sep">).
    var titleEl = document.getElementById("agent-run-title");
    titleEl.textContent = run.name || "";
    var sep = document.getElementById("agent-run-title-sep");
    if (sep) sep.style.display = run.name ? "" : "none";
    var meta = statusBadge(run) + " · " + sourceLabel(run.source) + " · " + durationHtml(run);
    var reason = endReasonLabel(run.endReason);
    if (reason) meta += ' · <span class="status-badge ' + (run.endReason === "completed" ? "status-done" : "status-failed") + '">' + esc(reason) + "</span>";
    meta += " · " + verificationBadge(run);
    if (run.dirId) meta += ' · <span style="font-family:var(--mono);">' + esc(run.dirId) + "</span>";
    if (run.startedAt) meta += " · " + '<span class="num" title="' + escAttr(new Date(run.startedAt).toLocaleString()) + '">' + esc(helpers.relTime ? helpers.relTime(run.startedAt) : new Date(run.startedAt).toLocaleString()) + "</span>";
    if (run.error) meta += '<br><span style="color: var(--danger-text);">' + esc(run.error) + "</span>";
    document.getElementById("agent-run-meta").innerHTML = meta;

    lastDetailRun = run;
    renderConclusion(run);
    renderResults(run);
    renderDetailActions(run);

    // Variables
    var varsEl = document.getElementById("agent-run-vars");
    var keys = Object.keys(run.variables || {});
    if (keys.length === 0) {
      varsEl.innerHTML = '<span style="color:var(--text-muted);">' + esc(t("runs.no-vars", "(无变量)")) + '</span>';
    } else {
      varsEl.innerHTML = keys.map(function(k) {
        return '<div class="info-row"><span>' + esc(k) + "</span><span>" + esc(String(run.variables[k]).slice(0, 200)) + "</span></div>";
      }).join("");
    }

    // Steps timeline
    var stepsEl = document.getElementById("agent-run-steps");
    if (!run.steps || run.steps.length === 0) {
      stepsEl.innerHTML = '<div style="color:var(--text-muted);padding:12px;">' + esc(t("runs.no-steps", "(无步骤)")) + '</div>';
      return;
    }
    stepsEl.innerHTML = run.steps.map(function(s, i) {
      var okIcon = s.ok ? icon("check", 12) : icon("close", 12);
      var head = '<div class="run-step' + (s.ok ? "" : " run-step-error") + '">' +
        '<div class="run-step-head">' +
          '<span class="run-step-num">' + (i + 1) + "</span> " + okIcon +
          ' <span class="run-step-tool">' + esc(s.tool) + "</span>" +
          ' <span class="run-step-dur">(' + fmtDuration(s.durationMs) + ")</span>" +
          (s.error ? ' <span style="color: var(--danger-text);">' + esc(s.error).slice(0, 120) + "</span>" : "") +
        "</div>";
      // args + result as collapsible <details> with <pre> (textContent is safe)
      var args = '<details><summary>' + esc(t("runs.step.args", "入参")) + '</summary><pre class="run-json" data-raw="' + escAttr(jsonPreview(s.args, 4000)) + '"></pre></details>';
      var res = s.result === undefined ? "" : '<details><summary>' + esc(t("runs.step.result", "结果")) + '</summary><pre class="run-json" data-raw="' + escAttr(jsonPreview(s.result, 4000)) + '"></pre></details>';
      return head + '<div class="run-step-body">' + args + res + "</div></div>";
    }).join("");
    // Inject raw JSON via textContent (prevents XSS even if trace contains HTML)
    stepsEl.querySelectorAll(".run-json").forEach(function(pre) {
      pre.textContent = pre.dataset.raw;
    });
  }

  // Filters re-run the (client-side) filter+render without a new IPC call, so
  // typing in the name box stays responsive on a 200-row list.
  function applyFiltersLocally() {
    readFilters();
    if (!lastList.length) return;
    var el = document.getElementById("agent-run-list");
    if (!el) return;
    var visible = lastList.filter(matchesFilters);
    updateFilterSummary(lastList.length, visible.length);
    if (visible.length === 0) {
      el.innerHTML = '<div class="empty-state">' + esc(t("runs.filter.no-match", "没有符合当前筛选条件的运行记录。")) + "</div>";
      return;
    }
    el.innerHTML = groupRuns(visible).map(function(item) {
      return item.group ? renderGroupCard(item.group) : renderRunCard(item.single);
    }).join("");
    ensureLiveTicker();
  }

  function bindFilters() {
    var row = document.querySelector(".run-filters");
    if (!row || row.dataset.bound) return;
    row.dataset.bound = "1";
    row.addEventListener("input", function(event) {
      if (!event.target.closest("#run-filter-name")) return;
      applyFiltersLocally();
    });
    row.addEventListener("change", function(event) {
      if (!event.target.closest("select")) return;
      applyFiltersLocally();
    });
  }

  // Live updates: refresh the list (and an open detail) when runs change.
  function bindLiveEvents() {
    if (agentBrowser.state.runsEventsBound) return;
    agentBrowser.state.runsEventsBound = true;
    bindFilters();
    var refreshIfActive = function() {
      if (agentBrowser.state.currentTab === "runs") agentBrowser.loadRunsTab();
    };
    api.on("agent:run-start", refreshIfActive);
    api.on("agent:run-step", function() {
      // If a detail dialog is open for this run, refresh it.
      var dlg = document.getElementById("dlg-agent-run");
      if (dlg && dlg.open) {
        var title = document.getElementById("agent-run-title").textContent;
        // Refresh list + re-render detail if still open (best-effort match by title is fragile;
        // simplest: refresh list; user can reopen).
      }
      refreshIfActive();
    });
    api.on("agent:run-finish", refreshIfActive);
  }

  function bindAll() {
    bindLiveEvents();
    bindFilters();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindAll);
  } else {
    bindAll();
  }
})();
