/**
 * License / trial paywall UI (sale-90/92).
 *
 * - Trial banner on the Profiles tab: plan, days left / profile usage, and an
 *   Activate entry point. Licensed installs show a quiet plan chip instead.
 * - Activation dialog: pastes an offline code, shows the device id (the buyer
 *   sends it to the seller for a bound code), never echoes the code anywhere.
 * - Gate interception: browser:create / browser:launch return
 *   { success: false, code: LICENSE_EXPIRED | PROFILE_LIMIT } when the trial
 *   lapsed or the cap is hit — the UI opens the paywall dialog instead of a
 *   bare error toast. Data (stop/export/delete) is never gated.
 */
(function () {
  "use strict";

  var agentBrowser = window.agentBrowser;
  var api = agentBrowser.api;
  var toast = agentBrowser.helpers.toast;
  var esc = agentBrowser.helpers.esc;
  var t = function (k, fb) { return window.i18n ? window.i18n.t(k, fb) : fb; };

  var lastStatus = null;

  function supported() {
    return !!(api && api.license && typeof api.license.status === "function");
  }

  function refresh() {
    if (!supported()) return Promise.resolve(null);
    return api.license.status().then(function (st) {
      lastStatus = st || null;
      renderLicenseBanner(st);
      return st;
    }).catch(function () { return lastStatus; });
  }

  function planLabel(st) {
    if (!st) return "";
    if (st.plan === "trial") return t("license.plan.trial", "Trial");
    if (st.plan === "monthly") return t("license.plan.monthly", "Monthly");
    if (st.plan === "yearly") return t("license.plan.yearly", "Yearly");
    if (st.plan === "lifetime") return t("license.plan.lifetime", "Lifetime");
    return String(st.plan || "");
  }

  function renderLicenseBanner(st) {
    var el = document.getElementById("license-banner");
    if (!el) return;
    if (!st) { el.style.display = "none"; return; }
    if (st.plan !== "trial") {
      el.className = "engine-banner ok";
      var exp = st.expiresAt ? " · " + t("license.expires", "expires {d}").replace("{d}", new Date(st.expiresAt).toLocaleDateString()) : "";
      el.innerHTML = "🔑 " + esc(planLabel(st) + (st.licensedTo ? " · " + st.licensedTo : "") + exp);
      el.style.display = "";
      return;
    }
    var days = typeof st.daysLeft === "number" ? st.daysLeft : null;
    var urgent = st.expired || (days !== null && days <= 3);
    el.className = "engine-banner" + (urgent ? " license-urgent" : "");
    var msg = st.expired
      ? t("license.trial.expired", "Trial expired — your profiles and data are untouched. Activate a license to keep creating and launching.")
      : t("license.trial.left", "Trial: {d} days left · {u}/{m} profiles used").replace("{d}", days).replace("{u}", "?").replace("{m}", st.maxProfiles == null ? "∞" : st.maxProfiles);
    el.innerHTML =
      '<span style="flex:1;">🔑 ' + esc(msg) + "</span>" +
      '<button class="btn btn-primary btn-sm" data-role="cmd" data-cmd="showLicenseDialog">' +
        esc(t("license.activate", "Activate")) + "</button>";
    el.style.display = "";
    // Try to fill in real profile usage without blocking the banner.
    try {
      api.browser.list().then(function (profiles) {
        var used = Array.isArray(profiles) ? profiles.length : 0;
        var body = el.querySelector("span");
        if (body && !st.expired && days !== null) {
          body.textContent = "🔑 " + t("license.trial.left", "Trial: {d} days left · {u}/{m} profiles used")
            .replace("{d}", days).replace("{u}", used).replace("{m}", st.maxProfiles == null ? "∞" : st.maxProfiles);
        }
      }).catch(function () { /* usage is best-effort */ });
    } catch (e) { /* list unavailable */ }
  }

  function openActivateDialog() {
    var dlg = document.getElementById("dlg-license");
    if (!dlg) return;
    refresh().then(function (st) {
      var devEl = document.getElementById("license-device-id");
      if (devEl) devEl.textContent = (st && st.deviceId) || (lastStatus && lastStatus.deviceId) || "—";
      var planEl = document.getElementById("license-current-plan");
      if (planEl) planEl.textContent = st ? planLabel(st) : (lastStatus ? planLabel(lastStatus) : "—");
      var input = document.getElementById("license-code-input");
      if (input) input.value = "";
      var refundBox = document.getElementById("license-refund-ack");
      if (refundBox) refundBox.checked = false;
      var err = document.getElementById("license-error");
      if (err) { err.textContent = ""; err.style.display = "none"; }
      if (!dlg.open) {
        dlg.showModal();
        if (typeof agentBrowser.focusDialogPrimary === "function") agentBrowser.focusDialogPrimary(dlg);
      }
    });
  }

  function submitActivation() {
    var input = document.getElementById("license-code-input");
    var err = document.getElementById("license-error");
    // Sale-93: one-shot refund-policy acknowledgement — required per
    // activation, never persisted (each code purchase re-confirms).
    var refundBox = document.getElementById("license-refund-ack");
    if (!refundBox || !refundBox.checked) {
      if (err) {
        err.textContent = t("license.refund-required", "Please tick the refund-policy acknowledgement first");
        err.style.display = "";
      } else {
        toast(t("license.refund-required", "Please tick the refund-policy acknowledgement first"), "error");
      }
      if (refundBox) refundBox.focus();
      return;
    }
    var code = input ? String(input.value || "").trim() : "";
    if (!code) {
      if (err) {
        err.textContent = t("license.code-required", "Paste your activation code first");
        err.style.display = "";
      }
      if (input) input.focus();
      return;
    }
    // Never echo the code: clear the field before the IPC round trip.
    if (input) input.value = "";
    api.license.activate(code).then(function (r) {
      code = "";
      if (r && r.ok) {
        toast(t("license.activated", "License activated"), "success");
        var dlg = document.getElementById("dlg-license");
        if (dlg && dlg.open) dlg.close();
        refresh();
        return;
      }
      var msg = (r && r.error) || t("license.activate-failed", "Activation failed");
      if (r && r.code === "DEVICE_MISMATCH") {
        msg = t("license.device-mismatch",
          "This code is bound to another device. Send your device ID (shown above) to the seller for a transfer code.");
      } else if (r && r.code === "EXPIRED_CODE") {
        msg = t("license.code-expired", "This activation code has expired — ask the seller for a fresh one.");
      } else if (r && r.code === "NO_PUBKEY") {
        msg = t("license.no-pubkey", "This build cannot verify licenses (trial only).");
      }
      if (err) { err.textContent = msg; err.style.display = ""; }
      else toast(msg, "error");
    }).catch(function (e) {
      code = "";
      var msg = (e && e.message) || t("license.activate-failed", "Activation failed");
      if (err) { err.textContent = msg; err.style.display = ""; }
      else toast(msg, "error");
    });
  }

  /**
   * Intercept a create/launch IPC result. Returns true when the result was a
   * license gate refusal (paywall dialog opened, caller should not toast).
   */
  function interceptGate(result) {
    if (!result || result.success !== false) return false;
    if (result.code !== "LICENSE_EXPIRED" && result.code !== "PROFILE_LIMIT") return false;
    var msg = result.error || (result.code === "PROFILE_LIMIT"
      ? t("license.limit-hit", "Profile limit reached — activate a license for more. Your data is untouched.")
      : t("license.expired-hit", "Trial expired — activate a license to continue. Your data is untouched."));
    agentBrowser.confirm(
      msg,
      function () { openActivateDialog(); },
      { title: t("license.paywall.title", "Activate license") },
    );
    refresh();
    return true;
  }

  agentBrowser.showLicenseDialog = openActivateDialog;
  agentBrowser.submitLicenseActivation = submitActivation;
  agentBrowser.refreshLicense = refresh;
  agentBrowser.interceptLicenseGate = interceptGate;
  agentBrowser.licenseStatus = function () { return lastStatus; };
})();
