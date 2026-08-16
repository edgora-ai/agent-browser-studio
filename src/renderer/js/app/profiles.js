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
        api.browser.launch(dirId).then(function (r) {
          if (r.success) {
            toast((window.i18n ? window.i18n.t("toast.profile.started", "🥷 Managed Chromium started") : "🥷 Managed Chromium started") + " (CDP port " + r.cdpPort + ")", "success");
            if (r.envCheck && r.envCheck.high) {
              var envCodes = (r.envCheck.findings || []).filter(function(f){ return f.severity === "high"; }).map(function(f){ return f.code; }).join(", ");
              toast("⚠️ 环境风险: " + (envCodes || "host 环境高危") + " — 点卡片 🖥 Env 看修复建议", "error");
            }
            var seq = markProfileRuntime(dirId, true, r.pid);
            setTimeout(function () { clearProfileRuntime(dirId, seq); scheduleProfilesRefresh(); }, 5000);
            scheduleProfilesRefresh();
          } else {
            toast(r.error || (window.i18n ? window.i18n.t("toast.profile.launch-failed", "Managed Chromium launch failed") : "Managed Chromium launch failed"), "error");
          }
        }).catch(function (e) { toast(e.message, "error"); });
      },

  stop: function (dirId) {
        api.browser.stop(dirId).then(function (r) {
          if (r && r.success === false) { toast(r.error || (window.i18n ? window.i18n.t("toast.profile.stop-failed", "Stop failed") : "Stop failed"), "error"); scheduleProfilesRefresh(); return; }
          toast((window.i18n ? window.i18n.t("toast.profile.stopped", "Browser stopped") : "Browser stopped"), "success");
          var seq = markProfileRuntime(dirId, false, null);
          setTimeout(function () { clearProfileRuntime(dirId, seq); scheduleProfilesRefresh(); }, 5000);
          scheduleProfilesRefresh();
        }).catch(function (e) { toast(e.message, "error"); });
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
        var chromeOpts = document.getElementById("new-profile-chrome-opts");
        var browserOptions = document.getElementById("new-profile-agent-browser-opts");
        var firefoxOpts = document.getElementById("new-profile-firefox-opts");
        if (chromeOpts) chromeOpts.style.display = "none";
        if (browserOptions) browserOptions.style.display = "block";
        if (firefoxOpts) firefoxOpts.style.display = "none";
        var browserRow = document.getElementById("new-profile-browser-row");
        if (browserRow) browserRow.style.display = "none";
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
        try { hardware = readHardwareFields("new-agent-browser-"); geolocation = readGeolocationFields("new-agent-browser-"); }
        catch (e) { toast(e.message || String(e), "error"); return; }

        api.browser.create(Object.assign({
          name: name,
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
        toast(t("toast.profile.export-failed", "导出失败: ") + ((r && r.error) || "unknown"), "error");
        return;
      }
      toast(t("toast.profile.exported", "已导出备份: ") + esc(r.filePath), "success");
    }).catch(function(e) {
      toast(t("toast.profile.export-failed", "导出失败: ") + (e.message || String(e)), "error");
    });
  };

  agentBrowser.importProfileArchive = function() {
    api.profile.importArchives().then(function(r) {
      if (!r || !r.success) {
        toast(t("toast.profile.import-failed", "导入失败: ") + ((r && r.error) || "unknown"), "error");
        return;
      }
      var rep = (r && r.report) || {};
      var imported = (rep.imported || []).length;
      var failed = (rep.failed || []).length;
      if (imported === 0 && failed === 0) return;
      var msg = t("toast.profile.imported", "已导入 profile: ") + imported + " 个";
      if (failed) msg += t("toast.profile.import-failed-count", "，失败 ") + failed + " 个";
      toast(msg, failed ? "error" : "success");
      loadProfiles();
    }).catch(function(e) {
      toast(t("toast.profile.import-failed", "导入失败: ") + (e.message || String(e)), "error");
    });
  };

  agentBrowser.bulkStart = function() {
    api.browser.list().then(function(profiles) {
      var stopped = (profiles || []).filter(function(p) { return !p.running; });
      if (stopped.length === 0) { toast((window.i18n ? window.i18n.t("toast.bulk.all-running", "All profiles already running") : "All profiles already running"), "success"); return; }
      toast("Starting " + stopped.length + " profiles...", "success");
      stopped.forEach(function(p, i) {
        setTimeout(function() {
          agentBrowser.launch(p.dirId);
          if (i === stopped.length - 1) { toast(stopped.length + " profiles started", "success"); setTimeout(agentBrowser.refresh, 2000); }
        }, i * 500);
      });
    }).catch(function(){});
  };

  agentBrowser.bulkStop = function() {
    api.browser.list().then(function(profiles) {
      var running = (profiles || []).filter(function(p) { return p.running; });
      if (running.length === 0) { toast((window.i18n ? window.i18n.t("toast.bulk.none-running", "No profiles running") : "No profiles running"), "success"); return; }
      toast("Stopping " + running.length + " profiles...", "success");
      running.forEach(function(r) { agentBrowser.stop(r.dirId); });
      setTimeout(agentBrowser.refresh, 2000);
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
      var html = '<option value="">(默认代理)</option>';
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
    loadProfiles();
  };

  agentBrowser.clearProfileFilters = function() {
    profileFilter = { status: "all", tags: [] };
    var s = document.getElementById("profile-status-filter"); if (s) s.value = "all";
    var t = document.getElementById("profile-tag-filter"); if (t) t.value = "";
    profileSelection = {};
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
    toast("Starting " + sel.length + " selected profiles...", "success");
    sel.forEach(function (dirId, i) {
      setTimeout(function () {
        agentBrowser.launch(dirId);
        if (i === sel.length - 1) { toast(sel.length + " profiles started", "success"); setTimeout(agentBrowser.refresh, 2500); }
      }, i * 500);
    });
  };

  agentBrowser.batchStopSelected = function() {
    var sel = selectedProfileIds();
    if (!sel.length) return;
    toast("Stopping " + sel.length + " selected profiles...", "success");
    sel.forEach(function (dirId) { agentBrowser.stop(dirId); });
    setTimeout(agentBrowser.refresh, 2000);
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
          if (errors) toast("已分配 " + (total - errors) + "/" + total + " 个 profile（" + errors + " 个失败）", "error");
          else toast("已分配代理到 " + total + " 个 profile", "success");
          loadProfiles();
        }
      }).catch(function () { done++; errors++; if (done === total) { toast("已分配 " + (total - errors) + "/" + total + " 个 profile", "error"); loadProfiles(); } });
    });
  };

  agentBrowser.batchDeleteSelected = function() {
    var sel = selectedProfileIds();
    if (!sel.length) return;
    agentBrowser.confirm('Delete ' + sel.length + ' selected profile(s)?', function () {
      var total = sel.length, done = 0, errors = 0;
      sel.forEach(function (dirId) {
        api.profile.delete(dirId).then(function (r) {
          done++;
          if (r && r.success === false) errors++;
          if (done === total) {
            sel.forEach(function (d) { delete profileSelection[d]; });
            if (errors) toast("已删除 " + (total - errors) + "/" + total + " 个 profile（" + errors + " 个失败）", "error");
            else toast("已删除 " + total + " 个 profile", "success");
            loadProfiles();
          }
        }).catch(function () { done++; errors++; if (done === total) { sel.forEach(function (d) { delete profileSelection[d]; }); toast("已删除 " + (total - errors) + "/" + total + " 个 profile", "error"); loadProfiles(); } });
      });
    });
  };

  agentBrowser.batchExportSelected = function() {
    var sel = selectedProfileIds();
    if (!sel.length) return;
    var t = function(k, fb) { return window.i18n ? window.i18n.t(k, fb) : fb; };
    api.profile.exportArchives(sel).then(function(r) {
      if (!r || !r.success) {
        toast(t("toast.profile.export-failed", "导出失败: ") + ((r && r.error) || "unknown"), "error");
        return;
      }
      var rep = (r && r.report) || {};
      var exported = (rep.exported || []).length;
      var skipped = (rep.skipped || []).length;
      var failed = (rep.failed || []).length;
      var msg = t("toast.profile.exported-batch", "已导出 ") + exported + " 个 profile";
      if (skipped) msg += "，跳过 " + skipped + "（运行中）";
      if (failed) msg += "，失败 " + failed + " 个";
      toast(msg, failed ? "error" : "success");
    }).catch(function(e) {
      toast(t("toast.profile.export-failed", "导出失败: ") + (e.message || String(e)), "error");
    });
  };

  agentBrowser.openRiskCheck = function(dirId) {
    var t = function(k, fb) { return window.i18n ? window.i18n.t(k, fb) : fb; };
    api.browser.status(dirId).then(function(s) {
      var wasRunning = s && s.running;
      if (!wasRunning) {
        toast(t('toast.fp.launching', 'Launching profile and opening risk check…'), 'info');
      } else {
        toast(t('toast.fp.opening', 'Opening risk check…'), 'info');
      }
      return api.browser.openRiskCheck(dirId).then(function(r) {
        if (r && r.success) {
          toast(t('toast.fp.opened', 'Opened risk check in profile'), 'success');
          // Refresh profile list to reflect newly running state
          if (!wasRunning) scheduleProfilesRefresh();
        } else {
          toast((r && r.error) || t('toast.fp.nav-failed', 'Failed to navigate to risk check'), 'error');
        }
      });
    }).catch(function(e) { toast(e.message || String(e), 'error'); });
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
    ]).then(function (results) {
      var browserProfiles = results[0] || [];
      var proxies = results[1];

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
          fingerprint: { browser: "chromium", version: cp.version, mode: cp.fingerprintMode || "managed", browserVersion: cp.browserVersion || null, platform: cp.platform || "windows", seed: cp.fingerprintSeed, timezone: cp.timezone, locale: cp.locale, webrtcMode: cp.webrtcMode || (cp.webrtcIp ? "altered" : "auto"), webrtcIp: cp.webrtcIp },
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
          ? '<div class="empty-state">No profiles match the current filter.</div>'
          : '<div class="empty-state">No profiles.<br>Click "+ New Profile" to get started.</div>';
        return;
      }

      var proxyOpts = (proxies || []).map(function (p) {
        var cfg = p.config || {};
        var label = String(cfg.type || "") + '://' + String(cfg.host || "") + ':' + String(cfg.port || "");
        return '<option value="' + escAttr(p.name) + '">' +
          esc(p.name) + ' (' + esc(label) + ')' + (p.isDefault ? ' ★' : '') + '</option>';
      }).join("");

      container.innerHTML = profiles.map(function (p) {
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

        var browserIcon = "🥷", browserName = "Managed Chromium";
        var fingerprintLabel = fp.mode === "off"
          ? "↪ Pass-through"
          : platformIcon(platform) + " 🎲#" + (fp.seed || "?");
        var hardware = { gpuRenderer: p.gpuRenderer, hardwareConcurrency: p.hardwareConcurrency, deviceMemory: p.deviceMemory, screenWidth: p.screenWidth, screenHeight: p.screenHeight };
        var fpCompleteness = fingerprintCompleteness(p);
        var identityStr = fp.mode === "off"
          ? "Native host identity"
          : (fp.timezone || "auto tz") + " · " + (fp.locale || "auto locale") + " · RTC " + esc(fp.webrtcMode || (fp.webrtcIp ? "altered" : "auto"));
        if (fp.mode !== "off" && fp.webrtcIp) identityStr += " · " + esc(fp.webrtcIp);
        var fingerprintTitle = (fp.mode === "off" ? "Real machine pass-through" : "Seed " + (fp.seed || "?") + " · " + osName + " · " + (fp.locale || "auto locale") + " · " + (fp.timezone || "auto timezone") + " · " + hardwareSummary(hardware) + " · completeness " + fpCompleteness + "%") + " · Chromium " + (fp.browserVersion || fp.version || "auto");
        var checkRiskAction = '<button class="btn btn-xs" data-action="risk-check" title="Open ping0.cc/env in this profile to check fingerprint risk" style="font-size:9px;">🔍 Check Risk</button> ';
        var driftCheckAction = '<button class="btn btn-xs" data-action="drift-check" title="Compare live fingerprint against the stored baseline" style="font-size:9px;">🧬 Drift</button> ';
        var envCheckAction = '<button class="btn btn-xs" data-action="env-risk" title="Check host environment risks (DNS resolvers / CN fonts / proxy DNS / rAF)" style="font-size:9px;">🖥 Env</button> ';
        var webRtcAction = '<button class="btn btn-xs" data-action="webrtc-diag" title="Run an in-browser WebRTC probe (ICE candidates / mDNS / RTT)" style="font-size:9px;">📡 WebRTC</button> ';
        var openAppAction = '<button class="btn btn-xs" data-action="open-app" title="Open as Web App (PWA / Sub-apps): standalone app window with this profile identity" style="font-size:9px;">🖥 App</button> ';
        var isLocked = !!(p.lock && p.lock.owner);
        var lockBadge = isLocked ? '<span class="status-badge" style="background:var(--warning-bg);color:var(--warning);" title="' + escAttr('Locked by ' + (p.lock.ownerName || p.lock.owner)) + '">🔒 ' + esc(p.lock.ownerName || 'device') + '</span>' : '';
        var drmBadge = p.drm ? '<span class="status-badge" style="background:var(--primary-bg);color:var(--primary);" title="Widevine/DRM enabled">🎬 DRM</span>' : '';
        var appBadge = p.appUrl ? '<span class="status-badge" style="background:var(--surface2);color:var(--text);" title="Web App: ' + escAttr(p.appUrl) + '">🖥 App</span>' : '';
        var tagHtml = (p.tags || []).map(function(tag) {
          return '<span class="status-badge status-done" style="font-size:9px;margin-right:4px;">' + esc(tag) + '</span>';
        }).join('');

        var proxyOptsHtml = renderProxyOptions(proxies, profileProxySelectionValue(p, "none"), true);

        return '<div class="profile-card' + (isRunning ? ' running' : '') + '" data-dir-id="' + escAttr(p.dirId) + '" data-lock="' + (isLocked ? '1' : '0') + '">' +
          '<div class="card-header">' +
            '<label class="profile-select" title="Select"><input type="checkbox" class="profile-select-checkbox" data-dir-id="' + escAttr(p.dirId) + '"' + (profileSelection[p.dirId] ? ' checked' : '') + '></label>' +
            '<span class="name" title="Click to rename" data-action="rename">' + esc(p.name) + '</span>' +
            '<span class="status-badge ' + (isRunning ? 'status-running' : 'status-stopped') + '">' + (isRunning ? 'Running' : 'Stopped') + '</span>' +
            lockBadge +
            drmBadge +
            appBadge +
          '</div>' +
          '<div class="info-row"><span>Browser</span><span>' + browserIcon + ' ' + esc(browserName) + '</span></div>' +
          '<div class="info-row"><span>Modified</span><span>' + date + '</span></div>' +
          '<div class="info-row"><span>Fingerprint</span><span title="' + escAttr(fingerprintTitle) + '">' + esc(fingerprintLabel) + '</span></div>' +
          '<div class="info-row"><span>Identity</span><span title="' + escAttr(identityStr) + '">' + esc(identityStr) + '</span></div>' +
          '<div class="info-row"><span>Hardware</span><span title="' + escAttr(hardwareSummary(hardware)) + '">' + esc(hardwareSummary(hardware)) + ' ' + checkRiskAction + driftCheckAction + envCheckAction + webRtcAction + (p.appUrl ? openAppAction : '') + '</span></div>' +
          '<div class="info-row"><span>Sync</span><span class="' + syncCls + '" title="' + escAttr(syncTitle) + '"><button class="btn btn-xs" style="font-size:9px;color:var(--text-muted);" data-action="note">📝</button>' + syncIcon + ' ' + esc((p.syncStatus === "synced" ? "Synced" : p.syncStatus === "dirty" ? "Dirty" : "Never")) + '</span></div>' +
          '<div class="info-row"><span>Proxy</span><span>' + esc(proxyStr) + '</span></div>' +
          ((p.tags || []).length ? '<div class="info-row"><span>Tags</span><span>' + tagHtml + '</span></div>' : '') +
          '<div class="card-actions">' +
            (isRunning
              ? '<button class="btn btn-secondary btn-sm" data-action="stop">⏹ Stop</button> '
              : '<button class="btn btn-primary btn-sm" data-action="launch">▶ Launch</button> ') +
            '<button class="btn btn-secondary btn-sm" data-action="edit">✎ Edit</button> ' +
            '<button class="btn btn-secondary btn-sm" data-action="cookies" title="Cookies">🍪</button> ' +
            '<button class="btn btn-secondary btn-sm" data-action="extensions" title="Extensions">🧩</button> ' +
            '<button class="btn btn-secondary btn-sm" data-action="export-archive" title="Export backup">📦</button> ' +
            '<button class="btn btn-secondary btn-sm" data-action="lock" title="' + (isLocked ? 'Release lock (uncheckout)' : 'Check out / lock to this device') + '">' + (isLocked ? '🔓' : '🔒') + '</button> ' +
            '<button class="btn btn-secondary btn-sm" data-action="logs" title="Operation logs + browser log tail (RoxyBrowser-style)">📋</button> ' +
            '<button class="btn btn-danger btn-sm" data-action="delete">🗑</button>' +
          '</div>' +
          '<div style="margin-top:4px;">' +
            '<select class="proxy-select" data-action="proxy" style="width:100%;font-size:10px;padding:4px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);">' + proxyOptsHtml + '</select>' +
          '</div>' +
        '</div>';
      }).join("");
      attachProfileCardHandlers(container);
      updateBatchBar(proxies);
    }).catch(function (e) {
      container.innerHTML = '<div class="empty-state">Error: ' + esc(e.message || String(e)) + '</div>';
    });
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
      if (!target || target.dataset.action !== "proxy") return;
      var card = target.closest(".profile-card");
      if (card && card.dataset.dirId) agentBrowser.proxyChanged(card.dataset.dirId, target);
    };
  }

  agentBrowser.checkDrift = function(dirId) {
    api.browser.checkDrift(dirId).then(function(r) {
      if (!r || !r.ok) { toast((r && r.error) || "Fingerprint check failed", "error"); return; }
      if (!r.hasBaseline) {
        toast("No fingerprint baseline yet — launch and use Capture Baseline first", "info");
        return;
      }
      if (!r.risky) {
        toast("Fingerprint stable (" + ((r.drift || []).length) + " benign change(s))", "success");
      } else {
        var fields = (r.drift || []).map(function(d) { return d.field; }).slice(0, 6).join(", ");
        toast("⚠ Risky fingerprint drift: " + fields + ((r.drift || []).length > 6 ? " (+" + ((r.drift || []).length - 6) + ")" : ""), "error");
      }
    }).catch(function(e) { toast(e.message || String(e), "error"); });
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
    rows.push('<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">中文字体: ' + ((res.cnFonts || []).join(', ') || '无') + '</div>');
    rows.push('<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">代理: ' + esc((res.proxy && res.proxy.mode) || '?') + ' · ' + esc((res.proxy && (res.proxy.type || '')) || '') + ' · DNS ' + esc((res.proxy && res.proxy.dnsLeakRisk) || '') + '</div>');
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
      (!findings.length ? '<div class="empty-state">未发现环境风险</div>' : '') +
      '</div>';
  }

  agentBrowser.openEnvRisk = function(dirId) {
    var dlg = document.getElementById('dlg-env-risk');
    var body = document.getElementById('env-risk-body');
    if (!dlg) { toast('Env check dialog unavailable', 'error'); return; }
    if (body) body.innerHTML = '<div class="loading">Checking host environment…</div>';
    dlg.showModal();
    api.browser.envRisk(dirId).then(renderEnvRisk).catch(function(e) {
      renderEnvRisk({ ok: false, error: e.message || String(e) });
    });
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
    rows.push('<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">RTCPeerConnection: ' + (res.rtcAvailable ? "可用" : "不可用") + ' · ICE candidates: ' + (res.candidates || []).length + ' · 连接状态: ' + esc(res.connectionState || "") + (typeof res.rttMs === "number" ? " · RTT: " + res.rttMs + "ms" : "") + '</div>');
    if ((res.mdnsHosts || []).length) rows.push('<div style="font-size:11px;margin-top:4px;"><span style="color:var(--text-muted);">mDNS 主机名: </span>' + res.mdnsHosts.map(esc).join(", ") + '</div>');
    if (hasLeak) rows.push('<div style="font-size:11px;margin-top:4px;"><span style="color:var(--danger);">⚠ 本地 IP 泄漏: </span>' + res.hostIps.map(esc).join(", ") + '</div>');
    if ((res.srflxIps || []).length) rows.push('<div style="font-size:11px;margin-top:4px;"><span style="color:var(--text-muted);">STUN 公网 IP: </span>' + res.srflxIps.map(esc).join(", ") + '</div>');
    if (res.error) rows.push('<div style="font-size:11px;color:var(--warning);margin-top:4px;">⚠ ' + esc(res.error) + '</div>');
    body.innerHTML = rows.join("");
    var histEl = document.getElementById("webrtc-diag-history");
    if (histEl && dirId) {
      api.webrtc.diagHistory(dirId).then(function(h) {
        var entries = (h && h.entries) || [];
        if (!entries.length) { histEl.innerHTML = '<div style="font-size:11px;color:var(--text-muted);margin-top:8px;">' + esc(t("webrtc.diag.no-history", "暂无历史记录")) + '</div>'; return; }
        var html = '<div style="font-size:11px;color:var(--text-muted);margin-top:8px;border-top:1px solid var(--border);padding-top:6px;">' + esc(t("webrtc.diag.history", "历史记录 ({n})").replace("{n}", entries.length)) + '</div>';
        entries.slice().reverse().forEach(function(en) {
          var ts = en.at ? new Date(en.at).toLocaleString() : "?";
          var leak = (en.hostIps || []).length > 0;
          html += '<div style="font-size:11px;margin-top:4px;">' + (leak ? "⚠" : "✅") + " " + esc(ts) + " — " + esc(en.summary || "") + '</div>';
        });
        histEl.innerHTML = html;
      }).catch(function() { histEl.innerHTML = ""; });
    }
  }

  agentBrowser.openWebRtcDiag = function(dirId) {
    window.__webrtcDiagDirId = dirId;
    var dlg = document.getElementById("dlg-webrtc-diag");
    var body = document.getElementById("webrtc-diag-body");
    var histEl = document.getElementById("webrtc-diag-history");
    if (!dlg) { toast(t("webrtc.diag.unavailable", "WebRTC 诊断对话框不可用"), "error"); return; }
    if (body) body.innerHTML = '<div class="loading">' + esc(t("webrtc.diag.running", "运行 WebRTC 诊断（如需会自动启动 profile 浏览器）…")) + '</div>';
    if (histEl) histEl.innerHTML = "";
    dlg.showModal();
    api.webrtc.diag(dirId).then(function(r) {
      renderWebRtcDiag(r || { ok: false, error: "unknown" }, dirId);
    }).catch(function(e) {
      renderWebRtcDiag({ ok: false, error: e.message || String(e) }, dirId);
    });
  };

  agentBrowser.webRtcDiagClear = function() {
    var dirId = window.__webrtcDiagDirId;
    if (!dirId) { return; }
    api.webrtc.diagClear(dirId).then(function(r) {
      if (r && r.success) { toast(t("webrtc.diag.cleared", "WebRTC 诊断历史已清除"), "success"); }
      var histEl = document.getElementById("webrtc-diag-history");
      if (histEl) histEl.innerHTML = '<div style="font-size:11px;color:var(--text-muted);margin-top:8px;">' + esc(t("webrtc.diag.no-history", "暂无历史记录")) + '</div>';
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
      activityEl.innerHTML = '<div class="empty-state">' + esc(t("logs.no-activity", "暂无操作记录")) + '</div>';
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
    tailEl.textContent = r.logTail || (t("logs.no-tail", "暂无浏览器日志（启动 profile 后生成）"));
  }

  agentBrowser.showProfileLogs = function(dirId) {
    document.getElementById("profile-logs-dir-id").value = dirId;
    var dlg = document.getElementById("dlg-profile-logs");
    if (!dlg) { toast(t("logs.unavailable", "日志对话框不可用"), "error"); return; }
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
    if (!locked) {
      var ok = confirm('锁定这个 profile 到当前设备？其他设备 Push 时将无法覆盖它（可强制覆盖）。\n\n锁定后记得 Push 一次，把锁同步到远端。');
      if (!ok) return;
    }
    api.browser.setLock(dirId, !locked).then(function(r) {
      if (!r || !r.success) { toast((r && r.error) || 'Lock failed', 'error'); return; }
      toast(locked ? '🔓 已解锁（记得 Push 同步）' : '🔒 已锁定到本设备（记得 Push 同步）', 'success');
      agentBrowser.loadProfiles();
    }).catch(function(e) { toast(e.message || String(e), 'error'); });
  };

  agentBrowser.loadProfiles = loadProfiles;

})();
