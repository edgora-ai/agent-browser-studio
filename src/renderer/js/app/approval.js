// Approval gate UI — when the agent tries a risky operation (DROP/DELETE/etc.),
// the main process emits agent:approval-request; we show a dialog and resolve it.
(function() {
  "use strict";
  var agentBrowser = window.agentBrowser;
  var api = agentBrowser.api;
  var helpers = agentBrowser.helpers;
  var toast = helpers.toast;
  var esc = helpers.esc;

  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }

  var currentRequest = null;

  function show(req) {
    currentRequest = req;
    document.getElementById("approval-desc").textContent = req.description || "";
    document.getElementById("approval-detail").textContent = req.detail ? t("approval.signature","签名: ") + req.detail : "";
    var dlg = document.getElementById("dlg-approval");
    if (!dlg.open) dlg.showModal();
  }

  function close() {
    var dlg = document.getElementById("dlg-approval");
    if (dlg.open) dlg.close();
    currentRequest = null;
  }

  agentBrowser.approvalAllow = function(mode) {
    if (!currentRequest) return;
    var id = currentRequest.id;
    close();
    api.approval.resolve(id, mode === "always" ? "always" : "once", { confirmed: true }).then(function(r) {
      if (r && r.success === false) { toast(r.error || t("approval.failed", "授权失败"), "error"); return; }
      toast(mode === "always" ? t("approval.allowed-always","已允许(永久)") : t("approval.allowed","已允许"), "success");
    }).catch(function(e) { toast((e && e.message) || String(e), "error"); });
  };

  agentBrowser.approvalDeny = function(arg) {
    // arg may be "deny" (reject) or "close" (just close dialog, treat as deny)
    if (!currentRequest && arg !== "close") return;
    if (currentRequest) {
      var id = currentRequest.id;
      close();
      api.approval.resolve(id, "deny", { confirmed: true }).then(function(r) {
        if (r && r.success === false) { toast(r.error || t("approval.failed", "授权失败"), "error"); return; }
        toast(t("approval.denied","已拒绝"), "info");
      }).catch(function(e) { toast((e && e.message) || String(e), "error"); });
    } else {
      close();
    }
  };

  function bind() {
    if (agentBrowser.state.approvalBound) return;
    agentBrowser.state.approvalBound = true;
    api.on("agent:approval-request", function(req) {
      show(req);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
