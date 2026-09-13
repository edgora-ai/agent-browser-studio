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
  var icon = helpers.icon;

  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }

  var CATEGORY_META = {
    profile:  { icon: "box", label: function(){ return t("activity.cat.profile", "Profile"); } },
    proxy:    { icon: "proxy", label: function(){ return t("activity.cat.proxy", "代理"); } },
    account:  { icon: "key", label: function(){ return t("activity.cat.account", "账号"); } },
    llm:      { icon: "agent", label: function(){ return t("activity.cat.llm", "LLM"); } },
    sync:     { icon: "sync", label: function(){ return t("activity.cat.sync", "同步"); } },
    automation:{ icon: "clock", label: function(){ return t("activity.cat.automation", "自动化"); } },
    agent:    { icon: "sparkle", label: function(){ return t("activity.cat.agent", "Agent"); } },
    settings: { icon: "settings", label: function(){ return t("activity.cat.settings", "设置"); } },
  };

  // R152: e.action is a stored enum (browser-manager writes "launch",
  // "fingerprint-drift"; proxy writes "export"; ...) and used to render raw —
  // the same class of defect R146 fixed for the `actor` enum on this same
  // line. Map the enums the backend actually writes (surveyed from all
  // recordAudit() call sites) to locale labels; anything unmapped falls
  // through to the raw enum so a new backend action degrades to today's
  // behaviour instead of "?"
  var ACTION_LABEL_KEYS = {
    "launch": "activity.act.launch",
    "stop": "activity.act.stop",
    "delete": "activity.act.delete",
    "create": "activity.act.create",
    "add": "activity.act.add",
    "update": "activity.act.update",
    "save": "activity.act.save",
    "export": "activity.act.export",
    "export-batch": "activity.act.export-batch",
    "import": "activity.act.import",
    "rotate": "activity.act.rotate",
    "qrcode-export": "activity.act.qrcode-export",
    "reveal-password": "activity.act.reveal-password",
    "copy-username": "activity.act.copy-username",
    "copy-password": "activity.act.copy-password",
    "bind": "activity.act.bind",
    "bulk-add": "activity.act.bulk-add",
    "bulk-create-profiles": "activity.act.bulk-create-profiles",
    "fingerprint-drift": "activity.act.fingerprint-drift",
    "fingerprint-drift-block": "activity.act.fingerprint-drift-block",
    "fingerprint-drift-error": "activity.act.fingerprint-drift-error",
    "injection-probe-block": "activity.act.injection-probe-block",
    "env-risk-high": "activity.act.env-risk-high",
    "env-risk-block": "activity.act.env-risk-block",
    "env-risk-error": "activity.act.env-risk-error",
    "consistency-warning": "activity.act.consistency-warning",
    "consistency-blocker": "activity.act.consistency-blocker",
    "dns-route": "activity.act.dns-route",
    "drm-enable": "activity.act.drm-enable",
    "drm-disable": "activity.act.drm-disable",
    "drm-probe": "activity.act.drm-probe",
    "webrtc-diagnostic": "activity.act.webrtc-diagnostic",
    "purge": "activity.act.purge",
    "restore": "activity.act.restore",
    "job-cancel": "activity.act.job-cancel",
    "conversation-create": "activity.act.conversation-create",
    "conversation-rename": "activity.act.conversation-rename",
    "conversation-delete": "activity.act.conversation-delete",
    "run-delete": "activity.act.run-delete",
    "runs-clear": "activity.act.runs-clear",
    "exec": "activity.act.exec",
    "install": "activity.act.install",
    "set-meta": "activity.act.set-meta",
    "team-init": "activity.act.team-init",
    "team-rename": "activity.act.team-rename",
    "team-enabled": "activity.act.team-enabled",
    "member-add": "activity.act.member-add",
    "member-remove": "activity.act.member-remove",
    "member-role": "activity.act.member-role",
    "resolve": "activity.act.resolve",
    "activate": "activity.act.activate",
    "rollback": "activity.act.rollback",
    "auto-rollback": "activity.act.auto-rollback",
    "install-request": "activity.act.install-request",
    "activate-request": "activity.act.activate-request",
  };
  function actionLabel(action) {
    var key = ACTION_LABEL_KEYS[String(action || "")];
    return key ? t(key, String(action)) : String(action || "?");
  }

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
    // R152: was slice(0, 24) — a character cut that clipped
    // "https://example.com/login" to "https://example.com/logi": mid-word,
    // with no "…" to even signal the loss. The full value goes into the DOM
    // (title keeps the whole string on hover) and CSS caps the chip width;
    // a <code> element is inline, and text-overflow only applies to a block
    // box's own line, so inline-block is what makes the ellipsis real. The
    // full string also survives for the open-job/run/profile buttons, whose
    // data-target-id always carried it.
    var code = ' <code class="activity-target" title="' + escAttr(value) + '">' + esc(value) + "</code>";
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
        var meta = CATEGORY_META[e.category] || { icon: "info", label: e.category || "?" };
        var target = renderTarget(e);
        // R179: `.slice(0, 200)` caps the string but not the line. A single
        // unbreakable token — an absolute path from rest-api-server.ts:395
        // ("imported " + zipPath), the 200-char account URL that
        // accounts index records as its target — has no soft-wrap point, so
        // 200 characters ran straight out of the card (measured +327px at
        // 900px, +507px at 700px). overflow-wrap makes the token break.
        var detail = e.detail ? '<div class="activity-detail">' + esc(String(e.detail).slice(0, 200)) + "</div>" : "";
        // R146: two defects in one line. The join relied on a trailing space in
        // the zh value ("由" has none), so it rendered "由system"; and `actor`
        // is a stored enum (api/auto/system), so it shipped raw identifiers
        // into the UI. Both are fixed by naming the actor and joining explicitly.
        var actorLabel = e.actor === "auto" ? t("activity.actor.auto", "auto")
          : e.actor === "api" ? t("activity.actor.api", "API")
          : e.actor === "system" ? t("activity.actor.system", "system")
          : e.actor;
        var actor = e.actor && e.actor !== "user"
          ? ' <span class="hint-line">' + esc(t("activity.actor-by", "by") + ' ' + actorLabel) + "</span>"
          : "";
        return '<div class="profile-card" style="padding:8px 10px;margin-bottom:6px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
            /* R142: icon + action name are one `.icon-text` row — as a bare
               inline svg the category glyph sat 1.3px off the label baseline.
               actor/target stay outside it so they keep wrapping with the row. */
            // R184: CATEGORY_META.label was dead — the table defined a
            // translated category name per entry and no code ever read it, so
            // the card showed a bare glyph with no way to tell a profile
            // action from a proxy one. It now labels the icon.
            '<span><span class="icon-text" title="' + escAttr(typeof meta.label === "function" ? meta.label() : "") + '" aria-label="' + escAttr(typeof meta.label === "function" ? meta.label() : "") + '">' + icon(meta.icon, 13) + '<strong>' + esc(actionLabel(e.action)) + '</strong></span>' + actor + target + '</span>' +
            '<span class="hint-line" style="white-space:nowrap;">' + esc(fmtTime(e.at)) + "</span>" +
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
      api.audit.clear({ confirmed: true }).then(function(r) {
        if (r && r.success === false) { toast(t("activity.toast.clear-failed","清空失败: ") + (r.error || ""), "error"); return; }
        toast(t("activity.toast.cleared","已清空"), "success"); agentBrowser.loadActivity();
      }).catch(function(e) { toast(t("activity.toast.clear-failed","清空失败: ") + (e.message || e), "error"); });
    }, { ackLabel: t("confirm.ack.permanent","我了解此操作会永久删除数据且不可撤销。") });
  };
})();
