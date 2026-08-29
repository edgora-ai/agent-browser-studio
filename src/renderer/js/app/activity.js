// Activity / audit tab — renders the audit log as a "who did what, when"
// timeline. Answers the team-governance question the scenario eval flagged.
(function() {
  "use strict";
  var agentBrowser = window.agentBrowser;
  var api = agentBrowser.api;
  var helpers = agentBrowser.helpers;
  var toast = helpers.toast;
  var esc = helpers.esc;
  var escAttr = helpers.escAttr;

  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }

  var CATEGORY_META = {
    profile:  { icon: "📦", label: function(){ return t("activity.cat.profile", "Profile"); } },
    proxy:    { icon: "🔌", label: function(){ return t("activity.cat.proxy", "代理"); } },
    account:  { icon: "🔑", label: function(){ return t("activity.cat.account", "账号"); } },
    llm:      { icon: "🤖", label: function(){ return t("activity.cat.llm", "LLM"); } },
    sync:     { icon: "☁️", label: function(){ return t("activity.cat.sync", "同步"); } },
    automation:{ icon: "⏰", label: function(){ return t("activity.cat.automation", "自动化"); } },
    agent:    { icon: "🧠", label: function(){ return t("activity.cat.agent", "Agent"); } },
    settings: { icon: "⚙️", label: function(){ return t("activity.cat.settings", "设置"); } },
  };

  function fmtTime(ms) {
    try { return new Date(ms).toLocaleString(); } catch (e) { return String(ms); }
  }

  function targetKind(target) {
    var value = String(target || "");
    if (/^job_[a-z0-9_-]+$/i.test(value)) return "job";
    if (/^run_[a-z0-9_-]+$/i.test(value)) return "run";
    if (/^(?:ab|cb)_[a-z0-9_-]+$/i.test(value)) return "profile";
    return "";
  }

  function renderTarget(entry) {
    var target = entry && entry.target;
    if (!target) return "";
    var value = String(target);
    var short = value.slice(0, 24);
    var code = ' <code style="font-family:var(--mono);font-size:11px;">' + esc(short) + '</code>';
    var kind = targetKind(value);
    var category = entry.category || "";
    if (category === "automation" && kind === "job") return code + ' <button class="btn btn-secondary btn-sm" data-activity-action="open-job" data-target-id="' + escAttr(value) + '">' + esc(t('activity.btn.open-job','查看 Job')) + '</button>';
    if (category === "agent" && kind === "run") return code + ' <button class="btn btn-secondary btn-sm" data-activity-action="open-run" data-target-id="' + escAttr(value) + '">' + esc(t('activity.btn.open-run','查看 Run')) + '</button>';
    if (category === "profile" && kind === "profile") return code + ' <button class="btn btn-secondary btn-sm" data-activity-action="open-profile" data-target-id="' + escAttr(value) + '">' + esc(t('activity.btn.open-profile','查看 Profile')) + '</button>';
    return code;
  }

  agentBrowser.activityOpenProfile = function(dirId) {
    if (!dirId) return;
    var safeId = String(dirId).replace(/[^a-zA-Z0-9_-]/g, "");
    agentBrowser.switchTab("profiles");
    var started = Date.now();
    function focusWhenReady() {
      var card = document.querySelector('[data-dir-id="' + safeId + '"]');
      if (card && card.scrollIntoView) {
        card.scrollIntoView({ block: "center", behavior: "smooth" });
        card.style.outline = "2px solid var(--primary)";
        setTimeout(function() { card.style.outline = ""; }, 1800);
        return;
      }
      if (Date.now() - started < 4000) {
        setTimeout(focusWhenReady, 100);
      } else {
        toast(t("activity.toast.profile-missing","Profile 不在当前列表中: ") + dirId, "error");
      }
    }
    focusWhenReady();
  };

  agentBrowser.loadActivity = function() {
    var filter = "";
    var sel = document.getElementById("activity-filter");
    if (sel) filter = sel.value || "";
    var opts = filter ? { category: filter, limit: 300 } : { limit: 300 };
    api.audit.list(opts).then(function(entries) {
      var el = document.getElementById("activity-list");
      if (!entries || entries.length === 0) {
        el.innerHTML = '<div class="empty-state">' + t("activity.empty-state","还没有审计记录。<br>启动/停止 profile、保存代理/账号/LLM 配置、运行自动化任务都会记录在这里。") + '</div>';
        return;
      }
      var html = entries.map(function(e) {
        var meta = CATEGORY_META[e.category] || { icon: "•", label: e.category || "?" };
        var target = renderTarget(e);
        var detail = e.detail ? '<div style="color:var(--text-muted);font-size:11px;margin-top:2px;">' + esc(String(e.detail).slice(0, 200)) + "</div>" : "";
        var actor = e.actor && e.actor !== "user" ? ' <span style="color:var(--text-muted);font-size:10px;">' + esc(t("activity.actor-by","by ")) + esc(e.actor) + "</span>" : "";
        return '<div class="profile-card" style="padding:8px 10px;margin-bottom:6px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
            '<span>' + meta.icon + ' <strong>' + esc(e.action || "?") + "</strong>" + actor + target + "</span>" +
            '<span style="color:var(--text-muted);font-size:10px;white-space:nowrap;">' + esc(fmtTime(e.at)) + "</span>" +
          "</div>" + detail + "</div>";
      }).join("");
      el.innerHTML = html;
      el.onclick = function(event) {
        var btn = event.target.closest("[data-activity-action]");
        if (!btn || !el.contains(btn)) return;
        var id = btn.dataset.targetId || "";
        if (btn.dataset.activityAction === "open-job") agentBrowser.automationShowJob(id);
        else if (btn.dataset.activityAction === "open-run") agentBrowser.runsOpen(id);
        else if (btn.dataset.activityAction === "open-profile") agentBrowser.activityOpenProfile(id);
      };
    }).catch(function(e) { toast(t("activity.toast.load-failed","加载审计失败: ") + (e.message || e), "error"); });
  };

  agentBrowser.activityFilter = function() { agentBrowser.loadActivity(); };

  agentBrowser.activityClear = function() {
    agentBrowser.confirm(t("activity.confirm.clear-all","清空所有审计记录？此操作不可撤销。"), function() {
      api.audit.clear().then(function() { toast(t("activity.toast.cleared","已清空"), "success"); agentBrowser.loadActivity(); });
    }, { ackLabel: t("confirm.ack.permanent","我了解此操作会永久删除数据且不可撤销。") });
  };
})();
