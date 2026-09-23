// Approval gate UI. Requests are queued because one Agent run can reach a
// second approval while another desktop-owned run is still waiting for input.
(function() {
  "use strict";
  var agentBrowser = window.agentBrowser;
  var api = agentBrowser.api;
  var helpers = agentBrowser.helpers;
  var toast = helpers.toast;

  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }
  function byId(id) { return document.getElementById(id); }
  function readCall(key, fn) {
    if (agentBrowser.ipc && typeof agentBrowser.ipc.call === "function") {
      return agentBrowser.ipc.call(key, fn, { kind: "list" });
    }
    return Promise.resolve().then(fn);
  }

  var queue = [];
  var queuedIds = Object.create(null);
  var currentRequest = null;
  var currentOwner = null;
  var ownershipSeq = 0;
  var recovering = true;
  var resolving = false;

  function setButtonsDisabled(disabled) {
    var dlg = byId("dlg-approval");
    if (!dlg || typeof dlg.querySelectorAll !== "function") return;
    var buttons = dlg.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = disabled;
  }

  function setStopVisible(visible) {
    var stop = byId("approval-stop-run");
    if (!stop) return;
    stop.style.display = visible ? "inline-flex" : "none";
    stop.disabled = resolving || !visible;
  }

  function updateQueueCount() {
    var el = byId("approval-queue-count");
    if (!el) return;
    var count = queue.length + (currentRequest ? 1 : 0);
    el.textContent = count > 1 ? t("approval.queue-count", "{count} requests waiting").replace("{count}", String(count)) : "";
    el.style.display = count > 1 ? "inline" : "none";
  }

  function closeDialog() {
    var dlg = byId("dlg-approval");
    if (dlg && dlg.open) dlg.close();
  }

  function ownerMatchesCurrent(requestId, owner) {
    if (!currentRequest || currentRequest.id !== requestId || !owner) return false;
    if (currentRequest.runId && owner.runId && currentRequest.runId !== owner.runId) return false;
    return true;
  }

  function resolveOwnership(req) {
    currentOwner = null;
    setStopVisible(false);
    var controller = agentBrowser.agentChatController;
    if (!req.runId || !controller) return;
    var local = typeof controller.findByRunId === "function" ? controller.findByRunId(req.runId) : null;
    if (ownerMatchesCurrent(req.id, local)) {
      currentOwner = local;
      setStopVisible(true);
      return;
    }
    if (typeof controller.resolveOwnedRun !== "function") return;
    var seq = ++ownershipSeq;
    Promise.resolve(controller.resolveOwnedRun(req)).then(function(owner) {
      if (seq !== ownershipSeq || !ownerMatchesCurrent(req.id, owner)) return;
      currentOwner = owner;
      setStopVisible(true);
    }).catch(function() {
      // Ownership could not be proved. Hiding the task-level Stop control is the
      // safe outcome; per-operation Deny remains available.
    });
  }

  function showCurrent() {
    if (recovering || currentRequest || resolving) return;
    if (!queue.length) {
      closeDialog();
      setStopVisible(false);
      updateQueueCount();
      return;
    }
    currentRequest = queue.shift();
    var description = byId("approval-desc");
    var detail = byId("approval-detail");
    if (description) description.textContent = currentRequest.description || "";
    // The separator is layout rather than translatable punctuation.
    if (detail) detail.textContent = currentRequest.detail ? t("approval.signature", "Signature") + ": " + currentRequest.detail : "";
    setButtonsDisabled(false);
    resolving = false;
    updateQueueCount();
    resolveOwnership(currentRequest);
    var dlg = byId("dlg-approval");
    if (dlg && !dlg.open) dlg.showModal();
  }

  function enqueue(req) {
    if (!req || !req.id || queuedIds[req.id]) return;
    queuedIds[req.id] = true;
    queue.push(req);
    queue.sort(function(a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    updateQueueCount();
    showCurrent();
  }

  function advance(requestId) {
    if (currentRequest && currentRequest.id === requestId) {
      delete queuedIds[requestId];
      currentRequest = null;
      currentOwner = null;
      resolving = false;
      ownershipSeq++;
      setButtonsDisabled(false);
      setStopVisible(false);
      showCurrent();
      return;
    }
    queue = queue.filter(function(req) {
      if (req.id !== requestId) return true;
      delete queuedIds[req.id];
      return false;
    });
    updateQueueCount();
  }

  function resolveCurrent(decision, successMessage) {
    if (!currentRequest || resolving) return Promise.resolve(null);
    var request = currentRequest;
    resolving = true;
    setButtonsDisabled(true);
    if (currentOwner) setStopVisible(true);
    return api.approval.resolve(request.id, decision, { confirmed: true }).then(function(result) {
      if (!result || result.success !== true) {
        // A false result means this approval was already aborted/resolved. Do
        // not claim success, and do not leave a stale request blocking the FIFO.
        toast(result && result.error || t("approval.failed", "Authorization failed"), "error");
        advance(request.id);
        return result;
      }
      toast(successMessage, decision === "deny" ? "info" : "success");
      advance(request.id);
      return result;
    }).catch(function(error) {
      resolving = false;
      setButtonsDisabled(false);
      setStopVisible(!!currentOwner);
      toast((error && error.message) || String(error), "error");
      return null;
    });
  }

  agentBrowser.approvalAllow = function(mode) {
    var always = mode === "always";
    return resolveCurrent(
      always ? "always" : "once",
      always ? t("approval.allowed-always", "Always allowed") : t("approval.allowed", "Allowed"),
    );
  };

  agentBrowser.approvalDeny = function() {
    // Closing the modal denies this operation only. It does not cancel the
    // Agent run; the separate Stop task action is deliberately explicit.
    return resolveCurrent("deny", t("approval.denied", "Denied"));
  };

  agentBrowser.approvalStopRun = function() {
    if (!currentRequest || !currentOwner || resolving) return Promise.resolve(null);
    var request = currentRequest;
    var owner = currentOwner;
    var controller = agentBrowser.agentChatController;
    if (!controller || typeof controller.stop !== "function") return Promise.resolve(null);
    resolving = true;
    setButtonsDisabled(true);
    setStopVisible(true);
    return Promise.resolve(controller.stop(owner)).then(function(result) {
      if (!result || result.accepted !== true) {
        // The run can terminalize and advance the FIFO before this IPC reply.
        // Never let A's late failure re-enable or reveal controls for B.
        if (!currentRequest || currentRequest.id !== request.id) return result;
        resolving = false;
        setButtonsDisabled(false);
        setStopVisible(!!currentOwner);
        toast(result && result.error || t("approval.stop-failed", "Could not stop the task"), "error");
        return result;
      }
      // Cancellation aborts the gate in main. Never also resolve it as Deny:
      // those are different user actions and a late resolve would be false.
      advance(request.id);
      return result;
    }).catch(function(error) {
      if (!currentRequest || currentRequest.id !== request.id) return null;
      resolving = false;
      setButtonsDisabled(false);
      setStopVisible(!!currentOwner);
      toast((error && error.message) || String(error), "error");
      return null;
    });
  };

  agentBrowser.approvalDiscardRun = function(runId) {
    if (!runId) return;
    queue = queue.filter(function(req) {
      if (req.runId !== runId) return true;
      delete queuedIds[req.id];
      return false;
    });
    if (currentRequest && currentRequest.runId === runId) {
      var id = currentRequest.id;
      delete queuedIds[id];
      currentRequest = null;
      currentOwner = null;
      resolving = false;
      ownershipSeq++;
      setButtonsDisabled(false);
      setStopVisible(false);
      showCurrent();
    } else {
      updateQueueCount();
    }
  };

  function bind() {
    if (agentBrowser.state.approvalBound) return;
    agentBrowser.state.approvalBound = true;
    api.on("agent:approval-request", enqueue);
    readCall("approval.list", function() { return api.approval.list(); }).then(function(requests) {
      (requests || []).forEach(enqueue);
      recovering = false;
      queue.sort(function(a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      showCurrent();
    }).catch(function(error) {
      recovering = false;
      console.warn("[approval] pending recovery failed:", error);
      showCurrent();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
