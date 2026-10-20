(function() {
  "use strict";

  var agentBrowser = window.agentBrowser;
  var api = agentBrowser.api;
  var R = agentBrowser.R;
  var state = agentBrowser.state;
  var profileFilter = { status: "all", tags: [] };
  var profileSelection = {};
  function isStoppedRuntime(profile) { return !!profile && !profile.running && profile.unknown !== true && profile.stopping !== true; }
  // R9 P1-2: in-flight launch/stop per card. Kept outside the DOM so a list
  // re-render (keyed diff rebuilds card nodes) cannot drop the busy state.
  var busyCards = Object.create(null);
  var trashPending = Object.create(null);
  // A failed purge may have removed bytes. Keep restore blocked even if the
  // current DOM (or a later list response) still calls the entry recoverable.
  var trashPurgeFailed = Object.create(null);
  var helpers = agentBrowser.helpers;
  var toast = helpers.toast;
  var esc = helpers.esc;
  var escAttr = helpers.escAttr;
  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }
  var icon = helpers.icon;
  var t = function(k, fb) { return window.i18n ? window.i18n.t(k, fb) : fb; };
  var fmt = helpers.fmt;
  var shortPath = helpers.shortPath;
  var renderChatMarkdown = helpers.renderChatMarkdown;
  var renderInlineMarkdown = helpers.renderInlineMarkdown;
  var safeCodeLanguage = helpers.safeCodeLanguage;
  var hardwareSummary = helpers.hardwareSummary;
  var shortenGpu = helpers.shortenGpu;
  var fingerprintCompleteness = helpers.fingerprintCompleteness;
  var platformIcon = helpers.platformIcon;
  var parseTagInput = helpers.parseTagInput;
  var parseListInput = helpers.parseListInput;
  var closeDialogIfOpen = helpers.closeDialogIfOpen;
  var clearSkillEditor = helpers.clearSkillEditor;
  var refreshSkillViews = helpers.refreshSkillViews;
  var skillSourceLabel = helpers.skillSourceLabel;
  var renderSkillTags = helpers.renderSkillTags;
  var renderSkillCard = helpers.renderSkillCard;
  var bindSkillCardActions = helpers.bindSkillCardActions;
  var readHardwareFields = helpers.readHardwareFields;
  var writeHardwareFields = helpers.writeHardwareFields;
  var validateHardwareFields = helpers.validateHardwareFields;
  var clearFieldErrors = helpers.clearFieldErrors;
  var showFieldErrors = helpers.showFieldErrors;
  var bindHardwareFieldValidation = helpers.bindHardwareFieldValidation;
  var renderProxyOptions = helpers.renderProxyOptions;
  var proxySelectionValue = helpers.proxySelectionValue;
  var profileProxySelectionValue = helpers.profileProxySelectionValue;
  var proxyDisplayLabel = helpers.proxyDisplayLabel;
  var parseProxySelection = helpers.parseProxySelection;
  var extractChromeExtensionId = helpers.extractChromeExtensionId;
  var getSyncStatus = helpers.getSyncStatus;
  var markProfileRuntime = helpers.markProfileRuntime;
  var clearProfileRuntime = helpers.clearProfileRuntime;
  var scheduleProfilesRefresh = helpers.scheduleProfilesRefresh;
  var getBrowserDisplay = helpers.getBrowserDisplay;
  var chromeOsFromPlatform = helpers.chromeOsFromPlatform;
  var uaPlatformFromPlatform = helpers.uaPlatformFromPlatform;
  var platformFromOsName = helpers.platformFromOsName;
  var normalizeBrowserPlatform = helpers.normalizeBrowserPlatform;
  var updateBrowserStatus = helpers.updateBrowserStatus;
  var renderBrowserBinaryCard = helpers.renderBrowserBinaryCard;

  // R8 P1-3 (round 2): profile/proxy writes go through the shared IPC wrapper
  // (hard timeout per kind) instead of bare api.*.then calls.
  function wcall(key, fn, opts) {
    return agentBrowser.ipc.call(key, fn, opts || { kind: "write" });
  }

  // Archive I/O and native pickers have no cancellation contract. A waiting
  // notice must not discard a later commit or permit a second import. Dedupe
  // the UI completion too, so repeated clicks produce only one final toast.
  var archiveCalls = Object.create(null);
  function archiveCall(key, fn, completed, failed) {
    if (archiveCalls[key]) return archiveCalls[key];
    var pending = agentBrowser.ipc.call(key, fn, {
      kind: "write", timeoutMs: 0, dedupe: true, slowNoticeMs: 15000,
      onSlow: function () {
        toast(t("archive.pending", "Still processing the backup operation. Keep this window open; it has not been cancelled."), "warning");
      },
    }).then(completed).catch(failed);
    archiveCalls[key] = pending.then(function (value) { delete archiveCalls[key]; return value; }, function (error) { delete archiveCalls[key]; throw error; });
    return archiveCalls[key];
  }
  function archiveWasCancelled(result) {
    return result && (result.cancelled === true || result.outcome === "cancelled" || result.code === "ARCHIVE_CANCELLED" || result.error === "cancelled");
  }

  // R189: reads were bare `api.*.then()` — no timeout. When the main process
  // hung, the list stayed on "Loading..." forever with no error and no retry
  // (measured: unchanged after 12s). ipc.call has had a per-kind budget all
  // along (list: 5000ms); reads just were not using it.
  function lcall(key, fn) {
    return agentBrowser.ipc.call(key, fn, { kind: "list" });
  }

  function profileErrorMessage(error) {
    var message = error && error.message ? error.message : String(error || "");
    // IPC may wrap the stable backend prefix. Do not infer host/kernel support
    // from renderer UA or app.paths; only main can validate the selected tuple.
    if (message.indexOf("Unsupported GPU overrides for Chromium:") !== -1) {
      return t("launch.gpu-unsupported", "This explicit WebGL request is unsupported. Managed overrides require a native ARM64 macOS main process, selected ARM64 Chromium and a matching platform persona. Use a supported tuple or clear gpuVendor/gpuRenderer to keep native GPU identity. Saved metadata is unchanged; WebGPU and GPU capabilities remain native.");
    }
    return message;
  }

  function readGeolocationFields(prefix) {
    var mode = document.getElementById(prefix + "geolocation-mode").value;
    if (mode !== "custom") {
      return { geolocationMode: mode, geolocationLatitude: null, geolocationLongitude: null, geolocationAccuracy: null };
    }
    var latitude = Number(document.getElementById(prefix + "geolocation-latitude").value);
    var longitude = Number(document.getElementById(prefix + "geolocation-longitude").value);
    var accuracyRaw = document.getElementById(prefix + "geolocation-accuracy").value.trim();
    var accuracy = accuracyRaw ? Number(accuracyRaw) : 50;
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new Error("Latitude must be between -90 and 90");
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error("Longitude must be between -180 and 180");
    if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000) throw new Error("Accuracy must be between 0 and 100000 meters");
    return { geolocationMode: mode, geolocationLatitude: latitude, geolocationLongitude: longitude, geolocationAccuracy: accuracy };
  }

  var businessPresetCatalog = [];
  var businessPresetsLoadSeq = 0;
  var profilesLoadSeq = 0;
  var newProfileProxySeq = 0;
  var newProfileFormSeq = 0;
  var consistencyPreviewSeq = 0;
  var newProfilePlatformEdited = false;

  function setNewProfilePlatformNote(key, fallback) {
    var note = document.getElementById("new-profile-platform-note");
    if (!note) return;
    note.setAttribute("data-i18n", key);
    note.textContent = t(key, fallback);
  }

  function loadNewProfileHostPlatform(seq) {
    var dialog = document.getElementById("dlg-profile");
    var select = document.getElementById("new-agent-browser-platform");
    return lcall("app.paths", function () { return api.app.paths(); }).then(function (paths) {
      if (seq !== newProfileFormSeq || !dialog.open) return;
      if (!paths || typeof paths.platform !== "string") throw new Error("Host platform unavailable");
      // Only main-process host metadata is trusted; never infer this from the UA.
      var platform = paths.platform === "darwin" ? "macos" : paths.platform === "win32" ? "windows" : null;
      if (!newProfilePlatformEdited && !select.value) select.value = platform || "";
      if (platform === null) {
        setNewProfilePlatformNote("profile.platform.unsupported-host", "This host does not support native managed Chromium. Portable profiles can still be stored; selecting Windows or macOS does not make this host supported.");
      }
    }).catch(function () {
      if (seq !== newProfileFormSeq || !dialog.open) return;
      // Auto remains unset so the common creation path still owns the default.
      setNewProfilePlatformNote("profile.platform.host-unavailable", "Host OS unavailable. Auto defers to the main-process creation default; native managed Chromium still requires a supported macOS or Windows host.");
    });
  }

  function writeGeolocationFields(prefix, meta) {
    document.getElementById(prefix + "geolocation-mode").value = meta.geolocationMode || "real";
    document.getElementById(prefix + "geolocation-latitude").value = meta.geolocationLatitude == null ? "" : meta.geolocationLatitude;
    document.getElementById(prefix + "geolocation-longitude").value = meta.geolocationLongitude == null ? "" : meta.geolocationLongitude;
    document.getElementById(prefix + "geolocation-accuracy").value = meta.geolocationAccuracy == null ? "" : meta.geolocationAccuracy;
  }

  function populateChromiumVersionSelect(id, selectedVersion, stillCurrent) {
    var select = document.getElementById(id);
    if (!select) return Promise.resolve();
    var seq = (select._profileVersionSeq || 0) + 1;
    select._profileVersionSeq = seq;
    function current() { return seq === select._profileVersionSeq && (!stillCurrent || stillCurrent()); }
    var selected = selectedVersion || "";
    select.innerHTML = "";
    select.appendChild(new Option(t("profile.new.field.version.auto", "Auto (newest installed)"), ""));
    if (selected) select.appendChild(new Option(selected, selected));
    select.value = selected;
    return api.browser.binary().then(function(info) {
      if (!current()) return;
      selected = select.value; // Keep input made while the optional list loads.
      var versions = (info && info.installedVersions) || [];
      select.innerHTML = "";
      select.appendChild(new Option(t("profile.new.field.version.auto", "Auto (newest installed)"), ""));
      versions.forEach(function(item) {
        select.appendChild(new Option(item.version, item.version));
      });
      if (selected && !versions.some(function(item) { return item.version === selected; })) {
        select.appendChild(new Option(selected + " " + t("profile.new.field.version.not-installed", "(not installed)"), selected));
      }
      select.value = selected;
    }).catch(function() {
      // Optional catalog failure retains the existing draft/placeholder, not
      // the saved value captured before the user started editing.
      if (current()) return select.value;
    });
  }

  // Keep one common identity form. Disabled hidden controls also stay out of
  // native form validation; their draft values survive an engine switch.
  function setProfileEngineOptions(dialogId, isFirefox) {
    var dialog = document.getElementById(dialogId);
    if (!dialog) return;
    dialog.querySelectorAll('[data-profile-engine="chromium"]').forEach(function (section) {
      section.style.display = isFirefox ? "none" : "";
      ["input", "select", "button"].forEach(function (tag) {
        section.querySelectorAll(tag).forEach(function (field) { field.disabled = isFirefox; });
      });
    });
  }

  // Imported profiles can contain a valid explicit TZ/locale outside the short
  // option lists. A native select would otherwise turn that value into Auto.
  function writeIdentitySelect(id, value) {
    var select = document.getElementById(id);
    var selected = value || "";
    if (!Array.prototype.some.call(select.querySelectorAll("option"), function (option) { return option.value === selected; })) {
      select.appendChild(new Option(selected, selected));
    }
    select.value = selected;
  }

  // R8 P2-3: refuse launch early when the engine is known-missing, with a
  // direct path to the fix — instead of a doomed IPC + post-hoc toast.
  // R10 P1-3: the guard is engine-aware. Chromium checks the managed build;
  // Firefox checks the installed Firefox. The old guard blocked Firefox
  // profiles when Chromium was missing (and vice versa).
  var lastFirefoxInfo = null;
  function engineMissing() {
    return !!(lastEngineInfo && !lastEngineInfo.installed);
  }
  function firefoxMissing() {
    return !!(lastFirefoxInfo && !lastFirefoxInfo.installed);
  }
  function guideToEngine() {
    agentBrowser.confirmHtml(
      esc(t("engine.guide.title", "Install the independent Chromium build")),
      function () { agentBrowser.selectChromiumBinary(); },
      {
        title: esc(t("engine.guide.heading", "Install guide")),
        detailHtml: '<div style="font-size:12px;line-height:1.6;">' +
          esc(t("engine.missing", "No managed Chromium installed — profiles cannot start until you point at a local build.")) +
          '</div>',
      },
    );
  }
  function guideToFirefox() {
    agentBrowser.confirmHtml(
      esc(t("engine.firefox-guide.title", "Install Firefox")),
      function () { /* informational only */ },
      {
        title: esc(t("engine.firefox-guide.heading", "Install guide")),
        detailHtml: '<div style="font-size:12px;line-height:1.6;">' +
          esc(t("engine.firefox-missing", "No Firefox installation was found — Firefox profiles cannot start until you install Firefox.")) +
          '</div>',
      },
    );
  }
  /** Engine-aware pre-launch gate. cb receives nothing; call launch IPC inside. */
  function withEngineGate(dirId, cb, viewOptions) {
    api.browser.list().then(function (profiles) {
      var meta = (profiles || []).filter(function (p) { return p.dirId === dirId; })[0] || {};
      if (meta.unknown === true || meta.stopping === true) {
        var runtimeMessage = t(meta.stopping ? "profile.runtime.stopping-help" : "profile.runtime.unconfirmed-help");
        toast(runtimeMessage, "warning");
        scheduleProfilesRefresh();
        if (viewOptions && viewOptions.fingerprintViewEpoch !== undefined && typeof agentBrowser.finishFingerprintLaunchView === "function") agentBrowser.finishFingerprintLaunchView(dirId, { error: runtimeMessage }, viewOptions.fingerprintViewEpoch);
        return;
      }
      var engine = meta.engine || "chromium";
      // Unknown/invalidated or available metadata must reach authoritative main
      // discovery; a cached banner is not permission to refuse a current launch.
      if (meta.runtimePending || meta.installed !== false) { cb(); return; }
      if (engine === "firefox") {
        if (firefoxMissing()) { guideToFirefox(); return; }
      } else {
        if (engineMissing()) { guideToEngine(); return; }
      }
      cb();
    }).catch(function () { cb(); }); // list failed — let the main process decide
  }

  function launchInner(dirId, opts) {
        // PL-06: block edit/delete while the launch is in flight.
        setCardBusy(dirId, true);
        var force = !!(opts && opts.forceDeadProxy);
        agentBrowser.ipc.call("browser.launch:" + dirId, function () { return api.browser.launch(dirId, force ? { forceDeadProxy: true } : undefined); }, { kind: "launch", dedupe: !force })
          .then(function (r) {
            var fingerprintEpoch = opts && opts.fingerprintViewEpoch;
            if (fingerprintEpoch !== undefined && typeof agentBrowser.finishFingerprintLaunchView === "function") agentBrowser.finishFingerprintLaunchView(dirId, r, fingerprintEpoch);
            // Sale-90/92: license gate first — an expired trial opens the
            // paywall dialog instead of a dead-end toast (or worse, a proxy
            // retry that can never succeed).
            if (r && typeof agentBrowser.interceptLicenseGate === "function" && agentBrowser.interceptLicenseGate(r)) {
              setCardBusy(dirId, false);
              return;
            }
            // R12 P1-1: dead-proxy escape hatch — offer a second confirm that
            // spells out the real-IP exposure, then retry with force.
            if (!r.success && r.code === "PROXY_UNREACHABLE" && !force) {
              setCardBusy(dirId, false);
              agentBrowser.confirm(
                t("launch.force-proxy.msg", "The proxy is unreachable, so this profile may not load pages. Launch anyway? Without a working proxy the browser may fall back to a direct connection and expose your real IP."),
                function () { launchInner(dirId, { forceDeadProxy: true, fingerprintViewEpoch: fingerprintEpoch }); },
                { title: t("launch.force-proxy.title", "Launch without a working proxy?") },
              );
              return;
            }
            if (r.success) {
              // UI R3: success toast carries the next step (health check) as
              // an action instead of a bare port number.
              var launchWarnings = [];
              if (r.cookieCheck && r.cookieCheck.checked && r.cookieCheck.error) {
                launchWarnings.push(t("toast.profile.cookies-pending", "Browser started, but queued cookies were not confirmed applied. Review the import result before using this session."));
              }
              var driftNotice = typeof agentBrowser.fingerprintLaunchNotice === "function" ? agentBrowser.fingerprintLaunchNotice(r.driftCheck) : { warning: false, hasDetails: false, detail: "" };
              if (driftNotice.warning) launchWarnings.push(driftNotice.detail);
              toast(t("toast.profile.started", "Managed Chromium started") + " (CDP port " + r.cdpPort + ")", launchWarnings.length ? "warning" : "success", {
                detail: launchWarnings.length ? launchWarnings.join(" ") : driftNotice.detail || t("toast.profile.started-next", "Next: run a health check from the card's health menu"),
                action: driftNotice.hasDetails
                  ? { label: t("launch.drift-review", "Review launch snapshot"), onClick: function () { showLaunchDriftReview(dirId, r.driftCheck, false); } }
                  : { label: t("toast.profile.check-now", "Check now"), onClick: (function (id) { return function () { agentBrowser.openEnvRisk(id); }; })(dirId) },
              });
              if (r.envCheck && r.envCheck.high) {
                var envCodes = (r.envCheck.findings || []).filter(function(f){ return f.severity === "high"; }).map(function(f){ return f.code; }).join(", ");
                toast(t("toast.env.high-risk", "Environment risk: {codes} — open Env on the card for fixes").replace("{codes}", envCodes || t("toast.env.high-generic", "host environment risk")), "error");
              }
              var seq = markProfileRuntime(dirId, true, r.pid);
              setTimeout(function () { clearProfileRuntime(dirId, seq); scheduleProfilesRefresh(); }, 5000);
              scheduleProfilesRefresh();
            } else {
              if (r.code === "fingerprint-drift") {
                if (fingerprintEpoch === undefined) showLaunchDriftReview(dirId, r.driftCheck, true);
                scheduleProfilesRefresh(); // A stop was requested, not a successful running launch.
                return;
              }
              // Stable main-process codes carry localized recovery guidance;
              // saving metadata or restarting Studio never applies identity live.
              var launchError = profileErrorMessage(r.error || t("toast.profile.launch-failed", "Managed Chromium launch failed"));
              if (r.code === "host-platform-mismatch") {
                launchError = t("launch.host-platform-mismatch", "This managed profile uses a different OS from this computer. Edit the profile OS to match the host, save, then stop the browser if it is running and start it again. Restarting Studio is not enough.");
              } else if (r.code === "restart-required") {
                launchError = t("launch.restart-required", "Saved identity changes are not active in this running browser. Explicitly stop the browser, then start it again. Saving or restarting Studio does not apply them live.");
              } else if (r.code === "fingerprint-check-unavailable") {
                launchError = t("err.drift.unavailable", "Launch refused: the stored fingerprint reference could not be checked. This is not evidence of drift. Review the details, then retry normal launch for fresh evidence.");
                if (fingerprintEpoch === undefined) showLaunchDriftReview(dirId, r.driftCheck || { checked: false }, false);
                scheduleProfilesRefresh();
              }
              if (r.code === "fingerprint-check-unavailable" && r.driftCheck && r.driftCheck.error) {
                toast(launchError, "error", { detail: r.driftCheck.error });
              } else {
                toast(launchError, "error");
              }
            }
          })
          .catch(function (e) {
            if (opts && opts.fingerprintViewEpoch !== undefined && typeof agentBrowser.finishFingerprintLaunchView === "function") agentBrowser.finishFingerprintLaunchView(dirId, { error: profileErrorMessage(e) }, opts.fingerprintViewEpoch);
            toast(profileErrorMessage(e), "error");
          })
          .then(function () { setCardBusy(dirId, false); });
  }

  Object.assign(agentBrowser, {
  launch: function (dirId, viewOptions) {
        withEngineGate(dirId, function () { launchInner(dirId, viewOptions && { fingerprintViewEpoch: viewOptions.fingerprintViewEpoch }); }, viewOptions);
      },

  stop: function (dirId) {
        setCardBusy(dirId, true);
        agentBrowser.ipc.call("browser.stop:" + dirId, function () { return api.browser.stop(dirId); }, { kind: "stop", dedupe: true })
          .then(function (r) {
            if (!r || r.success !== true) { toast((r && r.error) || t("toast.profile.stop-failed", "Stop failed"), "error"); scheduleProfilesRefresh(); return; }
            toast(t("toast.profile.stopped", "Stop request accepted. Waiting for browser exit."), "success");
            clearProfileRuntime(dirId);
            scheduleProfilesRefresh();
          })
          .catch(function (e) { toast(e.message, "error"); })
          .then(function () { setCardBusy(dirId, false); });
      },

  editProfile: function (dirId) {
        var seq = ++profileEditSeq;
        var dialog = document.getElementById("dlg-agent-browser-seed");
        bindProfileEditLifecycle(dialog);
        return api.browser.list().then(function(profiles) {
          if (seq !== profileEditSeq) return;
          var p = (profiles || []).find(function(x) { return x.dirId === dirId; });
          if (!p) { toast((window.i18n ? window.i18n.t("toast.profile.not-found", "Profile not found") : "Profile not found"), "error"); return; }
          var metaData = {
            name: p.name || "",
            fingerprintMode: p.fingerprintMode || "managed",
            browserVersion: p.browserVersion || "",
            allowThirdPartyCookies: p.allowThirdPartyCookies === true,
            drm: p.drm === true,
            seed: p.fingerprintSeed || 12345,
            platform: p.platform || 'windows',
            timezone: p.timezone || '',
            locale: p.locale || '',
            webrtcMode: p.webrtcMode || (p.webrtcIp ? 'altered' : 'auto'),
            webrtcIp: p.webrtcIp || '',
            geolocationMode: p.geolocationMode || 'real',
            geolocationLatitude: p.geolocationLatitude,
            geolocationLongitude: p.geolocationLongitude,
            geolocationAccuracy: p.geolocationAccuracy,
            gpuVendor: p.gpuVendor || '',
            gpuRenderer: p.gpuRenderer || '',
            hardwareConcurrency: p.hardwareConcurrency || '',
            deviceMemory: p.deviceMemory || '',
            screenWidth: p.screenWidth || '',
            screenHeight: p.screenHeight || '',
            storageQuota: p.storageQuota || '',
            taskbarHeight: p.taskbarHeight === 0 ? 0 : (p.taskbarHeight || ''),
            fontsDir: p.fontsDir || '',
            // B2 (#107): carry the prefix through — undefined forced the
            // window-title checkbox on and clobbered the value on save.
            windowTitlePrefix: p.windowTitlePrefix === null ? null : (p.windowTitlePrefix || undefined),
            appUrl: p.appUrl || '',
            proxyMode: p.proxyMode || (p.proxyName ? "named" : "none"),
            proxyName: p.proxyName || null
          };
          var isFirefox = p.engine === "firefox";
          document.getElementById("agent-browser-meta-dir-id").value = dirId;
          document.getElementById("agent-browser-meta-engine").value = isFirefox ? "firefox" : "chromium";
          setProfileEngineOptions("dlg-agent-browser-seed", isFirefox);
          document.getElementById("agent-browser-meta-firefox-note").style.display = isFirefox ? "" : "none";
          document.getElementById("agent-browser-meta-fingerprint-mode").value = metaData.fingerprintMode;
          // A hidden Chromium build selector must never replace a Firefox pin.
          if (!isFirefox) populateChromiumVersionSelect("agent-browser-meta-browser-version", metaData.browserVersion, function() {
            return seq === profileEditSeq && dialog.open && document.getElementById("agent-browser-meta-dir-id").value === dirId;
          });
          document.getElementById("agent-browser-meta-allow-third-party-cookies").checked = metaData.allowThirdPartyCookies;
          document.getElementById("agent-browser-meta-drm").checked = metaData.drm;
          document.getElementById("agent-browser-meta-name").value = metaData.name;
          document.getElementById("agent-browser-meta-seed").value = metaData.seed;
          writeIdentitySelect("agent-browser-meta-platform", metaData.platform);
          writeIdentitySelect("agent-browser-meta-timezone", metaData.timezone);
          writeIdentitySelect("agent-browser-meta-locale", metaData.locale);
          document.getElementById("agent-browser-meta-webrtc-mode").value = metaData.webrtcMode;
          document.getElementById("agent-browser-meta-webrtc").value = metaData.webrtcIp;
          document.getElementById("agent-browser-meta-render-scale-mode").value = p.renderScaleMode === "strict" ? "strict" : "native";
          writeGeolocationFields("agent-browser-meta-", metaData);
          writeHardwareFields("agent-browser-meta-", metaData);
          if (!isFirefox) bindHardwareFieldValidation("agent-browser-meta-");
          var wtPrefixMeta = metaData.windowTitlePrefix;
          var wtEnabled = wtPrefixMeta !== null;
          var wtPrefix = (wtPrefixMeta && wtPrefixMeta !== "") ? wtPrefixMeta : "";
          document.getElementById("agent-browser-meta-window-title-enabled").checked = wtEnabled;
          document.getElementById("agent-browser-meta-window-title-prefix").value = wtPrefix;
          document.getElementById("agent-browser-meta-app-url").value = metaData.appUrl;
          var proxySelect = document.getElementById("agent-browser-meta-proxy");
          var initialProxy = proxySelectionValue(metaData.proxyMode, metaData.proxyName);
          proxySelect.innerHTML = renderProxyOptions([], initialProxy, false);
          if (initialProxy.indexOf("named:") === 0) proxySelect.appendChild(new Option(metaData.proxyName, initialProxy));
          proxySelect.value = initialProxy;
          api.proxy.list().then(function(proxies) {
            if (seq !== profileEditSeq || !dialog.open || document.getElementById("agent-browser-meta-dir-id").value !== dirId) return;
            var selected = proxySelect.value;
            proxySelect.innerHTML = renderProxyOptions(proxies, selected, false);
            // A removed named proxy must not silently turn an unsaved choice
            // into a direct connection. Keep the value for main to validate.
            if (!Array.prototype.some.call(proxySelect.querySelectorAll("option"), function(option) { return option.value === selected; })) {
              proxySelect.appendChild(new Option(selected, selected));
            }
            proxySelect.value = selected;
          }).catch(function(e) {
            if (seq !== profileEditSeq || !dialog.open) return;
            toast(t("toast.proxy.load-failed", "Failed to load proxies") + ": " + (e.message || String(e)), "error");
          });
          profileEditBaseline = { dirId: dirId, signature: profileEditSignature(p) };
          if (!dialog.open) dialog.showModal();
        }).catch(function (e) { if (seq === profileEditSeq) toast(e.message, "error"); });
      },

  openDir: function (dirId) {
        api.profile.get(dirId).then(function (info) {
          return api.app.openDir(info.path);
        }).catch(function (e) { toast(e.message, "error"); });
      },

  delProfile: function (dirId) {
        // R8 P0: single delete used to bypass the trash via api.browser.delete
        // (hard delete, no undo). Route it through the same soft-delete path
        // as batch delete so every UI deletion is recoverable for 7 days.
        // `browser:delete` stays as the hard-delete channel for the REST API.
        if (busyCards[dirId]) return;
        setCardBusy(dirId, true);
        agentBrowser.confirmAsync(t("profile.delete-confirm", "Delete profile? It stays recoverable in the trash for 7 days."))
          .then(function (confirmed) {
            if (!confirmed) return;
            return agentBrowser.ipc.call("profile.trash:" + dirId, function () { return api.profile.trash(dirId); }, { kind: "write" })
              .then(function (r) {
                if (r && r.success) {
                  toast(t("toast.deleted", "Deleted"), "success", {
                    ttlMs: 12000,
                    detail: t("toast.trash.hint", "Kept in the trash for 7 days."),
                    action: { label: t("toast.undo", "Undo"), onClick: function () { restoreFromTrash([dirId]); } },
                  });
                  agentBrowser.refresh();
                } else {
                  toast(t("toast.trash.delete-failed", "Could not delete profile"), "error", { detail: trashFailureDetail(dirId, r && r.error), ttlMs: 0 });
                }
              });
          })
          .catch(function (e) {
            toast(t("toast.trash.delete-failed", "Could not delete profile"), "error", { detail: trashFailureDetail(dirId, e), ttlMs: 0 });
          })
          .finally(function () { setCardBusy(dirId, false); });
      },

  renameProfile: function (dirId, oldName) {
        document.getElementById("rename-dir-id").value = dirId;
        document.getElementById("rename-name").value = oldName;
        document.getElementById("dlg-rename").showModal();
      },

  doRename: function () {
        var dirId = document.getElementById("rename-dir-id").value;
        var newName = document.getElementById("rename-name").value.trim();
        if (!newName) { toast((window.i18n ? window.i18n.t("toast.name-required", "Name required") : "Name required"), "error"); return; }
        wcall("browser.setMeta", function () { return api.browser.setMeta(dirId, { name: newName }); }).then(function (r) {
          document.getElementById("dlg-rename").close();
          if (r.success) { toast((window.i18n ? window.i18n.t("toast.renamed", "Renamed") : "Renamed"), "success"); agentBrowser.refresh(); }
          else toast(r.error || "Failed", "error");
        }).catch(function (e) { toast(e.message, "error"); });
      },

  proxyChanged: function (dirId, selectEl) {
        var selection = parseProxySelection(selectEl.value, "none");
        wcall("proxy.setProfile", function () { return api.proxy.setProfile(dirId, selection.name, selection.mode); }).then(function (r) {
          if (r && r.success === false) { toast(r.error || (window.i18n ? window.i18n.t("toast.proxy.update-failed", "Proxy update failed") : "Proxy update failed"), "error"); agentBrowser.refresh(); return; }
          toast((window.i18n ? window.i18n.t("toast.proxy.updated", "Proxy updated") : "Proxy updated"), "success"); agentBrowser.refresh();
        }).catch(function (e) { toast(e.message, "error"); });
      },

  loadNewProfileProxies: function () {
        var seq = ++newProfileProxySeq;
        var dialog = document.getElementById("dlg-profile");
        var select = document.getElementById("new-profile-proxy");
        return api.proxy.list().then(function (proxies) {
          if (seq !== newProfileProxySeq || !dialog.open) return;
          // Read the current choice, not the default captured before user input.
          select.innerHTML = renderProxyOptions(proxies, select.value || "default", false);
        }).catch(function (e) {
          if (seq !== newProfileProxySeq || !dialog.open) return;
          toast((window.i18n ? window.i18n.t("toast.proxy.load-failed", "Failed to load proxies") : "Failed to load proxies") + ": " + e.message, "error");
        });
      },

  resetNewProfileForm: function (browser) {
        var formSeq = ++newProfileFormSeq;
        ++consistencyPreviewSeq;
        if (agentBrowser._consistencyPreviewTimer) clearTimeout(agentBrowser._consistencyPreviewTimer);
        newProfilePlatformEdited = false;
        ++newProfileProxySeq;
        document.getElementById("new-profile-proxy").innerHTML = renderProxyOptions([], "default", false);
        document.getElementById("new-profile-name").value = "";
        if (document.getElementById("new-profile-browser")) {
          document.getElementById("new-profile-browser").value = browser;
        }
        document.getElementById("new-profile-proxy").value = "default";
        document.getElementById("new-agent-browser-fingerprint-mode").value = "managed";
        populateChromiumVersionSelect("new-agent-browser-browser-version", "");
        document.getElementById("new-agent-browser-allow-third-party-cookies").checked = false;
        document.getElementById("new-agent-browser-drm").checked = false;
        document.getElementById("new-agent-browser-seed").value = "";
        var platformSelect = document.getElementById("new-agent-browser-platform");
        platformSelect.value = "";
        if (!platformSelect.dataset.hostPlatformBound) {
          platformSelect.dataset.hostPlatformBound = "1";
          platformSelect.addEventListener("change", function () { newProfilePlatformEdited = true; });
        }
        setNewProfilePlatformNote("profile.platform.host-help", "Managed Chromium requires a supported matching host OS (macOS on Mac, Windows on Windows). A WebGL persona does not enable cross-OS launch. Other OS identities are portable storage only.");
        document.getElementById("new-agent-browser-timezone").value = "";
        document.getElementById("new-agent-browser-locale").value = "";
        document.getElementById("new-agent-browser-webrtc").value = "";
        document.getElementById("new-agent-browser-webrtc-mode").value = "auto";
        document.getElementById("new-agent-browser-window-title-enabled").checked = true;
        document.getElementById("new-agent-browser-render-scale-mode").value = "native";
        writeGeolocationFields("new-agent-browser-", {});
        writeHardwareFields("new-agent-browser-", {});
        bindHardwareFieldValidation("new-agent-browser-");
        var presetSelect = document.getElementById("new-profile-preset");
        if (presetSelect) presetSelect.value = "";
        var presetInfo = document.getElementById("new-profile-preset-info");
        if (presetInfo) { presetInfo.style.display = "none"; presetInfo.innerHTML = ""; }
        loadNewProfileHostPlatform(formSeq);
      },

  loadBusinessPresets: function () {
        var select = document.getElementById("new-profile-preset");
        if (!select) return Promise.resolve([]);
        var seq = ++businessPresetsLoadSeq;
        var formSeq = newProfileFormSeq;
        return api.browser.presets().then(function(list) {
          if (seq !== businessPresetsLoadSeq || formSeq !== newProfileFormSeq || !document.getElementById("dlg-profile").open) return [];
          var selected = select.value;
          businessPresetCatalog = list || [];
          var zh = window.i18n && window.i18n.locale && window.i18n.locale.indexOf("zh") === 0;
          select.innerHTML = "";
          var none = document.createElement("option");
          none.value = "";
          none.textContent = (window.i18n ? window.i18n.t("profiles.preset.none", "None \u2014 manual setup") : "None \u2014 manual setup");
          select.appendChild(none);
          businessPresetCatalog.forEach(function(p) {
            var opt = document.createElement("option");
            opt.value = p.id;
            opt.textContent = p.icon + " " + (zh ? p.nameZh : p.name);
            select.appendChild(opt);
          });
          select.value = businessPresetCatalog.some(function(p) { return p.id === selected; }) ? selected : "";
          return businessPresetCatalog;
        }).catch(function() { return []; });
      },

  presetChanged: function () {
        var select = document.getElementById("new-profile-preset");
        var id = select ? select.value : "";
        var info = document.getElementById("new-profile-preset-info");
        if (!id) {
          if (info) { info.style.display = "none"; info.innerHTML = ""; }
          return;
        }
        var preset = null;
        for (var i = 0; i < businessPresetCatalog.length; i++) {
          if (businessPresetCatalog[i].id === id) { preset = businessPresetCatalog[i]; break; }
        }
        if (!preset) return;
        // A selected regional preset fills common identity on either engine;
        // it never resets mode, seed or an explicit OS choice.
        var nameEl = document.getElementById("new-profile-name");
        if (nameEl && !nameEl.value.trim()) nameEl.value = preset.nameSuffix;
        writeIdentitySelect("new-agent-browser-timezone", preset.profile.timezone);
        writeIdentitySelect("new-agent-browser-locale", preset.profile.locale);
        if (document.getElementById("new-profile-browser").value !== "firefox") {
          document.getElementById("new-agent-browser-webrtc-mode").value = preset.profile.webrtcMode;
          writeGeolocationFields("new-agent-browser-", {
            geolocationMode: preset.profile.geolocationMode,
            geolocationLatitude: preset.profile.geolocationLatitude,
            geolocationLongitude: preset.profile.geolocationLongitude,
            geolocationAccuracy: preset.profile.geolocationAccuracy,
          });
        }
        agentBrowser.scheduleConsistencyPreview();
        if (info) {
          var zh = window.i18n && window.i18n.locale && window.i18n.locale.indexOf("zh") === 0;
          var gates = [];
          if (preset.recommendedGates.blockOnConsistencyConflict) gates.push(zh ? "一致性" : "Consistency");
          if (preset.recommendedGates.blockOnProxyRisk) gates.push(zh ? "代理风控" : "Proxy risk");
          if (preset.recommendedGates.blockOnEnvironmentRisk) gates.push(zh ? "环境风控" : "Environment");
          info.innerHTML = (zh ? preset.descriptionZh : preset.description) + " \u00b7 " +
            (zh ? "地区" : "Region") + ": " + (zh ? preset.regionZh : preset.region) + " \u00b7 " +
            (zh ? "建议代理" : "Proxy") + ": " + (zh ? preset.proxyHintZh : preset.proxyHint) +
            (gates.length ? " \u00b7 " + (zh ? "建议开启安全门" : "Recommended gates") + ": " + gates.join("/") : "");
          info.style.display = "block";
        }
      },

  // sale-95: live four-way consistency preview on the create form —
  // proxy/timezone/locale/platform changes re-check without saving.
  // State lives on agentBrowser (this block is inside Object.assign, so no
  // bare var/function declarations allowed here).
  scheduleConsistencyPreview: function () {
    ++consistencyPreviewSeq; // Invalidate the previous reply at change intent.
    if (agentBrowser._consistencyPreviewTimer) clearTimeout(agentBrowser._consistencyPreviewTimer);
    agentBrowser._consistencyPreviewTimer = setTimeout(function () { agentBrowser.runConsistencyPreview(); }, 350);
  },
  runConsistencyPreview: function () {
    var host = document.getElementById("new-profile-consistency");
    var dialog = document.getElementById("dlg-profile");
    if (!host || !dialog.open) return;
    var seq = ++consistencyPreviewSeq;
    var formSeq = newProfileFormSeq;
    function current() { return seq === consistencyPreviewSeq && formSeq === newProfileFormSeq && dialog.open; }
    function note(text) { return '<p class="field-note-tight">' + esc(text) + '</p>'; }
    host.style.display = "";
    if (document.getElementById("new-agent-browser-fingerprint-mode").value === "off") {
      host.innerHTML = note(t("profile.new.mode.help", "Off disables managed identity overrides and retains the stored values. It is not an unmodified-browser or scheduling baseline."));
      return;
    }
    var selection = parseProxySelection(document.getElementById("new-profile-proxy").value, "default");
    var params = {
      timezone: document.getElementById("new-agent-browser-timezone").value || null,
      locale: document.getElementById("new-agent-browser-locale").value || null,
      platform: document.getElementById("new-agent-browser-platform").value || undefined,
      proxyMode: selection.mode || "default",
      proxyName: selection.name || null,
    };
    var intro = note(t("profile.consistency.cached-help", "Draft checks use stored fields and any cached proxy candidate, not a fresh exit observation. Live alignment has not been checked."));
    if (!params.timezone || !params.locale) {
      intro = note(t("profile.identity.auto-help", "Auto timezone / locale resolve at launch in Managed mode; not yet checked. Explicit values are kept. Cached proxy data is only a candidate, not proof of live alignment.")) + intro;
    }
    host.innerHTML = intro;
    // Null is Auto, not an identity to certify. Do not fabricate an OS while
    // host metadata is pending or turn an empty cached-only result into green.
    if ((!params.timezone && !params.locale) || !params.platform) return;
    function unavailable() {
      if (current()) host.innerHTML = intro + note(t("profile.consistency.unavailable", "Preview unavailable; live alignment is still not checked."));
    }
    api.browser.consistencyPreview(params).then(function (r) {
      if (!current()) return;
      if (!r || r.error || r.ok === false && !(r.blockers || []).length) { unavailable(); return; }
      var items = [];
      (r.warnings || []).forEach(function (w) { items.push({ level: "warn", text: w.message || w.code }); });
      (r.blockers || []).forEach(function (b) { items.push({ level: "block", text: b.message || b.code }); });
      host.innerHTML = intro + items.map(function (it) {
        return '<p class="field-note-tight ' + (it.level === "block" ? "health-text-poor" : "health-text-watch") + '">' +
          (it.level === "block" ? icon("close", 12) : icon("alert", 12)) + " " + esc(it.text) + '</p>';
      }).join("");
    }).catch(unavailable);
  },

  newProfile: function () {
        agentBrowser.resetNewProfileForm("chromium");
        agentBrowser.loadBusinessPresets();
        agentBrowser.profileBrowserChanged();
        var adv = document.getElementById("new-profile-advanced");
        if (adv && adv.open) adv.open = false; // RoxyBrowser 4.0.3-style: basic fields first, advanced collapsed
        var host = document.getElementById("new-profile-consistency");
        if (host) { host.style.display = "none"; host.innerHTML = ""; }
        ["new-profile-proxy", "new-agent-browser-timezone", "new-agent-browser-locale", "new-agent-browser-platform", "new-agent-browser-fingerprint-mode"].forEach(function (id) {
          var el = document.getElementById(id);
          if (el && !el.dataset.consistencyBound) {
            el.dataset.consistencyBound = "1";
            el.addEventListener("change", function () { agentBrowser.scheduleConsistencyPreview(); });
          }
        });
        document.getElementById("dlg-profile").showModal();
        agentBrowser.runConsistencyPreview();
      },

  quickCreateProfile: function () {
        var base = (window.i18n ? window.i18n.t("profiles.quick-name", "Quick Profile") : "Quick Profile");
        wcall("browser.create", function () { return api.browser.create({ name: base }); }).then(function(r) {
          // Round 3 follow-up: gate refusals open the paywall, not a toast.
          if (r && typeof agentBrowser.interceptLicenseGate === "function") {
            try { if (agentBrowser.interceptLicenseGate(r)) return; } catch (gateErr) { /* fall through */ }
          }
          if (!r || !r.dirId) { toast((r && r.error) || "Quick create failed", "error"); return; }
          toast((window.i18n ? window.i18n.t("toast.profile.quick-created", "Profile created") : "Profile created") + ": " + base, "success");
          loadProfiles();
        }).catch(function(e) { toast(e.message || String(e), "error"); });
      },

  profileBrowserChanged: function() {
        var browser = (document.getElementById("new-profile-browser") || {}).value || "chromium";
        var firefoxOpts = document.getElementById("new-profile-firefox-opts");
        var isFirefox = browser === "firefox";
        setProfileEngineOptions("dlg-profile", isFirefox);
        if (isFirefox && typeof clearFieldErrors === "function") clearFieldErrors("new-agent-browser-");
        if (firefoxOpts) firefoxOpts.style.display = isFirefox ? "block" : "none";
        var browserRow = document.getElementById("new-profile-browser-row");
        if (browserRow) browserRow.style.display = "block";
        var proxyRow = document.getElementById("new-profile-proxy-row");
        if (proxyRow) proxyRow.style.display = "block";
        agentBrowser.loadNewProfileProxies();
        agentBrowser.scheduleConsistencyPreview();
      },

  createProfile: function () {
        var name = document.getElementById("new-profile-name").value.trim();
        var proxySelection = parseProxySelection(document.getElementById("new-profile-proxy").value, "default");
        var businessPresetId = document.getElementById("new-profile-preset").value || undefined;

        if (!name) { toast((window.i18n ? window.i18n.t("toast.profile.name-prompt", "Please enter a name") : "Please enter a name"), "error"); return; }

        var isFirefox = document.getElementById("new-profile-browser").value === "firefox";
        var seedRaw = document.getElementById("new-agent-browser-seed").value.trim();
        var seed = seedRaw ? Number(seedRaw) : undefined;
        if (seed !== undefined && (!Number.isInteger(seed) || seed < 1 || seed > 999999)) { toast(t("toast.invalid-seed", "Invalid seed"), "error"); return; }
        var options = {
          name: name,
          engine: isFirefox ? "firefox" : undefined,
          fingerprintMode: document.getElementById("new-agent-browser-fingerprint-mode").value || "managed",
          fingerprintSeed: seed,
          platform: document.getElementById("new-agent-browser-platform").value || undefined,
          timezone: document.getElementById("new-agent-browser-timezone").value || null,
          locale: document.getElementById("new-agent-browser-locale").value || null,
          proxyMode: proxySelection.mode,
          proxyName: proxySelection.name,
        };
        if (!isFirefox) {
          // Hidden Chromium controls are neither validated nor read for Firefox.
          var newErrors = validateHardwareFields("new-agent-browser-");
          if (newErrors.length) {
            clearFieldErrors("new-agent-browser-");
            showFieldErrors(newErrors);
            toast(t("toast.form.invalid", "Please fix the highlighted fields"), "error");
            return;
          }
          var webrtcMode = document.getElementById("new-agent-browser-webrtc-mode").value || "auto";
          try {
            Object.assign(options, readHardwareFields("new-agent-browser-"), readGeolocationFields("new-agent-browser-"), {
              browserVersion: document.getElementById("new-agent-browser-browser-version").value || null,
              allowThirdPartyCookies: document.getElementById("new-agent-browser-allow-third-party-cookies").checked,
              drm: document.getElementById("new-agent-browser-drm").checked,
              webrtcMode: webrtcMode,
              webrtcIp: webrtcMode === "real" || webrtcMode === "disable" ? undefined : document.getElementById("new-agent-browser-webrtc").value.trim() || undefined,
              renderScaleMode: document.getElementById("new-agent-browser-render-scale-mode").value || "native",
              windowTitlePrefix: document.getElementById("new-agent-browser-window-title-enabled").checked ? "" : null,
              // Firefox takes only the supported common preset prefill. The
              // current server-side preset expansion would reintroduce hidden
              // geo/WebRTC fields and replace intentional null Auto values.
              businessPresetId: businessPresetId,
            });
          } catch (e) { toast(e.message || String(e), "error"); return; }
        }
        wcall("browser.create", function () { return api.browser.create(options); }).then(function(r) {
          // Sale-90/92: trial expiry / profile cap opens the paywall dialog
          // instead of closing the form with a misleading success toast.
          if (r && typeof agentBrowser.interceptLicenseGate === "function" && agentBrowser.interceptLicenseGate(r)) return;
          if (!r || r.success === false || !r.dirId) { toast(profileErrorMessage((r && r.error) || t("toast.profile.create-failed", "Profile creation failed")), "error"); return; }
          document.getElementById("dlg-profile").close();
          toast(t("toast.profile.created", "Browser profile created!"), "success");
          // UI R3: after create, land on the new card (scroll + highlight)
          // instead of leaving the user to hunt for it in a long list.
          var newId = r && r.dirId;
          loadProfiles();
          agentBrowser.switchTab("profiles");
          if (newId) {
            setTimeout(function () {
              try {
                if (agentBrowser.batch && typeof agentBrowser.batch.locateCard === "function") agentBrowser.batch.locateCard(newId);
              } catch (e) { /* best effort */ }
            }, 400);
          }
        }).catch(function(e) { toast(profileErrorMessage(e), "error"); });
      },

  refresh: function () { agentBrowser.loadTab(state.currentTab); },

  refreshProfilesSoft: function () { loadProfiles(true); }
  });
  agentBrowser.bulkImport = function() {
    api.proxy.list().then(function(proxies) {
      document.getElementById("bulk-import-proxy").innerHTML = renderProxyOptions(proxies, "default", false);
      document.getElementById("bulk-import-text").value = "";
      document.getElementById("bulk-import-status").innerHTML = "";
      document.getElementById("dlg-bulk-import").showModal();
    });
  };

  agentBrowser.doBulkImport = function() {
    var text = document.getElementById("bulk-import-text").value.trim();
    var fallbackProxy = parseProxySelection(document.getElementById("bulk-import-proxy").value, "default");
    var statusEl = document.getElementById("bulk-import-status");
    if (!text) { statusEl.innerHTML = '<span style="color: var(--danger-text);">' + esc(t("bulk.import.no-input", "Enter profile definitions")) + '</span>'; return; }
    // Parse via the shared CSV parser (supports header + per-row proxy/tags).
    wcall("browser.parseBulkCsv", function () { return api.browser.parseBulkCsv(text); }).then(function(res) {
      if (!res || !res.ok || !res.specs || !res.specs.length) {
        statusEl.innerHTML = '<span style="color: var(--danger-text);">' + esc(t("bulk.import.no-rows", "No valid rows (use a header: name,platform,locale,timezone,seed,proxy,webrtc,tags)")) + '</span>';
        return;
      }
      var specs = res.specs;
      var total = specs.length, done = 0, errors = 0;
      // P3 (#110): per-row failures used to count silently — keep the first
      // few messages so the user can fix the CSV instead of guessing.
      var errorLines = [];
      statusEl.innerHTML = '<span style="color: var(--primary-text);">' + esc(t("bulk.import.importing", "Importing {n} profiles...").replace("{n}", String(total))) + '</span>';
      function processNext(idx) {
        if (idx >= specs.length) {
          var errHtml = errorLines.length ? '<div style="margin-top:6px;font-size:11px;color: var(--danger-text);text-align:left;">' + errorLines.slice(0, 5).map(function (l) { return esc(l); }).join('<br>') + (errorLines.length > 5 ? '<br>…+' + (errorLines.length - 5) : '') + '</div>' : '';
          var doneMsg = t("bulk.import.done", "Imported {done}/{total}").replace("{done}", String(done)).replace("{total}", String(total));
          if (errors) doneMsg += " " + t("bulk.import.errors", "({n} errors)").replace("{n}", String(errors));
          statusEl.innerHTML = '<span style="color: var(--success-text);">' + esc(doneMsg) + '</span>' + errHtml;
          // Keep the dialog open when rows failed so the messages stay visible.
          if (errors) return;
          setTimeout(function() { document.getElementById("dlg-bulk-import").close(); agentBrowser.refresh(); }, 1000);
          return;
        }
        var s = specs[idx];
        // Per-row proxy wins; else the dialog's fallback selection.
        var proxyMode = s.proxyName ? "named" : fallbackProxy.mode;
        var proxyName = s.proxyName || fallbackProxy.name;
        wcall("browser.create", function () { return api.browser.create({
          name: s.name,
          platform: s.platform,
          locale: s.locale,
          timezone: s.timezone,
          fingerprintSeed: s.fingerprintSeed,
          webrtcMode: s.webrtcMode,
          webrtcIp: s.webrtcIp,
          geolocationMode: s.geolocationMode,
          geolocationLatitude: s.geolocationLatitude,
          geolocationLongitude: s.geolocationLongitude,
          geolocationAccuracy: s.geolocationAccuracy,
          proxyMode: proxyMode,
          proxyName: proxyName,
          tags: s.tags || []
        }); }).then(function(r) {
          // P3 (#110): a gate refusal arrives as {success:false} (not a
          // throw) — open the paywall and stop the batch instead of counting
          // a phantom success.
          if (r && typeof agentBrowser.interceptLicenseGate === "function") {
            try {
              // Review R3: don't abandon the recursion — record the stop as
              // a row entry and render the terminal summary so the status
              // element never sticks at "Importing n/total…".
              if (agentBrowser.interceptLicenseGate(r)) {
                errors++;
                // Round 3 D2: name the unattempted remainder — "Imported 3/50
                // (1 errors)" hides 46 never-tried rows.
                var skipped = total - idx - 1;
                var gateMsg = (r && r.code === "PROFILE_LIMIT")
                  ? t("license.limit-hit", "Profile limit reached — activate a license for more. Your data is untouched.")
                  : t("license.expired-hit", "Trial expired — activate a license to continue. Your data is untouched.");
                errorLines.push((s.name || ("row " + (idx + 1))) + ": " + gateMsg);
                var impMsg = t("bulk.import.done", "Imported {done}/{total}").replace("{done}", String(done)).replace("{total}", String(total));
                if (errors) impMsg += " " + t("bulk.import.errors", "({n} errors)").replace("{n}", String(errors));
                if (skipped > 0) impMsg += ", " + t("bulk.import.skipped", "{n} not attempted").replace("{n}", String(skipped));
                statusEl.innerHTML = '<span style="color: var(--success-text);">' + esc(impMsg) + '</span>' +
                  '<div style="margin-top:6px;font-size:11px;color: var(--danger-text);text-align:left;">' + errorLines.slice(0, 5).map(function (l) { return esc(l); }).join('<br>') + '</div>';
                return;
              }
            } catch (gateErr) { /* fall through to normal counting */ }
          }
          if (r && r.success === false) {
            errors++;
            errorLines.push((s.name || ("row " + (idx + 1))) + ": " + (r.error || "create failed"));
            processNext(idx + 1);
            return;
          }
          done++;
          statusEl.innerHTML = '<span style="color: var(--primary-text);">' + done + '/' + total + ' imported...</span>';
          processNext(idx + 1);
        }).catch(function(e) {
          errors++;
          errorLines.push((s.name || ("row " + (idx + 1))) + ": " + ((e && e.message) || String(e)));
          processNext(idx + 1);
        });
      }
      processNext(0);
    }).catch(function(e) { statusEl.innerHTML = '<span style="color: var(--danger-text);">' + esc((e && e.message) || e) + '</span>'; });
  };

  agentBrowser.exportProfileArchive = function(dirId) {
    return archiveCall("profile.exportArchive:" + dirId, function () { return api.profile.exportArchive(dirId); }, function(r) {
      if (archiveWasCancelled(r)) return r;
      if (!r || !r.success) {
        var failure = r && r.code === "PROFILE_STOP_REQUIRED"
          ? t("archive.stop-required", "Stop {n} profile(s) and wait for confirmed exit, then retry export.").replace("{n}", 1)
          : t("toast.profile.export-failed", "Export failed: ") + ((r && r.error) || "unknown");
        toast(failure, "error");
        return r;
      }
      var warnings = Array.isArray(r.warnings) ? r.warnings : [];
      var msg = t("toast.profile.exported", "Exported backup: ") + esc(r.filePath);
      if (warnings.length) msg += t("archive.export.warning-count", ". {n} warning(s): {details}").replace("{n}", warnings.length).replace("{details}", esc(warnings.join("; ")));
      toast(msg, warnings.length ? "warning" : "success");
      return r;
    }, function(e) {
      var raw = (e && e.message) || String(e);
      var failure = e && e.code === "PROFILE_STOP_REQUIRED"
        ? t("archive.stop-required", "Stop {n} profile(s) and wait for confirmed exit, then retry export.").replace("{n}", 1)
        : t("toast.profile.export-failed", "Export failed: ") + raw;
      toast(failure, "error");
      return { success: false, error: raw, code: e && e.code };
    });
  };

  agentBrowser.importProfileArchive = function() {
    return archiveCall("profile.importArchives", function () { return api.profile.importArchives(); }, function(r) {
      if (archiveWasCancelled(r)) return r;
      // Partial/failed batches still have authoritative item tallies. Do not
      // hide their committed imports behind the top-level success boolean.
      if (!r || !r.report) {
        toast(t("toast.profile.import-failed", "Import failed: ") + ((r && r.error) || "unknown"), "error");
        return r;
      }
      var rep = r.report;
      var imported = (rep.imported || []).length;
      var failed = (rep.failed || []).length;
      var warnings = (rep.imported || []).reduce(function(n, item) { return n + ((item.warnings || []).length); }, 0);
      var msg = t("toast.profile.imported", "Imported {n} profiles").replace("{n}", imported);
      if (failed) msg += t("toast.profile.import-failed-count", ", {n} failed").replace("{n}", failed);
      if (warnings) msg += t("toast.profile.import-dependencies", ". {n} dependency warnings: check named proxies/credentials, install missing extensions, and configure local fonts if needed before launch.").replace("{n}", warnings);
      if (imported) {
        var identityCounts = {};
        (rep.imported || []).forEach(function(item) { var state = item.identity && item.identity.configuration && item.identity.configuration.state || "not-verifiable"; identityCounts[state] = (identityCounts[state] || 0) + 1; });
        var identityLabels = { retained: "Configuration identity retained", changed: "Configuration identity changed", "not-verifiable": "Configuration identity not verifiable", "missing-seed": "Legacy configuration has no identity seed" };
        msg += ". " + Object.keys(identityCounts).map(function(state) { return t("identity.config." + state, identityLabels[state] || identityLabels["not-verifiable"]) + ": " + identityCounts[state]; }).join("; ") + ". " + t("identity.runtime.not-verified", "Runtime fingerprint not re-verified");
      }
      toast(msg, imported === 0 && failed > 0 ? "error" : (failed || warnings || imported === 0 ? "warning" : "success"));
      if (imported > 0) loadProfiles();
      return r;
    }, function(e) {
      toast(t("toast.profile.import-failed", "Import failed: ") + (e.message || String(e)), "error");
      return { success: false, error: e.message || String(e), code: e.code };
    });
  };

  // Batch start/stop (review items PL-01 / PL-02).
  // Both now delegate to the bounded-concurrency batch runner and report the
  // real per-profile tally instead of a hard-coded "N profiles started".
  function finishBatch() { agentBrowser.refresh(); }

  agentBrowser.bulkStart = function() {
    api.browser.list().then(function(profiles) {
      var stopped = (profiles || []).filter(isStoppedRuntime);
      if (stopped.length === 0) {
        var unconfirmed = (profiles || []).some(function(p) { return p.unknown === true || p.stopping === true; });
        toast(unconfirmed ? t("profile.runtime.launch-unavailable") : t("toast.bulk.all-running", "All profiles are already running"), unconfirmed ? "warning" : "success");
        return;
      }
      // R10 P1-3: engine-aware preflight — only refuse the subset whose
      // engine is actually missing. The old gate blocked Firefox batches
      // when Chromium was missing (and vice versa).
      var needChromium = stopped.some(function (p) { return (p.engine || "chromium") !== "firefox"; });
      var needFirefox = stopped.some(function (p) { return (p.engine || "chromium") === "firefox"; });
      var confirmedMissing = stopped.every(function (p) { return p.installed === false && !p.runtimePending; });
      if (confirmedMissing && needChromium && !needFirefox && engineMissing()) { guideToEngine(); return; }
      if (confirmedMissing && needFirefox && !needChromium && firefoxMissing()) { guideToFirefox(); return; }
      agentBrowser.batch.run({ kind: "launch", dirIds: stopped.map(function(p) { return p.dirId; }) })
        .then(finishBatch, finishBatch);
    }).catch(function(e){ toast((e && e.message) || String(e), 'error'); });
  };

  agentBrowser.bulkStop = function() {
    api.browser.list().then(function(profiles) {
      var running = (profiles || []).filter(function(p) { return p.running; });
      if (running.length === 0) { toast(t("toast.bulk.none-running", "No profiles are running"), "success"); return; }
      agentBrowser.batch.run({ kind: "stop", dirIds: running.map(function(p) { return p.dirId; }) })
        .then(finishBatch, finishBatch);
    }).catch(function(e){ toast((e && e.message) || String(e), 'error'); });
  };

  // ── Batch operations console (filter / select / batch actions) ──

  function selectedProfileIds() {
    return Object.keys(profileSelection).filter(function (dirId) { return profileSelection[dirId]; });
  }

  function updateBatchBar(proxies) {
    var count = selectedProfileIds().length;
    var bar = document.getElementById("profile-batch-actions");
    var counter = document.getElementById("profile-selected-count");
    if (bar) bar.style.display = count > 0 ? "" : "none";
    if (counter) counter.textContent = String(count);
    var sel = document.getElementById("batch-assign-proxy");
    if (sel && proxies) {
      var prev = sel.value;
      var html = '<option value="">' + esc(t("profiles.batch.proxy-default", "(Default proxy)")) + '</option>';
      (proxies || []).forEach(function (p) {
        html += '<option value="' + escAttr(p.name) + '">' + esc(p.name) + '</option>';
      });
      sel.innerHTML = html;
      if (prev && sel.querySelector('option[value="' + prev + '"]')) sel.value = prev;
    }
    var all = document.getElementById("profile-select-all");
    if (all) {
      var cards = document.querySelectorAll('#profile-list .profile-card');
      var selVisible = 0;
      Array.prototype.forEach.call(cards, function (card) { if (profileSelection[card.dataset.dirId]) selVisible++; });
      all.checked = cards.length > 0 && selVisible === cards.length;
    }
  }

  agentBrowser.onProfileFilterChange = function() {
    profileFilter.status = (document.getElementById("profile-status-filter") || {}).value || "all";
    profileFilter.tags = parseTagInput(document.getElementById("profile-tag-filter").value);
    profileSelection = {};
    profilePage = 1;
    loadProfiles();
  };

  agentBrowser.clearProfileFilters = function() {
    profileFilter = { status: "all", tags: [] };
    var s = document.getElementById("profile-status-filter"); if (s) s.value = "all";
    var t = document.getElementById("profile-tag-filter"); if (t) t.value = "";
    profileSelection = {};
    profilePage = 1;
    loadProfiles();
  };

  agentBrowser.onProfileSelectAllChange = function() {
    var all = document.getElementById("profile-select-all");
    var checked = all && all.checked;
    var cards = document.querySelectorAll('#profile-list .profile-card');
    Array.prototype.forEach.call(cards, function (card) {
      if (checked) profileSelection[card.dataset.dirId] = true; else delete profileSelection[card.dataset.dirId];
      var cb = card.querySelector(".profile-select-checkbox");
      if (cb) cb.checked = !!checked;
    });
    updateBatchBar();
  };

  agentBrowser.toggleProfileSelect = function(dirId, checked) {
    if (checked) profileSelection[dirId] = true;
    else delete profileSelection[dirId];
    updateBatchBar();
  };

  agentBrowser.batchStartSelected = function() {
    var sel = selectedProfileIds();
    if (!sel.length) return;
    agentBrowser.batch.run({ kind: "launch", dirIds: sel }).then(finishBatch, finishBatch);
  };

  agentBrowser.batchStopSelected = function() {
    var sel = selectedProfileIds();
    if (!sel.length) return;
    agentBrowser.batch.run({ kind: "stop", dirIds: sel }).then(finishBatch, finishBatch);
  };

  // R11 P2-1: in-flight guard for proxy assignment. The old forEach fired N
  // unbounded parallel writes with no mutual exclusion against batch
  // launch/stop or a second assign — batches interleaved and double-toasted.
  var assignInFlight = false;
  agentBrowser.batchAssignProxy = function() {
    var sel = selectedProfileIds();
    if (!sel.length) return;
    if (assignInFlight) {
      // R12 UX P2-2: assign has no cancel button (unlike launch/stop), so
      // "cancel it first" was a dead-end instruction. Say what is true.
      toast(t("batch.assign-busy", "Proxy assignment is already running — please wait for it to finish"), "info");
      return;
    }
    var proxyEl = document.getElementById("batch-assign-proxy");
    var proxyValue = proxyEl ? proxyEl.value : "";
    var mode = proxyValue ? "named" : "default";
    var proxyName = proxyValue || null;
    var total = sel.length, done = 0, errors = 0;
    assignInFlight = true;
    function finish() {
      if (done !== total) return;
      assignInFlight = false;
      if (errors) toast(t("toast.batch.assign-partial", "Assigned {ok}/{total} profiles ({failed} failed)").replace("{ok}", total - errors).replace("{total}", total).replace("{failed}", errors), "error");
      else toast(t("toast.batch.assign-ok", "Assigned the proxy to {n} profiles").replace("{n}", total), "success");
      loadProfiles();
    }
    // Bounded parallelism (4, matching the batch runner) instead of N-way fan-out.
    var queue = sel.slice();
    var workers = Math.min(4, queue.length);
    function next() {
      var dirId = queue.shift();
      if (!dirId) return;
      wcall("proxy.setProfile:" + dirId, function () { return api.proxy.setProfile(dirId, proxyName, mode); }).then(function (r) {
        done++;
        if (r && r.success === false) errors++;
        finish();
        next();
      }).catch(function () { done++; errors++; finish(); next(); });
    }
    for (var i = 0; i < workers; i++) next();
  };

  // R9 P1-3: trash browser — the 7-day recovery promise needs a visible
  // entry point, otherwise it is only reachable via the 12s undo toast.
  agentBrowser.showTrash = function () {
    var dlg = document.getElementById("dlg-trash");
    var listEl = document.getElementById("trash-list");
    if (!dlg || !listEl) return;
    clearTrashActionError();
    listEl.innerHTML = '<div class="loading">' + esc(t("trash.loading", "Loading trash…")) + '</div>';
    if (!dlg.open) dlg.showModal();
    agentBrowser.ipc.call("profile.trash-list", function () { return api.profile.trashList(); }, { kind: "list" })
      .then(function (r) {
        if (!r || !Array.isArray(r.entries)) throw new Error((r && r.error) || t("toast.failed", "Failed"));
        if (!r.success && !r.entries.length) throw new Error(r.error || t("toast.failed", "Failed"));
        renderTrashList(listEl, r.entries);
        if (!r.success) {
          // A partial expiry failure must remain visible without hiding the
          // affected entry or its manual recovery/purge action.
          listEl.insertAdjacentHTML("afterbegin", '<div role="alert" style="color:var(--danger-text);padding:8px 0;">' + esc(r.error || t("toast.failed", "Failed")) + '</div>');
        }
      })
      .catch(function (e) {
        listEl.innerHTML = '<div class="empty-state" role="alert">' + esc(e.message || String(e)) + '</div>';
      });
  };

  function renderTrashList(listEl, entries) {
    if (!entries.length) {
      listEl.innerHTML = '<div class="empty-state">' + esc(t("trash.empty", "Trash is empty — deleted profiles stay here for 7 days.")) + '</div>';
      return;
    }
    listEl.innerHTML = entries.map(function (en) {
      // S2-24: "deleted 2 d ago" answers the 7-day-window question at a
      // glance; the absolute stamp moves to the title.
      var absWhen = en.deletedAt ? new Date(en.deletedAt).toLocaleString() : "";
      var when = en.deletedAt ? (helpers.relTime ? helpers.relTime(en.deletedAt) : absWhen) : "?";
      var name = esc(en.name || (en.dirId || "").slice(0, 8));
      var id = escAttr(en.dirId || "");
      // R10 UX P1-1: every entry gets Restore + permanent Delete. Purge is
      // irreversible — the handler asks for an explicit ack first.
      var actions = '<button class="btn btn-danger btn-sm" data-trash-purge="' + id + '" data-trash-name="' + escAttr(en.name || en.dirId || "") + '">' + esc(t("trash.purge", "Delete forever")) + '</button>';
      var warningAttrs = 'class="trash-row-warning" role="alert"';
      var warning = "";
      if (en.recoveryRequired) {
        actions = "";
        warning = '<span ' + warningAttrs + '>' + esc(t("trash.recovery-required", "Recovery required — a live profile still uses this ID; resolve the conflict before deleting.")) + '</span>';
      } else if (en.incomplete || trashPurgeFailed[en.dirId]) {
        warning = '<span ' + warningAttrs + '>' + esc(t("trash.incomplete", "Data may be incomplete after a purge attempt; do not restore as complete.")) + '</span>';
      } else if (en.recoverable) {
        actions = '<button class="btn btn-primary btn-sm" data-trash-restore="' + id + '">' + esc(t("trash.restore", "Restore")) + '</button>' + actions;
        warning = '<span data-trash-warning="' + id + '" ' + warningAttrs + ' hidden>' + esc(t("trash.incomplete", "Data may be incomplete after a purge attempt; do not restore as complete.")) + '</span>';
      } else {
        warning = '<span ' + warningAttrs + '>' + esc(t("trash.unrecoverable", "data missing")) + '</span>';
      }
      // Warnings own a full line, including one revealed after a failed purge.
      // Keep action width separate from names so neither can paint over the other.
      return '<div class="trash-row"><div class="trash-row-identity"><div class="trash-row-name">' + name + '</div>' +
        '<div class="num trash-row-time" title="' + escAttr(absWhen) + '">' + esc(when) + '</div></div>' +
        (actions ? '<div class="trash-row-actions">' + actions + '</div>' : '') + warning + '</div>';
    }).join("");
    Object.keys(trashPending).forEach(applyTrashPending);
    // Wire restore buttons (re-rendered each open, so direct binding is fine).
    Array.prototype.forEach.call(listEl.querySelectorAll("[data-trash-restore]"), function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-trash-restore");
        if (trashPending[id] || trashPurgeFailed[id]) return;
        performTrashAction(id, "restore");
      });
    });
    Array.prototype.forEach.call(listEl.querySelectorAll("[data-trash-purge]"), function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-trash-purge");
        if (trashPending[id]) return;
        var nm = btn.getAttribute("data-trash-name") || id;
        // Reserve the ID before confirmation; confirmAsync also releases it on
        // Cancel/Esc and consumes the callback once, before starting the write.
        setTrashPending(id, true);
        agentBrowser.confirmAsync(
          t("trash.purge-confirm", "Permanently delete \"{name}\"? This cannot be undone.").replace("{name}", nm),
          { title: t("trash.purge-title", "Delete forever?") },
        ).then(function (confirmed) {
          if (confirmed) return performTrashAction(id, "purge");
        }).catch(function (e) {
          showTrashActionError("purge", id, e);
        }).finally(function () { setTrashPending(id, false); });
      });
    });
  }

  function setTrashPending(id, pending) {
    if (pending) trashPending[id] = true;
    else delete trashPending[id];
    applyTrashPending(id);
  }

  function applyTrashPending(id) {
    var listEl = document.getElementById("trash-list");
    if (!listEl) return;
    Array.prototype.forEach.call(listEl.querySelectorAll("[data-trash-restore], [data-trash-purge]"), function (btn) {
      var restoreId = btn.getAttribute("data-trash-restore");
      if ((restoreId || btn.getAttribute("data-trash-purge")) !== id) return;
      var disabled = trashPending[id] || (restoreId && trashPurgeFailed[id]);
      if (disabled) btn.setAttribute("disabled", "disabled");
      else btn.removeAttribute("disabled");
      btn.setAttribute("aria-busy", trashPending[id] ? "true" : "false");
    });
    Array.prototype.forEach.call(listEl.querySelectorAll("[data-trash-warning]"), function (warning) {
      if (warning.getAttribute("data-trash-warning") === id) warning.hidden = !trashPurgeFailed[id];
    });
  }

  function clearTrashActionError() {
    var errorEl = document.getElementById("trash-action-error");
    if (errorEl) errorEl.hidden = true;
  }

  function showTrashActionError(action, id, error) {
    if (action === "purge") trashPurgeFailed[id] = true;
    var errorEl = document.getElementById("trash-action-error");
    if (!errorEl) return;
    // Foreground inside the native dialog: do not send raw backend exceptions
    // through friendlyErrors or insert recovery paths as HTML.
    errorEl.querySelector(".trash-action-summary").textContent = action === "restore"
      ? t("toast.trash.restore-failed", "Could not restore profile")
      : t("toast.trash.purge-failed", "Could not permanently delete profile");
    var detailEl = errorEl.querySelector(".toast-detail");
    detailEl.textContent = trashFailureDetail(id, error);
    detailEl.scrollTop = 0;
    errorEl.hidden = false;
    errorEl.scrollIntoView({ block: "nearest" });
  }

  // Modal restore and both Undo entrypoints share the same per-ID reservation.
  // A blocked Undo is a per-ID failure, not a successful restore or a reason to
  // release a reservation owned by another operation.
  function restoreTrashProfile(id) {
    var blocked = trashPending[id]
      ? t("toast.card.busy", "This profile is busy — wait for the current operation to finish")
      : trashPurgeFailed[id]
        ? t("trash.incomplete", "Data may be incomplete after a purge attempt; do not restore as complete.")
        : null;
    if (blocked) return Promise.resolve({ success: false, error: blocked });
    setTrashPending(id, true);
    return agentBrowser.ipc.call("profile.trash-restore:" + id, function () { return api.profile.trashRestore(id); }, { kind: "write" })
      .finally(function () { setTrashPending(id, false); });
  }

  function performTrashAction(id, action) {
    var request = action === "restore" ? restoreTrashProfile(id)
      : agentBrowser.ipc.call("profile.trash-purge:" + id, function () { return api.profile.trashPurge(id); }, { kind: "write" });
    return request.then(function (r) {
      if (r && r.success) {
        delete trashPurgeFailed[id];
        toast(action === "restore" ? t("toast.trash.restore-ok", "Restored {n} profiles").replace("{n}", 1) : t("trash.purged", "Permanently deleted"), "success");
        loadProfiles();
        agentBrowser.showTrash();
      } else showTrashActionError(action, id, r && r.error);
    }).catch(function (e) { showTrashActionError(action, id, e); });
    // Never refresh on failure: trash-list also sweeps expired entries, and a
    // purge failure is not evidence that the directory bytes were rolled back.
  }

  function trashFailureDetail(id, error) {
    var reason = error && typeof error === "object" ? (error.error || error.message || String(error)) : error;
    return id + ": " + String(reason || t("toast.failed", "Failed"));
  }

  // PL-09: restores are serialised so two profiles never race for the same
  // directory while it is being moved back out of the trash.
  function restoreFromTrash(ids) {
    var pending = ids.slice();
    var restored = 0, failures = [];
    function next() {
      if (!pending.length) {
        if (failures.length) {
          toast(t("toast.trash.restore-partial", "Restored {ok}, {failed} could not be restored")
            .replace("{ok}", restored).replace("{failed}", failures.length), "error", { detail: failures.join("\n") });
        } else {
          toast(t("toast.trash.restore-ok", "Restored {n} profiles").replace("{n}", restored), "success");
        }
        if (restored) loadProfiles();
        return;
      }
      var id = pending.shift();
      restoreTrashProfile(id)
        .then(function (r) {
          if (r && r.success === true) restored++;
          else failures.push(trashFailureDetail(id, r && r.error));
        })
        .catch(function (e) { failures.push(trashFailureDetail(id, e)); })
        .then(next);
    }
    next();
  }

  function deleteProfilesWithTally(sel) {
    var total = sel.length, done = 0, failures = [], succeeded = [];
    sel.forEach(function (dirId) {
      // PL-09: soft-delete, so the toast can offer a real undo.
      agentBrowser.ipc.call("profile.trash:" + dirId, function () { return api.profile.trash(dirId); }, { kind: "write" })
        .then(function (r) {
          done++;
          if (r && r.success === true) succeeded.push(dirId);
          else failures.push(trashFailureDetail(dirId, r && r.error));
        })
        .catch(function (e) { done++; failures.push(trashFailureDetail(dirId, e)); })
        .then(function () {
          if (done !== total) return;
          succeeded.forEach(function (id) { delete profileSelection[id]; });
          updateBatchBar();
          if (failures.length) {
            toast(t("toast.batch.delete-partial", "Deleted {ok}/{total} profiles ({failed} failed)")
              .replace("{ok}", succeeded.length).replace("{total}", total).replace("{failed}", failures.length),
              "error", { detail: failures.join("\n") });
          } else {
            toast(t("toast.batch.delete-ok", "Deleted {n} profiles").replace("{n}", total), "success", {
              ttlMs: 12000,
              detail: t("toast.trash.hint", "Kept in the trash for 7 days."),
              action: { label: t("toast.undo", "Undo"), onClick: function () { restoreFromTrash(sel); } },
            });
          }
          loadProfiles();
        });
    });
  }

  function buildDeleteConfirm(sel, nameMap) {
    var names = sel.map(function(id) { return nameMap[id] || id.slice(0, 8); });
    // PL-09: list every profile. The old dialog capped the list at five names,
    // so confirming "delete 50" only ever showed five of them.
    // R9 P3-4: the old copy claimed "cannot be undone / permanently deleted"
    // but deletes are soft (trash + undo + 7-day recovery). Say what actually
    // happens: running profiles are refused by the backend and counted failed.
    var detail = '<div style="max-height:180px;overflow:auto;">' +
      names.map(function(n) { return "• " + esc(n); }).join("<br>") +
      '</div><div style="margin-top:8px;color: var(--danger-text);">' +
      esc(t("confirm.delete.warning", "Profiles move to the trash and stay recoverable for 7 days. Running profiles are skipped (stop them first).")) +
      "</div>";
    var opts = { title: t("confirm.delete.title", "Delete profiles"), detailHtml: detail };
    if (sel.length >= 10) {
      opts.ackLabel = t("confirm.delete.ack", "I understand that {n} profiles will be moved to the trash.").replace("{n}", sel.length);
    }
    agentBrowser.confirm(
      t("confirm.delete.msg", "Delete {n} selected profile(s)?").replace("{n}", sel.length),
      function () { deleteProfilesWithTally(sel); },
      opts,
    );
  }

  agentBrowser.batchDeleteSelected = function() {
    var sel = selectedProfileIds();
    if (!sel.length) return;
    api.profile.list().then(function(profiles) {
      var nameMap = {};
      (profiles || []).forEach(function(p) { nameMap[p.dirId] = p.name || p.dirId.slice(0, 8); });
      buildDeleteConfirm(sel, nameMap);
    }).catch(function() {
      buildDeleteConfirm(sel, {});
    });
  };

  agentBrowser.batchExportSelected = function() {
    var sel = selectedProfileIds();
    if (!sel.length) return Promise.resolve();
    return archiveCall("profile.exportArchives:" + sel.slice().sort().join(","), function () { return api.profile.exportArchives(sel); }, function(r) {
      if (archiveWasCancelled(r)) return r;
      if (!r || !r.report) {
        toast(t("toast.profile.export-failed", "Export failed: ") + ((r && r.error) || "unknown"), "error");
        return r;
      }
      var rep = r.report;
      var exported = (rep.exported || []).length;
      var skipped = (rep.skipped || []).length;
      var stopRequired = (rep.skipped || []).filter(function(item) { return item && (item.reason === "running" || item.reason === "running-or-unconfirmed" || item.code === "PROFILE_STOP_REQUIRED"); }).length;
      var failed = (rep.failed || []).length;
      var warnings = (rep.exported || []).reduce(function(n, item) { return n + ((item.warnings || []).length); }, 0);
      var msg = t("toast.profile.exported-batch", "Exported {n} profiles").replace("{n}", exported);
      if (skipped) msg += t("toast.batch.export-skipped", ", skipped {n}").replace("{n}", skipped);
      if (stopRequired) msg += " " + t("archive.stop-required", "Explicitly stop {n} running or unconfirmed profile(s) and wait for browser exit before exporting again. No automatic stop was requested.").replace("{n}", stopRequired);
      if (failed) msg += t("toast.batch.export-failed", ", {n} failed").replace("{n}", failed);
      if (warnings) msg += t("archive.batch.warning-count", ", {n} warnings").replace("{n}", warnings);
      toast(msg, exported === 0 && failed > 0 ? "error" : (skipped || failed || warnings || exported === 0 ? "warning" : "success"));
      return r;
    }, function(e) {
      toast(t("toast.profile.export-failed", "Export failed: ") + (e.message || String(e)), "error");
      return { success: false, error: e.message || String(e), code: e.code };
    });
  };

  // ── Fingerprint / environment checks (review items PL-03, TE-04, TE-09) ──
  //
  // Three problems used to live in these entry points:
  //  1. a "check" silently started a stopped profile (PL-03);
  //  2. the check posted the profile fingerprint to a third party with no
  //     consent and no local fallback (TE-04);
  //  3. clicking repeatedly fired overlapping checks (TE-09).
  var EXTERNAL_CONSENT_KEY = "agent-browser-external-risk-check-consent";

  // Main-process history is authoritative. This local key is only a display
  // cache; older summaries contain no positive evidence and never earn PASS.
  var HEALTH_HISTORY_KEY = "agent-browser-health-history-v1";
  var HEALTH_HISTORY_LIMIT = 5;
  var healthHistoryByProfile = Object.create(null);
  var healthReadSeq = Object.create(null);
  var healthEpoch = Object.create(null);
  var healthHistoryViewSeq = 0;
  var HEALTH_OUTCOMES = ["pass", "warn", "risk", "error", "unavailable", "inconclusive", "cancelled", "baseline-established"];

  var CACHEABLE_HEALTH_KINDS = ["env", "webrtc", "drift", "consistency"];
  function projectHealthDisplayCache(value) {
    var projected = Object.create(null);
    if (!value || typeof value !== "object" || Array.isArray(value)) return projected;
    Object.keys(value).forEach(function (dirId) {
      if (!Array.isArray(value[dirId])) return;
      projected[dirId] = value[dirId].filter(function (entry) {
        return entry && typeof entry === "object" && !Array.isArray(entry) && CACHEABLE_HEALTH_KINDS.indexOf(entry.kind) !== -1;
      }).map(function (entry) {
        // This is the OLD display-cache schema, not canonical health history.
        // In particular, an unrelated check/clear must not reserialize network
        // entries or a networkSummary/hop sidecar left in an older cache.
        var legacy = { kind: entry.kind };
        if (typeof entry.at === "number" && Number.isFinite(entry.at)) legacy.at = entry.at;
        ["outcome", "verdict", "detail", "summary", "requestId", "source"].forEach(function (key) {
          if (typeof entry[key] === "string") legacy[key] = entry[key];
        });
        return legacy;
      });
    });
    return projected;
  }
  function readHealthHistory() {
    try {
      return projectHealthDisplayCache(JSON.parse(localStorage.getItem(HEALTH_HISTORY_KEY) || "{}"));
    } catch (e) { return Object.create(null); }
  }
  function knownHealthOutcome(value) { return HEALTH_OUTCOMES.indexOf(value) !== -1; }
  function healthEntryOutcome(entry) {
    if (!entry) return "inconclusive";
    var outcome = knownHealthOutcome(entry.outcome) ? entry.outcome : "inconclusive";
    if (outcome === "pass" && (entry.source === "legacy" || entry.kind === "consistency" || entry.kind === "network" || entry.unverified)) return "inconclusive";
    return outcome;
  }
  function cachedHealthEntries(dirId) {
    var value = readHealthHistory()[dirId];
    return Array.isArray(value) ? value.filter(function (en) { return en && typeof en === "object"; }).map(function (en) {
      // Preserve the stored original, including old detail, but not its authority.
      return Object.assign({}, en, { outcome: "inconclusive", source: "legacy", unverified: true });
    }) : [];
  }
  function healthEntriesFor(dirId) {
    var snapshot = healthHistoryByProfile[dirId];
    var list = snapshot && snapshot.entries && snapshot.entries.length ? snapshot.entries : cachedHealthEntries(dirId);
    return list.slice().sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
  }
  function recordHealthResult(dirId, kind, summary, requestId) {
    if (!dirId || !summary || CACHEABLE_HEALTH_KINDS.indexOf(kind) === -1) return;
    var outcome = knownHealthOutcome(summary.outcome || summary.verdict) ? (summary.outcome || summary.verdict) : "inconclusive";
    var entry = { kind: kind, at: Date.now(), outcome: outcome, verdict: outcome, detail: summary.detail || "", summary: summary.detail || "", requestId: requestId, source: "cached" };
    var all = readHealthHistory();
    var list = Array.isArray(all[dirId]) ? all[dirId].filter(function (en) { return en && en.kind !== kind; }) : [];
    list.push(entry);
    list.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    all[dirId] = list.slice(0, HEALTH_HISTORY_LIMIT);
    try { localStorage.setItem(HEALTH_HISTORY_KEY, JSON.stringify(projectHealthDisplayCache(all))); }
    catch (e) { console.warn("Health display cache could not be saved", e); }
    // A just-returned main result can be shown while its authoritative history
    // is queried. History read failures retain it as unverified, not empty.
    var current = healthHistoryByProfile[dirId];
    healthHistoryByProfile[dirId] = { entries: [entry].concat(current ? current.entries.filter(function (en) { return en.kind !== kind; }) : []), pending: true };
    healthReadSeq[dirId] = (healthReadSeq[dirId] || 0) + 1;
    updateHealthCard(dirId);
    refreshHealthSummary(dirId).catch(function () { /* The retained summary is marked unverified by the reader. */ });
  }
  function removeCachedHealthKind(dirId, kind) {
    var all = readHealthHistory();
    if (!Array.isArray(all[dirId])) return;
    all[dirId] = all[dirId].filter(function (en) { return en && en.kind !== kind; });
    try { localStorage.setItem(HEALTH_HISTORY_KEY, JSON.stringify(projectHealthDisplayCache(all))); }
    catch (e) { console.warn("Cleared health display cache could not be saved", e); }
  }
  function queryHealthHistory(dirId, networkRead) {
    return lcall("browser.healthHistory:" + dirId, function () {
      if (typeof api.browser.healthHistory !== "function") throw new Error(t("health.history-unavailable", "Authoritative health history is unavailable; cached results are not verified."));
      return networkRead ? networkSafeInvoke(function () { return api.browser.healthHistory(dirId); }, "health.history-unavailable") : api.browser.healthHistory(dirId);
    }).then(function (h) {
      if (!h || h.ok === false || h.success === false || !Array.isArray(h.entries) || h.entries.some(function (en) {
        if (!en || !knownHealthOutcome(en.outcome) || typeof en.at !== "number" || !Number.isFinite(en.at)) return true;
        if (en.kind === "network") return en.source !== "runtime" || en.summary !== NETWORK_SUMMARY_CODE || en.outcome === "pass" || en.outcome === "baseline-established" || !projectNetworkSummary(en.networkSummary);
        return CACHEABLE_HEALTH_KINDS.indexOf(en.kind) === -1 || ["runtime", "host", "baseline", "cached", "legacy"].indexOf(en.source) === -1;
      })) throw new Error(!networkRead && h && h.error || t("health.history-unavailable", "Authoritative health history is unavailable; cached results are not verified."));
      return h.entries.map(function (entry) {
        if (entry.kind !== "network") return entry;
        // Only the canonical typed summary may enter history memory. Do not
        // reuse raw summary/detail strings or any origin/detail sidecar.
        return { kind: "network", at: entry.at, outcome: entry.outcome, summary: NETWORK_SUMMARY_CODE,
          requestId: typeof entry.requestId === "string" ? entry.requestId : undefined, source: "runtime", networkSummary: projectNetworkSummary(entry.networkSummary) };
      });
    });
  }
  function refreshHealthSummary(dirId, networkRead) {
    var seq = healthReadSeq[dirId] = (healthReadSeq[dirId] || 0) + 1;
    return queryHealthHistory(dirId, networkRead).then(function (entries) {
      if (seq !== healthReadSeq[dirId]) return null;
      var previous = healthHistoryByProfile[dirId];
      var unpersisted = previous ? previous.entries.filter(function (en) {
        return en.source === "cached" && !entries.some(function (stored) {
          return stored.kind === en.kind && (stored.requestId && stored.requestId === en.requestId || stored.at >= en.at);
        });
      }).map(function (en) { return Object.assign({}, en, { unverified: true }); }) : [];
      healthHistoryByProfile[dirId] = { entries: entries.concat(unpersisted) };
      updateHealthCard(dirId);
      return entries;
    }).catch(function (error) {
      if (seq === healthReadSeq[dirId]) {
        var previous = healthHistoryByProfile[dirId];
        var entries = previous ? previous.entries : cachedHealthEntries(dirId);
        healthHistoryByProfile[dirId] = { entries: entries.map(function (en) { return Object.assign({}, en, { unverified: true }); }), error: error.message || String(error) };
        updateHealthCard(dirId);
      }
      throw error;
    });
  }
  function lastHealthFor(dirId) {
    var list = healthEntriesFor(dirId);
    return list.length ? list[0] : null;
  }
  function relativeTime(ts) {
    if (typeof ts !== "number" || !Number.isFinite(ts)) return t("common.unknown", "Unknown");
    var diff = Date.now() - ts;
    if (diff < 60000) return t("profile.health.just-now", "just now");
    var mins = Math.floor(diff / 60000);
    if (mins < 60) return t("profile.health.minutes-ago", "{n}m ago").replace("{n}", mins);
    var hours = Math.floor(mins / 60);
    if (hours < 24) return t("profile.health.hours-ago", "{n}h ago").replace("{n}", hours);
    return t("profile.health.days-ago", "{n}d ago").replace("{n}", Math.floor(hours / 24));
  }
  function healthVerdict(entry) {
    var outcome = healthEntryOutcome(entry);
    var colors = { pass: "var(--success-text)", risk: "var(--danger-text)", error: "var(--danger-text)", warn: "var(--warning-text)" };
    var labels = { pass: "Pass", risk: "Risk", warn: "Watch", error: "Error", unavailable: "Unavailable", inconclusive: "Not verified", cancelled: "Cancelled", "baseline-established": "Baseline established" };
    return { outcome: outcome, label: t("health.outcome." + outcome, labels[outcome]), color: colors[outcome] || "var(--text-muted)", icon: outcome === "pass" ? "check" : outcome === "risk" || outcome === "warn" || outcome === "error" ? "alert" : "info" };
  }
  function healthBadgeHtml(entry) {
    var verdict = healthVerdict(entry);
    return '<span class="status-badge" data-health-outcome="' + verdict.outcome + '" style="color:' + verdict.color + ';">' + icon(verdict.icon, 12) + ' ' + esc(verdict.label) + '</span>';
  }
  function healthEntryDetail(entry) {
    return entry && entry.kind === "network" ? networkSummaryText(entry.networkSummary) : entry && (entry.summary || entry.detail) || "";
  }
  function healthSummaryHtml(last) {
    if (!last) return esc(t("profile.health.never", "Not checked yet"));
    var verdict = healthVerdict(last);
    return esc(t("profile.health.last", "Last check: {when}").replace("{when}", relativeTime(last.at))) +
      ' · <b style="color:' + verdict.color + ';">' + esc(verdict.label) + '</b>';
  }
  function updateHealthCard(dirId) {
    var el = document.querySelector('#profile-list .profile-card[data-dir-id="' + String(dirId).replace(/"/g, "") + '"] .health-verdict');
    if (!el) return;
    var last = lastHealthFor(dirId);
    var snapshot = healthHistoryByProfile[dirId];
    el.innerHTML = !last && snapshot && snapshot.error ? esc(t("health.outcome.inconclusive", "Not verified")) : healthSummaryHtml(last);
    el.setAttribute("data-health-outcome", last ? healthEntryOutcome(last) : "inconclusive");
    el.setAttribute("title", snapshot && snapshot.error || healthEntryDetail(last));
  }
  function showHealthHistory(dirId) {
    var viewSeq = ++healthHistoryViewSeq;
    refreshHealthSummary(dirId).then(function (list) {
      if (viewSeq !== healthHistoryViewSeq || !list) return;
      if (!list.length) list = healthEntriesFor(dirId).slice().reverse();
      if (!list.length) { toast(t("profile.health.no-history", "No health checks recorded for this profile yet"), "info"); return; }
      var rows = list.slice().reverse().map(function (entry) {
        return '<div style="display:flex;gap:8px;align-items:baseline;border-bottom:1px solid var(--border);padding:5px 0;">' +
          '<b style="min-width:110px;">' + esc(t("profile.health.kind." + entry.kind, entry.kind)) + '</b>' +
          '<span style="min-width:82px;color:var(--text-muted);">' + esc(relativeTime(entry.at)) + '</span>' + healthBadgeHtml(entry) +
          '<span style="min-width:0;color:var(--text-muted);word-break:break-word;">' + (entry.kind === "network" ? networkSummaryHtml(entry.networkSummary) : esc(healthEntryDetail(entry))) + '</span></div>';
      }).join("");
      agentBrowser.confirmHtml(esc(t("profile.health.history-title", "Health check history")), function () {}, {
        title: esc(t("profile.health.history-heading", "Recent checks")), detailHtml: '<div style="font-size:12px;">' + rows + '</div>',
      });
    }).catch(function (error) { if (viewSeq === healthHistoryViewSeq) toast(error.message || String(error), "error"); });
  }
  function lastHealthHtml(dirId) {
    var last = lastHealthFor(dirId);
    return '<span class="health-verdict" data-health-outcome="' + (last ? healthEntryOutcome(last) : "inconclusive") + '" style="font-size:11px;color:var(--text-muted);" title="' + escAttr(healthEntryDetail(last)) + '">' + healthSummaryHtml(last) + '</span>';
  }
  function summarizeEnvRisk(r) {
    var res = r && r.result;
    var outcome = r && knownHealthOutcome(r.outcome) ? r.outcome : "inconclusive";
    if (!r || !r.ok && (!knownHealthOutcome(r.outcome) || r.outcome === "pass")) outcome = "error";
    else if (outcome === "pass" || !knownHealthOutcome(r.outcome)) {
      if (!res || !Array.isArray(res.findings)) outcome = "inconclusive";
      else if (res.findings.some(function (f) { return f.severity === "high"; })) outcome = "risk";
      else if (res.findings.some(function (f) { return f.severity === "medium"; }) && outcome === "pass") outcome = "warn";
    }
    return { outcome: outcome, detail: r && r.error || res && res.summary || t("health.scope.host", "Host-environment observations only; not a complete profile fingerprint verdict.") };
  }
  function summarizeWebRtc(r) {
    var res = r && r.result;
    var outcome = r && knownHealthOutcome(r.outcome) ? r.outcome : "inconclusive";
    if (!r || !r.ok && (!knownHealthOutcome(r.outcome) || r.outcome === "pass")) outcome = "error";
    else if (outcome === "pass" || !knownHealthOutcome(r.outcome)) {
      if (!res) outcome = "inconclusive";
      else if (Array.isArray(res.hostIps) && res.hostIps.length) outcome = "risk";
      else if (res.error) outcome = "error";
      else if (res.rtcAvailable === false) outcome = "unavailable";
      else if (res.rtcAvailable !== true || !Array.isArray(res.hostIps) || !Array.isArray(res.candidates)) outcome = "inconclusive";
    }
    return { outcome: outcome, detail: r && r.error || res && (res.error || res.summary) || t("health.scope.rtc", "This diagnostic only reports the observed WebRTC probe; it is not an external-site score.") };
  }

  var DETECT_GLOBAL_MAX = 2;
  var detectInFlight = {};
  var detectGlobalCount = 0;

  function hasExternalRiskConsent() {
    try { return localStorage.getItem(EXTERNAL_CONSENT_KEY) === "1"; } catch (e) { return false; }
  }

  function grantExternalRiskConsent() {
    try { localStorage.setItem(EXTERNAL_CONSENT_KEY, "1"); } catch (e) { /* storage disabled */ }
  }

  /** Serialise per profile and cap global concurrency (TE-09). */
  function acquireDetectSlot(dirId) {
    if (detectInFlight[dirId]) {
      toast(t("toast.detect.busy", "A check is already running for this profile"), "info");
      return false;
    }
    if (detectGlobalCount >= DETECT_GLOBAL_MAX) {
      toast(t("toast.detect.global-busy", "Too many checks running — wait for one to finish"), "info");
      return false;
    }
    detectInFlight[dirId] = true;
    detectGlobalCount++;
    return true;
  }

  function releaseDetectSlot(dirId, request) {
    if (!detectInFlight[dirId] || request && detectInFlight[dirId] !== request) return;
    delete detectInFlight[dirId];
    detectGlobalCount = Math.max(0, detectGlobalCount - 1);
  }

  var healthDialogs = { env: { seq: 0, dirId: null, request: null }, webrtc: { seq: 0, dirId: null, request: null },
    network: { seq: 0, dirId: null, request: null, pageSeq: 0, pages: [], selection: null, origin: "", phase: "idle", loading: false, latestResult: null, notice: null } };
  function healthEpochKey(dirId, kind) { return dirId + ":" + kind; }
  function invalidateHealthKind(dirId, kind) {
    var key = healthEpochKey(dirId, kind);
    healthEpoch[key] = (healthEpoch[key] || 0) + 1;
    healthReadSeq[dirId] = (healthReadSeq[dirId] || 0) + 1;
    healthHistoryViewSeq++;
  }
  function beginHealthRequest(dirId, kind) {
    if (healthClearInFlight[dirId]) { toast(t("toast.detect.busy", "A check is already running for this profile"), "info"); return null; }
    if (!acquireDetectSlot(dirId)) return null;
    invalidateHealthKind(dirId, kind);
    var request = { dirId: dirId, kind: kind, requestId: "health-" + kind + "-" + agentBrowser.ipc.newTraceId(), epoch: healthEpoch[healthEpochKey(dirId, kind)] || 0, settled: false };
    detectInFlight[dirId] = request;
    return request;
  }
  function healthRequestCurrent(request) {
    if (!request || request.discarded || request.epoch !== (healthEpoch[healthEpochKey(request.dirId, request.kind)] || 0)) return false;
    if (request.fingerprintViewEpoch !== undefined && !agentBrowser.isFingerprintViewCurrent(request.fingerprintViewEpoch, request.dirId)) return false;
    if (!request.view) return true;
    var view = healthDialogs[request.kind];
    var dlg = document.getElementById(request.kind === "network" ? "dlg-network-observation" : request.kind === "env" ? "dlg-env-risk" : "dlg-webrtc-diag");
    return view.seq === request.view && view.dirId === request.dirId && !!(dlg && dlg.open);
  }
  function healthResponseCurrent(request, result) {
    if (request.kind === "network") return healthRequestCurrent(request) && !!result && result.requestId === request.requestId;
    // Env/RTC keep their established compatibility contract. Network requires
    // the caller's exact ID even if an otherwise plausible reply omits it.
    var callerOwnsId = request.kind === "env" || request.kind === "webrtc";
    return healthRequestCurrent(request) && (!callerOwnsId || !result || !result.requestId || result.requestId === request.requestId);
  }
  function healthCall(key, fn, request) {
    // Health work has a main-process cancellation contract. A renderer timer
    // cannot stop it or free its slot. Ordinary IPC timeout budgets stay intact.
    return agentBrowser.ipc.call(key + ":" + request.dirId + ":" + request.requestId, fn, {
      kind: "detect", timeoutMs: 0, traceId: request.requestId, slowNoticeMs: 20000,
      onSlow: function () {
        if (healthRequestCurrent(request)) toast(t("health.waiting", "Still waiting for the check. Work may continue in the background; closing this dialog does not stop it."), "warning");
      },
    });
  }
  function finishHealthRequest(request) {
    request.settled = true;
    releaseDetectSlot(request.dirId, request);
    var view = healthDialogs[request.kind];
    if (view && view.request === request) {
      view.request = null;
      if (request.kind === "network") updateNetworkControls();
      else updateHealthCancelButton(request.kind);
    }
  }
  function updateHealthCancelButton(kind) {
    var button = document.getElementById(kind === "env" ? "env-risk-cancel" : "webrtc-diag-cancel");
    var request = healthDialogs[kind].request;
    if (button) button.disabled = !request || request.settled || request.cancelPending || request.cancelRequested;
  }
  function openHealthDialog(kind, dirId, request) {
    var view = healthDialogs[kind];
    view.seq++;
    view.dirId = dirId;
    view.request = request;
    view.latestResult = null;
    view.historyEntries = null;
    request.view = view.seq;
    var dlg = document.getElementById(kind === "env" ? "dlg-env-risk" : "dlg-webrtc-diag");
    if (!dlg._healthLifecycleBound) {
      dlg._healthLifecycleBound = true;
      function invalidateView() {
        view.seq++;
        view.dirId = null;
        view.request = null;
        healthHistoryViewSeq++;
        if (kind === "env") currentEnvRiskDirId = null;
        else window.__webrtcDiagDirId = null;
        updateHealthCancelButton(kind);
      }
      dlg.addEventListener("cancel", invalidateView);
      dlg.addEventListener("close", function () { if (!dlg.open) invalidateView(); });
    }
    if (kind === "env") currentEnvRiskDirId = dirId;
    else window.__webrtcDiagDirId = dirId;
    if (!dlg.open) dlg.showModal();
    updateHealthCancelButton(kind);
  }
  function cancelHealthDialog(kind) {
    var view = healthDialogs[kind], request = view.request;
    if (!request || request.settled || request.cancelPending || request.cancelRequested) return;
    request.cancelPending = true;
    updateHealthCancelButton(kind);
    lcall("browser.healthCancel:" + request.requestId, function () {
      return api.browser.healthCancel(request.dirId, { kind: kind, requestId: request.requestId });
    }).then(function (r) {
      if (!healthRequestCurrent(request) || request.settled) return;
      request.cancelRequested = !!(r && r.success && r.cancelled);
      toast(request.cancelRequested
        ? t("health.cancel-requested", "Cancellation requested. Waiting for the check to settle; the browser is not stopped.")
        : t("health.cancel-not-confirmed", "Cancellation was not confirmed. The check may still be running."), "warning");
    }).catch(function (e) { if (healthRequestCurrent(request) && !request.settled) toast(t("health.cancel-not-confirmed", "Cancellation was not confirmed. The check may still be running.") + " " + (e.message || String(e)), "error");
    }).then(function () { request.cancelPending = false; updateHealthCancelButton(kind); });
  }
  agentBrowser.cancelEnvRisk = function () { cancelHealthDialog("env"); };
  agentBrowser.cancelWebRtcDiag = function () { cancelHealthDialog("webrtc"); };

  function askExternalConsent(dirId, onGranted) {
    var detail = '<div style="font-size:12px;line-height:1.6;">' +
      esc(t("risk.external.body", "This check opens an external site inside the profile. That site will receive this profile's fingerprint and its proxy exit IP.")) +
      '</div><ul style="font-size:11.5px;color:var(--text-muted);margin:8px 0 0 18px;padding:0;">' +
      "<li>" + esc(t("risk.external.item1", "Browser fingerprint (canvas / WebGL / fonts / screen)")) + "</li>" +
      "<li>" + esc(t("risk.external.item2", "User agent and platform strings")) + "</li>" +
      "<li>" + esc(t("risk.external.item3", "Proxy exit IP and geolocation")) + "</li>" +
      "</ul>";
    agentBrowser.confirmHtml(
      esc(t("risk.external.title", "Send this profile's fingerprint to an external site?")),
      function () {
        grantExternalRiskConsent();
        if (typeof onGranted === "function") onGranted();
        else agentBrowser.openRiskCheck(dirId);
      },
      { title: esc(t("risk.external.heading", "External risk check")), detailHtml: detail },
    );
  }

  // R8 P2-5: shared external-consent gateway. The wizard used to call
  // api.browser.openRiskCheck directly, bypassing the consent dialog —
  // every entry point to an external check must go through here.
  agentBrowser.ensureExternalRiskConsent = function (dirId, onGranted) {
    if (hasExternalRiskConsent()) {
      if (typeof onGranted === "function") onGranted();
      return true;
    }
    askExternalConsent(dirId, onGranted);
    return false;
  };

  function confirmLaunchForCheck(dirId) {
    agentBrowser.confirm(
      t("risk.launch.msg", "This check needs a running browser. Start the profile now?"),
      function () { runRiskCheck(dirId, true); },
      {
        title: t("risk.launch.title", "Start profile for check"),
        detailHtml: '<div style="font-size:12px;">' +
          esc(t("risk.launch.body", "The profile will be started and left running after the check.")) + "</div>",
      },
    );
  }

  function runRiskCheck(dirId, allowLaunch) {
    var request = beginHealthRequest(dirId, "risk");
    if (!request) return;
    toast(allowLaunch ? t("toast.fp.launching", "Starting profile and opening risk check…") : t("toast.fp.opening", "Opening risk check…"), "info");
    healthCall("browser.openRiskCheck", function () {
      return api.browser.openRiskCheck(dirId, { allowLaunch: !!allowLaunch });
    }, request).then(function (r) {
      finishHealthRequest(request);
      if (r && r.success) {
        toast(t("toast.fp.opened", "Opened risk check in profile"), "success");
        if (allowLaunch) scheduleProfilesRefresh();
        return;
      }
      if (r && r.code === "PROFILE_NOT_RUNNING") {
        confirmLaunchForCheck(dirId);
        return;
      }
      // Sale-90/92: gated launch inside open-risk-check opens the paywall.
      if (r && typeof agentBrowser.interceptLicenseGate === "function" && agentBrowser.interceptLicenseGate(r)) return;
      toast((r && r.error) || t("toast.fp.nav-failed", "Failed to navigate to risk check"), "error");
    }).catch(function (e) {
      finishHealthRequest(request);
      toast(e && e.message ? e.message : String(e), "error");
    });
  }

  agentBrowser.openRiskCheck = function(dirId) {
    // Consent first (TE-04): nothing leaves the machine until the user agrees.
    if (!hasExternalRiskConsent()) { askExternalConsent(dirId); return; }
    openRiskCheckAfterConsent(dirId);
  };

  function openRiskCheckAfterConsent(dirId) {
    api.browser.status(dirId).then(function(s) {
      if (s && s.running) { runRiskCheck(dirId, false); return; }
      confirmLaunchForCheck(dirId);
    }).catch(function(e) { toast(e.message || String(e), "error"); });
  }

  // ── Engine banner (review item PL-07) ──
  // Without this, a missing Chromium build only showed up as a launch failure
  // plus a small red dot in the sidebar; new users had no in-app recovery path.
  // R8 P2-3: the banner state is also cached so launch()/bulkStart can refuse
  // early with guidance instead of firing a doomed IPC and toasting afterwards.
  var lastEngineInfo = null;
  function renderEngineBanner(info, probeFailed, pending) {
    lastEngineInfo = info || null;
    var el = document.getElementById("engine-banner");
    if (!el) return;
    var className = "engine-banner";
    var html;
    if (pending) {
      html = icon("browser", 13) + " " + esc(t("common.loading", "Loading…"));
    // R169: a failed probe is unknown, not evidence of a missing engine.
    } else if (probeFailed) {
      html = icon("alert", 13) + ' <span style="flex:1;">' +
        esc(t("engine.unknown", "Could not determine the managed Chromium status — check the log or retry.")) +
        '</span>' +
        '<button class="btn btn-primary btn-sm" data-role="cmd" data-cmd="loadProfiles">' +
          esc(t("common.retry", "Retry")) + "</button>";
    } else if (info && info.installed) {
      className += " ok";
      html = icon("browser", 13) + " " + esc(t("engine.ok", "Managed Chromium {v}").replace("{v}", info.version || "?"));
    } else {
      html = icon("alert", 13) + ' <span style="flex:1;">' +
        esc(t("engine.missing", "No managed Chromium installed — profiles cannot start until you point at a local build.")) +
        '</span>' +
        '<button class="btn btn-primary btn-sm" data-role="cmd" data-cmd="selectChromiumBinary">' +
          esc(t("engine.select", "Select local build…")) + "</button> " +
        '<button class="btn btn-secondary btn-sm" data-role="cmd" data-cmd="showEngineGuide">' +
          esc(t("engine.guide", "Install guide")) + "</button>";
    }
    var signature = className + "|" + html;
    if (el._engineBannerSignature !== signature) {
      el.className = className;
      el.innerHTML = html;
      el._engineBannerSignature = signature;
    }
    el.setAttribute("aria-busy", pending ? "true" : "false");
    el.style.display = "";
  }

  agentBrowser.selectChromiumBinary = function() {
    api.browser.selectBinary().then(function (r) {
      if (r && r.success) {
        toast(t("engine.selected", "Chromium configured"), "success");
        updateBrowserStatus();
        agentBrowser.loadProfiles();
        return;
      }
      if (r && !r.cancelled) toast(r.error || t("engine.select-failed", "Could not configure that binary"), "error");
    }).catch(function (e) { toast(e.message || String(e), "error"); });
  };

  agentBrowser.showEngineGuide = function() {
    agentBrowser.confirmHtml(
      esc(t("engine.guide.title", "Install the independent Chromium build")),
      function () { /* informational only */ },
      {
        title: esc(t("engine.guide.heading", "Install guide")),
        detailHtml: '<div style="font-size:12px;line-height:1.6;">' +
          esc(t("engine.guide.body", "Build Chromium with the maintained patch set (see the required version under patches/), verify it, then install it into the local engine cache:")) +
          '</div><pre style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:11px;overflow:auto;margin:8px 0 0;">' +
          esc("npm run verify:chromium -- /path/to/Chromium.app\nnpm run install:chromium -- /path/to/Chromium.app") +
          "</pre>",
      },
    );
  };

  agentBrowser.addNote = function(dirId) {
    api.browser.list().then(function(profiles) {
      var p = (profiles || []).find(function(x) { return x.dirId === dirId; });
      var note = (p && p.note) || "";
      document.getElementById("note-dir-id").value = dirId;
      document.getElementById("note-text").value = note;
      document.getElementById("dlg-note").showModal();
    });
  };

  agentBrowser.saveNote = function() {
    var dirId = document.getElementById("note-dir-id").value;
    var note = document.getElementById("note-text").value.trim();
    document.getElementById("dlg-note").close();
    wcall("browser.setMeta", function () { return api.browser.setMeta(dirId, { note: note }); }).then(function(r) {
      if (r.success) { toast((window.i18n ? window.i18n.t("toast.note.saved", "Note saved") : "Note saved"), "success"); agentBrowser.refresh(); }
      else toast((window.i18n ? window.i18n.t("toast.note.save-failed", "Failed to save note") : "Failed to save note"), "error");
    });
  };
  agentBrowser.saveBrowserMeta = function() {
    var dirId = document.getElementById("agent-browser-meta-dir-id").value;
    var name = document.getElementById("agent-browser-meta-name").value.trim();
    var isFirefox = document.getElementById("agent-browser-meta-engine").value === "firefox";
    var seed = Number(document.getElementById("agent-browser-meta-seed").value);
    if (!Number.isInteger(seed) || seed < 1 || seed > 999999) { toast(t("toast.invalid-seed", "Invalid seed"), "error"); return; }
    if (!name) { toast(t("toast.name-required", "Name required"), "error"); return; }
    var proxySelection = parseProxySelection(document.getElementById("agent-browser-meta-proxy").value, "none");
    var meta = {
      name: name,
      fingerprintMode: document.getElementById("agent-browser-meta-fingerprint-mode").value || "managed",
      fingerprintSeed: seed,
      platform: document.getElementById("agent-browser-meta-platform").value,
      timezone: document.getElementById("agent-browser-meta-timezone").value || null,
      locale: document.getElementById("agent-browser-meta-locale").value || null,
      proxyMode: proxySelection.mode,
      proxyName: proxySelection.name,
    };
    if (!isFirefox) {
      var metaErrors = validateHardwareFields("agent-browser-meta-");
      if (metaErrors.length) {
        clearFieldErrors("agent-browser-meta-");
        showFieldErrors(metaErrors);
        toast(t("toast.form.invalid", "Please fix the highlighted fields"), "error");
        return;
      }
      var webrtcMode = document.getElementById("agent-browser-meta-webrtc-mode").value || "auto";
      try {
        Object.assign(meta, readHardwareFields("agent-browser-meta-"), readGeolocationFields("agent-browser-meta-"), {
          browserVersion: document.getElementById("agent-browser-meta-browser-version").value || null,
          allowThirdPartyCookies: document.getElementById("agent-browser-meta-allow-third-party-cookies").checked,
          drm: document.getElementById("agent-browser-meta-drm").checked,
          webrtcMode: webrtcMode,
          webrtcIp: webrtcMode === "real" || webrtcMode === "disable" ? null : document.getElementById("agent-browser-meta-webrtc").value.trim() || null,
          renderScaleMode: document.getElementById("agent-browser-meta-render-scale-mode").value === "strict" ? "strict" : "native",
          appUrl: document.getElementById("agent-browser-meta-app-url").value.trim() || null,
          windowTitlePrefix: document.getElementById("agent-browser-meta-window-title-enabled").checked ? document.getElementById("agent-browser-meta-window-title-prefix").value.trim() || "" : null,
        });
      } catch (e) { toast(e.message || String(e), "error"); return; }
    }
    // Firefox's existing version pin and other explicit identity metadata are
    // deliberately omitted from this patch, not cleared by hidden controls.
    document.getElementById("dlg-agent-browser-seed").close();
    var promises = [];
    promises.push(wcall("browser.setMeta", function () { return api.browser.setMeta(dirId, meta); }));
    Promise.all(promises).then(function(r) {
      if (r[0] && r[0].success) { toast((window.i18n ? window.i18n.t("toast.profile.saved", "Profile saved") : "Profile saved"), "success"); loadProfiles(); }
      else toast(profileErrorMessage((r[0] && r[0].error) || (window.i18n ? window.i18n.t("toast.save-failed", "Failed to save") : "Failed to save")), "error");
    }).catch(function (e) { toast(profileErrorMessage(e) || (window.i18n ? window.i18n.t("toast.save-failed", "Failed to save") : "Failed to save"), "error"); });
  };

  // ══════ Profiles ══════
  var profileEditSeq = 0;
  var profileEditBaseline = null;

  function bindProfileEditLifecycle(dialog) {
    if (!dialog || dialog._profileEditBound) return;
    dialog._profileEditBound = true;
    function invalidateEdit() {
      ++profileEditSeq;
      profileEditBaseline = null;
    }
    dialog.addEventListener("cancel", invalidateEdit);
    dialog.addEventListener("close", function() { if (!dialog.open) invalidateEdit(); });
  }

  // A UI change detector only, not a content hash/proof. Compare the saved
  // fields exposed by browser.list, excluding runtime discovery and mtimes.
  function profileEditSignature(profile) {
    return JSON.stringify([
      "name", "engine", "browserVersion", "fingerprintMode", "fingerprintSeed", "platform",
      "allowThirdPartyCookies", "drm", "timezone", "locale", "webrtcMode", "webrtcIp",
      "geolocationMode", "geolocationLatitude", "geolocationLongitude", "geolocationAccuracy",
      "gpuVendor", "gpuRenderer", "hardwareConcurrency", "deviceMemory", "screenWidth", "screenHeight",
      "storageQuota", "taskbarHeight", "fontsDir", "renderScaleMode", "windowTitlePrefix", "appUrl",
      "proxyMode", "proxyName", "note", "tags", "preset", "syncedAt", "syncStatus", "syncScope", "syncReason",
    ].map(function(key) { return profile[key] == null ? null : profile[key]; }));
  }

  function checkProfileEditBaseline(profiles) {
    var dialog = document.getElementById("dlg-agent-browser-seed");
    if (!dialog || !dialog.open || !profileEditBaseline) return;
    var baseline = profileEditBaseline;
    if (document.getElementById("agent-browser-meta-dir-id").value !== baseline.dirId) return;
    var current = profiles.find(function(p) { return p.dirId === baseline.dirId; });
    var signature = current ? profileEditSignature(current) : null;
    if (signature === baseline.signature || signature === baseline.warned) return;
    baseline.warned = signature;
    toast(t("profile.edit.baseline-changed", "Saved profile data or its sync baseline changed while this editor was open. Your unsaved inputs were kept; close and reopen before saving to avoid overwriting newer data."), "info", { ttlMs: 0 });
  }

  agentBrowser.invalidateProfilesForSync = function() {
    retireNetworkView(false, "network.unavailable");
    if (typeof agentBrowser.invalidateFingerprintComparison === "function") agentBrowser.invalidateFingerprintComparison();
    ++profilesLoadSeq;
    ++profileEditSeq;
    ++newProfileProxySeq;
    ++businessPresetsLoadSeq;
    ++consistencyPreviewSeq;
    lastEngineInfo = null;
    lastFirefoxInfo = null;
    Object.keys(detectInFlight).forEach(function (dirId) {
      var request = detectInFlight[dirId];
      if (request && request.kind) invalidateHealthKind(dirId, request.kind);
    });
    Object.keys(healthHistoryByProfile).forEach(function (dirId) {
      healthReadSeq[dirId] = (healthReadSeq[dirId] || 0) + 1;
      healthHistoryByProfile[dirId].entries = healthHistoryByProfile[dirId].entries.map(function (en) { return Object.assign({}, en, { unverified: true }); });
      updateHealthCard(dirId);
    });
    healthHistoryViewSeq++;
    // Keep selection, filters, and the open editor's original baseline/draft.
    // A later current-generation list can warn, but must never refill it.
  };

  function profileSyncTitle(profile) {
    var reasons = {
      "baseline-match": ["profile.sync.reason.match", "Matches the recorded sync baseline for the current storage target."],
      "content-changed": ["profile.sync.reason.changed", "Saved locally; changes are not synchronized."],
      "no-baseline": ["profile.sync.reason.none", "No sync baseline has been recorded."],
      "legacy-marker": ["profile.sync.reason.legacy", "Legacy sync record has no usable content proof. Sync again to establish a baseline."],
      "invalid-baseline": ["profile.sync.reason.invalid", "The recorded sync baseline is unusable; matching content cannot be verified."],
      "target-mismatch": ["profile.sync.reason.target-changed", "Storage target changed; the recorded baseline belongs to a different endpoint or bucket."],
      "target-unavailable": ["profile.sync.reason.target-unavailable", "Storage target unavailable; sync state cannot be verified."],
      "preferences-unavailable": ["profile.sync.reason.preferences-unavailable", "Preferences could not be read safely; sync state is unknown."],
      "content-unavailable": ["profile.sync.reason.content-unavailable", "Portable profile metadata could not be read; sync state is unknown."],
    };
    var reason = reasons[profile.syncReason] || ["profile.sync.reason.unknown", "No usable sync proof was returned; sync state is unknown."];
    var title = t(reason[0], reason[1]);
    if (profile.syncStatus === "synced" && typeof profile.syncedAt === "number" && Number.isFinite(profile.syncedAt) && profile.syncedAt >= 0) {
      title += " " + t("profile.sync.baseline-at", "Baseline recorded: {when}").replace("{when}", new Date(profile.syncedAt).toLocaleString());
    }
    return title + " " + t("profile.sync.proof-scope", "Proof scope: portable profile metadata and Preferences only. Cookies, localStorage and other browser data are not verified by this badge.");
  }

  function loadProfiles(soft) {
    var seq = ++profilesLoadSeq;
    var container = document.getElementById("profile-list");
    if (!soft) {
      closeAllCardMenus(container);
      container.innerHTML = '<div class="loading">Loading...</div>';
    }

    // R164: browser.list() failure used to be swallowed into [] — the page
    // then painted the *empty* state ("还没有配置。点击「新建配置」…"), reporting
    // a load failure as "you have no profiles". Record it and render the
    // error state instead; the other optional calls keep their soft fallbacks
    // (proxy.list() stays bare — it is load-bearing, and its rejection
    // reaches the outer catch below).
    // Cold extraction/verification is independent of persisted metadata.
    // Late status may update only this load's banner, never rebuild its cards.
    var banner = document.getElementById("engine-banner");
    if (!soft || !banner || !banner._engineBannerSignature) {
      renderEngineBanner(null, false, true);
    } else {
      // Collapsing a settled banner shifts scroll anchoring and dismisses an
      // open menu. Keep its presentation, not its authority, during recheck.
      lastEngineInfo = null;
      banner.setAttribute("aria-busy", "true");
    }
    lastFirefoxInfo = null;
    Promise.resolve().then(function () { return api.browser.binary(); }).then(function (info) {
      if (seq !== profilesLoadSeq || state.currentTab !== "profiles") return;
      renderEngineBanner(info, !info);
    }).catch(function () {
      if (seq !== profilesLoadSeq || state.currentTab !== "profiles") return;
      renderEngineBanner(null, true);
    });
    if (api.browser.engineStatus) Promise.resolve().then(function () { return api.browser.engineStatus(); }).then(function (info) {
      if (seq !== profilesLoadSeq || state.currentTab !== "profiles") return;
      lastFirefoxInfo = info && info.firefox || null;
    }).catch(function () {
      if (seq !== profilesLoadSeq || state.currentTab !== "profiles") return;
      lastFirefoxInfo = null; // Unknown, not a false missing-engine launch gate.
    });
    var listError = null;
    Promise.all([
      lcall("browser.list", function () { return api.browser.list(); }).catch(function (e) { listError = e; return []; }),
      api.proxy.list(),
    ]).then(function (results) {
      if (seq !== profilesLoadSeq) return;
      if (listError) {
        closeAllCardMenus(container);
        agentBrowser.renderViewState(container, { error: listError.message || String(listError), retry: { cmd: "loadProfiles" } });
        return;
      }
      var browserProfiles = results[0] || [];
      var proxies = results[1];
      checkProfileEditBaseline(browserProfiles);
      // Sale-90/92: trial/paywall banner refreshes with every profile load.
      try { if (typeof agentBrowser.refreshLicense === "function") agentBrowser.refreshLicense(); } catch (e) { /* banner is best-effort */ }

      // Build a proxy lookup map for legacy renderer-side fallback.
      var proxyMap = {};
      var defaultProxyName = null;
      (proxies || []).forEach(function(p) { proxyMap[p.name] = p.config; if (p.isDefault) defaultProxyName = p.name; });

      var profiles = browserProfiles.map(function(cp) {
        var proxyMode = cp.proxyMode || (cp.proxyName ? "named" : "none");
        var resolvedProxy = cp.proxy || (proxyMode === "default" ? proxyMap[defaultProxyName] : proxyMap[cp.proxyName]) || null;
        var syncStatus = getSyncStatus(cp);
        var syncReason = cp.syncReason || (cp.syncedAt != null ? "legacy-marker" : syncStatus === "never" ? "no-baseline" : null);
        if (syncStatus === "unknown" && cp.syncStatus !== "unknown") syncReason = cp.syncedAt != null ? "legacy-marker" : null;
        return {
          dirId: cp.dirId,
          name: cp.name,
          sizeBytes: 0,
          lastModified: cp.lastModified || 0,
          running: cp.running,
          unknown: cp.unknown,
          stopping: cp.stopping,
          pid: cp.pid,
          proxy: resolvedProxy,
          proxyMode: proxyMode,
          proxyName: cp.proxyName || null,
          syncedAt: cp.syncedAt == null ? null : cp.syncedAt,
          syncStatus: syncStatus,
          syncScope: cp.syncScope || null,
          syncReason: syncReason,
          fingerprint: { browser: cp.engine || "chromium", version: cp.version, mode: cp.fingerprintMode || "managed", browserVersion: cp.browserVersion || null, platform: cp.platform || "windows", seed: cp.fingerprintSeed, timezone: cp.timezone, locale: cp.locale, webrtcMode: cp.webrtcMode || (cp.webrtcIp ? "altered" : "auto"), webrtcIp: cp.webrtcIp },
          gpuVendor: cp.gpuVendor || null,
          gpuRenderer: cp.gpuRenderer || null,
          hardwareConcurrency: cp.hardwareConcurrency || null,
          deviceMemory: cp.deviceMemory || null,
          screenWidth: cp.screenWidth || null,
          screenHeight: cp.screenHeight || null,
          storageQuota: cp.storageQuota || null,
          taskbarHeight: cp.taskbarHeight === 0 ? 0 : (cp.taskbarHeight || null),
          fontsDir: cp.fontsDir || null,
          allowThirdPartyCookies: cp.allowThirdPartyCookies === true,
          drm: cp.drm === true,
          tags: cp.tags || [],
          // B1 (#107): service returns appUrl/lock (browser-manager
          // listBrowserProfiles) and the card reads p.appUrl/p.lock — the
          // map used to drop both, so the App button and lock badge never
          // rendered.
          appUrl: cp.appUrl || null,
          lock: cp.lock || null,
        };
      });

      // A5: one-time data-safety reminder once real profiles exist.
      updateBackupHint(browserProfiles.length > 0);

      profiles.forEach(function (p) {
        var override = window._profileRuntimeOverrides && window._profileRuntimeOverrides[p.dirId];
        if (!override) return;
        if (p.unknown === true || p.stopping === true || override.expiresAt && Date.now() > override.expiresAt) {
          delete window._profileRuntimeOverrides[p.dirId];
          return;
        }
        if (override.pending && p.running === override.running) {
          delete window._profileRuntimeOverrides[p.dirId];
          return;
        }
        if (override.pending) { p.running = override.running; p.pid = override.pid; }
      });
      // Apply status + tag filters (batch operations console).
      if (profileFilter.status === "running") profiles = profiles.filter(function (p) { return p.running && p.unknown !== true; });
      else if (profileFilter.status === "stopped") profiles = profiles.filter(isStoppedRuntime);
      if (profileFilter.tags && profileFilter.tags.length) {
        profiles = profiles.filter(function (p) {
          var tags = (p.tags || []).map(function (t) { return String(t).toLowerCase(); });
          return profileFilter.tags.some(function (tag) { return tags.indexOf(tag) !== -1; });
        });
      }

      if (!profiles || profiles.length === 0) {
        closeAllCardMenus(container);
        var filtered = profileFilter.status !== "all" || (profileFilter.tags && profileFilter.tags.length);
        if (filtered) {
          // A filter result is a dead end the user created; the way out is to
          // clear it, so offer that rather than sending them to the toolbar.
          // S2-8: goes through renderViewState like every other empty state,
          // so it picks up the brand robot too.
          agentBrowser.renderViewState(container, {
            empty: t("profiles.empty.filtered", "No profiles match the current filter."),
            cta: { label: t("profiles.filter.clear", "Clear filters"), cmd: "clearProfileFilters" },
          });
        } else {
          // R187: the copy told the user to click "+ New Profile" 244px away in
          // the toolbar — the tabs that render through renderViewState() all
          // put their CTA *in* the empty state (see accounts/proxy/storage).
          // Same affordance here.
          agentBrowser.renderViewState(container, {
            empty: t("profiles.empty.none", "No profiles yet. Click \"+ New Profile\" to get started."),
            cta: { label: t("profiles.new", "+ New Browser Profile"), cmd: "newProfile" },
          });
        }
        lastRenderSignature = "";
        profilePage = 1;
        var pagerEl = document.getElementById("profile-pagination");
        if (pagerEl) pagerEl.style.display = "none";
        updateBatchBar(proxies);
        return;
      }

      var proxyOpts = (proxies || []).map(function (p) {
        var cfg = p.config || {};
        var label = String(cfg.type || "") + '://' + String(cfg.host || "") + ':' + String(cfg.port || "");
        return '<option value="' + escAttr(p.name) + '">' +
          esc(p.name) + ' (' + esc(label) + ')' + (p.isDefault ? ' · ' + t('proxy.default-tag', 'default') : '') + '</option>';
      }).join("");

      var cardHtmlFn = function (p) {
        var isUnknown = p.unknown === true, isStopping = p.stopping === true;
        var isRunning = p.running && !isUnknown;
        var runtimeHelp = isStopping ? t("profile.runtime.stopping-help") : isUnknown ? t("profile.runtime.unconfirmed-help") : "";
        // R9 P1-2: render the in-flight busy state so a list re-render cannot
        // re-enable a card mid-launch (setCardBusy also patches live nodes).
        var isBusy = !!busyCards[p.dirId];
        var disAttr = isBusy ? " disabled" : "";
        // Keep the render signature tied to metadata, not the passing clock.
        // The relative Modified label is updated in place after reconciliation.
        var absDate = p.lastModified ? new Date(p.lastModified).toLocaleString() : "";
        var proxyStr = proxyDisplayLabel(p);

        var syncIcon = "", syncCls = "", syncLabel = "";
        var syncTitle = profileSyncTitle(p);
        if (p.syncStatus === "synced") { syncIcon = icon("sync", 12); syncCls = "sync-synced"; syncLabel = t("profile.sync.synced", "Synced"); }
        else if (p.syncStatus === "dirty") { syncIcon = icon("zap", 12); syncCls = "sync-dirty"; syncLabel = t("profile.sync.local-changes", "Local changes"); }
        else if (p.syncStatus === "never") { syncIcon = icon("sync", 12); syncCls = "sync-never"; syncLabel = t("profile.sync.never", "Never"); }
        else { syncIcon = icon("alert", 12); syncCls = "sync-unknown"; syncLabel = t("profile.sync.unknown", "Unknown"); }

        var fp = p.fingerprint || {};
        var platform = fp.platform || "windows";
        var osName = platform === "macos" ? "macOS" : "Windows";

        // R146: webrtcMode / event filters are stored enums, not copy. They used
        // to be interpolated raw, which leaked the identifier into the zh UI
        // ("RTC auto", "事件stopped"). Falls back to the raw value so an unknown
        // enum (a newer backend) still renders something rather than blank.
        function webrtcModeLabel(mode) {
          return t("profile.webrtc." + mode, mode);
        }

        var isFirefox = fp.browser === "firefox" || p.engine === "firefox";
        var browserIcon = icon(isFirefox ? "firefox" : "browser", 12);
        var browserName = isFirefox ? "Firefox" : t("profile.card.chromium", "Managed Chromium");
        var fingerprintLabel = fp.mode === "off"
          ? t("profile.card.passthrough", "Off")
          : (isFirefox ? t("profile.new.mode.managed", "Managed identity") : platformIcon(platform)) + " #" + (fp.seed || "?");
        var hardware = { gpuRenderer: p.gpuRenderer, hardwareConcurrency: p.hardwareConcurrency, deviceMemory: p.deviceMemory, screenWidth: p.screenWidth, screenHeight: p.screenHeight };
        var fpCompleteness = fingerprintCompleteness(p);
        var identityStr = fp.mode === "off"
          ? t("profile.card.identity-off", "Managed identity disabled")
          : (fp.timezone || t("profile.card.auto-tz", "Auto TZ (at launch)")) + " · " + (fp.locale || t("profile.card.auto-locale", "Auto locale (at launch)"));
        if (fp.mode !== "off" && !isFirefox) {
          identityStr += " · RTC " + webrtcModeLabel(fp.webrtcMode || (fp.webrtcIp ? "altered" : "auto"));
          if (fp.webrtcIp) identityStr += " · " + fp.webrtcIp;
        }
        var managedTitle = t("profile.card.seed-title", "Seed ") + (fp.seed || "?") + " · " + osName + " · " + (fp.locale || t("profile.card.auto-locale", "Auto locale (at launch)")) + " · " + (fp.timezone || t("profile.card.auto-timezone", "Auto timezone (at launch)"));
        managedTitle += isFirefox
          ? " · " + t("profile.card.firefox-managed", "Supported identity settings; native/preload coverage depends on the installed engine, not full capability parity")
          : " · " + hardwareSummary(hardware) + " · " + t("profile.card.completeness", "completeness ") + fpCompleteness + "%";
        var fingerprintTitle = (fp.mode === "off" ? t("profile.card.real-machine", "Managed identity disabled; browser startup policies still apply") : managedTitle) + " · " + (isFirefox ? "Firefox " : "Chromium ") + (fp.browserVersion || fp.version || "auto");
        // ── Review item UE-01: four 9px check buttons made the card
        // unreadable. They collapse into one labelled control; every check is
        // local except the last one, which is an explicit opt-in (TE-04).
        var healthSelect = '<select class="health-select" data-action="health" aria-label="' +
          escAttr(t('profile.health.aria', 'Run a health check')) + '">' +
          '<option value="">' + esc(t('profile.health.placeholder', 'Health…')) + '</option>' +
          '<option value="drift">' + esc(t('profile.health.drift', 'Run fingerprint comparison')) + '</option>' +
          '<option value="drift-details">' + esc(t('profile.health.drift-details', 'View last fingerprint comparison')) + '</option>' +
          '<option value="lock">' + esc(t('profile.health.lock', 'Capture/update live reference…')) + '</option>' +
          '<option value="consistency">' + esc(t('profile.health.consistency', '4-field alignment')) + '</option>' +
          '<option value="env">' + esc(t('profile.health.env', 'Host environment')) + '</option>' +
          '<option value="webrtc">' + esc(t('profile.health.webrtc', 'WebRTC leak')) + '</option>' +
          '<option value="network">' + esc(t('profile.health.network', 'Observe this page’s network for 10 seconds')) + '</option>' +
          '<option value="risk">' + esc(t('profile.health.external', 'External site (ping0.cc)')) + '</option>' +
          '<option value="history">' + esc(t('profile.health.history', 'History')) + '</option>' +
          '<option value="reset">' + esc(t('profile.health.reset', 'Advanced: reset fingerprint baseline…')) + '</option>' +
          '</select>';
        var isLocked = !!(p.lock && p.lock.owner);
        var lockBadge = isLocked ? '<span class="status-badge badge-governance" style="background:var(--warning-bg);color: var(--warning-text);" title="' + escAttr(t('profile.badge.locked', 'Locked (governance): owned by {owner}').replace('{owner}', p.lock.ownerName || p.lock.owner)) + '">' + icon("lock", 11) + ' ' + esc(p.lock.ownerName || 'device') + '</span>' : '';
        var drmBadge = !isFirefox && p.drm ? '<span class="status-badge badge-capability" title="' + escAttr(t('profile.badge.drm', 'Capability: Widevine/DRM enabled')) + '">' + icon("play", 11) + ' DRM</span>' : '';
        var appBadge = p.appUrl ? '<span class="status-badge badge-capability" title="' + escAttr(t('profile.badge.app', 'Capability: Web App {url}').replace('{url}', p.appUrl)) + '">' + icon("monitor", 11) + ' App</span>' : '';
        var engineBadge = isFirefox ? '<span class="status-badge badge-capability chip-firefox" title="' + escAttr(t('profile.badge.firefox', 'Firefox engine; identity mode is shown separately')) + '">' + icon("firefox", 11) + ' Firefox</span>' : '';
        // ── Review item UE-06: sync moves into the governance tier so the
        // three status tiers are visually distinct (lifecycle / governance /
        // capability) instead of five equal-weight badges.
        var syncBadge = '<span class="status-badge badge-governance ' + syncCls + '" title="' + escAttr(syncTitle) + '">' + syncIcon + ' ' + esc(syncLabel) + '</span>';
        var tagHtml = (p.tags || []).map(function(tag) {
          // S2-6: tags are metadata, not status — quiet .tag chip, not a
          // heavy uppercase status pill (see the CSS note).
          return '<span class="tag">' + esc(tag) + '</span>';
        }).join('');

        var proxyOptsHtml = renderProxyOptions(proxies, profileProxySelectionValue(p, "none"), true);

        return '<div class="profile-card' + (isRunning ? ' running' : '') + (isBusy ? ' busy' : '') + '" data-dir-id="' + escAttr(p.dirId) + '" data-lock="' + (isLocked ? '1' : '0') + '" aria-busy="' + (isBusy ? 'true' : 'false') + '">' +
          '<div class="card-header">' +
            '<label class="profile-select" title="Select"><input type="checkbox" class="profile-select-checkbox" data-dir-id="' + escAttr(p.dirId) + '"></label>' +
            // R181: click-to-rename carried a title but was a bare <span> —
            // no tabindex, no role, no keyboard path. The card menu has an
            // equivalent Rename button, so this shortcut is not the only way
            // in, but a mouse-only affordance that announces itself on hover
            // should still be reachable: role+tabindex+Enter/Space, with the
            // accessible name carrying the action rather than the title.
            '<span class="name" role="button" tabindex="0" title="' + escAttr(t('profile.name.title', 'Click to rename')) +
              '" aria-label="' + escAttr(t('profile.name.title', 'Click to rename') + ': ' + p.name) +
              '" data-action="rename">' + esc(p.name) + '</span>' +
            // Premium-R11: badges live in their own row of the header grid.
            // Sharing a flex row with the name made a long name and the badge
            // cluster fight for width (and at 700px the badges overflowed the
            // card by ~129px). Row 2 is theirs alone, so they wrap among
            // themselves and the card never grows past its column.
            '<span class="card-status">' +
              '<span class="status-badge badge-lifecycle ' + (isUnknown || isStopping ? 'status-warn' : isRunning ? 'status-running' : 'status-stopped') + '" title="' + escAttr(runtimeHelp) + '">' + esc(isUnknown ? t('profile.status.unconfirmed', 'Runtime unconfirmed') : isStopping ? t('profile.status.stopping', 'Waiting for browser exit') : isRunning ? t('profile.status.running', 'Running') : t('profile.status.stopped', 'Stopped')) + '</span>' +
              lockBadge +
              syncBadge +
              engineBadge +
              drmBadge +
              appBadge +
            '</span>' +
          '</div>' +
          /* R142: the browser value is icon + name, so the cell itself is the
             flex row (`.icon-text`) and the name is the truncating label. As a
             bare inline svg it sat 1.6px above the text baseline.
             R143: the rows are wrapped in one `.card-meta` grid so the label
             column is shared (see the CSS note) — as loose siblings each row
             sized its own `max-content` label column and the value column
             jumped 26px from row to row. */
          '<div class="card-meta">' +
          '<div class="info-row"><span>' + esc(t('profile.row.browser', 'Browser')) + '</span><span class="icon-text">' + browserIcon + '<span class="icon-text-label">' + esc(browserName) + '</span></span></div>' +
          '<div class="info-row"><span>' + esc(t('profile.row.modified', 'Modified')) + '</span><span class="num profile-modified-time" data-modified-at="' + escAttr(p.lastModified || "") + '" title="' + escAttr(absDate) + '">' + esc(absDate || "?") + '</span></div>' +
          '<div class="info-row"><span>' + esc(t('profile.row.fingerprint', 'Fingerprint')) + '</span><span title="' + escAttr(fingerprintTitle) + '">' + esc(fingerprintLabel) + '</span></div>' +
          '<div class="info-row"><span>' + esc(t('profile.row.identity', 'Identity')) + '</span><span title="' + escAttr(identityStr) + '">' + esc(identityStr) + '</span></div>' +
          (!isFirefox ? '<div class="info-row"><span>' + esc(t('profile.row.hardware', 'Hardware')) + '</span><span title="' + escAttr(hardwareSummary(hardware)) + '">' + esc(hardwareSummary(hardware)) + '</span></div>' : '') +
          '<div class="info-row info-row-health"><span>' + esc(t('profile.row.health', 'Health')) + '</span><span>' + healthSelect + ' ' + lastHealthHtml(p.dirId) + '</span></div>' +
          ((p.tags || []).length ? '<div class="info-row info-row-tags"><span>' + esc(t('profile.row.tags', 'Tags')) + '</span><span class="tag-list">' + tagHtml + '</span></div>' : '') +
          '</div>' +
          /* S2-10: one control band instead of two stacked ones. The proxy
             switcher, primary action, edit and overflow menu are the card's
             toolbar — giving the select its own full-width row spent ~40px of
             every card on chrome. Edit goes icon-only (its accessible name is
             unchanged); the label space belongs to the proxy name. */
          '<div class="card-footer card-controls">' +
            // The dropdown only names the proxy; the resolved endpoint stays
            // reachable as a tooltip so merging the old "Proxy" row into this
            // control loses no information.
            '<select class="proxy-select" data-action="proxy" title="' + escAttr(proxyStr) + '" aria-label="' + escAttr(t('profile.row.proxy', 'Proxy')) + '">' + proxyOptsHtml + '</select>' +
            (isUnknown || isStopping
              ? '<button class="btn btn-secondary btn-sm" data-action="refresh-runtime" title="' + escAttr(runtimeHelp) + '" aria-label="' + escAttr(t('profile.action.retry-status', 'Retry status')) + '"' + disAttr + '>' + icon('refresh', 14) + ' ' + esc(t('profile.action.retry-status', 'Retry status')) + '</button> '
              : isRunning
                ? '<button class="btn btn-secondary btn-sm" data-action="stop" aria-label="' + escAttr(t('profile.action.stop', 'Stop this profile')) + '"' + disAttr + '>' + icon('stop', 14) + ' ' + esc(t('profile.action.stop-label', 'Stop')) + '</button> '
                : '<button class="btn btn-primary btn-sm" data-action="launch" aria-label="' + escAttr(t('profile.action.launch', 'Launch this profile')) + '"' + disAttr + '>' + icon('play', 14) + ' ' + esc(t('profile.action.launch-label', 'Launch')) + '</button> ') +
            '<button class="btn btn-secondary btn-sm btn-icon" data-action="edit" title="' + escAttr(t('profile.action.edit', 'Edit this profile')) + '" aria-label="' + escAttr(t('profile.action.edit', 'Edit this profile')) + '"' + disAttr + '>' + icon('edit', 14) + '</button> ' +
            (p.appUrl ? '<button class="btn btn-secondary btn-sm btn-icon" data-action="open-app" title="' + escAttr(t('profile.action.open-app', 'Open as Web App')) + '" aria-label="' + escAttr(t('profile.action.open-app', 'Open as Web App')) + '">' + icon('monitor', 14) + '</button> ' : '') +
            // ── UE-08: every control has an accessible name ──
            '<details class="card-menu">' +
              '<summary aria-label="' + escAttr(t('profile.action.more', 'More actions')) + '" title="' + escAttr(t('profile.action.more', 'More actions')) + '">⋯</summary>' +
              '<div class="card-menu-list" popover="manual">' +
                '<button type="button" data-action="rename">' + icon('edit', 14) + esc(t('profile.menu.rename', 'Rename')) + '</button>' +
                '<button type="button" data-action="note">' + icon('doc', 14) + esc(t('profile.menu.note', 'Note')) + '</button>' +
                '<button type="button" data-action="cookies">' + icon('cookie', 14) + esc(t('profile.menu.cookies', 'Cookies')) + '</button>' +
                '<button type="button" data-action="extensions">' + icon('extensions', 14) + esc(t('profile.menu.extensions', 'Extensions')) + '</button>' +
                '<button type="button" data-action="export-archive">' + icon('box', 14) + esc(t('profile.menu.export', 'Export backup')) + '</button>' +
                '<button type="button" data-action="lock">' + icon(isLocked ? 'unlock' : 'lock', 14) + esc(isLocked ? t('profile.menu.unlock', 'Release lock') : t('profile.menu.lock', '🔒 Lock to device')) + '</button>' +
                '<button type="button" data-action="logs">' + icon('list', 14) + esc(t('profile.menu.logs', 'Logs')) + '</button>' +
                '<button type="button" data-action="webrtc-diag">' + icon('globe', 14) + esc(t('webrtc.diag.title', 'In-browser WebRTC Diagnostics')) + '</button>' +
                '<button type="button" class="danger" data-action="delete"' + disAttr + '>' + icon('trash', 14) + esc(t('profile.menu.delete', 'Delete')) + '</button>' +
              '</div>' +
            '</details>' +
          '</div>' +
        '</div>';
      };
      renderProfileList(container, profiles, cardHtmlFn);
      attachProfileCardHandlers(container);
      updateBatchBar(proxies);
      if (typeof api.browser.healthHistory === "function") profiles.forEach(function (p) {
        refreshHealthSummary(p.dirId).catch(function (error) { console.warn("Profile health history read failed", error); });
      });
    }).catch(function (e) {
      if (seq !== profilesLoadSeq) return;
      closeAllCardMenus(container);
      container.innerHTML = '<div class="empty-state">' + esc(t("profiles.load-error", "Error: ")) + esc(e.message || String(e)) + '</div>';
      lastRenderSignature = "";
    });
  }

  // ── Profile list rendering: paging + keyed incremental updates ──
  // (review items TE-02 / UE-07)
  //
  // Before: every refresh rebuilt the whole grid with innerHTML, so a list of
  // 200 profiles re-created 200 cards on every launch/stop — dropping scroll
  // position, checkbox state and the focus in a proxy dropdown.
  //
  // Now: only the visible page is built, unchanged cards are reused by key,
  // and an identical render is skipped entirely (zero DOM mutations).
  var PAGE_SIZE = 50;
  var profilePage = 1;
  var lastRenderSignature = "";

  function htmlSignature(text) {
    // djb2 — cheap, good enough to detect "this card did not change".
    var hash = 5381;
    for (var i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
    return hash.toString(36);
  }

  function setProfilePage(page) {
    profilePage = Math.max(1, page);
    loadProfiles(true);
  }

  function renderPagination(container, total, pageCount) {
    var el = document.getElementById("profile-pagination");
    if (pageCount <= 1) {
      if (el) el.style.display = "none";
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = "profile-pagination";
      el.className = "batch-progress";
      container.parentNode.insertBefore(el, container.nextSibling);
      el.addEventListener("click", function (event) {
        var btn = event.target.closest("[data-page]");
        if (!btn) return;
        setProfilePage(parseInt(btn.getAttribute("data-page"), 10) || 1);
      });
    }
    el.style.display = "";
    var start = (profilePage - 1) * PAGE_SIZE + 1;
    var end = Math.min(total, profilePage * PAGE_SIZE);
    el.innerHTML =
      '<span>' + esc(t("profiles.pager.range", "Showing {a}-{b} of {n}").replace("{a}", start).replace("{b}", end).replace("{n}", total)) + "</span>" +
      '<span style="flex:1"></span>' +
      '<button class="btn btn-secondary btn-sm" data-page="' + (profilePage - 1) + '"' + (profilePage <= 1 ? " disabled" : "") + ">" + esc(t("profiles.pager.prev", "Previous")) + "</button>" +
      '<span>' + profilePage + " / " + pageCount + "</span>" +
      '<button class="btn btn-secondary btn-sm" data-page="' + (profilePage + 1) + '"' + (profilePage >= pageCount ? " disabled" : "") + ">" + esc(t("profiles.pager.next", "Next")) + "</button>";
  }

  function updateProfileCardView(card, lastModified) {
    var checkbox = card.querySelector(".profile-select-checkbox");
    var checked = !!profileSelection[card.dataset.dirId];
    if (checkbox && checkbox.checked !== checked) checkbox.checked = checked;
    var label = card.querySelector(".profile-modified-time");
    if (!label) return;
    var text = lastModified && helpers.relTime ? helpers.relTime(lastModified)
      : (lastModified ? new Date(lastModified).toLocaleString() : "?");
    if (label.textContent !== text) label.textContent = text;
  }

  function renderProfileList(container, profiles, cardHtmlFn) {
    var total = profiles.length;
    var pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (profilePage > pageCount) profilePage = pageCount;
    if (profilePage < 1) profilePage = 1;
    var start = (profilePage - 1) * PAGE_SIZE;
    var pageItems = profiles.slice(start, start + PAGE_SIZE);

    var cards = pageItems.map(function (p) {
      var html = cardHtmlFn(p);
      return { dirId: p.dirId, html: html, sig: htmlSignature(html), lastModified: p.lastModified };
    });

    // Fast path: reuse unchanged cards, updating selection and relative-time
    // display in place. Verify the DOM too: overlapping refreshes can replace
    // the list with a placeholder after an earlier data signature was recorded.
    var signature = cards.map(function (c) { return c.dirId + ":" + c.sig; }).join("|") + "#" + pageCount;
    var renderedCards = container.querySelectorAll(":scope > .profile-card");
    var renderedSignature = Array.prototype.map.call(
      renderedCards,
      function (card) { return card.dataset.dirId + ":" + card.getAttribute("data-card-sig"); },
    ).join("|") + "#" + pageCount;
    if (signature === lastRenderSignature && renderedSignature === signature) {
      cards.forEach(function (card, index) {
        updateProfileCardView(renderedCards[index], card.lastModified);
      });
      renderPagination(container, total, pageCount);
      return;
    }
    lastRenderSignature = signature;

    // Even reused cards move into the fragment below. Close before the first
    // detach, but leave a truly identical soft refresh entirely untouched.
    closeAllCardMenus(container);
    // Remember focus + scroll so a refresh does not interrupt the user.
    var active = document.activeElement;
    var focusIsMenuSummary = active && active.matches && active.matches('.card-menu > summary');
    var focusIsSelection = active && active.matches && active.matches('.profile-select-checkbox');
    var activeCard = active && active.closest ? active.closest(".profile-card") : null;
    var focusKey = activeCard ? (activeCard.dataset.dirId || "") + "|" + (active.getAttribute("data-action") || active.className || "") : null;
    var scrollingEl = document.getElementById("content") || document.scrollingElement || document.documentElement;
    var scrollTop = scrollingEl ? scrollingEl.scrollTop : 0;

    var existing = {};
    Array.prototype.forEach.call(container.children, function (el) {
      if (el.dataset && el.dataset.dirId) existing[el.dataset.dirId] = el;
    });

    var frag = document.createDocumentFragment();
    cards.forEach(function (card) {
      var el = existing[card.dirId];
      if (el && el.getAttribute("data-card-sig") === card.sig) {
        delete existing[card.dirId];
      } else {
        var tmp = document.createElement("div");
        tmp.innerHTML = card.html;
        el = tmp.firstElementChild;
        if (el) el.setAttribute("data-card-sig", card.sig);
      }
      if (el) {
        updateProfileCardView(el, card.lastModified);
        frag.appendChild(el);
      }
    });
    // Cards that are no longer present (deleted or paged away) get removed.
    Object.keys(existing).forEach(function (dirId) {
      if (existing[dirId].parentNode) existing[dirId].parentNode.removeChild(existing[dirId]);
    });
    // R11-51: the initial <div class="loading"> placeholder has no dirId so
    // the map above never removes it — it sat in the list forever next to
    // real cards. Drop non-card children once cards render.
    if (cards.length) {
      Array.prototype.slice.call(container.children).forEach(function (el) {
        if (!(el.dataset && el.dataset.dirId) && !el.classList.contains("profile-card")) {
          if (el.parentNode) el.parentNode.removeChild(el);
        }
      });
    }
    if (frag.childNodes.length || container.children.length === 0) container.appendChild(frag);

    if (scrollingEl && scrollTop) scrollingEl.scrollTop = scrollTop;
    if (focusKey) {
      var parts = focusKey.split("|");
      var target = container.querySelector('.profile-card[data-dir-id="' + parts[0].replace(/"/g, "") + '"] ' +
        (focusIsMenuSummary ? '.card-menu > summary' : focusIsSelection ? '.profile-select-checkbox' : '[data-action="' + (parts[1] || "").replace(/"/g, "") + '"]'));
      if (target && target.focus) target.focus();
    }

    renderPagination(container, total, pageCount);
  }

  // ── Card busy state (review item PL-06, R9 P1-2) ──
  // While a launch/stop is in flight the card is dimmed and stops accepting
  // input, so a user cannot race a delete against a browser that is starting.
  // CSS pointer-events:none blocks mouse, but keyboard/screen-reader users can
  // still activate buttons — so also flip real `disabled` + aria-disabled.
  function setCardBusy(dirId, busy) {
    if (busy) busyCards[dirId] = true;
    else delete busyCards[dirId];
    var card = document.querySelector('#profile-list .profile-card[data-dir-id="' + String(dirId).replace(/"/g, "") + '"]');
    if (!card) return;
    applyCardBusy(card, busy);
  }
  function applyCardBusy(card, busy) {
    if (busy) closeAllCardMenus(card);
    if (busy) card.classList.add("busy");
    else card.classList.remove("busy");
    card.setAttribute("aria-busy", busy ? "true" : "false");
    var ctrls = card.querySelectorAll("button, select, input");
    Array.prototype.forEach.call(ctrls, function (el) {
      if (busy) el.setAttribute("disabled", "disabled");
      else el.removeAttribute("disabled");
    });
  }

  function closeAllCardMenus(scope) {
    var owner = scope || document.getElementById("profile-list");
    if (typeof agentBrowser.closeCardMenus === "function") {
      agentBrowser.closeCardMenus(owner || document);
      return;
    }
    // Standalone renderer harnesses can omit the delegation module.
    var menus = owner ? owner.querySelectorAll(".card-menu[open]") : document.querySelectorAll("#profile-list .card-menu[open]");
    Array.prototype.forEach.call(menus, function (m) { m.removeAttribute("open"); });
  }

  function attachProfileCardHandlers(container) {
    // R181: role="button" + tabindex makes .name focusable, but a div-based
    // control gets no free Enter/Space activation the way a real <button>
    // does — without this the element takes focus and then ignores the key.
    // Same pattern as the env-risk history rows above.
    container.onkeydown = function (event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      var target = event.target.closest("[data-action]");
      if (!target || !container.contains(target)) return;
      if (target.tagName === "BUTTON" || target.tagName === "SUMMARY") return; // native
      event.preventDefault();
      target.click();
    };
    container.onclick = function (event) {
      var target = event.target.closest("[data-action]");
      if (!target || !container.contains(target)) return;
      var card = target.closest(".profile-card");
      if (!card) return;
      var dirId = card.dataset.dirId;
      var action = target.dataset.action;
      if (!dirId || action === "proxy") return;
      // R9 P1-2: belt and suspenders — disabled buttons already block mouse
      // and keyboard activation, but the handler is the last gate for any
      // path that reaches here (e.g. details-menu summary toggles).
      if (busyCards[dirId] && action !== "stop") {
        toast(t("toast.card.busy", "This profile is busy — wait for the current operation to finish"), "info");
        return;
      }
      closeAllCardMenus();
      if (action === "rename") agentBrowser.renameProfile(dirId, card.querySelector(".name")?.textContent || "");
      else if (action === "note") agentBrowser.addNote(dirId);
      else if (action === "stop") agentBrowser.stop(dirId);
      else if (action === "launch") agentBrowser.launch(dirId);
      else if (action === "refresh-runtime") loadProfiles(true);
      else if (action === "edit") agentBrowser.editProfile(dirId);
      else if (action === "cookies") agentBrowser.showCookies(dirId);
      else if (action === "extensions") agentBrowser.showExtensions(dirId);
      else if (action === "export-archive") agentBrowser.exportProfileArchive(dirId);
      else if (action === "delete") agentBrowser.delProfile(dirId);
      else if (action === "risk-check") agentBrowser.openRiskCheck(dirId);
      else if (action === "drift-check") agentBrowser.checkDrift(dirId);
      else if (action === "lock") agentBrowser.toggleLock(dirId, card);
      else if (action === "env-risk") agentBrowser.openEnvRisk(dirId);
      else if (action === "webrtc-diag") agentBrowser.openWebRtcDiag(dirId);
      else if (action === "open-app") agentBrowser.openApp(dirId);
      else if (action === "logs") agentBrowser.showProfileLogs(dirId);
    };
    container.onchange = function (event) {
      var target = event.target;
      if (target && target.classList && target.classList.contains("profile-select-checkbox")) {
        var card = target.closest(".profile-card");
        if (card && card.dataset.dirId) agentBrowser.toggleProfileSelect(card.dataset.dirId, target.checked);
        return;
      }
      var action = target && target.dataset ? target.dataset.action : null;
      // R10 UX P2-3: onchange was the unguarded twin of onclick — a proxy or
      // health change mid-launch raced the starting browser. Same short-circuit.
      var changeCard = target && target.closest ? target.closest(".profile-card") : null;
      var changeDirId = changeCard && changeCard.dataset.dirId;
      if (changeDirId && busyCards[changeDirId] && (action === "proxy" || action === "health")) {
        toast(t("toast.card.busy", "This profile is busy — wait for the current operation to finish"), "info");
        if (action === "health") target.value = "";
        return;
      }
      if (action === "proxy") {
        var pcard = target.closest(".profile-card");
        if (pcard && pcard.dataset.dirId) agentBrowser.proxyChanged(pcard.dataset.dirId, target);
        return;
      }
      // Single "Health" control (UE-01) instead of four 9px buttons.
      if (action === "health") {
        var kind = target.value;
        target.value = ""; // reset so the same check can be run again
        var hcard = target.closest(".profile-card");
        if (!kind || !hcard || !hcard.dataset.dirId) return;
        var id = hcard.dataset.dirId;
        if (kind === "drift") agentBrowser.checkDrift(id);
        else if (kind === "drift-details") agentBrowser.openFingerprintDetails(id);
        else if (kind === "lock") agentBrowser.lockBaseline(id);
        else if (kind === "reset") agentBrowser.resetBaseline(id);
        else if (kind === "consistency") agentBrowser.runConsistencyCheck(id);
        else if (kind === "env") agentBrowser.openEnvRisk(id);
        else if (kind === "webrtc") agentBrowser.openWebRtcDiag(id);
        else if (kind === "network") agentBrowser.openNetworkDiagnostics(id);
        else if (kind === "risk") agentBrowser.openRiskCheck(id);
        else if (kind === "history") showHealthHistory(id);
      }
    };
  }

  // sale-96: one-click fingerprint lock — capture the live baseline now so
  // later drift blocks the launch. Requires a running profile (CDP read).
  var baselineConfirmations = Object.create(null);
  var baselineResetConfirmations = Object.create(null);
  function baselineReviewValue(value, full) {
    var text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined) return t("common.unknown", "Unknown");
    return !full && text.length > 240 ? text.slice(0, 240) + "…" : text;
  }
  function showLaunchDriftReview(dirId, check, blocked) {
    agentBrowser.showFingerprintComparison(dirId, check || { checked: false }, { source: "launch", historical: true, blocked: blocked });
  }
  function resetHealthBaseline(dirId, confirmationToken) {
    var request = beginHealthRequest(dirId, "drift");
    if (!request) return;
    delete baselineResetConfirmations[dirId];
    healthCall("browser.resetBaseline", function () {
      return api.browser.resetBaseline(dirId, confirmationToken ? { confirmationToken: confirmationToken } : undefined);
    }, request).then(function (r) {
      finishHealthRequest(request);
      if (!healthResponseCurrent(request, r)) return;
      if (r && (r.code === "PROFILE_RUNNING" || r.code === "PROFILE_STOP_REQUIRED")) {
        toast(t("health.baseline.reset-running", "Stop this profile first, then choose Health > Reset fingerprint baseline… again. No stop was requested."), "warning");
        return;
      }
      if (r && r.code === "BASELINE_CONFIRMATION_STALE") {
        toast(t("health.baseline.reset-stale", "The reset review expired or the profile changed. Nothing was reset. Choose Health > Reset fingerprint baseline… and review again."), "warning");
        return;
      }
      if (r && r.code === "BASELINE_NOT_SET") {
        toast(t("health.baseline.reset-not-set", "No fingerprint baseline is set; nothing was reset."), "info");
        return;
      }
      if (r && r.code === "BASELINE_RESET_CONFIRMATION_REQUIRED") {
        if (typeof r.confirmationToken !== "string" || !r.confirmationToken) {
          toast(r.error || t("health.baseline.reset-failed", "Fingerprint baseline could not be reset."), "error");
          return;
        }
        baselineResetConfirmations[dirId] = r.confirmationToken;
        agentBrowser.confirm(t("health.baseline.reset-confirm", "Remove this profile's stored fingerprint baseline?"), function () {
          if (!healthRequestCurrent(request) || baselineResetConfirmations[dirId] !== r.confirmationToken) {
            toast(t("health.baseline.reset-stale", "The reset review expired or the profile changed. Nothing was reset. Choose Health > Reset fingerprint baseline… and review again."), "warning");
            return;
          }
          var token = baselineResetConfirmations[dirId];
          delete baselineResetConfirmations[dirId];
          resetHealthBaseline(dirId, token);
        }, {
          title: t("health.baseline.reset-title", "Reset fingerprint baseline?"),
          ackLabel: t("health.baseline.reset-ack", "I understand that this removes the comparison baseline, not the detected risk, and does not prove the profile is safe."),
          detailHtml: '<div style="font-size:12px;line-height:1.6;">' + esc(t("health.baseline.reset-scope", "Only the fingerprint baseline is removed. The seed, identity settings, operation history, Cookies and LocalStorage stay unchanged.")) + '</div>' +
            '<div style="margin-top:8px;">' + esc(t("health.baseline.reset-unverified", "Fingerprint comparison will be unavailable until you launch the profile and choose Health > Lock fingerprint baseline. Resetting is not a safety pass and does not launch the browser.")) + '</div>' +
            (r.warning ? '<div style="margin-top:8px;color:var(--warning-text);">' + esc(r.warning) + '</div>' : ''),
        });
        return;
      }
      if (r && r.ok && r.baselineReset === true) {
        var detail = t("health.baseline.reset-done", "Fingerprint baseline removed. Comparison is not verified until a new launch and Lock fingerprint baseline; this is not a safety pass.");
        recordHealthResult(dirId, "drift", { outcome: "inconclusive", detail: detail }, request.requestId);
        toast(detail + (r.warning ? " " + r.warning : ""), r.warning ? "warning" : "info");
        scheduleProfilesRefresh();
      } else {
        toast(r && r.error || t("health.baseline.reset-failed", "Fingerprint baseline could not be reset."), "error");
      }
    }).catch(function (e) {
      finishHealthRequest(request);
      if (healthRequestCurrent(request)) toast(e.message || String(e), "error");
    });
  }
  agentBrowser.resetBaseline = function(dirId) { resetHealthBaseline(dirId); };

  // Narrow mutation bridge for the viewer. Main binds the candidate and token;
  // the existing health lease also invalidates confirmations on a newer check.
  var snapshotBaselineConfirmations = Object.create(null);
  agentBrowser.captureReviewedFingerprintBaseline = function(dirId, reportId, token, viewEpoch) {
    var reviewed = snapshotBaselineConfirmations[dirId];
    if (!agentBrowser.isFingerprintViewCurrent(viewEpoch, dirId) || token && (!reviewed || reviewed.reportId !== reportId || reviewed.token !== token || !healthRequestCurrent(reviewed.request))) {
      return Promise.resolve({ ok: false, code: "BASELINE_CONFIRMATION_STALE" });
    }
    delete snapshotBaselineConfirmations[dirId];
    var request = beginHealthRequest(dirId, "drift");
    if (!request) return Promise.resolve({ ok: false, code: "HEALTH_BUSY" });
    request.fingerprintViewEpoch = viewEpoch;
    var options = { reportId: reportId };
    if (token) options.confirmationToken = token;
    return healthCall("browser.captureBaseline", function () { return api.browser.captureBaseline(dirId, options); }, request).then(function (result) {
      finishHealthRequest(request);
      if (!healthResponseCurrent(request, result)) return null;
      if (result && result.code === "BASELINE_CONFIRMATION_REQUIRED" && typeof result.confirmationToken === "string") snapshotBaselineConfirmations[dirId] = { reportId: reportId, token: result.confirmationToken, request: request };
      if (result && result.ok && result.baselineCommitted === true) {
        recordHealthResult(dirId, "drift", { outcome: result.outcome === "risk" || result.risky ? "risk" : "baseline-established", detail: t("fingerprint.saved") }, request.requestId);
        scheduleProfilesRefresh();
      }
      return result;
    }).catch(function (error) { finishHealthRequest(request); if (healthRequestCurrent(request)) throw error; return null; });
  };

  function captureHealthBaseline(dirId, confirmationToken, fingerprintEpoch) {
    var request = beginHealthRequest(dirId, "drift");
    if (!request) {
      if (fingerprintEpoch !== undefined) agentBrowser.showFingerprintBaselineOutcome(dirId, { ok: false, code: "HEALTH_BUSY" }, { epoch: fingerprintEpoch, live: true });
      return;
    }
    request.fingerprintViewEpoch = fingerprintEpoch;
    delete baselineConfirmations[dirId];
    healthCall("browser.captureBaseline", function () {
      return api.browser.status(dirId).then(function (s) {
        if (!s || !s.running) return { ok: false, outcome: "unavailable", code: "PROFILE_NOT_RUNNING" };
        return api.browser.captureBaseline(dirId, confirmationToken ? { confirmationToken: confirmationToken } : undefined);
      });
    }, request).then(function (r) {
      finishHealthRequest(request);
      if (!healthResponseCurrent(request, r)) return;
      if (fingerprintEpoch !== undefined) agentBrowser.showFingerprintBaselineOutcome(dirId, r, { epoch: fingerprintEpoch, live: true });
      if (r && r.code === "PROFILE_NOT_RUNNING") {
        toast(t("toast.fp.lock-need-running", "Start the profile first, then lock — the baseline is read from the live browser"), "info");
        return;
      }
      if (r && r.code === "BASELINE_CONFIRMATION_REQUIRED") {
        var reviewOutcome = r.risky || r.outcome === "risk" || r.report && r.report.risky ? "risk" : "warn";
        recordHealthResult(dirId, "drift", { outcome: reviewOutcome, detail: t("health.baseline.not-replaced", "Changes need review. The previous baseline has not been replaced.") }, request.requestId);
        if (!r.confirmationToken) { toast(t("toast.fp.lock-failed", "Failed to lock baseline"), "error"); return; }
        baselineConfirmations[dirId] = r.confirmationToken;
        var fields = (r.report && r.report.changes || r.drift || []).map(function (d) {
          return '<div style="margin-top:6px;"><b>' + esc(d.field || d.code || "") + '</b>' +
            '<div>' + esc(t("health.baseline.previous", "Previous / expected")) + ': ' + esc(baselineReviewValue(d.baseline)) + '</div>' +
            '<div>' + esc(t("health.baseline.current", "Current snapshot")) + ': ' + esc(baselineReviewValue(d.current)) + '</div></div>';
        }).join("");
        agentBrowser.confirm(t("health.baseline.confirm", "Replace the baseline with the reviewed snapshot?"), function () {
          if (baselineConfirmations[dirId] !== r.confirmationToken || !healthRequestCurrent(request)) return;
          var token = baselineConfirmations[dirId];
          delete baselineConfirmations[dirId]; // A confirmation is single-use; never retry a stale token.
          captureHealthBaseline(dirId, token, fingerprintEpoch);
        }, { title: t("health.baseline.risk-title", "Confirm reference replacement"),
          ackLabel: t("fingerprint.update.ack"),
          detailHtml: '<div>' + esc(t("health.baseline.not-replaced", "Changes need review. The previous baseline has not been replaced.")) + '</div>' +
            '<div style="margin-top:8px;word-break:break-word;">' + fields + '</div>' +
            '<div style="margin-top:8px;">' + esc(t("health.baseline.bound-confirmation", "This confirmation is bound to the reviewed baseline, configuration and live snapshot. If any changes, review and confirm again. Saving a new reference does not mean the profile passed a health check.")) + '</div>',
        });
        return;
      }
      if (r && r.code === "BASELINE_CONFIRMATION_STALE") {
        recordHealthResult(dirId, "drift", { outcome: "inconclusive", detail: t("health.baseline.stale", "The baseline or live snapshot changed. Nothing was replaced. Run Capture/update live reference again and review the new snapshot.") }, request.requestId);
        toast(t("health.baseline.stale", "The baseline or live snapshot changed. Nothing was replaced. Run Capture/update live reference again and review the new snapshot."), "warning");
        return;
      }
      if (r && r.ok) {
        var outcome = r.risky || r.outcome === "risk" ? "risk" : r.outcome === "warn" ? "warn" : "baseline-established";
        var detail = outcome === "baseline-established" ? t("health.baseline.established", "Baseline recorded; this is not a fingerprint stability pass.") : t("health.baseline.risk-saved", "Baseline replaced after explicit confirmation. This is not a fingerprint stability or safety pass.");
        recordHealthResult(dirId, "drift", { outcome: outcome, detail: detail }, r.requestId || request.requestId);
        toast(detail + (r.warning ? " " + r.warning : ""), outcome === "baseline-established" && !r.warning ? "info" : "warning");
        scheduleProfilesRefresh();
      } else {
        var error = r && r.error || t("toast.fp.lock-failed", "Failed to lock baseline");
        recordHealthResult(dirId, "drift", { outcome: r && (r.outcome === "cancelled" || r.outcome === "unavailable") ? r.outcome : r && r.code === "BASELINE_CAPTURE_UNAVAILABLE" ? "unavailable" : "error", detail: error }, request.requestId);
        toast(error, "error");
      }
    }).catch(function (e) {
      finishHealthRequest(request);
      if (!healthRequestCurrent(request)) return;
      if (fingerprintEpoch !== undefined) agentBrowser.showFingerprintBaselineOutcome(dirId, { ok: false }, { epoch: fingerprintEpoch, live: true });
      toast(e.message || String(e), "error");
    });
  }
  agentBrowser.lockBaseline = function(dirId, fingerprintEpoch) { captureHealthBaseline(dirId, undefined, fingerprintEpoch); };

  // B3 (#107): browser:consistency-check existed in main + preload with
  // zero renderer callers — the 4-field alignment check (IP/timezone/locale/
  // ASN) the SOP tells every new environment to run had no entry point.
  agentBrowser.runConsistencyCheck = function(dirId) {
    var request = beginHealthRequest(dirId, "consistency");
    if (!request) return;
    healthCall("browser.consistencyCheck", function () {
      return api.browser.consistencyCheck(dirId);
    }, request).then(function (r) {
      finishHealthRequest(request);
      if (!healthResponseCurrent(request, r)) return;
      if (!r || r.error || r.ok === false && !(r.blockers || []).length) {
        recordHealthResult(dirId, "consistency", { outcome: r && r.outcome === "cancelled" ? "cancelled" : "error", detail: r && r.error || t("toast.fp.consistency-failed", "Alignment check failed") }, request.requestId);
        toast(t("toast.fp.consistency-failed", "Alignment check failed"), "error"); return;
      }
      var blockers = r.blockers || [];
      var warnings = r.warnings || [];
      // This endpoint checks saved fields and cached proxy metadata, not the
      // effective launched identity. Empty findings (including Auto/null or
      // Off) cannot certify live alignment or earn a green health PASS.
      var unverified = t("toast.fp.consistency-unverified", "No conflicts found in stored/cached fields; live alignment is not verified.");
      recordHealthResult(dirId, "consistency", {
        outcome: blockers.length ? "risk" : warnings.length ? "warn" : "inconclusive",
        detail: blockers.concat(warnings).map(function (f) { return f.code || f.message; }).slice(0, 6).join(", ") || unverified,
      }, r.requestId || request.requestId);
      if (!blockers.length && !warnings.length) {
        toast(unverified, "info");
      } else {
        var lines = blockers.concat(warnings).map(function (f) {
          return (f.severity === "blocker" ? icon("close", 12) : icon("alert", 12)) + " " + (f.message || f.code);
        }).join("\n");
        agentBrowser.confirm(lines, function () {}, {
          title: t("toast.fp.consistency-title", "Alignment issues ({n})").replace("{n}", blockers.length + warnings.length),
        });
      }
      scheduleProfilesRefresh();
    }).catch(function (e) {
      finishHealthRequest(request);
      if (healthRequestCurrent(request)) toast(e.message || String(e), "error");
    });
  };

  agentBrowser.checkDrift = function(dirId) {
    var request = beginHealthRequest(dirId, "drift");
    if (!request) return;
    request.fingerprintViewEpoch = agentBrowser.beginFingerprintComparison(dirId, { source: "manual" });
    return healthCall("browser.checkDrift", function () {
      return api.browser.checkDrift(dirId);
    }, request).then(function(r) {
      finishHealthRequest(request);
      if (!healthResponseCurrent(request, r)) return;
      agentBrowser.showFingerprintComparison(dirId, r, { epoch: request.fingerprintViewEpoch, source: "manual", historical: !!(r && r.code === "PROFILE_NOT_RUNNING") });
      // A stopped response replays original evidence. It must not mint a new
      // check, cache timestamp, history query, baseline or launch.
      if (r && r.code === "PROFILE_NOT_RUNNING") return;
      recordHealthResult(dirId, "drift", agentBrowser.fingerprintComparisonSummary(r), r && r.requestId || request.requestId);
      scheduleProfilesRefresh();
    }).catch(function(e) {
      finishHealthRequest(request);
      if (!healthRequestCurrent(request)) return;
      agentBrowser.showFingerprintComparison(dirId, { ok: false, outcome: "error", error: e.message || String(e) }, { epoch: request.fingerprintViewEpoch, source: "manual" });
    });
  };

  function renderEnvRisk(r) {
    healthDialogs.env.latestResult = r;
    var body = document.getElementById('env-risk-body');
    if (!body) return;
    var summary = summarizeEnvRisk(r);
    if (!r || !r.result) {
      body.innerHTML = healthBadgeHtml(summary) + '<div class="empty-state">' + esc(summary.detail) + '</div>';
      return;
    }
    var res = r.result;
    var findings = Array.isArray(res.findings) ? res.findings : [];
    var rows = [];
    rows.push('<div class="card-header"><span class="name">' + esc(t("health.host", "Host")) + '</span>' + healthBadgeHtml(summary) + '</div>');
    rows.push('<div style="font-size:11px;color:var(--text-muted);">' + esc(res.hostPlatform || t("common.unknown", "Unknown")) + ' · ' + esc(t("health.locale", "Locale")) + ' ' + esc(res.hostLocale || '?') + '</div>');
    rows.push('<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + esc(t("health.scope.host", "Host-environment observations only; not a complete profile fingerprint verdict.")) + '</div>');
    rows.push('<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">DNS: ' + esc((res.resolvers || []).map(function(rr){ return rr.address + (rr.isCn ? ' (CN!)' : ''); }).join(', ') || 'n/a') + '</div>');
    rows.push('<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + esc(t("env.cn-fonts", "CN fonts")) + ': ' + esc((res.cnFonts || []).join(', ') || t("common.none", "none")) + '</div>');
    rows.push('<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + esc(t("env.proxy", "Proxy")) + ': ' + esc((res.proxy && res.proxy.mode) || '?') + ' · ' + esc((res.proxy && (res.proxy.type || '')) || '') + ' · DNS ' + esc((res.proxy && res.proxy.dnsLeakRisk) || '') + '</div>');
    if (res.raf && res.raf.samples > 0) {
      rows.push('<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">rAF: ' + esc(t("health.raf", "{samples} samples, median {ms}ms, approximately {hz}Hz ({standard})")
        .replace("{samples}", res.raf.samples).replace("{ms}", res.raf.medianMs).replace("{hz}", res.raf.refreshHz)
        .replace("{standard}", res.raf.standard ? t("health.standard", "standard") : t("health.non-standard", "non-standard"))) + '</div>');
    }
    body.innerHTML = rows.join('') +
      '<div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">' +
      findings.map(findingCardHtml).join('') +
      (!findings.length ? '<div class="empty-state">' + esc(summary.outcome === "pass" ? t("env.no-risk", "No environment risk found") : healthVerdict(summary).label) + '</div>' : '') +
      '</div>';
  }

  // R9 P1-4: persisted history with detail replay (mirrors webrtc diag).
  // R11 UX P2-2: rows expand to replay the full findings of that run.
  var currentEnvRiskDirId = null;
  function healthHistoryCurrent(kind, dirId, seq, epoch) {
    var view = healthDialogs[kind];
    var dlg = document.getElementById(kind === "env" ? "dlg-env-risk" : "dlg-webrtc-diag");
    return !!(dlg && dlg.open) && view.dirId === dirId && view.seq === seq && epoch === (healthEpoch[healthEpochKey(dirId, kind)] || 0);
  }
  function queryDiagnosticHistory(kind, dirId) {
    return lcall(kind + ".history:" + dirId, function () {
      return kind === "env" ? api.browser.envRiskHistory(dirId) : api.webrtc.diagHistory(dirId);
    }).then(function (h) {
      if (!h || h.ok === false || h.success === false || !Array.isArray(h.entries)) throw new Error(h && h.error || t("health.history-unavailable", "Authoritative health history is unavailable; cached results are not verified."));
      return h.entries;
    });
  }
  function renderHealthHistoryFailure(kind, error) {
    var host = document.getElementById(kind === "env" ? "env-risk-history" : "webrtc-diag-history");
    if (!host) return;
    var notice = host.querySelector(".health-history-error");
    if (!notice) { notice = document.createElement("div"); notice.className = "health-history-error"; host.appendChild(notice); }
    notice.innerHTML = '<span style="color:var(--danger-text);">' + esc(t("health.history-unavailable", "Authoritative health history is unavailable; cached results are not verified.")) + '</span> ' +
      '<button type="button" class="btn btn-secondary btn-sm">' + esc(t("common.retry", "Retry")) + '</button>';
    notice.setAttribute("title", error && error.message || String(error || ""));
    notice.querySelector("button").addEventListener("click", function () {
      var view = healthDialogs[kind];
      if (view.dirId) loadDiagnosticHistory(kind, view.dirId);
    });
  }
  function diagnosticHistoryOutcome(kind, entry) {
    if (entry.source === "legacy") return "inconclusive";
    return (kind === "env" ? summarizeEnvRisk({ ok: true, result: entry, outcome: entry.outcome }) : summarizeWebRtc({ ok: true, result: entry, outcome: entry.outcome })).outcome;
  }
  function renderDiagnosticHistory(kind, entries) {
    healthDialogs[kind].historyEntries = entries;
    var histEl = document.getElementById(kind === "env" ? "env-risk-history" : "webrtc-diag-history");
    if (!histEl) return;
    if (!entries.length) {
      histEl.innerHTML = '<div style="font-size:11px;color:var(--text-muted);margin-top:8px;">' + esc(t("env.risk.no-history", "No history yet")) + '</div>';
      return;
    }
    var attr = kind === "env" ? "env" : "webrtc";
    var html = '<div style="font-size:11px;color:var(--text-muted);margin-top:8px;border-top:1px solid var(--border);padding-top:6px;">' + esc(t("env.risk.history", "History ({n})").replace("{n}", entries.length)) + '</div>';
    entries.slice().reverse().forEach(function (en) {
      var idx = entries.indexOf(en);
      html += '<div class="' + attr + '-hist-row" data-' + attr + '-hist="' + idx + '" style="font-size:11px;margin-top:4px;cursor:pointer;" role="button" tabindex="0" title="' + escAttr(t("env.risk.expand", "Click to replay details")) + '">' +
        healthBadgeHtml({ outcome: diagnosticHistoryOutcome(kind, en) }) + ' ' + esc(en.at ? new Date(en.at).toLocaleString() : "?") + ' — ' + esc(en.summary || "") + ' ▸</div>' +
        '<div data-' + attr + '-hist-detail="' + idx + '" style="display:none;margin:4px 0 8px;font-size:11px;color:var(--text-muted);"></div>';
    });
    histEl.innerHTML = html;
    Array.prototype.forEach.call(histEl.querySelectorAll("[data-" + attr + "-hist]"), function (row) {
      function toggle() {
        var idx = Number(row.getAttribute("data-" + attr + "-hist"));
        var detail = histEl.querySelector('[data-' + attr + '-hist-detail="' + idx + '"]');
        if (!detail) return;
        if (detail.style.display !== "none") { detail.style.display = "none"; return; }
        var en = entries[idx] || {}, parts = [healthBadgeHtml({ outcome: diagnosticHistoryOutcome(kind, en) })];
        if (kind === "env") {
          var findings = Array.isArray(en.findings) ? en.findings : [];
          parts.push(findings.length ? findings.map(findingCardHtml).join("") : '<div>' + esc(diagnosticHistoryOutcome(kind, en) === "pass" ? t("env.no-risk", "No environment risk found") : t("health.outcome.inconclusive", "Not verified")) + '</div>');
        } else {
          parts.push('<div>' + esc(t("webrtc.conn-state", "connection state")) + ': ' + esc(en.connectionState || "?") + ' · RTT: ' + esc(rtcRttText(en)) + '</div>');
          parts.push('<div>' + esc(t("webrtc.ice-candidates", "ICE candidates")) + ': ' + (en.candidates || []).length + '</div>');
          if ((en.mdnsHosts || []).length) parts.push('<div>mDNS: ' + en.mdnsHosts.map(esc).join(", ") + '</div>');
          if ((en.hostIps || []).length) parts.push('<div style="color:var(--danger-text);">' + esc(t("webrtc.local-ip-leak", "Local IP leak")) + ': ' + en.hostIps.map(esc).join(", ") + '</div>');
          if ((en.srflxIps || []).length) parts.push('<div>STUN: ' + en.srflxIps.map(esc).join(", ") + '</div>');
          if (en.error) parts.push('<div style="color:var(--danger-text);">' + esc(en.error) + '</div>');
          parts.push('<div>' + esc(t("health.scope.rtc-peer", "Scope: ICE candidate exposure on the current page only. This probe does not establish a remote peer connection or verify all WebRTC routes or latency. An empty RTT means not measured; a connected peer is required.")) + '</div>');
        }
        detail.innerHTML = parts.join("");
        detail.style.display = "block";
      }
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    });
  }
  function loadDiagnosticHistory(kind, dirId) {
    var seq = healthDialogs[kind].seq, epoch = healthEpoch[healthEpochKey(dirId, kind)] || 0;
    return queryDiagnosticHistory(kind, dirId).then(function (entries) {
      if (healthHistoryCurrent(kind, dirId, seq, epoch)) renderDiagnosticHistory(kind, entries);
      return entries;
    }).catch(function (error) {
      if (healthHistoryCurrent(kind, dirId, seq, epoch)) renderHealthHistoryFailure(kind, error);
      throw error;
    });
  }
  function findingCardHtml(f) {
    var color = f.severity === 'high' ? 'var(--danger-text)' : (f.severity === 'medium' ? 'var(--warning-text)' : 'var(--text-muted)');
    var bg = f.severity === 'high' ? 'var(--danger-bg)' : (f.severity === 'medium' ? 'var(--warning-bg)' : 'transparent');
    return '<div style="border:1px solid ' + color + ';background:' + bg + ';border-radius:8px;padding:8px 10px;">' +
      '<div style="font-size:12px;color:' + color + ';font-weight:600;">' + esc(t("health.severity." + f.severity, String(f.severity || ""))) + ' · ' + esc(f.code) + '</div>' +
      '<div style="font-size:12px;color:var(--text);margin-top:2px;">' + esc(f.message) + '</div>' +
      '<div class="icon-text" style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + icon("info", 11) + esc(f.fix) + '</div>' +
    '</div>';
  }
  function renderEnvRiskHistory(dirId) {
    return loadDiagnosticHistory("env", dirId).catch(function (error) { console.warn("Environment history read failed", error); });
  }

  agentBrowser.openEnvRisk = function(dirId) {
    var dlg = document.getElementById('dlg-env-risk');
    var body = document.getElementById('env-risk-body');
    if (!dlg) { toast(t('env.dialog.unavailable', 'Env check dialog unavailable'), 'error'); return; }
    var request = beginHealthRequest(dirId, "env");
    if (!request) return;
    openHealthDialog("env", dirId, request);
    if (body) body.innerHTML = '<div class="loading">' + esc(t('env.checking', 'Checking host environment…')) + '</div>';
    var histEl = document.getElementById("env-risk-history");
    if (histEl) histEl.innerHTML = "";
    healthCall("browser.envRisk", function () { return api.browser.envRisk(dirId, { requestId: request.requestId }); }, request)
      .then(function (r) {
        if (!healthResponseCurrent(request, r)) return;
        recordHealthResult(dirId, "env", summarizeEnvRisk(r), request.requestId);
        renderEnvRisk(r);
        renderEnvRiskHistory(dirId);
      }).catch(function (e) {
        if (!healthRequestCurrent(request)) return;
        var r = { ok: false, outcome: "error", error: e.message || String(e) };
        recordHealthResult(dirId, "env", summarizeEnvRisk(r), request.requestId);
        renderEnvRisk(r);
      }).finally(function () { finishHealthRequest(request); });
  };

  // sale-97: one-click report export — the presale "ticket" (profile name +
  // timestamp + app version + latest env/webrtc results, redacted server-side).
  function downloadReportJson(filename, payload) {
    try {
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      return true;
    } catch (e) {
      toast((e && e.message) || String(e), "error");
      return false;
    }
  }
  function profileNameForReport(dirId, fallback) {
    var card = document.querySelector('#profile-list .profile-card[data-dir-id="' + String(dirId).replace(/"/g, "") + '"] .name');
    return (card && card.textContent.trim()) || fallback || dirId.slice(0, 8);
  }
  function exportHealthHistory(kind) {
    var view = healthDialogs[kind], dirId = view.dirId;
    if (!dirId) return;
    var seq = view.seq, epoch = healthEpoch[healthEpochKey(dirId, kind)] || 0;
    Promise.all([queryDiagnosticHistory(kind, dirId), api.app.version()]).then(function (rs) {
      if (!healthHistoryCurrent(kind, dirId, seq, epoch)) return;
      var history = rs[0].slice(-20);
      var payload = {
        kind: kind === "env" ? "env-risk-report" : "webrtc-report",
        profile: { dirId: dirId, name: profileNameForReport(dirId) },
        exportedAt: new Date().toISOString(), appVersion: rs[1],
        latest: history.length ? history[history.length - 1] : null, history: history,
      };
      // Export the stored original; exporting must not run a new host probe or
      // turn an unreadable history into an apparently successful empty report.
      if (downloadReportJson((kind === "env" ? "env-risk-" : "webrtc-") + dirId.slice(0, 8) + ".json", payload)) toast(t("report.exported", "Report exported"), "success");
    }).catch(function (e) { if (healthHistoryCurrent(kind, dirId, seq, epoch)) toast(e.message || String(e), "error"); });
  }
  agentBrowser.envRiskExport = function() { exportHealthHistory("env"); };
  agentBrowser.webRtcDiagExport = function() { exportHealthHistory("webrtc"); };

  var healthClearInFlight = Object.create(null);
  function clearHealthHistory(kind) {
    var view = healthDialogs[kind], dirId = view.dirId, seq = view.seq;
    if (!dirId || healthClearInFlight[dirId]) return;
    agentBrowser.confirm(kind === "env"
      ? t("env.risk.clear-confirm", "Clear this profile's environment risk history? This cannot be undone.")
      : t("webrtc.diag.clear-confirm", "Clear this profile's WebRTC diagnostic history? This cannot be undone."), function () {
      if (view.dirId !== dirId || view.seq !== seq || healthClearInFlight[dirId]) return;
      invalidateHealthKind(dirId, kind); // Also fences an already-running check and earlier history reads.
      var epoch = healthEpoch[healthEpochKey(dirId, kind)];
      healthClearInFlight[dirId] = true;
      var cleared = false;
      agentBrowser.ipc.call(kind + ".clear:" + dirId, function () {
        return kind === "env" ? api.browser.envRiskClear(dirId) : api.webrtc.diagClear(dirId);
      }, { kind: "write", timeoutMs: 0, slowNoticeMs: 15000, onSlow: function () {
        if (healthHistoryCurrent(kind, dirId, seq, epoch)) toast(t("health.waiting", "Still waiting for the check. Work may continue in the background; closing this dialog does not stop it."), "warning");
      } }).then(function (r) {
        if (!r || (kind === "env" ? r.ok !== true : r.success !== true)) throw new Error(r && r.error || t("health.clear-failed", "History was not cleared."));
        cleared = true;
        return Promise.all([queryHealthHistory(dirId), queryDiagnosticHistory(kind, dirId)]);
      }).then(function (histories) {
        if (epoch !== healthEpoch[healthEpochKey(dirId, kind)]) return;
        removeCachedHealthKind(dirId, kind);
        healthHistoryByProfile[dirId] = { entries: histories[0] };
        healthReadSeq[dirId] = (healthReadSeq[dirId] || 0) + 1;
        updateHealthCard(dirId);
        if (!healthHistoryCurrent(kind, dirId, seq, epoch)) return;
        renderDiagnosticHistory(kind, histories[1]);
        view.latestResult = null;
        var body = document.getElementById(kind === "env" ? "env-risk-body" : "webrtc-diag-body");
        if (body) body.textContent = t("profile.health.never", "Not checked yet");
        toast(kind === "env" ? t("env.risk.cleared", "Environment risk history cleared") : t("webrtc.diag.cleared", "WebRTC diagnostic history cleared"), "success");
      }).catch(function (error) {
        if (cleared) {
          var previous = healthHistoryByProfile[dirId];
          healthHistoryByProfile[dirId] = { entries: (previous ? previous.entries : cachedHealthEntries(dirId)).map(function (en) { return en.kind === kind ? Object.assign({}, en, { unverified: true }) : en; }), error: error.message || String(error) };
          updateHealthCard(dirId);
        }
        if (!healthHistoryCurrent(kind, dirId, seq, epoch)) return;
        if (cleared) renderHealthHistoryFailure(kind, error);
        toast(cleared ? t("health.clear-unverified", "The clear request completed, but history could not be read back. Previous display is retained as unverified; retry the history read.") : error.message || String(error), "error");
      }).finally(function () { delete healthClearInFlight[dirId]; });
    }, { title: kind === "env" ? t("env.risk.clear-title", "Clear history?") : t("webrtc.diag.clear-title", "Clear history?") });
  }
  agentBrowser.envRiskClear = function() { clearHealthHistory("env"); };


  function rtcRttText(result) {
    return typeof result.rttMs === "number" && Number.isFinite(result.rttMs) ? result.rttMs + "ms" : t("health.rtt-unmeasured", "Not measured (requires a connected peer)");
  }
  function renderWebRtcDiag(r, dirId) {
    healthDialogs.webrtc.latestResult = r;
    var body = document.getElementById("webrtc-diag-body");
    if (!body) return;
    var summary = summarizeWebRtc(r);
    if (!r || !r.result) {
      body.innerHTML = healthBadgeHtml(summary) + '<div class="empty-state">' + esc(summary.detail) + '</div>';
      return;
    }
    var res = r.result;
    var hasLeak = (res.hostIps || []).length > 0;
    var badge = healthBadgeHtml(summary);
    var when = res.at ? new Date(res.at).toLocaleString() : "";
    var rows = [];
    rows.push('<div class="card-header"><span class="name">WebRTC · ' + esc(when) + '</span><span>' + badge + '</span></div>');
    rows.push('<div style="font-size:12px;color:var(--text);margin-top:4px;">' + esc(res.summary || "") + '</div>');
    rows.push('<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">RTCPeerConnection: ' + (res.rtcAvailable ? t("webrtc.available", "available") : t("webrtc.unavailable", "unavailable")) + ' · ' + esc(t("webrtc.ice-candidates", "ICE candidates")) + ': ' + (res.candidates || []).length + ' · ' + esc(t("webrtc.conn-state", "connection state")) + ': ' + esc(res.connectionState || "") + " · RTT: " + esc(rtcRttText(res)) + '</div>');
    if ((res.mdnsHosts || []).length) rows.push('<div style="font-size:11px;margin-top:4px;"><span style="color:var(--text-muted);">' + esc(t("webrtc.mdns", "mDNS hostnames")) + ': </span>' + res.mdnsHosts.map(esc).join(", ") + '</div>');
    if (hasLeak) rows.push('<div style="font-size:11px;margin-top:4px;"><span class="icon-text" style="color: var(--danger-text);">' + icon("alert", 11) + esc(t("webrtc.local-ip-leak", "Local IP leak")) + ': </span>' + res.hostIps.map(esc).join(", ") + '</div>');
    if ((res.srflxIps || []).length) rows.push('<div style="font-size:11px;margin-top:4px;"><span style="color:var(--text-muted);">' + esc(t("webrtc.stun-ip", "STUN public IP")) + ': </span>' + res.srflxIps.map(esc).join(", ") + '</div>');
    if (res.error) rows.push('<div class="icon-text" style="font-size:11px;color: var(--warning-text);margin-top:4px;">' + icon("alert", 11) + esc(res.error) + '</div>');
    rows.push('<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">' + esc(t("health.scope.rtc", "This diagnostic only reports the observed WebRTC probe; it is not an external-site score.")) + '</div>');
    rows.push('<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + esc(t("health.scope.rtc-peer", "Scope: ICE candidate exposure on the current page only. This probe does not establish a remote peer connection or verify all WebRTC routes or latency. An empty RTT means not measured; a connected peer is required.")) + '</div>');
    body.innerHTML = rows.join("");
    if (dirId) loadDiagnosticHistory("webrtc", dirId).catch(function (error) { console.warn("WebRTC history read failed", error); });
  }

  function runWebRtcDiag(dirId, allowLaunch) {
    var dlg = document.getElementById("dlg-webrtc-diag");
    var body = document.getElementById("webrtc-diag-body");
    var histEl = document.getElementById("webrtc-diag-history");
    if (!dlg) { toast(t("webrtc.diag.unavailable", "WebRTC diagnostic dialog unavailable"), "error"); return; }
    var request = beginHealthRequest(dirId, "webrtc");
    if (!request) return;
    openHealthDialog("webrtc", dirId, request);
    if (body) body.innerHTML = '<div class="loading">' + esc(allowLaunch
      ? t("webrtc.diag.running-launch", "Starting profile and running the WebRTC diagnostic…")
      : t("webrtc.diag.running", "Running the WebRTC diagnostic…")) + '</div>';
    if (histEl) histEl.innerHTML = "";
    healthCall("webrtc.diag", function () {
      var ready = allowLaunch ? Promise.resolve({ running: true }) : api.browser.status(dirId);
      return ready.then(function (s) {
        if (!healthRequestCurrent(request)) return null;
        if (!s || !s.running) return { ok: false, outcome: "unavailable", code: "PROFILE_NOT_RUNNING" };
        return api.webrtc.diag(dirId, { allowLaunch: !!allowLaunch, requestId: request.requestId });
      });
    }, request).then(function (payload) {
      if (!healthResponseCurrent(request, payload)) return;
      if (payload && !payload.ok && payload.code === "PROFILE_NOT_RUNNING") {
        renderWebRtcDiag({ ok: false, outcome: "unavailable", error: t("risk.launch.msg", "This check needs a running browser. Start the profile now?") });
        confirmLaunchForWebRtc(dirId, request);
        return;
      }
      recordHealthResult(dirId, "webrtc", summarizeWebRtc(payload), request.requestId);
      renderWebRtcDiag(payload, dirId);
    }).catch(function (e) {
      if (!healthRequestCurrent(request)) return;
      var payload = { ok: false, outcome: "error", error: e.message || String(e) };
      recordHealthResult(dirId, "webrtc", summarizeWebRtc(payload), request.requestId);
      renderWebRtcDiag(payload, dirId);
    }).finally(function () { finishHealthRequest(request); });
  }

  function confirmLaunchForWebRtc(dirId, request) {
    agentBrowser.confirm(t("risk.launch.msg", "This check needs a running browser. Start the profile now?"), function () {
      if (!healthRequestCurrent(request)) return;
      runWebRtcDiag(dirId, true);
    }, { title: t("risk.launch.title", "Start profile for check"), detailHtml: '<div style="font-size:12px;">' +
      esc(t("risk.launch.body", "The profile will be started and left running after the check.")) + '</div>' });
  }
  agentBrowser.openWebRtcDiag = function(dirId) { runWebRtcDiag(dirId, false); };

  agentBrowser.webRtcDiagClear = function() { clearHealthHistory("webrtc"); };

  // ── Explicit, bounded observation of one already-running Chromium page ──
  // No polling/job, page navigation, launch, active fetch or report export lives
  // here. Main owns runtime/selection authority and the finite transport window.
  var NETWORK_SUMMARY_CODE = "NETWORK_OBSERVATION_V1";
  var NETWORK_COUNT_KEYS = ["requests", "hops", "responses", "finished", "failed", "blocked", "requestCancelled", "redirects", "http4xx", "http5xx", "pending", "cache", "serviceWorker", "unattributed", "cspIssues"];
  var NETWORK_STOP_REASONS = ["window-ended", "cancelled", "deadline", "connection-closed", "target-changed", "setup-rejected", "setup-timeout", "protocol-invalid", "limit-exceeded", "evidence-incomplete", "cleanup-unverified"];
  var NETWORK_COVERAGE = { network: ["observed", "partial", "unavailable"], csp: ["observed", "unavailable"], worker: ["not-observed"], oopif: ["not-observed"], console: ["not-observed"], storage: ["not-observed"], frames: ["selected-target-main-frame"], bridgeHop: ["unknown"], upstreamHop: ["unknown"] };
  var NETWORK_TERMINALS = ["pending", "finished", "failed", "blocked", "cancelled", "redirected"];
  var NETWORK_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE"];
  var NETWORK_RESOURCE_TYPES = ["Document", "Stylesheet", "Image", "Media", "Font", "Script", "TextTrack", "XHR", "Fetch", "Prefetch", "EventSource", "WebSocket", "Manifest", "SignedExchange", "Ping", "CSPViolationReport", "Preflight", "Other"];
  var NETWORK_ERRORS = ["ERR_FAILED", "ERR_ABORTED", "ERR_TIMED_OUT", "ERR_CONNECTION_TIMED_OUT", "ERR_CONNECTION_CLOSED", "ERR_CONNECTION_RESET", "ERR_CONNECTION_REFUSED", "ERR_CONNECTION_ABORTED", "ERR_CONNECTION_FAILED", "ERR_NAME_NOT_RESOLVED", "ERR_NAME_RESOLUTION_FAILED", "ERR_INTERNET_DISCONNECTED", "ERR_NETWORK_CHANGED", "ERR_ADDRESS_UNREACHABLE", "ERR_PROXY_CONNECTION_FAILED", "ERR_TUNNEL_CONNECTION_FAILED", "ERR_NO_SUPPORTED_PROXIES", "ERR_PROXY_AUTH_REQUESTED", "ERR_PROXY_AUTH_UNSUPPORTED", "ERR_INVALID_AUTH_CREDENTIALS", "ERR_SSL_PROTOCOL_ERROR", "ERR_CERT_AUTHORITY_INVALID", "ERR_CERT_COMMON_NAME_INVALID", "ERR_CERT_DATE_INVALID", "ERR_BLOCKED_BY_CLIENT", "ERR_BLOCKED_BY_RESPONSE", "ERR_BLOCKED_BY_CSP", "ERR_CONTENT_LENGTH_MISMATCH", "ERR_INCOMPLETE_CHUNKED_ENCODING", "ERR_EMPTY_RESPONSE", "ERR_HTTP_RESPONSE_CODE_FAILURE", "ERR_HTTP2_PROTOCOL_ERROR", "ERR_QUIC_PROTOCOL_ERROR", "ERR_CACHE_MISS", "ERR_UNSAFE_REDIRECT", "ERR_TOO_MANY_REDIRECTS", "ERR_INVALID_REDIRECT", "ERR_INVALID_URL", "ERR_UNKNOWN_URL_SCHEME", "ERR_DISALLOWED_URL_SCHEME", "ERR_ACCESS_DENIED"];
  var NETWORK_BLOCKED_REASONS = ["other", "csp", "mixed-content", "origin", "inspector", "subresource-filter", "content-type", "coep-frame-resource-needs-coep-header", "coop-sandboxed-iframe-cannot-navigate-to-coop-page", "corp-not-same-origin", "corp-not-same-origin-after-defaulted-to-same-origin-by-coep", "corp-not-same-site", "sri-message-signature-mismatch"];
  var NETWORK_CORS_REASONS = ["DisallowedByMode", "OriginDisallowedByMode", "InvalidResponse", "WildcardOriginNotAllowed", "MissingAllowOriginHeader", "MultipleAllowOriginValues", "InvalidAllowOriginValue", "AllowOriginMismatch", "InvalidAllowCredentials", "CorsDisabledScheme", "PreflightInvalidStatus", "PreflightDisallowedRedirect", "PreflightWildcardOriginNotAllowed", "PreflightMissingAllowOriginHeader", "PreflightMultipleAllowOriginValues", "PreflightInvalidAllowOriginValue", "PreflightAllowOriginMismatch", "PreflightInvalidAllowCredentials", "PreflightMissingAllowExternal", "PreflightInvalidAllowExternal", "PreflightMissingAllowPrivateNetwork", "PreflightInvalidAllowPrivateNetwork", "InvalidAllowMethodsPreflightResponse", "InvalidAllowHeadersPreflightResponse", "MethodDisallowedByPreflightResponse", "HeaderDisallowedByPreflightResponse", "RedirectContainsCredentials", "InsecurePrivateNetwork", "InvalidPrivateNetworkAccess"];

  function networkExactKeys(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length) return false;
    return keys.every(function (key) {
      var field = Object.getOwnPropertyDescriptor(value, key);
      return field && field.enumerable && Object.prototype.hasOwnProperty.call(field, "value");
    });
  }
  function projectNetworkSummary(value) {
    // Renderer-only defensive projection of the published scalar schema. Main's
    // pure normalizer remains the storage authority; JSON words are not proof.
    try {
      if (!networkExactKeys(value, ["version", "completion", "stopReason", "armedAt", "endedAt", "durationMs", "counts", "coverage"]) || value.version !== 1 ||
          ["completed", "partial", "cancelled", "unavailable"].indexOf(value.completion) === -1 || NETWORK_STOP_REASONS.indexOf(value.stopReason) === -1 ||
          !Number.isSafeInteger(value.endedAt) || value.endedAt < 0 || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || value.durationMs > 10000 ||
          !networkExactKeys(value.counts, NETWORK_COUNT_KEYS) || !networkExactKeys(value.coverage, Object.keys(NETWORK_COVERAGE))) return null;
      var counts = {}, scope = {};
      if (!NETWORK_COUNT_KEYS.every(function (key) {
        var count = value.counts[key], limit = key === "cspIssues" || key === "unattributed" ? 256 : 128;
        if (!Number.isSafeInteger(count) || count < 0 || count > limit) return false;
        counts[key] = count; return true;
      }) || !Object.keys(NETWORK_COVERAGE).every(function (key) {
        var claim = value.coverage[key];
        if (NETWORK_COVERAGE[key].indexOf(claim) === -1) return false;
        scope[key] = claim; return true;
      })) return null;
      if (counts.requests !== counts.hops || counts.finished + counts.failed + counts.blocked + counts.requestCancelled + counts.redirects + counts.pending !== counts.hops ||
          counts.responses > counts.hops || counts.http4xx > counts.responses || counts.http5xx > counts.responses || counts.cache > counts.hops || counts.serviceWorker > counts.hops ||
          counts.cspIssues > 0 && scope.csp !== "observed") return null;
      if (value.armedAt === null) {
        if (["unavailable", "cancelled"].indexOf(value.completion) === -1 || value.durationMs !== 0 || scope.network !== "unavailable" || scope.csp !== "unavailable" ||
            NETWORK_COUNT_KEYS.some(function (key) { return counts[key] !== 0; })) return null;
      } else {
        if (!Number.isSafeInteger(value.armedAt) || value.armedAt < 0 || value.endedAt - value.armedAt !== value.durationMs || value.completion === "unavailable") return null;
        if (value.completion === "completed" ? value.durationMs !== 10000 || value.stopReason !== "window-ended" || scope.network !== "observed" : scope.network !== "partial") return null;
      }
      return { version: 1, completion: value.completion, stopReason: value.stopReason, armedAt: value.armedAt, endedAt: value.endedAt, durationMs: value.durationMs, counts: counts, coverage: scope };
    } catch (error) { return null; }
  }
  function networkSummaryText(value) {
    var summary = projectNetworkSummary(value);
    if (!summary) return t("network.unavailable", "Network observation is unavailable.");
    return [t("network.completion." + summary.completion), t("network.stop." + summary.stopReason),
      t("network.duration", "Observed duration: {ms} ms").replace("{ms}", summary.durationMs)]
      .concat(NETWORK_COUNT_KEYS.map(function (key) { return t("network.count." + key) + ": " + summary.counts[key]; }))
      .concat(Object.keys(NETWORK_COVERAGE).map(function (key) { return t("network.coverage." + key) + ": " + t("network.coverage." + summary.coverage[key]); })).join(" · ");
  }
  function networkSummaryHtml(value) {
    var summary = projectNetworkSummary(value);
    if (!summary) return '<div class="empty-state">' + esc(t("network.unavailable", "Network observation is unavailable.")) + '</div>';
    return '<div style="font-size:12px;line-height:1.6;min-width:0;">' +
      '<b>' + esc(t("network.completion." + summary.completion)) + '</b> · ' + esc(t("network.duration", "Observed duration: {ms} ms").replace("{ms}", summary.durationMs)) +
      '<div style="color:var(--text-muted);">' + esc(t("network.stop." + summary.stopReason)) + '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:3px 14px;margin-top:6px;">' + NETWORK_COUNT_KEYS.map(function (key) {
        return '<span data-network-count="' + key + '">' + esc(t("network.count." + key)) + ': ' + summary.counts[key] + '</span>';
      }).join("") + '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:3px 14px;margin-top:8px;padding-top:6px;border-top:1px solid var(--border);color:var(--text-muted);">' + Object.keys(NETWORK_COVERAGE).map(function (key) {
        return '<span data-network-coverage="' + key + '">' + esc(t("network.coverage." + key)) + ': ' + esc(t("network.coverage." + summary.coverage[key])) + '</span>';
      }).join("") + '</div><p style="margin:8px 0;color:var(--text-muted);">' + esc(t("network.scope")) + '</p></div>';
  }
  function networkOrigin(value) {
    if (typeof value !== "string" || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return null;
    try {
      var parsed = new URL(value);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password && parsed.origin === value ? parsed.origin : null;
    } catch (error) { return null; }
  }
  function networkLocalId(value) { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(value) ? value : null; }
  function networkStatus(value) { return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null; }
  function networkEnum(value, values) { return values.indexOf(value) !== -1 ? value : value == null ? null : "unknown"; }
  function projectNetworkHop(value) {
    if (!value || typeof value !== "object" || !networkLocalId(value.id) || !networkLocalId(value.chainId) || !networkOrigin(value.origin)) return null;
    return { id: value.id, chainId: value.chainId, redirectedFrom: networkLocalId(value.redirectedFrom), origin: networkOrigin(value.origin),
      method: networkEnum(value.method, NETWORK_METHODS), resourceType: networkEnum(value.resourceType, NETWORK_RESOURCE_TYPES),
      status: networkStatus(value.status), networkStatus: networkStatus(value.networkStatus), terminal: networkEnum(value.terminal, NETWORK_TERMINALS),
      errorCode: networkEnum(value.errorCode, NETWORK_ERRORS), blockedReason: networkEnum(value.blockedReason, NETWORK_BLOCKED_REASONS), corsReason: networkEnum(value.corsReason, NETWORK_CORS_REASONS),
      fromDiskCache: typeof value.fromDiskCache === "boolean" ? value.fromDiskCache : null, fromServiceWorker: typeof value.fromServiceWorker === "boolean" ? value.fromServiceWorker : null,
      fromPrefetchCache: typeof value.fromPrefetchCache === "boolean" ? value.fromPrefetchCache : null, servedFromCache: typeof value.servedFromCache === "boolean" ? value.servedFromCache : null };
  }
  function projectNetworkStatusEvidence(value) {
    if (!value || !networkLocalId(value.id) || !networkLocalId(value.chainId) || networkStatus(value.status) === null || value.source !== "extra-info" || ["unique", "unknown"].indexOf(value.association) === -1) return null;
    var hopId = value.association === "unique" ? networkLocalId(value.hopId) : null;
    if (value.association === "unique" && !hopId) return null;
    return { id: value.id, chainId: value.chainId, hopId: hopId, status: value.status, source: "extra-info", association: value.association };
  }
  function networkFailureCopy(code) {
    if (typeof code !== "string") return "network.unavailable";
    var copy = { PROFILE_NOT_FOUND: "network.failure.profile-not-found", HEALTH_INVALID_REQUEST: "network.failure.invalid-request",
      HEALTH_BUSY: "network.failure.busy", HEALTH_CANCELLED: "network.failure.cancelled", HEALTH_TIMEOUT: "network.failure.timeout",
      HEALTH_PROFILE_CHANGED: "network.failure.profile-changed", HEALTH_HISTORY_WRITE_FAILED: "network.failure.history-write-failed",
      NETWORK_RUNTIME_UNAVAILABLE: "network.failure.runtime-unavailable", NETWORK_ENGINE_UNSUPPORTED: "network.failure.engine-unsupported",
      NETWORK_SELECTION_STALE: "network.selection-expired", NETWORK_SELECTION_LIMIT: "network.failure.selection-limit",
      NETWORK_SETUP_TIMEOUT: "network.failure.setup-timeout", NETWORK_PROTOCOL_INVALID: "network.failure.protocol-invalid",
      NETWORK_OBSERVATION_FAILED: "network.failure.observation-failed" };
    return Object.prototype.hasOwnProperty.call(copy, code) ? copy[code] : "network.unavailable";
  }
  function projectNetworkReply(value, request) {
    if (!value || value.requestId !== request.requestId) return null;
    var summary = projectNetworkSummary(value.observation);
    var safe = { requestId: request.requestId, observation: summary, outcome: ["warn", "risk", "error", "unavailable", "inconclusive", "cancelled"].indexOf(value.outcome) !== -1 ? value.outcome : "inconclusive",
      notice: value.ok !== true || !summary || typeof value.code === "string" ? networkFailureCopy(value.code) : null, hops: [], httpStatusEvidence: [], detailUnavailable: false };
    if (!summary) return safe;
    if (!Array.isArray(value.hops) || value.hops.length > 128 || !Array.isArray(value.httpStatusEvidence) || value.httpStatusEvidence.length > 256) {
      safe.observation = null; safe.notice = "network.unavailable"; return safe;
    }
    value.hops.forEach(function (value) { var projected = projectNetworkHop(value); if (projected) safe.hops.push(projected); else safe.detailUnavailable = true; });
    value.httpStatusEvidence.forEach(function (value) { var projected = projectNetworkStatusEvidence(value); if (projected) safe.httpStatusEvidence.push(projected); else safe.detailUnavailable = true; });
    if (new Blob([JSON.stringify({ hops: safe.hops, httpStatusEvidence: safe.httpStatusEvidence })]).size > 262144) {
      safe.observation = null; safe.hops = []; safe.httpStatusEvidence = []; safe.notice = "network.unavailable";
    }
    return safe;
  }
  function networkSafeInvoke(fn, copyKey) {
    // Sanitize before ipc.call can report an exception to observability. Native
    // messages, full URLs or stack samples must not become renderer logs/toasts.
    return Promise.resolve().then(fn).catch(function () { throw new Error(t(copyKey || "network.unavailable", "Network observation is unavailable.")); });
  }
  function networkViewCurrent(seq, dirId, pageSeq) {
    var view = healthDialogs.network, dialog = document.getElementById("dlg-network-observation");
    return !!(dialog && dialog.open) && view.seq === seq && view.dirId === dirId && (pageSeq === undefined || view.pageSeq === pageSeq);
  }
  function unsubscribeNetworkRequest(request) {
    var unsubscribe = request && request.networkUnsubscribe;
    if (typeof unsubscribe !== "function") return;
    request.networkUnsubscribe = null;
    try { unsubscribe(); }
    catch (error) { console.warn("Network observation notification cleanup could not be confirmed"); }
  }
  function updateNetworkControls() {
    var view = healthDialogs.network, request = view.request;
    var active = !!(request && !request.settled && !request.discarded);
    var clearing = !!(view.dirId && healthClearInFlight[view.dirId]);
    var select = document.getElementById("network-page-select"), start = document.getElementById("network-observation-start"), refresh = document.getElementById("network-page-refresh");
    var cancel = document.getElementById("network-observation-cancel"), clear = document.getElementById("network-observation-clear");
    if (select) select.disabled = !view.dirId || view.loading || active || clearing;
    if (start) start.disabled = !view.dirId || !view.selection || view.loading || active || clearing;
    if (refresh) refresh.disabled = !view.dirId || active || clearing;
    if (cancel) cancel.disabled = !active || request.cancelPending || request.cancelSent;
    if (clear) clear.disabled = !view.dirId || clearing;
  }
  function renderNetworkChooser() {
    var view = healthDialogs.network, select = document.getElementById("network-page-select"), origin = document.getElementById("network-page-origin");
    if (select) {
      select.innerHTML = '<option value="">' + esc(t("network.pages.placeholder")) + '</option>' + view.pages.map(function (page) {
        return '<option value="' + escAttr(page.handle) + '">' + esc(t("network.pages.ordinal", "Page {n}").replace("{n}", page.ordinal)) + ' · ' + esc(page.origin) + '</option>';
      }).join("");
      select.value = view.selection || "";
    }
    if (origin) origin.textContent = view.origin;
    updateNetworkControls();
  }
  function networkFactText(value, kind) {
    if (value === null || value === undefined || value === "unknown") return t("network.fact.unknown", "Unknown");
    if (kind === "terminal") return t("network.terminal." + value);
    if (kind === "blocked" && value === "csp") return t("network.blocked.csp");
    if (kind === "cors" && value === "MissingAllowOriginHeader") return t("network.cors.MissingAllowOriginHeader");
    return value;
  }
  function networkHopHtml(hop) {
    var facts = [esc(networkFactText(hop.method)), esc(networkFactText(hop.resourceType)), esc(networkFactText(hop.terminal, "terminal")),
      esc(t("network.status.browser")) + ': ' + esc(networkFactText(hop.status)), esc(t("network.status.wire")) + ': ' + esc(networkFactText(hop.networkStatus))];
    if (hop.errorCode !== null) facts.push(esc(t("network.error.label", "Network error")) + ': ' + esc(networkFactText(hop.errorCode)));
    if (hop.blockedReason !== null) facts.push(esc(t("network.blocked.label", "Blocked reason")) + ': ' + esc(networkFactText(hop.blockedReason, "blocked")));
    if (hop.corsReason !== null) facts.push('CORS: ' + esc(networkFactText(hop.corsReason, "cors")));
    ["fromDiskCache", "fromServiceWorker", "fromPrefetchCache", "servedFromCache"].forEach(function (key) {
      facts.push(esc(t("network.flag." + key)) + ': ' + esc(t(hop[key] === null ? "network.fact.unknown" : hop[key] ? "network.fact.yes" : "network.fact.no")));
    });
    return '<div data-network-hop="' + escAttr(hop.id) + '" style="padding:8px 0;border-top:1px solid var(--border);min-width:0;">' +
      '<div style="overflow-wrap:anywhere;word-break:break-word;font-family:var(--mono);font-size:11px;">' + esc(hop.origin) + '</div>' +
      '<div style="font-size:11px;line-height:1.6;color:var(--text-muted);">' + facts.join(' · ') + '</div></div>';
  }
  function renderNetworkView() {
    var view = healthDialogs.network, status = document.getElementById("network-observation-status"), body = document.getElementById("network-observation-body");
    renderNetworkChooser();
    if (status) {
      status.setAttribute("data-network-phase", view.phase);
      var key = view.notice || (view.phase === "setup" ? "network.setup" : view.phase === "observing10s" ? "network.observing10s" :
        ["completed", "partial", "cancelled", "unavailable"].indexOf(view.phase) !== -1 ? "network.completion." + view.phase : "network.choose");
      status.textContent = view.dirId ? (view.phase === "unavailable" && key !== "network.unavailable" ? t("network.unavailable") + " " : "") + t(key) : "";
    }
    if (!body) return;
    var result = view.latestResult;
    if (!result || !result.observation) { body.textContent = ""; return; }
    var summary = result.observation, counts = summary.counts;
    var html = networkSummaryHtml(summary);
    if (summary.armedAt !== null && counts.requests === 0) html += '<p class="hint-line">' + esc(t("network.no-traffic")) + '</p>';
    else if (summary.completion === "completed" && summary.coverage.network === "observed" && counts.finished > 0 && !result.notice && !result.detailUnavailable &&
        ["error", "risk", "unavailable", "cancelled"].indexOf(result.outcome) === -1 &&
        ["failed", "blocked", "requestCancelled", "http4xx", "http5xx", "pending", "unattributed", "cspIssues"].every(function (key) { return counts[key] === 0; })) {
      html += '<p style="color:var(--text-muted);">' + icon("info", 12) + ' ' + esc(t("network.no-errors")) + '</p>';
    }
    if (result.detailUnavailable) html += '<p class="hint-line">' + esc(t("network.detail-unavailable")) + '</p>';
    html += result.hops.map(networkHopHtml).join("");
    html += result.httpStatusEvidence.map(function (evidence) {
      // Chain-level evidence stays separate. Do not guess which redirect hop
      // owns an ambiguous status, nor overwrite browser status with wire status.
      return '<div data-network-http-evidence="' + escAttr(evidence.id) + '" style="font-size:11px;padding:6px 0;color:var(--text-muted);">' +
        esc(t("network.status.extra-info")) + ': ' + evidence.status + ' · ' + esc(t("network.status.association." + evidence.association)) + '</div>';
    }).join("");
    body.innerHTML = html;
  }
  function discardNetworkDetails(notice) {
    var view = healthDialogs.network, request = view.request;
    view.seq++; view.pageSeq++;
    if (view.dirId) invalidateHealthKind(view.dirId, "network");
    if (request) { request.discarded = true; request.selection = null; unsubscribeNetworkRequest(request); }
    view.pages = []; view.selection = null; view.origin = ""; view.latestResult = null; view.loading = false;
    view.phase = "cancelled"; view.notice = notice || "network.completion.cancelled";
    renderNetworkView();
    return request;
  }
  function sendNetworkCancellation(request, notify) {
    if (!request || request.kind !== "network" || request.settled || !request.invoked || request.cancelSent || detectInFlight[request.dirId] !== request) return;
    request.cancelSent = true; request.cancelPending = true;
    var seq = healthDialogs.network.seq, dirId = request.dirId;
    updateNetworkControls();
    lcall("browser.healthCancel:" + request.requestId, function () {
      return networkSafeInvoke(function () { return api.browser.healthCancel(dirId, { kind: "network", requestId: request.requestId }); }, "health.cancel-not-confirmed");
    }).then(function (response) {
      request.cancelRequested = !!(response && response.success && response.cancelled);
      if (notify && networkViewCurrent(seq, dirId) && !request.settled) toast(t(request.cancelRequested ? "health.cancel-requested" : "health.cancel-not-confirmed"), "warning");
    }).catch(function () {
      if (notify && networkViewCurrent(seq, dirId) && !request.settled) toast(t("health.cancel-not-confirmed"), "warning");
    }).finally(function () { request.cancelPending = false; if (healthDialogs.network.request === request) updateNetworkControls(); });
  }
  function retireNetworkView(close, notice) {
    var view = healthDialogs.network;
    if (!view.dirId && !view.request) return;
    var request = discardNetworkDetails(notice);
    sendNetworkCancellation(request, false);
    view.request = null;
    if (close) view.dirId = null;
    renderNetworkView();
  }
  agentBrowser.openNetworkDiagnostics = function (dirId) {
    var dialog = document.getElementById("dlg-network-observation"), view = healthDialogs.network;
    if (!dialog || typeof dirId !== "string" || !dirId) { toast(t("network.unavailable"), "warning"); return; }
    retireNetworkView(false);
    view.seq++; view.pageSeq++; view.dirId = dirId; view.request = null; view.notice = null; view.phase = "idle";
    if (!dialog._networkLifecycleBound) {
      dialog._networkLifecycleBound = true;
      dialog.addEventListener("cancel", function () { retireNetworkView(true); });
      dialog.addEventListener("close", function () { if (!dialog.open) retireNetworkView(true); });
    }
    if (!dialog.open) dialog.showModal();
    agentBrowser.refreshNetworkPages();
  };
  agentBrowser.refreshNetworkPages = function () {
    var view = healthDialogs.network;
    if (!view.dirId || view.request && !view.request.settled && !view.request.discarded || healthClearInFlight[view.dirId]) return;
    var dirId = view.dirId, seq = view.seq, pageSeq = ++view.pageSeq;
    view.pages = []; view.selection = null; view.origin = ""; view.latestResult = null; view.loading = true; view.phase = "choosing"; view.notice = "network.pages.loading";
    renderNetworkView();
    lcall("browser.networkPages:" + dirId + ":" + pageSeq, function () {
      return networkSafeInvoke(function () { return api.browser.networkPages(dirId); });
    }).then(function (response) {
      if (!networkViewCurrent(seq, dirId, pageSeq)) return;
      if (!response || response.ok !== true || !Array.isArray(response.pages) || response.pages.length > 32) {
        view.phase = "unavailable"; view.notice = networkFailureCopy(response && response.code); return;
      }
      var seen = Object.create(null);
      view.pages = response.pages.filter(function (page) {
        if (!page || typeof page.handle !== "string" || !page.handle || page.handle.length > 1024 || /[\x00-\x1f\x7f]/.test(page.handle) || seen[page.handle] ||
            !networkOrigin(page.origin) || !Number.isSafeInteger(page.ordinal) || page.ordinal < 1) return false;
        seen[page.handle] = true; return true;
      }).map(function (page) { return { handle: page.handle, origin: networkOrigin(page.origin), ordinal: page.ordinal }; });
      view.notice = view.pages.length ? "network.choose" : "network.pages.empty";
    }).catch(function () { if (networkViewCurrent(seq, dirId, pageSeq)) { view.phase = "unavailable"; view.notice = "network.unavailable"; } })
      .finally(function () { if (networkViewCurrent(seq, dirId, pageSeq)) { view.loading = false; renderNetworkView(); } });
  };
  agentBrowser.networkPageChanged = function () {
    var view = healthDialogs.network, select = document.getElementById("network-page-select");
    if (!view.dirId || !select || view.loading || view.request && !view.request.settled && !view.request.discarded || healthClearInFlight[view.dirId]) return;
    var page = view.pages.find(function (page) { return page.handle === select.value; });
    view.selection = page ? page.handle : null; view.origin = page ? page.origin : "";
    renderNetworkChooser();
  };
  agentBrowser.startNetworkObservation = function () {
    var view = healthDialogs.network;
    if (!view.dirId || view.loading || !view.selection || !view.pages.some(function (page) { return page.handle === view.selection; })) return;
    var request = beginHealthRequest(view.dirId, "network");
    if (!request) return;
    request.view = view.seq; request.selection = view.selection; request.armed = false;
    view.request = request; view.pages = []; view.selection = null; view.latestResult = null; view.phase = "setup"; view.notice = null;
    renderNetworkView();
    try {
      request.networkUnsubscribe = api.browser.onNetworkArmed(function (event) {
        if (!healthRequestCurrent(request) || !request.invoked || request.settled || request.armed || !networkExactKeys(event, ["dirId", "requestId", "armedAt", "observeForMs"]) ||
            event.dirId !== request.dirId || event.requestId !== request.requestId || event.observeForMs !== 10000 || !Number.isSafeInteger(event.armedAt) || event.armedAt < 0) return;
        request.armed = true; view.phase = "observing10s"; view.notice = null; renderNetworkView();
      });
      if (typeof request.networkUnsubscribe !== "function") throw new Error("NETWORK_ARMED_SUBSCRIPTION_UNAVAILABLE");
    } catch (error) {
      unsubscribeNetworkRequest(request); request.selection = null; view.phase = "unavailable"; view.notice = "network.unavailable";
      finishHealthRequest(request); renderNetworkView(); return;
    }
    healthCall("browser.networkObserve", function () {
      if (!healthRequestCurrent(request)) { request.selection = null; return null; }
      var selection = request.selection; request.selection = null;
      return networkSafeInvoke(function () {
        if (!healthRequestCurrent(request)) return null;
        request.invoked = true;
        return api.browser.networkObserve(request.dirId, { selection: selection, requestId: request.requestId });
      })
        .then(function (response) { return healthRequestCurrent(request) ? projectNetworkReply(response, request) : null; });
    }, request).then(function (result) {
      if (!healthRequestCurrent(request)) return;
      if (!healthResponseCurrent(request, result)) { view.phase = "unavailable"; view.notice = "network.unavailable"; renderNetworkView(); return; }
      view.latestResult = result; view.phase = result.observation ? result.observation.completion : "unavailable"; view.notice = result.notice;
      renderNetworkView();
      // Do not synthesize a persisted history entry from the transient result.
      // A failed canonical refresh retains the old summary only as unverified.
      refreshHealthSummary(request.dirId, true).catch(function () { /* The reader marks the retained safe summary unverified. */ });
    }).catch(function () {
      if (healthRequestCurrent(request)) { view.phase = "unavailable"; view.notice = "network.unavailable"; renderNetworkView(); }
    }).finally(function () { unsubscribeNetworkRequest(request); finishHealthRequest(request); });
  };
  agentBrowser.cancelNetworkObservation = function () {
    var view = healthDialogs.network, request = view.request;
    if (!request || request.settled || request.discarded) return;
    discardNetworkDetails(); sendNetworkCancellation(request, true);
  };
  agentBrowser.networkObservationClear = function () {
    var view = healthDialogs.network, dirId = view.dirId, seq = view.seq;
    if (!dirId || healthClearInFlight[dirId]) return;
    agentBrowser.confirm(t("network.clear-confirm"), function () {
      if (!networkViewCurrent(seq, dirId) || healthClearInFlight[dirId]) return;
      var request = discardNetworkDetails("network.clearing");
      var epoch = healthEpoch[healthEpochKey(dirId, "network")], clearSeq = view.seq, cleared = false, failureCopy = "health.clear-failed";
      healthClearInFlight[dirId] = true; sendNetworkCancellation(request, false); updateNetworkControls();
      agentBrowser.ipc.call("network.clear:" + dirId, function () {
        return networkSafeInvoke(function () { return api.browser.healthClear(dirId, "network"); }, "health.clear-failed");
      }, { kind: "write", timeoutMs: 0, slowNoticeMs: 15000, onSlow: function () {
        if (networkViewCurrent(clearSeq, dirId)) toast(t("network.clearing"), "warning");
      } }).then(function (response) {
        if (!response || response.ok !== true) { failureCopy = response && response.code ? networkFailureCopy(response.code) : "health.clear-failed"; throw new Error(t(failureCopy)); }
        cleared = true; return queryHealthHistory(dirId, true);
      }).then(function (entries) {
        if (epoch !== healthEpoch[healthEpochKey(dirId, "network")]) return;
        removeCachedHealthKind(dirId, "network");
        healthHistoryByProfile[dirId] = { entries: entries }; healthReadSeq[dirId] = (healthReadSeq[dirId] || 0) + 1; updateHealthCard(dirId);
        if (!networkViewCurrent(clearSeq, dirId)) return;
        view.phase = "idle"; view.notice = "network.cleared"; renderNetworkView(); toast(t("network.cleared"), "success");
      }).catch(function () {
        if (cleared && epoch === healthEpoch[healthEpochKey(dirId, "network")]) {
          var previous = healthHistoryByProfile[dirId];
          healthHistoryByProfile[dirId] = { entries: (previous ? previous.entries : cachedHealthEntries(dirId)).map(function (entry) { return entry.kind === "network" ? Object.assign({}, entry, { unverified: true }) : entry; }), error: t("health.clear-unverified") };
          updateHealthCard(dirId);
        }
        if (!networkViewCurrent(clearSeq, dirId)) return;
        view.notice = cleared ? "health.clear-unverified" : failureCopy; renderNetworkView(); toast(t(view.notice), "error");
      }).finally(function () { delete healthClearInFlight[dirId]; if (networkViewCurrent(clearSeq, dirId)) updateNetworkControls(); });
    }, { title: t("network.clear-title") });
  };

  if (typeof document.addEventListener === "function") document.addEventListener("agent-browser-language-change", function () {
    Object.keys(healthHistoryByProfile).forEach(updateHealthCard);
    if (healthDialogs.network.dirId) renderNetworkView();
    ["env", "webrtc"].forEach(function (kind) {
      var view = healthDialogs[kind];
      if (!view.dirId) return;
      if (view.latestResult) {
        if (kind === "env") renderEnvRisk(view.latestResult);
        else renderWebRtcDiag(view.latestResult);
      }
      if (view.historyEntries) renderDiagnosticHistory(kind, view.historyEntries);
    });
  });

  agentBrowser.openApp = function(dirId) {
    api.browser.list().then(function(profiles) {
      var p = (profiles || []).find(function(x) { return x.dirId === dirId; });
      var appUrl = (p && p.appUrl) || "";
      if (!appUrl) {
        toast((window.i18n ? window.i18n.t("toast.app.no-url", "No Web App URL configured — set one in Profile Edit") : "No Web App URL configured — set one in Profile Edit"), "error");
        agentBrowser.editProfile(dirId);
        return;
      }
      toast((window.i18n ? window.i18n.t("toast.app.opening", "Opening as Web App (auto-launch if needed)…") : "Opening as Web App (auto-launch if needed)…"), "info");
      api.browser.openApp(dirId).then(function(r) {
        if (r && r.success) {
          toast((window.i18n ? window.i18n.t("toast.app.opened", "Web App opened: ") : "Web App opened: ") + (r.appUrl || appUrl), "success");
          scheduleProfilesRefresh();
        } else {
          toast((r && r.error) || (window.i18n ? window.i18n.t("toast.app.failed", "Failed to open Web App") : "Failed to open Web App"), "error");
        }
      }).catch(function(e) { toast(e.message || String(e), "error"); });
    }).catch(function(e) { toast(e.message || String(e), "error"); });
  };

  function renderProfileLogs(r) {
    var activityEl = document.getElementById("profile-logs-activity");
    var tailEl = document.getElementById("profile-logs-tail");
    if (!activityEl || !tailEl) return;
    if (!r || !r.success) {
      activityEl.innerHTML = '<div class="empty-state">' + esc((r && r.error) || "Failed to load logs") + '</div>';
      tailEl.textContent = "";
      return;
    }
    var entries = r.activity || [];
    if (!entries.length) {
      activityEl.innerHTML = '<div class="empty-state">' + esc(t("logs.no-activity", "No activity yet")) + '</div>';
    } else {
      activityEl.innerHTML = entries.map(function(e) {
        var when = e.at ? new Date(e.at).toLocaleString() : "?";
        var catIcon = e.category === "profile" ? "box" : "info";
        return '<div style="padding:4px 6px;border-bottom:1px solid var(--border);">' +
          '<span class="hint-line" style="white-space:nowrap;">' + esc(when) + '</span> ' +
          icon(catIcon, 12) + ' <strong>' + esc(e.action || "?") + '</strong>' +
          (e.detail ? ' <span style="color:var(--text-muted);font-size:11px;">— ' + esc(String(e.detail).slice(0, 140)) + '</span>' : '') +
          '</div>';
      }).join("");
    }
    tailEl.textContent = r.logTail || (t("logs.no-tail", "No browser log yet (generated once the profile starts)"));
  }

  agentBrowser.showProfileLogs = function(dirId) {
    document.getElementById("profile-logs-dir-id").value = dirId;
    var dlg = document.getElementById("dlg-profile-logs");
    if (!dlg) { toast(t("logs.unavailable", "Log dialog unavailable"), "error"); return; }
    dlg.showModal();
    agentBrowser.refreshProfileLogs();
  };

  agentBrowser.refreshProfileLogs = function() {
    var dirId = document.getElementById("profile-logs-dir-id").value;
    if (!dirId) return;
    var activityEl = document.getElementById("profile-logs-activity");
    var tailEl = document.getElementById("profile-logs-tail");
    // R172: both were hardcoded EN in the zh UI.
    if (activityEl) activityEl.innerHTML = '<div class="loading">' + esc(t("common.loading", "Loading…")) + '</div>';
    if (tailEl) tailEl.textContent = t("common.loading", "Loading…");
    api.browser.logs(dirId).then(function(r) {
      renderProfileLogs(r || { success: false, error: "unknown" });
    }).catch(function(e) {
      renderProfileLogs({ success: false, error: e.message || String(e) });
    });
  };

  agentBrowser.toggleLock = function(dirId, card) {
    var locked = card ? card.dataset.lock === "1" : false;
    var apply = function() {
      wcall("browser.setLock", function () { return api.browser.setLock(dirId, !locked); }).then(function(r) {
        if (!r || !r.success) { toast((r && r.error) || 'Lock failed', 'error'); return; }
        toast(locked ? t('profile.lock.unlocked', 'Unlocked (remember to push)') : t('profile.lock.locked', 'Locked to this device (remember to push)'), 'success');
        agentBrowser.loadProfiles();
      }).catch(function(e) { toast(e.message || String(e), 'error'); });
    };
    if (!locked) {
      agentBrowser.confirm(t('profile.lock.confirm', 'Lock this profile to the current device? Other devices can no longer overwrite it on push (a forced push still can).\n\nRemember to push once so the lock syncs to the remote.'), apply);
      return;
    }
    apply();
  };

  var BACKUP_HINT_KEY = "abs-backup-hint-dismissed";

  function updateBackupHint(hasProfiles) {
    var el = document.getElementById("backup-hint");
    if (!el) return;
    var dismissed = false;
    try { dismissed = !!localStorage.getItem(BACKUP_HINT_KEY); } catch (e) { dismissed = false; }
    el.style.display = (hasProfiles && !dismissed) ? "flex" : "none";
  }

  agentBrowser.dismissBackupHint = function () {
    var el = document.getElementById("backup-hint");
    if (el) el.style.display = "none";
    try { localStorage.setItem(BACKUP_HINT_KEY, "1"); } catch (e) { /* storage disabled */ }
  };

  agentBrowser.loadProfiles = loadProfiles;

})();
