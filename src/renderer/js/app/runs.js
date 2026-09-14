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

  var STATUS_CLS = { running: "status-running", done: "status-done", error: "status-stopped" };

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

  agentBrowser.loadRunsTab = function() {
    lcall("agentRuns.list", function () { return api.agentRuns.list(); }).then(function(list) {
      var el = document.getElementById("agent-run-list");
      if (!list || list.length === 0) {
        if (window.agentBrowser && window.agentBrowser.renderViewState) window.agentBrowser.renderViewState(el,{empty:t("runs.empty-state","暂无记录")}); else el.innerHTML = '<div class="empty-state">' + t("runs.empty-state", "还没有运行记录。<br>在 Agent 里发一条消息,或让定时任务跑一次,记录会出现在这里。") + '</div>';
        return;
      }
      el.innerHTML = groupRuns(list).map(function(item) {
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

  function canRetryRun(run) {
    return !!run && run.status === "error" && !!run.dirId && !!run.source &&
      run.source.type === "automation" && !!run.source.ruleId;
  }

  function retryButton(run) {
    return canRetryRun(run)
      ? '<button class="btn btn-primary btn-sm" data-run-action="retry">' + t("runs.btn.retry", "重试") + '</button>'
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
      (run.startedAt ? '<div class="info-row"><span>' + t("runs.row.started", "开始") + '</span><span>' + new Date(run.startedAt).toLocaleString() + "</span></div>" : "") +
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
    var cls = running ? "status-running" : (failed ? "status-stopped" : "status-done");
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
        '<span class="card-status">' +
          groupRetryButton(runs) + groupBadge(runs) +
        "</span></div>" +
      '<div class="info-row"><span>' + t("runs.row.source", "来源") + '</span><span>' + sourceLabel(first.source) + "</span></div>" +
      (first.startedAt ? '<div class="info-row"><span>' + t("runs.row.started", "开始") + '</span><span>' + new Date(first.startedAt).toLocaleString() + "</span></div>" : "") +
      '<details class="run-group-detail" open>' +
        '<summary style="cursor:pointer;font-size:12px;color:var(--text-muted);padding:6px 0;">' +
          esc(t("runs.group.expand-n", "展开/收起 {n} 个 profile 结果").replace("{n}", String(runs.length))) + "</summary>" +
        '<div class="run-group-rows">' + rows + "</div>" +
      "</details>" +
    "</div>";
  }

  agentBrowser.runsRetry = function(runId) {
    agentBrowser.confirm(t("runs.confirm.retry", "重试这个 profile 的 agent 任务?（会重新启动浏览器并按规则提示词再跑一次）"), function() {
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
    api.agentRuns.get(runId).then(function(run) {
      if (!run) { toast(t("runs.toast.not-found", "记录不存在"), "error"); return; }
      renderDetail(run);
      document.getElementById("dlg-agent-run").showModal();
      ensureLiveTicker();
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

  function renderDetail(run) {
    // R158: a run without a name left the title's " — " separator dangling
    // after the localized fallback ("运行详情 — "). Hide the separator when
    // there's no run name (markup: <span id="agent-run-title-sep">).
    var titleEl = document.getElementById("agent-run-title");
    titleEl.textContent = run.name || "";
    var sep = document.getElementById("agent-run-title-sep");
    if (sep) sep.style.display = run.name ? "" : "none";
    var meta = statusBadge(run) + " · " + sourceLabel(run.source) + " · " + durationHtml(run);
    if (run.dirId) meta += ' · <span style="font-family:var(--mono);">' + esc(run.dirId) + "</span>";
    if (run.startedAt) meta += " · " + new Date(run.startedAt).toLocaleString();
    if (run.error) meta += '<br><span style="color: var(--danger-text);">' + esc(run.error) + "</span>";
    document.getElementById("agent-run-meta").innerHTML = meta;

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

  // Live updates: refresh the list (and an open detail) when runs change.
  function bindLiveEvents() {
    if (agentBrowser.state.runsEventsBound) return;
    agentBrowser.state.runsEventsBound = true;
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindLiveEvents);
  } else {
    bindLiveEvents();
  }
})();
