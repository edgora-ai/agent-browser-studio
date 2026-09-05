// Agent Runs tab — inspectable trace of each agent task execution.
(function() {
  "use strict";
  var agentBrowser = window.agentBrowser;
  var api = agentBrowser.api;
  var helpers = agentBrowser.helpers;
  var toast = helpers.toast;
  var esc = helpers.esc;
  var escAttr = helpers.escAttr;

  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }

  var STATUS_CLS = { running: "status-running", done: "status-done", error: "status-stopped" };

  function statusBadge(run) {
    var cls = STATUS_CLS[run.status] || "status-stopped";
    var label = t("runs.status." + run.status, run.status);
    return '<span class="status-badge ' + cls + '">' + esc(label) + "</span>";
  }

  function sourceLabel(src) {
    if (!src) return "?";
    if (src.type === "automation") {
      var label = t("runs.source.schedule", "⏰ 定时 ") + esc(src.ruleName || src.ruleId || "");
      if (src.jobId) label += ' <span style="font-family:var(--mono);color:var(--text-muted);">' + esc(src.jobId) + '</span>';
      return label;
    }
    return t("runs.source.chat", "💬 对话");
  }

  function fmtDuration(ms) {
    if (!ms || ms < 0) return "-";
    if (ms < 1000) return ms + "ms";
    return (ms / 1000).toFixed(1) + "s";
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
    api.agentRuns.list().then(function(list) {
      var el = document.getElementById("agent-run-list");
      if (!list || list.length === 0) {
        if (window.agentBrowser && window.agentBrowser.renderViewState) window.agentBrowser.renderViewState(el,{empty:t("runs.empty-state","暂无记录")}); else el.innerHTML = '<div class="empty-state">' + t("runs.empty-state", "还没有运行记录。<br>在 Agent 里发一条消息,或让定时任务跑一次,记录会出现在这里。") + '</div>';
        return;
      }
      el.innerHTML = groupRuns(list).map(function(item) {
        return item.group ? renderGroupCard(item.group) : renderRunCard(item.single);
      }).join("");
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
    var dur = run.finishedAt ? fmtDuration(run.finishedAt - run.startedAt) : t("runs.running-hint", "运行中…");
    var name = esc(run.name);
    if (run.source && run.source.retryOf) {
      name += ' <span class="status-badge status-warn">' + esc(t("runs.retry-tag", "重试")) + '</span>';
    }
    return '<div class="profile-card" data-run-id="' + escAttr(run.id) + '">' +
      '<div class="card-header"><span class="name">' + name + "</span>" + statusBadge(run) + "</div>" +
      '<div class="info-row"><span>' + t("runs.row.source", "来源") + '</span><span>' + sourceLabel(run.source) + "</span></div>" +
      (run.dirId ? '<div class="info-row"><span>' + t("runs.row.profile", "Profile") + '</span><span style="font-family:var(--mono);font-size:11px;">' + esc(run.dirId) + "</span></div>" : "") +
      '<div class="info-row"><span>' + t("runs.row.steps", "步骤") + '</span><span>' + run.stepCount + t("runs.row.steps-unit", " 步") + "</span></div>" +
      '<div class="info-row"><span>' + t("runs.row.duration", "耗时") + '</span><span>' + esc(dur) + "</span></div>" +
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
    if (ok > 0) parts.push(ok + " ok");
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
      var durRow = run.finishedAt ? fmtDuration(run.finishedAt - run.startedAt) : t("runs.running-hint", "运行中…");
      var err = run.error
        ? '<div style="color:var(--danger);font-size:11px;word-break:break-word;margin-top:4px;">' + esc(run.error).slice(0, 160) + "</div>"
        : "";
      return '<div class="run-group-row" data-run-id="' + escAttr(run.id) + '" style="border-top:1px solid var(--border);padding:8px 0;">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          '<span style="font-family:var(--mono);font-size:11px;word-break:break-all;">' + esc(run.dirId || "—") + "</span>" +
          statusBadge(run) +
          '<span style="color:var(--text-muted);font-size:11px;">' + run.stepCount + t("runs.row.steps-unit", " 步") + " · " + esc(durRow) + "</span>" +
          '<span style="margin-left:auto;display:inline-flex;gap:6px;">' +
            '<button class="btn btn-secondary btn-sm" data-run-action="open">' + t("runs.btn.view", "查看") + '</button>' +
            retryButton(run) +
            '<button class="btn btn-danger btn-sm" data-run-action="delete">' + t("runs.btn.delete", "删除") + '</button>' +
          "</span>" +
        "</div>" + err +
      "</div>";
    }).join("");
    return '<div class="profile-card run-group-card" data-group-id="' + escAttr(first.source && first.source.jobId ? first.source.jobId : "") + '">' +
      '<div class="card-header"><span class="name">' + esc(first.name) +
        ' <span style="color:var(--text-muted);font-size:11px;">× ' + runs.length + ' ' + t("runs.group.profiles", "profiles") + '</span></span>' +
        '<span style="display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;">' +
          groupRetryButton(runs) + groupBadge(runs) +
        "</span></div>" +
      '<div class="info-row"><span>' + t("runs.row.source", "来源") + '</span><span>' + sourceLabel(first.source) + "</span></div>" +
      (first.startedAt ? '<div class="info-row"><span>' + t("runs.row.started", "开始") + '</span><span>' + new Date(first.startedAt).toLocaleString() + "</span></div>" : "") +
      '<details class="run-group-detail" open>' +
        '<summary style="cursor:pointer;font-size:12px;color:var(--text-muted);padding:6px 0;">' +
          t("runs.group.expand", "展开/收起 " + runs.length + " 个 profile 结果") + "</summary>" +
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
        toast(t("runs.toast.cleared", "已清空 ") + ((r && r.deleted) || 0) + t("runs.toast.cleared-unit", " 条"), "success");
        agentBrowser.loadRunsTab();
      }).catch(function(e) { toast(e.message || String(e), "error"); });
    }, { ackLabel: t("confirm.ack.permanent","我了解此操作会永久删除数据且不可撤销。") });
  };

  function renderDetail(run) {
    document.getElementById("agent-run-title").textContent = run.name;
    var dur = run.finishedAt ? fmtDuration(run.finishedAt - run.startedAt) : t("runs.running-hint", "运行中…");
    var meta = statusBadge(run) + " · " + sourceLabel(run.source) + " · " + dur;
    if (run.dirId) meta += ' · <span style="font-family:var(--mono);">' + esc(run.dirId) + "</span>";
    if (run.startedAt) meta += " · " + new Date(run.startedAt).toLocaleString();
    if (run.error) meta += '<br><span style="color:var(--danger);">' + esc(run.error) + "</span>";
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
      var icon = s.ok ? "✅" : "❌";
      var head = '<div class="run-step' + (s.ok ? "" : " run-step-error") + '">' +
        '<div class="run-step-head">' +
          '<span class="run-step-num">' + (i + 1) + "</span> " + icon +
          ' <span class="run-step-tool">' + esc(s.tool) + "</span>" +
          ' <span class="run-step-dur">(' + fmtDuration(s.durationMs) + ")</span>" +
          (s.error ? ' <span style="color:var(--danger);">' + esc(s.error).slice(0, 120) + "</span>" : "") +
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
