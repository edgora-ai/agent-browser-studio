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
        el.innerHTML = '<div class="empty-state">' + t("runs.empty-state", "还没有运行记录。<br>在 Agent 里发一条消息,或让定时任务跑一次,记录会出现在这里。") + '</div>';
        return;
      }
      el.innerHTML = list.map(function(run) {
        var dur = run.finishedAt ? fmtDuration(run.finishedAt - run.startedAt) : t("runs.running-hint", "运行中…");
        return '<div class="profile-card" data-run-id="' + escAttr(run.id) + '">' +
          '<div class="card-header"><span class="name">' + esc(run.name) + "</span>" + statusBadge(run) + "</div>" +
          '<div class="info-row"><span>' + t("runs.row.source", "来源") + '</span><span>' + sourceLabel(run.source) + "</span></div>" +
          (run.dirId ? '<div class="info-row"><span>' + t("runs.row.profile", "Profile") + '</span><span style="font-family:var(--mono);font-size:11px;">' + esc(run.dirId) + "</span></div>" : "") +
          '<div class="info-row"><span>' + t("runs.row.steps", "步骤") + '</span><span>' + run.stepCount + t("runs.row.steps-unit", " 步") + "</span></div>" +
          '<div class="info-row"><span>' + t("runs.row.duration", "耗时") + '</span><span>' + esc(dur) + "</span></div>" +
          (run.startedAt ? '<div class="info-row"><span>' + t("runs.row.started", "开始") + '</span><span>' + new Date(run.startedAt).toLocaleString() + "</span></div>" : "") +
          '<div class="card-actions">' +
            '<button class="btn btn-secondary btn-sm" data-run-action="open">' + t("runs.btn.view", "查看") + '</button>' +
            '<button class="btn btn-danger btn-sm" data-run-action="delete">' + t("runs.btn.delete", "删除") + '</button>' +
          "</div>" +
        "</div>";
      }).join("");
      el.onclick = function(event) {
        var btn = event.target.closest("[data-run-action]");
        if (!btn || !el.contains(btn)) return;
        var card = btn.closest("[data-run-id]");
        var runId = card.dataset.runId;
        if (btn.dataset.runAction === "open") agentBrowser.runsOpen(runId);
        else if (btn.dataset.runAction === "delete") agentBrowser.runsDelete(runId);
      };
    }).catch(function(e) { toast(t("runs.toast.load-failed", "加载失败: ") + (e.message || e), "error"); });
  };

  agentBrowser.runsOpen = function(runId) {
    api.agentRuns.get(runId).then(function(run) {
      if (!run) { toast(t("runs.toast.not-found", "记录不存在"), "error"); return; }
      renderDetail(run);
      document.getElementById("dlg-agent-run").showModal();
    });
  };

  agentBrowser.runsDelete = function(runId) {
    api.agentRuns.delete(runId).then(function() {
      toast(t("runs.toast.deleted", "已删除"), "success");
      agentBrowser.loadRunsTab();
    });
  };

  agentBrowser.runsClear = function() {
    if (!confirm(t("runs.confirm.clear-all", "清空所有运行记录?"))) return;
    api.agentRuns.clear().then(function(r) {
      toast(t("runs.toast.cleared", "已清空 ") + (r.deleted || 0) + t("runs.toast.cleared-unit", " 条"), "success");
      agentBrowser.loadRunsTab();
    });
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
