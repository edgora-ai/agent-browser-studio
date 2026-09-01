(function() {
  "use strict";

  var agentBrowser = window.agentBrowser;
  var api = agentBrowser.api;
  var R = agentBrowser.R;
  var state = agentBrowser.state;
  var profileFilter = { status: "all", tags: [] };
  var profileSelection = {};
  var helpers = agentBrowser.helpers;
  var toast = helpers.toast;
  var esc = helpers.esc;
  var escAttr = helpers.escAttr;
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
  function writeGeolocationFields(prefix, meta) {
    document.getElementById(prefix + "geolocation-mode").value = meta.geolocationMode || "real";
    document.getElementById(prefix + "geolocation-latitude").value = meta.geolocationLatitude == null ? "" : meta.geolocationLatitude;
    document.getElementById(prefix + "geolocation-longitude").value = meta.geolocationLongitude == null ? "" : meta.geolocationLongitude;
    document.getElementById(prefix + "geolocation-accuracy").value = meta.geolocationAccuracy == null ? "" : meta.geolocationAccuracy;
  }

  function populateChromiumVersionSelect(id, selectedVersion) {
    var select = document.getElementById(id);
    if (!select) return Promise.resolve();
    var selected = selectedVersion || "";
    return api.browser.binary().then(function(info) {
      var versions = (info && info.installedVersions) || [];
      select.innerHTML = "";
      select.appendChild(new Option("Auto (newest installed)", ""));
      versions.forEach(function(item) {
        select.appendChild(new Option(item.version, item.version));
      });
      if (selected && !versions.some(function(item) { return item.version === selected; })) {
        select.appendChild(new Option(selected + " (not installed)", selected));
      }
      select.value = selected;
    }).catch(function() {
      select.value = selected;
    });
  }

  Object.assign(agentBrowser, {
  launch: function (dirId) {
        // PL-06: block edit/delete while the launch is in flight.
        setCardBusy(dirId, true);
        agentBrowser.ipc.call("browser.launch:" + dirId, function () { return api.browser.launch(dirId); }, { kind: "launch", dedupe: true })
          .then(function (r) {
            if (r.success) {
              toast(t("toast.profile.started", "🥷 Managed Chromium started") + " (CDP port " + r.cdpPort + ")", "success");
              if (r.envCheck && r.envCheck.high) {
                var envCodes = (r.envCheck.findings || []).filter(function(f){ return f.severity === "high"; }).map(function(f){ return f.code; }).join(", ");
                toast(t("toast.env.high-risk", "⚠️ Environment risk: ") + (envCodes || t("toast.env.high-generic", "host environment risk")) + t("toast.env.high-hint", " — open 🖥 Env on the card for fixes"), "error");
              }
              var seq = markProfileRuntime(dirId, true, r.pid);
              setTimeout(function () { clearProfileRuntime(dirId, seq); scheduleProfilesRefresh(); }, 5000);
              scheduleProfilesRefresh();
            } else {
              // PL-04: proxy failures are fail-closed, so the reason matters.
              // UX-3: the friendly-error layer already renders localized,
              // actionable copy for proxy failures — no extra hint needed.
              toast(r.error || t("toast.profile.launch-failed", "Managed Chromium launch failed"), "error");
            }
          })
          .catch(function (e) { toast(e.message, "error"); })
          .then(function () { setCardBusy(dirId, false); });
      },

  stop: function (dirId) {
        setCardBusy(dirId, true);
        agentBrowser.ipc.call("browser.stop:" + dirId, function () { return api.browser.stop(dirId); }, { kind: "stop", dedupe: true })
          .then(function (r) {
            if (r && r.success === false) { toast(r.error || t("toast.profile.stop-failed", "Stop failed"), "error"); scheduleProfilesRefresh(); return; }
            toast(t("toast.profile.stopped", "Browser stopped"), "success");
            var seq = markProfileRuntime(dirId, false, null);
            setTimeout(function () { clearProfileRuntime(dirId, seq); scheduleProfilesRefresh(); }, 5000);
            scheduleProfilesRefresh();
          })
          .catch(function (e) { toast(e.message, "error"); })
          .then(function () { setCardBusy(dirId, false); });
      },

  editProfile: function (dirId) {
        api.browser.list().then(function(profiles) {
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
            appUrl: p.appUrl || '',
            proxyMode: p.proxyMode || (p.proxyName ? "named" : "none"),
            proxyName: p.proxyName || null
          };
          document.getElementById("agent-browser-meta-dir-id").value = dirId;
          document.getElementById("agent-browser-meta-fingerprint-mode").value = metaData.fingerprintMode;
          populateChromiumVersionSelect("agent-browser-meta-browser-version", metaData.browserVersion);
          document.getElementById("agent-browser-meta-allow-third-party-cookies").checked = metaData.allowThirdPartyCookies;
          document.getElementById("agent-browser-meta-drm").checked = metaData.drm;
          document.getElementById("agent-browser-meta-name").value = metaData.name;
          document.getElementById("agent-browser-meta-seed").value = metaData.seed;
          document.getElementById("agent-browser-meta-platform").value = metaData.platform;
          document.getElementById("agent-browser-meta-timezone").value = metaData.timezone;
          document.getElementById("agent-browser-meta-locale").value = metaData.locale;
          document.getElementById("agent-browser-meta-webrtc-mode").value = metaData.webrtcMode;
          document.getElementById("agent-browser-meta-webrtc").value = metaData.webrtcIp;
          writeGeolocationFields("agent-browser-meta-", metaData);
          writeHardwareFields("agent-browser-meta-", metaData);
          bindHardwareFieldValidation("agent-browser-meta-");
          var wtPrefixMeta = metaData.windowTitlePrefix;
          var wtEnabled = wtPrefixMeta !== null;
          var wtPrefix = (wtPrefixMeta && wtPrefixMeta !== "") ? wtPrefixMeta : "";
          document.getElementById("agent-browser-meta-window-title-enabled").checked = wtEnabled;
          document.getElementById("agent-browser-meta-window-title-prefix").value = wtPrefix;
          document.getElementById("agent-browser-meta-app-url").value = metaData.appUrl;
          api.proxy.list().then(function(proxies) {
            var sel = document.getElementById("agent-browser-meta-proxy");
            sel.innerHTML = renderProxyOptions(proxies, proxySelectionValue(metaData.proxyMode, metaData.proxyName), false);
          });
          document.getElementById("dlg-agent-browser-seed").showModal();
        }).catch(function (e) { toast(e.message, "error"); });
      },

  openDir: function (dirId) {
        api.profile.get(dirId).then(function (info) {
          return api.app.openDir(info.path);
        }).catch(function (e) { toast(e.message, "error"); });
      },

  delProfile: function (dirId) {
        agentBrowser.confirm("Delete profile? All data will be removed.", function () {
          api.browser.delete(dirId).then(function (r) {
            if (r && r.success) { toast((window.i18n ? window.i18n.t("toast.deleted", "Deleted") : "Deleted"), "success"); agentBrowser.refresh(); }
            else toast((r && r.error) || (window.i18n ? window.i18n.t("toast.failed", "Failed") : "Failed"), "error");
          }).catch(function (e) { toast(e.message, "error"); });
        });
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
        api.browser.setMeta(dirId, { name: newName }).then(function (r) {
          document.getElementById("dlg-rename").close();
          if (r.success) { toast((window.i18n ? window.i18n.t("toast.renamed", "Renamed") : "Renamed"), "success"); agentBrowser.refresh(); }
          else toast(r.error || "Failed", "error");
        }).catch(function (e) { toast(e.message, "error"); });
      },

  proxyChanged: function (dirId, selectEl) {
        var selection = parseProxySelection(selectEl.value, "none");
        api.proxy.setProfile(dirId, selection.name, selection.mode).then(function (r) {
          if (r && r.success === false) { toast(r.error || (window.i18n ? window.i18n.t("toast.proxy.update-failed", "Proxy update failed") : "Proxy update failed"), "error"); agentBrowser.refresh(); return; }
          toast((window.i18n ? window.i18n.t("toast.proxy.updated", "Proxy updated") : "Proxy updated"), "success"); agentBrowser.refresh();
        }).catch(function (e) { toast(e.message, "error"); });
      },

  loadNewProfileProxies: function () {
        return api.proxy.list().then(function (proxies) {
          document.getElementById("new-profile-proxy").innerHTML = renderProxyOptions(proxies, "default", false);
        }).catch(function (e) { toast((window.i18n ? window.i18n.t("toast.proxy.load-failed", "Failed to load proxies") : "Failed to load proxies") + ": " + e.message, "error"); });
      },

  resetNewProfileForm: function (browser) {
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
        document.getElementById("new-agent-browser-platform").value = "windows";
        document.getElementById("new-agent-browser-timezone").value = "";
        document.getElementById("new-agent-browser-locale").value = "";
        document.getElementById("new-agent-browser-webrtc").value = "";
        writeGeolocationFields("new-agent-browser-", {});
        writeHardwareFields("new-agent-browser-", {});
        bindHardwareFieldValidation("new-agent-browser-");
        var presetSelect = document.getElementById("new-profile-preset");
        if (presetSelect) presetSelect.value = "";
        var presetInfo = document.getElementById("new-profile-preset-info");
        if (presetInfo) { presetInfo.style.display = "none"; presetInfo.innerHTML = ""; }
      },

  loadBusinessPresets: function () {
        var select = document.getElementById("new-profile-preset");
        if (!select) return Promise.resolve([]);
        return api.browser.presets().then(function(list) {
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
        // Coherent identity prefill (advanced section fields).
        var nameEl = document.getElementById("new-profile-name");
        if (nameEl && !nameEl.value.trim()) nameEl.value = preset.nameSuffix;
        var platformEl = document.getElementById("new-agent-browser-platform");
        if (platformEl) platformEl.value = preset.profile.platform;
        var tzEl = document.getElementById("new-agent-browser-timezone");
        if (tzEl) tzEl.value = preset.profile.timezone;
        var locEl = document.getElementById("new-agent-browser-locale");
        if (locEl) locEl.value = preset.profile.locale;
        var webrtcModeEl = document.getElementById("new-agent-browser-webrtc-mode");
        if (webrtcModeEl) webrtcModeEl.value = preset.profile.webrtcMode;
        try {
          writeGeolocationFields("new-agent-browser-", {
            geolocationMode: preset.profile.geolocationMode,
            geolocationLatitude: preset.profile.geolocationLatitude,
            geolocationLongitude: preset.profile.geolocationLongitude,
            geolocationAccuracy: preset.profile.geolocationAccuracy,
          });
        } catch (e) { /* ignore */ }
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

  newProfile: function () {
        agentBrowser.resetNewProfileForm("chromium");
        agentBrowser.loadBusinessPresets();
        agentBrowser.loadNewProfileProxies();
        agentBrowser.profileBrowserChanged();
        var adv = document.getElementById("new-profile-advanced");
        if (adv && adv.open) adv.open = false; // RoxyBrowser 4.0.3-style: basic fields first, advanced collapsed
        document.getElementById("dlg-profile").showModal();
      },

  quickCreateProfile: function () {
        var base = (window.i18n ? window.i18n.t("profiles.quick-name", "Quick Profile") : "Quick Profile");
        api.browser.create({ name: base }).then(function(r) {
          if (!r || !r.dirId) { toast((r && r.error) || "Quick create failed", "error"); return; }
          toast((window.i18n ? window.i18n.t("toast.profile.quick-created", "Profile created") : "Profile created") + ": " + base, "success");
          loadProfiles();
        }).catch(function(e) { toast(e.message || String(e), "error"); });
      },

  profileBrowserChanged: function() {
        var browser = (document.getElementById("new-profile-browser") || {}).value || "chromium";
        var chromeOpts = document.getElementById("new-profile-chrome-opts");
        var browserOptions = document.getElementById("new-profile-agent-browser-opts");
        var firefoxOpts = document.getElementById("new-profile-firefox-opts");
        var isFirefox = browser === "firefox";
        if (chromeOpts) chromeOpts.style.display = "none";
        if (browserOptions) browserOptions.style.display = isFirefox ? "none" : "block";
        if (firefoxOpts) firefoxOpts.style.display = isFirefox ? "block" : "none";
        var browserRow = document.getElementById("new-profile-browser-row");
        if (browserRow) browserRow.style.display = "block";
        var proxyRow = document.getElementById("new-profile-proxy-row");
        if (proxyRow) proxyRow.style.display = "block";
        agentBrowser.loadNewProfileProxies();
      },

  createProfile: function () {
        var name = document.getElementById("new-profile-name").value.trim();
        var proxySelection = parseProxySelection(document.getElementById("new-profile-proxy").value, "default");
        var businessPresetId = document.getElementById("new-profile-preset").value || undefined;

        if (!name) { toast((window.i18n ? window.i18n.t("toast.profile.name-prompt", "Please enter a name") : "Please enter a name"), "error"); return; }

        var browserPlatform = document.getElementById("new-agent-browser-platform").value;
        var fingerprintMode = document.getElementById("new-agent-browser-fingerprint-mode").value || "managed";
        var browserVersion = document.getElementById("new-agent-browser-browser-version").value || null;
        var allowThirdPartyCookies = document.getElementById("new-agent-browser-allow-third-party-cookies").checked;
        var drm = document.getElementById("new-agent-browser-drm").checked;
        var seedRaw = document.getElementById("new-agent-browser-seed").value.trim();
        var seed = seedRaw ? Number(seedRaw) : undefined;
        if (seed !== undefined && (!Number.isInteger(seed) || seed < 1 || seed > 999999)) { toast((window.i18n ? window.i18n.t("toast.invalid-seed", "Invalid seed") : "Invalid seed"), "error"); return; }
        var tz = document.getElementById("new-agent-browser-timezone").value || undefined;
        var loc = document.getElementById("new-agent-browser-locale").value || undefined;
        var webrtcMode = document.getElementById("new-agent-browser-webrtc-mode").value || "auto";
        var webrtcIp = document.getElementById("new-agent-browser-webrtc").value.trim() || undefined;
        var windowTitlePrefix = document.getElementById("new-agent-browser-window-title-enabled").checked ? "" : null;
        if (webrtcMode === "real" || webrtcMode === "disable") webrtcIp = undefined;
        var hardware, geolocation;
        // UE-04: validate on submit and point at the offending field instead of
        // surfacing a technical field name in a toast.
        var newErrors = validateHardwareFields("new-agent-browser-");
        if (newErrors.length) {
          clearFieldErrors("new-agent-browser-");
          showFieldErrors(newErrors);
          toast(t("toast.form.invalid", "Please fix the highlighted fields"), "error");
          return;
        }
        try { hardware = readHardwareFields("new-agent-browser-"); geolocation = readGeolocationFields("new-agent-browser-"); }
        catch (e) { toast(e.message || String(e), "error"); return; }

        var engine = (document.getElementById("new-profile-browser").value === "firefox") ? "firefox" : undefined;
        api.browser.create(Object.assign({
          name: name,
          engine: engine,
          fingerprintMode: fingerprintMode,
          browserVersion: browserVersion,
          allowThirdPartyCookies: allowThirdPartyCookies,
          drm: drm,
          fingerprintSeed: seed,
          platform: browserPlatform,
          timezone: tz,
          locale: loc,
          webrtcMode: webrtcMode,
          webrtcIp: webrtcIp,
          proxyMode: proxySelection.mode,
          windowTitlePrefix: windowTitlePrefix,
          proxyName: proxySelection.name,
          businessPresetId: businessPresetId,
        }, geolocation, hardware)).then(function(r) {
          document.getElementById("dlg-profile").close();
          toast((window.i18n ? window.i18n.t("toast.profile.created", "Managed Chromium profile created!") : "Managed Chromium profile created!"), "success");
          loadProfiles();
          agentBrowser.switchTab("profiles");
        }).catch(function(e) { toast(e.message, "error"); });
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
    if (!text) { statusEl.innerHTML = '<span style="color:var(--danger);">Enter profile definitions</span>'; return; }
    // Parse via the shared CSV parser (supports header + per-row proxy/tags).
    api.browser.parseBulkCsv(text).then(function(res) {
      if (!res || !res.ok || !res.specs || !res.specs.length) {
        statusEl.innerHTML = '<span style="color:var(--danger);">No valid rows (use a header: name,platform,locale,timezone,seed,proxy,webrtc,tags)</span>';
        return;
      }
      var specs = res.specs;
      var total = specs.length, done = 0, errors = 0;
      statusEl.innerHTML = '<span style="color:var(--primary);">Importing ' + total + ' profiles...</span>';
      function processNext(idx) {
        if (idx >= specs.length) {
          statusEl.innerHTML = '<span style="color:var(--success);">Imported ' + done + '/' + total + (errors ? ' (' + errors + ' errors)' : '') + '</span>';
          setTimeout(function() { document.getElementById("dlg-bulk-import").close(); agentBrowser.refresh(); }, 1000);
          return;
        }
        var s = specs[idx];
        // Per-row proxy wins; else the dialog's fallback selection.
        var proxyMode = s.proxyName ? "named" : fallbackProxy.mode;
        var proxyName = s.proxyName || fallbackProxy.name;
        api.browser.create({
          name: s.name,
          platform: s.platform || "windows",
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
        }).then(function() {
          done++;
          statusEl.innerHTML = '<span style="color:var(--primary);">' + done + '/' + total + ' imported...</span>';
          processNext(idx + 1);
        }).catch(function() { errors++; processNext(idx + 1); });
      }
      processNext(0);
    }).catch(function(e) { statusEl.innerHTML = '<span style="color:var(--danger);">' + esc((e && e.message) || e) + '</span>'; });
  };

  agentBrowser.exportProfileArchive = function(dirId) {
    api.profile.exportArchive(dirId).then(function(r) {
      if (!r || !r.success) {
        toast(t("toast.profile.export-failed", "Export failed: ") + ((r && r.error) || "unknown"), "error");
        return;
      }
      toast(t("toast.profile.exported", "Exported backup: ") + esc(r.filePath), "success");
    }).catch(function(e) {
      toast(t("toast.profile.export-failed", "Export failed: ") + (e.message || String(e)), "error");
    });
  };

  agentBrowser.importProfileArchive = function() {
    api.profile.importArchives().then(function(r) {
      if (!r || !r.success) {
        toast(t("toast.profile.import-failed", "Import failed: ") + ((r && r.error) || "unknown"), "error");
        return;
      }
      var rep = (r && r.report) || {};
      var imported = (rep.imported || []).length;
      var failed = (rep.failed || []).length;
      if (imported === 0 && failed === 0) return;
      var msg = t("toast.profile.imported", "Imported {n} profiles").replace("{n}", imported);
      if (failed) msg += t("toast.profile.import-failed-count", ", {n} failed").replace("{n}", failed);
      toast(msg, failed ? "error" : "success");
      loadProfiles();
    }).catch(function(e) {
      toast(t("toast.profile.import-failed", "Import failed: ") + (e.message || String(e)), "error");
    });
  };

  // Batch start/stop (review items PL-01 / PL-02).
  // Both now delegate to the bounded-concurrency batch runner and report the
  // real per-profile tally instead of a hard-coded "N profiles started".
  function finishBatch() { agentBrowser.refresh(); }

  agentBrowser.bulkStart = function() {
    api.browser.list().then(function(profiles) {
      var stopped = (profiles || []).filter(function(p) { return !p.running; });
      if (stopped.length === 0) { toast(t("toast.bulk.all-running", "All profiles are already running"), "success"); return; }
      agentBrowser.batch.run({ kind: "launch", dirIds: stopped.map(function(p) { return p.dirId; }) })
        .then(finishBatch, finishBatch);
    }).catch(function(){});
  };

  agentBrowser.bulkStop = function() {
    api.browser.list().then(function(profiles) {
      var running = (profiles || []).filter(function(p) { return p.running; });
      if (running.length === 0) { toast(t("toast.bulk.none-running", "No profiles are running"), "success"); return; }
      agentBrowser.batch.run({ kind: "stop", dirIds: running.map(function(p) { return p.dirId; }) })
        .then(finishBatch, finishBatch);
    }).catch(function(){});
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
    if (sel && proxies && proxies.length) {
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

  agentBrowser.batchAssignProxy = function() {
    var sel = selectedProfileIds();
    if (!sel.length) return;
    var proxyEl = document.getElementById("batch-assign-proxy");
    var proxyValue = proxyEl ? proxyEl.value : "";
    var mode = proxyValue ? "named" : "default";
    var proxyName = proxyValue || null;
    var total = sel.length, done = 0, errors = 0;
    sel.forEach(function (dirId) {
      api.proxy.setProfile(dirId, proxyName, mode).then(function (r) {
        done++;
        if (r && r.success === false) errors++;
        if (done === total) {
          if (errors) toast(t("toast.batch.assign-partial", "Assigned {ok}/{total} profiles ({failed} failed)").replace("{ok}", total - errors).replace("{total}", total).replace("{failed}", errors), "error");
          else toast(t("toast.batch.assign-ok", "Assigned the proxy to {n} profiles").replace("{n}", total), "success");
          loadProfiles();
        }
      }).catch(function () { done++; errors++; if (done === total) { toast(t("toast.batch.assign-done", "Assigned {ok}/{total} profiles").replace("{ok}", total - errors).replace("{total}", total), "error"); loadProfiles(); } });
    });
  };

  // PL-09: restores are serialised so two profiles never race for the same
  // directory while it is being moved back out of the trash.
  function restoreFromTrash(ids) {
    var pending = ids.slice();
    var restored = 0, failed = 0;
    function next() {
      if (!pending.length) {
        if (failed) {
          toast(t("toast.trash.restore-partial", "Restored {ok}, {failed} could not be restored")
            .replace("{ok}", restored).replace("{failed}", failed), "error");
        } else {
          toast(t("toast.trash.restore-ok", "Restored {n} profiles").replace("{n}", restored), "success");
        }
        loadProfiles();
        return;
      }
      var id = pending.shift();
      agentBrowser.ipc.call("profile.trash-restore:" + id, function () { return api.profile.trashRestore(id); }, { kind: "write" })
        .then(function (r) { if (r && r.success) restored++; else failed++; })
        .catch(function () { failed++; })
        .then(next);
    }
    next();
  }

  function deleteProfilesWithTally(sel) {
    var total = sel.length, done = 0, errors = 0;
    sel.forEach(function (dirId) {
      // PL-09: soft-delete, so the toast can offer a real undo.
      agentBrowser.ipc.call("profile.trash:" + dirId, function () { return api.profile.trash(dirId); }, { kind: "write" })
        .then(function (r) {
          done++;
          if (r && r.success === false) errors++;
        })
        .catch(function () { done++; errors++; })
        .then(function () {
          if (done !== total) return;
          sel.forEach(function (d) { delete profileSelection[d]; });
          if (errors) {
            toast(t("toast.batch.delete-partial", "Deleted {ok}/{total} profiles ({failed} failed)")
              .replace("{ok}", total - errors).replace("{total}", total).replace("{failed}", errors), "error");
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
    var detail = '<div style="max-height:180px;overflow:auto;">' +
      names.map(function(n) { return "• " + esc(n); }).join("<br>") +
      '</div><div style="margin-top:8px;color:var(--danger);">' +
      esc(t("confirm.delete.warning", "This cannot be undone. Cookies and local storage are deleted with the profile. Running profiles must be stopped first.")) +
      "</div>";
    var opts = { title: t("confirm.delete.title", "Delete profiles"), detailHtml: detail };
    if (sel.length >= 10) {
      opts.ackLabel = t("confirm.delete.ack", "I understand that {n} profiles and their site data will be permanently deleted.").replace("{n}", sel.length);
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
    if (!sel.length) return;
    var t = function(k, fb) { return window.i18n ? window.i18n.t(k, fb) : fb; };
    api.profile.exportArchives(sel).then(function(r) {
      if (!r || !r.success) {
        toast(t("toast.profile.export-failed", "Export failed: ") + ((r && r.error) || "unknown"), "error");
        return;
      }
      var rep = (r && r.report) || {};
      var exported = (rep.exported || []).length;
      var skipped = (rep.skipped || []).length;
      var failed = (rep.failed || []).length;
      var msg = t("toast.profile.exported-batch", "Exported {n} profiles").replace("{n}", exported);
      if (skipped) msg += t("toast.batch.export-skipped", ", skipped {n} (running)").replace("{n}", skipped);
      if (failed) msg += t("toast.batch.export-failed", ", {n} failed").replace("{n}", failed);
      toast(msg, failed ? "error" : "success");
    }).catch(function(e) {
      toast(t("toast.profile.export-failed", "Export failed: ") + (e.message || String(e)), "error");
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

  // ── Health check history (review item PL-05) ──
  // A check result used to exist only inside the open dialog: close it and the
  // finding was gone, so risk management could never become a loop. Each
  // profile now keeps its latest few results locally (nothing is uploaded).
  var HEALTH_HISTORY_KEY = "agent-browser-health-history-v1";
  var HEALTH_HISTORY_LIMIT = 5;

  function readHealthHistory() {
    try { return JSON.parse(localStorage.getItem(HEALTH_HISTORY_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  }

  function recordHealthResult(dirId, kind, summary) {
    if (!dirId || !summary) return;
    var all = readHealthHistory();
    var list = (all[dirId] || []).filter(function (entry) { return entry.kind !== kind; });
    list.push({ kind: kind, at: Date.now(), verdict: summary.verdict || "pass", detail: summary.detail || "" });
    list.sort(function (a, b) { return b.at - a.at; });
    all[dirId] = list.slice(0, HEALTH_HISTORY_LIMIT);
    try { localStorage.setItem(HEALTH_HISTORY_KEY, JSON.stringify(all)); } catch (e) { /* storage disabled */ }
  }

  function lastHealthFor(dirId) {
    var list = readHealthHistory()[dirId] || [];
    return list.length ? list[0] : null;
  }

  function relativeTime(ts) {
    var diff = Date.now() - ts;
    if (diff < 60000) return t("profile.health.just-now", "just now");
    var mins = Math.floor(diff / 60000);
    if (mins < 60) return t("profile.health.minutes-ago", "{n}m ago").replace("{n}", mins);
    var hours = Math.floor(mins / 60);
    if (hours < 24) return t("profile.health.hours-ago", "{n}h ago").replace("{n}", hours);
    return t("profile.health.days-ago", "{n}d ago").replace("{n}", Math.floor(hours / 24));
  }

  // PL-05 (part 2): let the user read back what was checked and when, instead
  // of only seeing the latest verdict on the card.
  function showHealthHistory(dirId) {
    var list = readHealthHistory()[dirId] || [];
    if (!list.length) {
      toast(t("profile.health.no-history", "No health checks recorded for this profile yet"), "info");
      return;
    }
    var rows = list.map(function (entry) {
      var verdict = entry.verdict === "risk"
        ? t("profile.health.verdict-risk", "Risk")
        : entry.verdict === "warn"
          ? t("profile.health.verdict-warn", "Watch")
          : t("profile.health.verdict-pass", "Pass");
      var color = entry.verdict === "risk" ? "var(--danger)" : entry.verdict === "warn" ? "var(--warning)" : "var(--success)";
      var kindLabel = t("profile.health.kind." + entry.kind, entry.kind);
      return '<div style="display:flex;gap:8px;align-items:baseline;border-bottom:1px solid var(--border);padding:5px 0;">' +
        '<b style="min-width:110px;">' + esc(kindLabel) + "</b>" +
        '<span style="min-width:82px;color:var(--text-muted);">' + esc(relativeTime(entry.at)) + "</span>" +
        '<b style="min-width:56px;color:' + color + ';">' + esc(verdict) + "</b>" +
        '<span style="color:var(--text-muted);word-break:break-word;">' + esc(entry.detail || "") + "</span>" +
        "</div>";
    }).join("");
    agentBrowser.confirmHtml(
      esc(t("profile.health.history-title", "Health check history")),
      function () { /* informational only */ },
      {
        title: esc(t("profile.health.history-heading", "Recent checks")),
        detailHtml: '<div style="font-size:12px;">' + rows + "</div>",
      },
    );
  }

  function lastHealthHtml(dirId) {
    var last = lastHealthFor(dirId);
    if (!last) {
      return '<span style="font-size:11px;color:var(--text-muted);">' + esc(t("profile.health.never", "Not checked yet")) + "</span>";
    }
    var verdict = last.verdict === "risk"
      ? { key: "profile.health.verdict-risk", fb: "Risk", color: "var(--danger)" }
      : last.verdict === "warn"
        ? { key: "profile.health.verdict-warn", fb: "Watch", color: "var(--warning)" }
        : { key: "profile.health.verdict-pass", fb: "Pass", color: "var(--success)" };
    return '<span style="font-size:11px;color:var(--text-muted);" title="' + escAttr(last.detail || "") + '">' +
      esc(t("profile.health.last", "Last check: {when}").replace("{when}", relativeTime(last.at))) +
      ' · <b style="color:' + verdict.color + ';">' + esc(t(verdict.key, verdict.fb)) + "</b></span>";
  }

  function summarizeEnvRisk(r) {
    var findings = (r && r.result && r.result.findings) || [];
    var high = findings.filter(function (f) { return f.severity === "high"; }).length;
    var medium = findings.filter(function (f) { return f.severity === "medium"; }).length;
    return { verdict: high ? "risk" : medium ? "warn" : "pass", detail: high + " high / " + medium + " medium finding(s)" };
  }

  function summarizeWebRtc(r) {
    var res = (r && r.result) || {};
    var leak = (res.hostIps || []).length > 0;
    return { verdict: leak ? "risk" : "pass", detail: res.summary || (leak ? "local IP exposed" : "no local IP leak") };
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

  function releaseDetectSlot(dirId) {
    if (!detectInFlight[dirId]) return;
    delete detectInFlight[dirId];
    detectGlobalCount = Math.max(0, detectGlobalCount - 1);
  }

  function askExternalConsent(dirId) {
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
        agentBrowser.openRiskCheck(dirId);
      },
      { title: esc(t("risk.external.heading", "External risk check")), detailHtml: detail },
    );
  }

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
    if (!acquireDetectSlot(dirId)) return;
    toast(allowLaunch ? t("toast.fp.launching", "Starting profile and opening risk check…") : t("toast.fp.opening", "Opening risk check…"), "info");
    agentBrowser.ipc.call("browser.openRiskCheck", function () {
      return api.browser.openRiskCheck(dirId, { allowLaunch: !!allowLaunch });
    }, { kind: "detect" }).then(function (r) {
      releaseDetectSlot(dirId);
      if (r && r.success) {
        toast(t("toast.fp.opened", "Opened risk check in profile"), "success");
        if (allowLaunch) scheduleProfilesRefresh();
        return;
      }
      if (r && r.code === "PROFILE_NOT_RUNNING") {
        confirmLaunchForCheck(dirId);
        return;
      }
      toast((r && r.error) || t("toast.fp.nav-failed", "Failed to navigate to risk check"), "error");
    }).catch(function (e) {
      releaseDetectSlot(dirId);
      toast(e && e.message ? e.message : String(e), "error");
    });
  }

  agentBrowser.openRiskCheck = function(dirId) {
    // Consent first (TE-04): nothing leaves the machine until the user agrees.
    if (!hasExternalRiskConsent()) { askExternalConsent(dirId); return; }
    api.browser.status(dirId).then(function(s) {
      if (s && s.running) { runRiskCheck(dirId, false); return; }
      confirmLaunchForCheck(dirId);
    }).catch(function(e) { toast(e.message || String(e), "error"); });
  };

  // ── Engine banner (review item PL-07) ──
  // Without this, a missing Chromium build only showed up as a launch failure
  // plus a small red dot in the sidebar; new users had no in-app recovery path.
  function renderEngineBanner(info) {
    var el = document.getElementById("engine-banner");
    if (!el) return;
    if (info && info.installed) {
      el.className = "engine-banner ok";
      el.innerHTML = "🥷 " + esc(t("engine.ok", "Managed Chromium {v}").replace("{v}", info.version || "?"));
      el.style.display = "";
      return;
    }
    el.className = "engine-banner";
    el.innerHTML = '⚠️ <span style="flex:1;">' +
      esc(t("engine.missing", "No managed Chromium installed — profiles cannot start until you point at a local build.")) +
      '</span>' +
      '<button class="btn btn-primary btn-sm" data-role="cmd" data-cmd="selectChromiumBinary">' +
        esc(t("engine.select", "Select local build…")) + "</button> " +
      '<button class="btn btn-secondary btn-sm" data-role="cmd" data-cmd="showEngineGuide">' +
        esc(t("engine.guide", "Install guide")) + "</button>";
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
          esc(t("engine.guide.body", "Build Chromium 150/151 with the maintained patch set, verify it, then install it into the local engine cache:")) +
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
    api.browser.setMeta(dirId, { note: note }).then(function(r) {
      if (r.success) { toast((window.i18n ? window.i18n.t("toast.note.saved", "Note saved") : "Note saved"), "success"); agentBrowser.refresh(); }
      else toast((window.i18n ? window.i18n.t("toast.note.save-failed", "Failed to save note") : "Failed to save note"), "error");
    });
  };
  agentBrowser.saveBrowserMeta = function() {
    var dirId = document.getElementById("agent-browser-meta-dir-id").value;
    var name = document.getElementById("agent-browser-meta-name").value.trim();
    var fingerprintMode = document.getElementById("agent-browser-meta-fingerprint-mode").value || "managed";
    var browserVersion = document.getElementById("agent-browser-meta-browser-version").value || null;
    var allowThirdPartyCookies = document.getElementById("agent-browser-meta-allow-third-party-cookies").checked;
    var drm = document.getElementById("agent-browser-meta-drm").checked;
    var seed = Number(document.getElementById("agent-browser-meta-seed").value);
    var platform = document.getElementById("agent-browser-meta-platform").value;
    var timezone = document.getElementById("agent-browser-meta-timezone").value || null;
    var locale = document.getElementById("agent-browser-meta-locale").value || null;
    var webrtcMode = document.getElementById("agent-browser-meta-webrtc-mode").value || "auto";
    var webrtcIp = document.getElementById("agent-browser-meta-webrtc").value.trim() || null;
    var appUrl = document.getElementById("agent-browser-meta-app-url").value.trim() || null;
    var windowTitlePrefix;
    if (document.getElementById("agent-browser-meta-window-title-enabled").checked) {
      windowTitlePrefix = document.getElementById("agent-browser-meta-window-title-prefix").value.trim() || "";
    } else {
      windowTitlePrefix = null;
    }
    if (webrtcMode === "real" || webrtcMode === "disable") webrtcIp = null;
    var proxySelection = parseProxySelection(document.getElementById("agent-browser-meta-proxy").value, "none");
    var hardware, geolocation;
    // UE-04: field-level validation on the edit form too.
    var metaErrors = validateHardwareFields("agent-browser-meta-");
    if (metaErrors.length) {
      clearFieldErrors("agent-browser-meta-");
      showFieldErrors(metaErrors);
      toast(t("toast.form.invalid", "Please fix the highlighted fields"), "error");
      return;
    }
    try { hardware = readHardwareFields("agent-browser-meta-"); geolocation = readGeolocationFields("agent-browser-meta-"); }
    catch (e) { toast(e.message || String(e), "error"); return; }
    document.getElementById("dlg-agent-browser-seed").close();
    if (!Number.isInteger(seed) || seed < 1 || seed > 999999) { toast((window.i18n ? window.i18n.t("toast.invalid-seed", "Invalid seed") : "Invalid seed"), "error"); return; }
    if (!name) { toast((window.i18n ? window.i18n.t("toast.name-required", "Name required") : "Name required"), "error"); return; }
    var promises = [];
    promises.push(api.browser.setMeta(dirId, Object.assign({
      name: name, fingerprintMode: fingerprintMode, browserVersion: browserVersion,
      allowThirdPartyCookies: allowThirdPartyCookies,
      drm: drm,
      fingerprintSeed: seed, platform: platform,
      timezone: timezone, locale: locale, webrtcMode: webrtcMode, webrtcIp: webrtcIp,
      proxyMode: proxySelection.mode, proxyName: proxySelection.name,
      appUrl: appUrl,
      windowTitlePrefix: windowTitlePrefix
    }, geolocation, hardware)));
    Promise.all(promises).then(function(r) {
      if (r[0] && r[0].success) { toast((window.i18n ? window.i18n.t("toast.profile.saved", "Profile saved") : "Profile saved"), "success"); loadProfiles(); }
      else toast((r[0] && r[0].error) || (window.i18n ? window.i18n.t("toast.save-failed", "Failed to save") : "Failed to save"), "error");
    }).catch(function (e) { toast(e.message || (window.i18n ? window.i18n.t("toast.save-failed", "Failed to save") : "Failed to save"), "error"); });
  };

  // ══════ Profiles ══════
  function loadProfiles(soft) {
    var container = document.getElementById("profile-list");
    if (!soft) container.innerHTML = '<div class="loading">Loading...</div>';

    Promise.all([
      api.browser.list().catch(function () { return []; }),
      api.proxy.list(),
      api.browser.binary().catch(function () { return null; }),
    ]).then(function (results) {
      var browserProfiles = results[0] || [];
      var proxies = results[1];
      // PL-07: surface the engine state on the page that needs it.
      renderEngineBanner(results[2]);

      // Build a proxy lookup map for legacy renderer-side fallback.
      var proxyMap = {};
      var defaultProxyName = null;
      (proxies || []).forEach(function(p) { proxyMap[p.name] = p.config; if (p.isDefault) defaultProxyName = p.name; });

      var profiles = browserProfiles.map(function(cp) {
        var proxyMode = cp.proxyMode || (cp.proxyName ? "named" : "none");
        var resolvedProxy = cp.proxy || (proxyMode === "default" ? proxyMap[defaultProxyName] : proxyMap[cp.proxyName]) || null;
        return {
          dirId: cp.dirId,
          name: cp.name,
          sizeBytes: 0,
          lastModified: cp.lastModified || 0,
          running: cp.running,
          pid: cp.pid,
          proxy: resolvedProxy,
          proxyMode: proxyMode,
          proxyName: cp.proxyName || null,
          syncedAt: cp.syncedAt || null,
          syncStatus: cp.syncStatus || getSyncStatus(cp.syncedAt, cp.lastModified || 0),
          fingerprint: { browser: cp.engine || "chromium", version: cp.version, mode: cp.engine === "firefox" ? "off" : (cp.fingerprintMode || "managed"), browserVersion: cp.browserVersion || null, platform: cp.platform || "windows", seed: cp.fingerprintSeed, timezone: cp.timezone, locale: cp.locale, webrtcMode: cp.webrtcMode || (cp.webrtcIp ? "altered" : "auto"), webrtcIp: cp.webrtcIp },
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
        };
      });

      // A5: one-time data-safety reminder once real profiles exist.
      updateBackupHint(browserProfiles.length > 0);

      profiles.forEach(function (p) {
        var override = window._profileRuntimeOverrides && window._profileRuntimeOverrides[p.dirId];
        if (!override) return;
        if (override.expiresAt && Date.now() > override.expiresAt) {
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
      if (profileFilter.status === "running") profiles = profiles.filter(function (p) { return p.running; });
      else if (profileFilter.status === "stopped") profiles = profiles.filter(function (p) { return !p.running; });
      if (profileFilter.tags && profileFilter.tags.length) {
        profiles = profiles.filter(function (p) {
          var tags = (p.tags || []).map(function (t) { return String(t).toLowerCase(); });
          return profileFilter.tags.some(function (tag) { return tags.indexOf(tag) !== -1; });
        });
      }

      if (!profiles || profiles.length === 0) {
        var filtered = profileFilter.status !== "all" || (profileFilter.tags && profileFilter.tags.length);
        container.innerHTML = filtered
          ? '<div class="empty-state">' + esc(t("profiles.empty.filtered", "No profiles match the current filter.")) + '</div>'
          : '<div class="empty-state">' + esc(t("profiles.empty.none", "No profiles yet. Click \"+ New Profile\" to get started.")) + '</div>';
        lastRenderSignature = "";
        profilePage = 1;
        var pagerEl = document.getElementById("profile-pagination");
        if (pagerEl) pagerEl.style.display = "none";
        return;
      }

      var proxyOpts = (proxies || []).map(function (p) {
        var cfg = p.config || {};
        var label = String(cfg.type || "") + '://' + String(cfg.host || "") + ':' + String(cfg.port || "");
        return '<option value="' + escAttr(p.name) + '">' +
          esc(p.name) + ' (' + esc(label) + ')' + (p.isDefault ? ' ★' : '') + '</option>';
      }).join("");

      var cardHtmlFn = function (p) {
        var isRunning = p.running;
        var date = p.lastModified ? new Date(p.lastModified).toLocaleDateString() : "?";
        var proxyStr = proxyDisplayLabel(p);

        var syncIcon = "", syncTitle = "", syncCls = "";
        if (p.syncStatus === "synced") { syncIcon = "☁️"; syncCls = "sync-synced"; syncTitle = "Synced: " + new Date(p.syncedAt).toLocaleString(); }
        else if (p.syncStatus === "dirty") { syncIcon = "⚡"; syncCls = "sync-dirty"; syncTitle = "Unsaved changes"; }
        else { syncIcon = "☁️"; syncCls = "sync-never"; syncTitle = "Never synced"; }

        var fp = p.fingerprint || {};
        var platform = fp.platform || "windows";
        var osName = platform === "macos" ? "macOS" : "Windows";

        var isFirefox = fp.browser === "firefox" || p.engine === "firefox";
        var browserIcon = isFirefox ? "🦊" : "🥷";
        var browserName = isFirefox ? "Firefox (stock)" : "Managed Chromium";
        var fingerprintLabel = (isFirefox || fp.mode === "off")
          ? (isFirefox ? "↪ Firefox pass-through" : "↪ Pass-through")
          : platformIcon(platform) + " 🎲#" + (fp.seed || "?");
        var hardware = { gpuRenderer: p.gpuRenderer, hardwareConcurrency: p.hardwareConcurrency, deviceMemory: p.deviceMemory, screenWidth: p.screenWidth, screenHeight: p.screenHeight };
        var fpCompleteness = fingerprintCompleteness(p);
        var identityStr = (isFirefox || fp.mode === "off")
          ? (isFirefox ? "Native Firefox host identity" : "Native host identity")
          : (fp.timezone || "auto tz") + " · " + (fp.locale || "auto locale") + " · RTC " + esc(fp.webrtcMode || (fp.webrtcIp ? "altered" : "auto"));
        if (fp.mode !== "off" && !isFirefox && fp.webrtcIp) identityStr += " · " + esc(fp.webrtcIp);
        var fingerprintTitle = (fp.mode === "off" ? "Real machine pass-through (Firefox: stock identity)" : "Seed " + (fp.seed || "?") + " · " + osName + " · " + (fp.locale || "auto locale") + " · " + (fp.timezone || "auto timezone") + " · " + hardwareSummary(hardware) + " · completeness " + fpCompleteness + "%") + " · " + (isFirefox ? "Firefox " : "Chromium ") + (fp.browserVersion || fp.version || "auto");
        // ── Review item UE-01: four 9px check buttons made the card
        // unreadable. They collapse into one labelled control; every check is
        // local except the last one, which is an explicit opt-in (TE-04).
        var healthSelect = '<select class="health-select" data-action="health" aria-label="' +
          escAttr(t('profile.health.aria', 'Run a health check')) + '">' +
          '<option value="">' + esc(t('profile.health.placeholder', '🩺 Health…')) + '</option>' +
          '<option value="drift">' + esc(t('profile.health.drift', '🧬 Fingerprint drift')) + '</option>' +
          '<option value="env">' + esc(t('profile.health.env', '🖥 Host environment')) + '</option>' +
          '<option value="webrtc">' + esc(t('profile.health.webrtc', '📡 WebRTC leak')) + '</option>' +
          '<option value="risk">' + esc(t('profile.health.external', '🔍 External site (ping0.cc)')) + '</option>' +
          '<option value="history">' + esc(t('profile.health.history', '🕘 History')) + '</option>' +
          '</select>';
        var isLocked = !!(p.lock && p.lock.owner);
        var lockBadge = isLocked ? '<span class="status-badge badge-governance" style="background:var(--warning-bg);color:var(--warning);" title="' + escAttr(t('profile.badge.locked', 'Locked (governance): owned by {owner}').replace('{owner}', p.lock.ownerName || p.lock.owner)) + '">🔒 ' + esc(p.lock.ownerName || 'device') + '</span>' : '';
        var drmBadge = p.drm ? '<span class="status-badge badge-capability" title="' + escAttr(t('profile.badge.drm', 'Capability: Widevine/DRM enabled')) + '">🎬 DRM</span>' : '';
        var appBadge = p.appUrl ? '<span class="status-badge badge-capability" title="' + escAttr(t('profile.badge.app', 'Capability: Web App {url}').replace('{url}', p.appUrl)) + '">🖥 App</span>' : '';
        var engineBadge = isFirefox ? '<span class="status-badge badge-capability" style="color:#ff7a18;" title="' + escAttr(t('profile.badge.firefox', 'Capability: Firefox engine (pass-through identity)')) + '">🦊 Firefox</span>' : '';
        // ── Review item UE-06: sync moves into the governance tier so the
        // three status tiers are visually distinct (lifecycle / governance /
        // capability) instead of five equal-weight badges.
        var syncBadge = '<span class="status-badge badge-governance ' + syncCls + '" title="' + escAttr(syncTitle) + '">' + syncIcon + ' ' +
          esc(p.syncStatus === "synced" ? t('profile.sync.synced', 'Synced') : p.syncStatus === "dirty" ? t('profile.sync.dirty', 'Dirty') : t('profile.sync.never', 'Never')) + '</span>';
        var tagHtml = (p.tags || []).map(function(tag) {
          return '<span class="status-badge status-done" style="font-size:11px;margin-right:4px;">' + esc(tag) + '</span>';
        }).join('');

        var proxyOptsHtml = renderProxyOptions(proxies, profileProxySelectionValue(p, "none"), true);

        return '<div class="profile-card' + (isRunning ? ' running' : '') + '" data-dir-id="' + escAttr(p.dirId) + '" data-lock="' + (isLocked ? '1' : '0') + '">' +
          '<div class="card-header">' +
            '<label class="profile-select" title="Select"><input type="checkbox" class="profile-select-checkbox" data-dir-id="' + escAttr(p.dirId) + '"' + (profileSelection[p.dirId] ? ' checked' : '') + '></label>' +
            '<span class="name" title="' + escAttr(t('profile.name.title', 'Click to rename')) + '" data-action="rename">' + esc(p.name) + '</span>' +
            '<span class="status-badge badge-lifecycle ' + (isRunning ? 'status-running' : 'status-stopped') + '">' + (isRunning ? t('profile.status.running', 'Running') : t('profile.status.stopped', 'Stopped')) + '</span>' +
            lockBadge +
            syncBadge +
            engineBadge +
            drmBadge +
            appBadge +
          '</div>' +
          '<div class="info-row"><span>' + esc(t('profile.row.browser', 'Browser')) + '</span><span>' + browserIcon + ' ' + esc(browserName) + '</span></div>' +
          '<div class="info-row"><span>' + esc(t('profile.row.modified', 'Modified')) + '</span><span>' + date + '</span></div>' +
          '<div class="info-row"><span>' + esc(t('profile.row.fingerprint', 'Fingerprint')) + '</span><span title="' + escAttr(fingerprintTitle) + '">' + esc(fingerprintLabel) + '</span></div>' +
          '<div class="info-row"><span>' + esc(t('profile.row.identity', 'Identity')) + '</span><span title="' + escAttr(identityStr) + '">' + esc(identityStr) + '</span></div>' +
          '<div class="info-row"><span>' + esc(t('profile.row.hardware', 'Hardware')) + '</span><span title="' + escAttr(hardwareSummary(hardware)) + '">' + esc(hardwareSummary(hardware)) + ' ' + healthSelect + ' ' + lastHealthHtml(p.dirId) + '</span></div>' +
          '<div class="info-row"><span>' + esc(t('profile.row.proxy', 'Proxy')) + '</span><span>' + esc(proxyStr) + '</span></div>' +
          ((p.tags || []).length ? '<div class="info-row"><span>' + esc(t('profile.row.tags', 'Tags')) + '</span><span>' + tagHtml + '</span></div>' : '') +
          '<div class="card-actions">' +
            (isRunning
              ? '<button class="btn btn-secondary btn-sm" data-action="stop" aria-label="' + escAttr(t('profile.action.stop', 'Stop this profile')) + '">⏹ ' + esc(t('profile.action.stop-label', 'Stop')) + '</button> '
              : '<button class="btn btn-primary btn-sm" data-action="launch" aria-label="' + escAttr(t('profile.action.launch', 'Launch this profile')) + '">▶ ' + esc(t('profile.action.launch-label', 'Launch')) + '</button> ') +
            '<button class="btn btn-secondary btn-sm" data-action="edit" aria-label="' + escAttr(t('profile.action.edit', 'Edit this profile')) + '">✎ ' + esc(t('profile.action.edit-label', 'Edit')) + '</button> ' +
            (p.appUrl ? '<button class="btn btn-secondary btn-sm" data-action="open-app" aria-label="' + escAttr(t('profile.action.open-app', 'Open as Web App')) + '">🖥 ' + esc(t('profile.action.app', 'App')) + '</button> ' : '') +
            // ── UE-08: every control has an accessible name ──
            '<details class="card-menu">' +
              '<summary aria-label="' + escAttr(t('profile.action.more', 'More actions')) + '" title="' + escAttr(t('profile.action.more', 'More actions')) + '">⋯</summary>' +
              '<div class="card-menu-list">' +
                '<button type="button" data-action="rename">' + esc(t('profile.menu.rename', '✏️ Rename')) + '</button>' +
                '<button type="button" data-action="note">' + esc(t('profile.menu.note', '📝 Note')) + '</button>' +
                '<button type="button" data-action="cookies">' + esc(t('profile.menu.cookies', '🍪 Cookies')) + '</button>' +
                '<button type="button" data-action="extensions">' + esc(t('profile.menu.extensions', '🧩 Extensions')) + '</button>' +
                '<button type="button" data-action="export-archive">' + esc(t('profile.menu.export', '📦 Export backup')) + '</button>' +
                '<button type="button" data-action="lock">' + esc(isLocked ? t('profile.menu.unlock', '🔓 Release lock') : t('profile.menu.lock', '🔒 Lock to device')) + '</button>' +
                '<button type="button" data-action="logs">' + esc(t('profile.menu.logs', '📋 Logs')) + '</button>' +
                '<button type="button" data-action="webrtc-diag">' + esc(t('webrtc.diag.title', '📡 In-browser WebRTC Diagnostics')) + '</button>' +
                '<button type="button" class="danger" data-action="delete">' + esc(t('profile.menu.delete', '🗑 Delete')) + '</button>' +
              '</div>' +
            '</details>' +
          '</div>' +
          '<div style="margin-top:4px;">' +
            '<select class="proxy-select" data-action="proxy" style="width:100%;font-size:10px;padding:4px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);">' + proxyOptsHtml + '</select>' +
          '</div>' +
        '</div>';
      };
      renderProfileList(container, profiles, cardHtmlFn);
      attachProfileCardHandlers(container);
      updateBatchBar(proxies);
    }).catch(function (e) {
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

  function renderProfileList(container, profiles, cardHtmlFn) {
    var total = profiles.length;
    var pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (profilePage > pageCount) profilePage = pageCount;
    if (profilePage < 1) profilePage = 1;
    var start = (profilePage - 1) * PAGE_SIZE;
    var pageItems = profiles.slice(start, start + PAGE_SIZE);

    var cards = pageItems.map(function (p) {
      var html = cardHtmlFn(p);
      return { dirId: p.dirId, html: html, sig: htmlSignature(html) };
    });

    // Fast path: nothing changed -> touch no DOM at all. Verify the DOM too:
    // overlapping refreshes can replace the list with a loading placeholder
    // after an earlier request has already recorded this data signature.
    var signature = cards.map(function (c) { return c.dirId + ":" + c.sig; }).join("|") + "#" + pageCount;
    var renderedSignature = Array.prototype.map.call(
      container.querySelectorAll(":scope > .profile-card"),
      function (card) { return card.dataset.dirId + ":" + card.getAttribute("data-card-sig"); },
    ).join("|") + "#" + pageCount;
    if (signature === lastRenderSignature && renderedSignature === signature) {
      renderPagination(container, total, pageCount);
      return;
    }
    lastRenderSignature = signature;

    // Remember focus + scroll so a refresh does not interrupt the user.
    var active = document.activeElement;
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
      if (el) frag.appendChild(el);
    });
    // Cards that are no longer present (deleted or paged away) get removed.
    Object.keys(existing).forEach(function (dirId) {
      if (existing[dirId].parentNode) existing[dirId].parentNode.removeChild(existing[dirId]);
    });
    if (frag.childNodes.length || container.children.length === 0) container.appendChild(frag);

    if (scrollingEl && scrollTop) scrollingEl.scrollTop = scrollTop;
    if (focusKey) {
      var parts = focusKey.split("|");
      var target = container.querySelector('.profile-card[data-dir-id="' + parts[0].replace(/"/g, "") + '"] [data-action="' + (parts[1] || "").replace(/"/g, "") + '"]');
      if (target && target.focus) target.focus();
    }

    renderPagination(container, total, pageCount);
  }

  // ── Card busy state (review item PL-06) ──
  // While a launch/stop is in flight the card is dimmed and stops accepting
  // input, so a user cannot race a delete against a browser that is starting.
  function setCardBusy(dirId, busy) {
    var card = document.querySelector('#profile-list .profile-card[data-dir-id="' + String(dirId).replace(/"/g, "") + '"]');
    if (!card) return;
    if (busy) card.classList.add("busy");
    else card.classList.remove("busy");
  }

  function closeAllCardMenus() {
    var menus = document.querySelectorAll("#profile-list .card-menu[open]");
    Array.prototype.forEach.call(menus, function (m) { m.removeAttribute("open"); });
  }

  function attachProfileCardHandlers(container) {
    container.onclick = function (event) {
      var target = event.target.closest("[data-action]");
      if (!target || !container.contains(target)) return;
      var card = target.closest(".profile-card");
      if (!card) return;
      var dirId = card.dataset.dirId;
      var action = target.dataset.action;
      if (!dirId || action === "proxy") return;
      closeAllCardMenus();
      if (action === "rename") agentBrowser.renameProfile(dirId, card.querySelector(".name")?.textContent || "");
      else if (action === "note") agentBrowser.addNote(dirId);
      else if (action === "stop") agentBrowser.stop(dirId);
      else if (action === "launch") agentBrowser.launch(dirId);
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
        else if (kind === "env") agentBrowser.openEnvRisk(id);
        else if (kind === "webrtc") agentBrowser.openWebRtcDiag(id);
        else if (kind === "risk") agentBrowser.openRiskCheck(id);
        else if (kind === "history") showHealthHistory(id);
      }
    };
  }

  agentBrowser.checkDrift = function(dirId) {
    // TE-09: one check per profile at a time, max 2 globally.
    if (!acquireDetectSlot(dirId)) return;
    agentBrowser.ipc.call("browser.checkDrift", function () {
      return api.browser.checkDrift(dirId);
    }, { kind: "detect" }).then(function(r) {
      releaseDetectSlot(dirId);
      if (!r || !r.ok) { toast((r && r.error) || t("toast.fp.drift-failed", "Fingerprint check failed"), "error"); return; }
      if (!r.hasBaseline) {
        toast(t("toast.fp.no-baseline", "No fingerprint baseline yet — launch the profile and capture a baseline first"), "info");
        return;
      }
      var driftFields = (r.drift || []).map(function(d) { return d.field; });
      // PL-05: keep the verdict so the card can show it later.
      recordHealthResult(dirId, "drift", {
        verdict: r.risky ? "risk" : driftFields.length ? "warn" : "pass",
        detail: driftFields.slice(0, 6).join(", "),
      });
      if (!r.risky) {
        toast(t("toast.fp.stable", "Fingerprint stable ({n} benign change(s))").replace("{n}", driftFields.length), "success");
      } else {
        toast("⚠ " + t("toast.fp.drift", "Risky fingerprint drift") + ": " + driftFields.slice(0, 6).join(", ") + (driftFields.length > 6 ? " (+" + (driftFields.length - 6) + ")" : ""), "error");
      }
      scheduleProfilesRefresh();
    }).catch(function(e) {
      releaseDetectSlot(dirId);
      toast(e.message || String(e), "error");
    });
  };

  function renderEnvRisk(r) {
    var body = document.getElementById('env-risk-body');
    if (!body) return;
    if (!r || !r.ok) {
      body.innerHTML = '<div class="empty-state">' + esc((r && r.error) || 'Env check failed') + '</div>';
      return;
    }
    var res = r.result || {};
    var findings = res.findings || [];
    var okBadge = res.ok ? '<span class="status-badge status-done">PASS</span>' : '<span class="status-badge" style="background:var(--danger-bg);color:var(--danger);">RISK</span>';
    var rows = [];
    rows.push('<div class="card-header"><span class="name">Host</span><span>' + okBadge + '</span></div>');
    rows.push('<div style="font-size:11px;color:var(--text-muted);">' + esc(res.hostPlatform) + ' · locale ' + esc(res.hostLocale || '?') + '</div>');
    rows.push('<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">DNS: ' + ((res.resolvers || []).map(function(rr){ return rr.address + (rr.isCn ? ' (CN!)' : ''); }).join(', ') || 'n/a') + '</div>');
    rows.push('<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + esc(t("env.cn-fonts", "CN fonts")) + ': ' + ((res.cnFonts || []).join(', ') || esc(t("common.none", "none"))) + '</div>');
    rows.push('<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + esc(t("env.proxy", "Proxy")) + ': ' + esc((res.proxy && res.proxy.mode) || '?') + ' · ' + esc((res.proxy && (res.proxy.type || '')) || '') + ' · DNS ' + esc((res.proxy && res.proxy.dnsLeakRisk) || '') + '</div>');
    if (res.raf && res.raf.samples > 0) {
      rows.push('<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">rAF: ' + esc(String(res.raf.medianMs)) + 'ms ≈ ' + esc(String(res.raf.refreshHz)) + 'Hz (' + esc(String(res.raf.samples)) + ' samples, ' + (res.raf.standard ? 'standard' : 'non-standard') + ')</div>');
    }
    body.innerHTML = rows.join('') +
      '<div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">' +
      findings.map(function(f) {
        var color = f.severity === 'high' ? 'var(--danger)' : (f.severity === 'medium' ? 'var(--warning)' : 'var(--text-muted)');
        var bg = f.severity === 'high' ? 'var(--danger-bg)' : (f.severity === 'medium' ? 'var(--warning-bg)' : 'transparent');
        return '<div style="border:1px solid ' + color + ';background:' + bg + ';border-radius:8px;padding:8px 10px;">' +
          '<div style="font-size:12px;color:' + color + ';font-weight:600;">' + esc(f.severity.toUpperCase()) + ' · ' + esc(f.code) + '</div>' +
          '<div style="font-size:12px;color:var(--text);margin-top:2px;">' + esc(f.message) + '</div>' +
          '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">💡 ' + esc(f.fix) + '</div>' +
        '</div>';
      }).join('') +
      (!findings.length ? '<div class="empty-state">' + esc(t("env.no-risk", "No environment risk found")) + '</div>' : '') +
      '</div>';
  }

  agentBrowser.openEnvRisk = function(dirId) {
    var dlg = document.getElementById('dlg-env-risk');
    var body = document.getElementById('env-risk-body');
    if (!dlg) { toast(t('env.dialog.unavailable', 'Env check dialog unavailable'), 'error'); return; }
    if (!acquireDetectSlot(dirId)) return;
    if (body) body.innerHTML = '<div class="loading">' + esc(t('env.checking', 'Checking host environment…')) + '</div>';
    dlg.showModal();
    agentBrowser.ipc.call("browser.envRisk", function () { return api.browser.envRisk(dirId); }, { kind: "detect" })
      .then(function (r) {
        releaseDetectSlot(dirId);
        if (r && r.ok) recordHealthResult(dirId, "env", summarizeEnvRisk(r)); // PL-05
        renderEnvRisk(r);
      })
      .catch(function (e) { releaseDetectSlot(dirId); renderEnvRisk({ ok: false, error: e.message || String(e) }); });
  };


  function renderWebRtcDiag(r, dirId) {
    var body = document.getElementById("webrtc-diag-body");
    if (!body) return;
    if (!r || !r.ok) {
      body.innerHTML = '<div class="empty-state">' + esc((r && r.error) || "WebRTC diagnostic failed") + '</div>';
      return;
    }
    var res = r.result || {};
    var hasLeak = (res.hostIps || []).length > 0;
    var badge = !res.rtcAvailable
      ? '<span class="status-badge" style="background:var(--surface2);color:var(--text-muted);">N/A</span>'
      : hasLeak
        ? '<span class="status-badge" style="background:var(--danger-bg);color:var(--danger);">RISK</span>'
        : '<span class="status-badge status-done">PASS</span>';
    var when = res.at ? new Date(res.at).toLocaleString() : "";
    var rows = [];
    rows.push('<div class="card-header"><span class="name">WebRTC · ' + esc(when) + '</span><span>' + badge + '</span></div>');
    rows.push('<div style="font-size:12px;color:var(--text);margin-top:4px;">' + esc(res.summary || "") + '</div>');
    rows.push('<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">RTCPeerConnection: ' + (res.rtcAvailable ? t("webrtc.available", "available") : t("webrtc.unavailable", "unavailable")) + ' · ' + esc(t("webrtc.ice-candidates", "ICE candidates")) + ': ' + (res.candidates || []).length + ' · ' + esc(t("webrtc.conn-state", "connection state")) + ': ' + esc(res.connectionState || "") + (typeof res.rttMs === "number" ? " · RTT: " + res.rttMs + "ms" : "") + '</div>');
    if ((res.mdnsHosts || []).length) rows.push('<div style="font-size:11px;margin-top:4px;"><span style="color:var(--text-muted);">' + esc(t("webrtc.mdns", "mDNS hostnames")) + ': </span>' + res.mdnsHosts.map(esc).join(", ") + '</div>');
    if (hasLeak) rows.push('<div style="font-size:11px;margin-top:4px;"><span style="color:var(--danger);">⚠ ' + esc(t("webrtc.local-ip-leak", "Local IP leak")) + ': </span>' + res.hostIps.map(esc).join(", ") + '</div>');
    if ((res.srflxIps || []).length) rows.push('<div style="font-size:11px;margin-top:4px;"><span style="color:var(--text-muted);">' + esc(t("webrtc.stun-ip", "STUN public IP")) + ': </span>' + res.srflxIps.map(esc).join(", ") + '</div>');
    if (res.error) rows.push('<div style="font-size:11px;color:var(--warning);margin-top:4px;">⚠ ' + esc(res.error) + '</div>');
    body.innerHTML = rows.join("");
    var histEl = document.getElementById("webrtc-diag-history");
    if (histEl && dirId) {
      api.webrtc.diagHistory(dirId).then(function(h) {
        var entries = (h && h.entries) || [];
        if (!entries.length) { histEl.innerHTML = '<div style="font-size:11px;color:var(--text-muted);margin-top:8px;">' + esc(t("webrtc.diag.no-history", "No history yet")) + '</div>'; return; }
        var html = '<div style="font-size:11px;color:var(--text-muted);margin-top:8px;border-top:1px solid var(--border);padding-top:6px;">' + esc(t("webrtc.diag.history", "History ({n})").replace("{n}", entries.length)) + '</div>';
        entries.slice().reverse().forEach(function(en) {
          var ts = en.at ? new Date(en.at).toLocaleString() : "?";
          var leak = (en.hostIps || []).length > 0;
          html += '<div style="font-size:11px;margin-top:4px;">' + (leak ? "⚠" : "✅") + " " + esc(ts) + " — " + esc(en.summary || "") + '</div>';
        });
        histEl.innerHTML = html;
      }).catch(function() { histEl.innerHTML = ""; });
    }
  }

  function runWebRtcDiag(dirId, allowLaunch) {
    var dlg = document.getElementById("dlg-webrtc-diag");
    var body = document.getElementById("webrtc-diag-body");
    var histEl = document.getElementById("webrtc-diag-history");
    if (!dlg) { toast(t("webrtc.diag.unavailable", "WebRTC diagnostic dialog unavailable"), "error"); return; }
    if (!acquireDetectSlot(dirId)) return;
    if (body) {
      body.innerHTML = '<div class="loading">' +
        esc(allowLaunch ? t("webrtc.diag.running-launch", "Starting profile and running the WebRTC diagnostic…") : t("webrtc.diag.running", "Running the WebRTC diagnostic…")) +
        "</div>";
    }
    if (histEl) histEl.innerHTML = "";
    dlg.showModal();
    agentBrowser.ipc.call("webrtc.diag", function () {
      return api.webrtc.diag(dirId, { allowLaunch: !!allowLaunch });
    }, { kind: "detect"     }).then(function(r) {
      releaseDetectSlot(dirId);
      var payload = r || { ok: false, error: "unknown" };
      if (!payload.ok && payload.code === "PROFILE_NOT_RUNNING") {
        dlg.close();
        confirmLaunchForWebRtc(dirId);
        return;
      }
      if (payload.ok) recordHealthResult(dirId, "webrtc", summarizeWebRtc(payload)); // PL-05
      renderWebRtcDiag(payload, dirId);
    }).catch(function(e) {
      releaseDetectSlot(dirId);
      renderWebRtcDiag({ ok: false, error: e.message || String(e) }, dirId);
    });
  }

  function confirmLaunchForWebRtc(dirId) {
    agentBrowser.confirm(
      t("risk.launch.msg", "This check needs a running browser. Start the profile now?"),
      function () { runWebRtcDiag(dirId, true); },
      {
        title: t("risk.launch.title", "Start profile for check"),
        detailHtml: '<div style="font-size:12px;">' +
          esc(t("risk.launch.body", "The profile will be started and left running after the check.")) + "</div>",
      },
    );
  }

  agentBrowser.openWebRtcDiag = function(dirId) {
    window.__webrtcDiagDirId = dirId;
    api.browser.status(dirId).then(function(s) {
      // PL-03: never start a browser as a side effect of a diagnostic.
      if (s && s.running) { runWebRtcDiag(dirId, false); return; }
      confirmLaunchForWebRtc(dirId);
    }).catch(function(e) { toast(e.message || String(e), "error"); });
  };

  agentBrowser.webRtcDiagClear = function() {
    var dirId = window.__webrtcDiagDirId;
    if (!dirId) { return; }
    api.webrtc.diagClear(dirId).then(function(r) {
      if (r && r.success) { toast(t("webrtc.diag.cleared", "WebRTC diagnostic history cleared"), "success"); }
      var histEl = document.getElementById("webrtc-diag-history");
      if (histEl) histEl.innerHTML = '<div style="font-size:11px;color:var(--text-muted);margin-top:8px;">' + esc(t("webrtc.diag.no-history", "No history yet")) + '</div>';
    }).catch(function(e) { toast(e.message || String(e), "error"); });
  };

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
        var icon = e.category === "profile" ? "📦" : "•";
        return '<div style="padding:4px 6px;border-bottom:1px solid var(--border);">' +
          '<span style="color:var(--text-muted);font-size:10px;white-space:nowrap;">' + esc(when) + '</span> ' +
          icon + ' <strong>' + esc(e.action || "?") + '</strong>' +
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
    if (activityEl) activityEl.innerHTML = '<div class="loading">Loading...</div>';
    if (tailEl) tailEl.textContent = "Loading...";
    api.browser.logs(dirId).then(function(r) {
      renderProfileLogs(r || { success: false, error: "unknown" });
    }).catch(function(e) {
      renderProfileLogs({ success: false, error: e.message || String(e) });
    });
  };

  agentBrowser.toggleLock = function(dirId, card) {
    var locked = card ? card.dataset.lock === "1" : false;
    var apply = function() {
      api.browser.setLock(dirId, !locked).then(function(r) {
        if (!r || !r.success) { toast((r && r.error) || 'Lock failed', 'error'); return; }
        toast(locked ? t('profile.lock.unlocked', '🔓 Unlocked (remember to push)') : t('profile.lock.locked', '🔒 Locked to this device (remember to push)'), 'success');
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
