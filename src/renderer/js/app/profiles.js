(function() {
  "use strict";

  var cloak = window.cloak;
  var api = cloak.api;
  var R = cloak.R;
  var state = cloak.state;
  var helpers = cloak.helpers;
  var toast = helpers.toast;
  var esc = helpers.esc;
  var escAttr = helpers.escAttr;
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
  var normalizeCloakPlatform = helpers.normalizeCloakPlatform;
  var updateCloakStatus = helpers.updateCloakStatus;
  var renderCloakBinaryCard = helpers.renderCloakBinaryCard;

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
    return api.cloak.binary().then(function(info) {
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

  Object.assign(cloak, {
  launch: function (dirId) {
        api.cloak.launch(dirId).then(function (r) {
          if (r.success) {
            toast((window.i18n ? window.i18n.t("toast.profile.started", "🥷 CloakBrowser started") : "🥷 CloakBrowser started") + " (CDP port " + r.cdpPort + ")", "success");
            var seq = markProfileRuntime(dirId, true, r.pid);
            setTimeout(function () { clearProfileRuntime(dirId, seq); scheduleProfilesRefresh(); }, 5000);
            scheduleProfilesRefresh();
          } else {
            toast(r.error || (window.i18n ? window.i18n.t("toast.profile.launch-failed", "CloakBrowser launch failed") : "CloakBrowser launch failed"), "error");
          }
        }).catch(function (e) { toast(e.message, "error"); });
      },

  stop: function (dirId) {
        api.cloak.stop(dirId).then(function (r) {
          if (r && r.success === false) { toast(r.error || (window.i18n ? window.i18n.t("toast.profile.stop-failed", "Stop failed") : "Stop failed"), "error"); scheduleProfilesRefresh(); return; }
          toast((window.i18n ? window.i18n.t("toast.profile.stopped", "Browser stopped") : "Browser stopped"), "success");
          var seq = markProfileRuntime(dirId, false, null);
          setTimeout(function () { clearProfileRuntime(dirId, seq); scheduleProfilesRefresh(); }, 5000);
          scheduleProfilesRefresh();
        }).catch(function (e) { toast(e.message, "error"); });
      },

  editProfile: function (dirId) {
        api.cloak.list().then(function(profiles) {
          var p = (profiles || []).find(function(x) { return x.dirId === dirId; });
          if (!p) { toast((window.i18n ? window.i18n.t("toast.profile.not-found", "Profile not found") : "Profile not found"), "error"); return; }
          var metaData = {
            name: p.name || "",
            fingerprintMode: p.fingerprintMode || "managed",
            browserVersion: p.browserVersion || "",
            allowThirdPartyCookies: p.allowThirdPartyCookies === true,
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
            proxyMode: p.proxyMode || (p.proxyName ? "named" : "none"),
            proxyName: p.proxyName || null
          };
          document.getElementById("cloak-meta-dir-id").value = dirId;
          document.getElementById("cloak-meta-fingerprint-mode").value = metaData.fingerprintMode;
          populateChromiumVersionSelect("cloak-meta-browser-version", metaData.browserVersion);
          document.getElementById("cloak-meta-allow-third-party-cookies").checked = metaData.allowThirdPartyCookies;
          document.getElementById("cloak-meta-name").value = metaData.name;
          document.getElementById("cloak-meta-seed").value = metaData.seed;
          document.getElementById("cloak-meta-platform").value = metaData.platform;
          document.getElementById("cloak-meta-timezone").value = metaData.timezone;
          document.getElementById("cloak-meta-locale").value = metaData.locale;
          document.getElementById("cloak-meta-webrtc-mode").value = metaData.webrtcMode;
          document.getElementById("cloak-meta-webrtc").value = metaData.webrtcIp;
          writeGeolocationFields("cloak-meta-", metaData);
          writeHardwareFields("cloak-meta-", metaData);
          api.proxy.list().then(function(proxies) {
            var sel = document.getElementById("cloak-meta-proxy");
            sel.innerHTML = renderProxyOptions(proxies, proxySelectionValue(metaData.proxyMode, metaData.proxyName), false);
          });
          document.getElementById("dlg-cloak-seed").showModal();
        }).catch(function (e) { toast(e.message, "error"); });
      },

  openDir: function (dirId) {
        api.profile.get(dirId).then(function (info) {
          return api.app.openDir(info.path);
        }).catch(function (e) { toast(e.message, "error"); });
      },

  delProfile: function (dirId) {
        cloak.confirm("Delete profile? All data will be removed.", function () {
          api.cloak.delete(dirId).then(function (r) {
            if (r && r.success) { toast((window.i18n ? window.i18n.t("toast.deleted", "Deleted") : "Deleted"), "success"); cloak.refresh(); }
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
        api.cloak.setMeta(dirId, { name: newName }).then(function (r) {
          document.getElementById("dlg-rename").close();
          if (r.success) { toast((window.i18n ? window.i18n.t("toast.renamed", "Renamed") : "Renamed"), "success"); cloak.refresh(); }
          else toast(r.error || "Failed", "error");
        }).catch(function (e) { toast(e.message, "error"); });
      },

  proxyChanged: function (dirId, selectEl) {
        var selection = parseProxySelection(selectEl.value, "none");
        api.proxy.setProfile(dirId, selection.name, selection.mode).then(function (r) {
          if (r && r.success === false) { toast(r.error || (window.i18n ? window.i18n.t("toast.proxy.update-failed", "Proxy update failed") : "Proxy update failed"), "error"); cloak.refresh(); return; }
          toast((window.i18n ? window.i18n.t("toast.proxy.updated", "Proxy updated") : "Proxy updated"), "success"); cloak.refresh();
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
        document.getElementById("new-cloak-fingerprint-mode").value = "managed";
        populateChromiumVersionSelect("new-cloak-browser-version", "");
        document.getElementById("new-cloak-allow-third-party-cookies").checked = false;
        document.getElementById("new-cloak-seed").value = "";
        document.getElementById("new-cloak-platform").value = "windows";
        document.getElementById("new-cloak-timezone").value = "";
        document.getElementById("new-cloak-locale").value = "";
        document.getElementById("new-cloak-webrtc").value = "";
        writeGeolocationFields("new-cloak-", {});
        writeHardwareFields("new-cloak-", {});
      },

  newProfile: function () {
        cloak.resetNewProfileForm("cloak");
        cloak.loadNewProfileProxies();
        cloak.profileBrowserChanged();
        document.getElementById("dlg-profile").showModal();
      },

  profileBrowserChanged: function() {
        var chromeOpts = document.getElementById("new-profile-chrome-opts");
        var cloakOpts = document.getElementById("new-profile-cloak-opts");
        var firefoxOpts = document.getElementById("new-profile-firefox-opts");
        if (chromeOpts) chromeOpts.style.display = "none";
        if (cloakOpts) cloakOpts.style.display = "block";
        if (firefoxOpts) firefoxOpts.style.display = "none";
        var browserRow = document.getElementById("new-profile-browser-row");
        if (browserRow) browserRow.style.display = "none";
        var proxyRow = document.getElementById("new-profile-proxy-row");
        if (proxyRow) proxyRow.style.display = "block";
        cloak.loadNewProfileProxies();
      },

  createProfile: function () {
        var name = document.getElementById("new-profile-name").value.trim();
        var proxySelection = parseProxySelection(document.getElementById("new-profile-proxy").value, "default");

        if (!name) { toast((window.i18n ? window.i18n.t("toast.profile.name-prompt", "Please enter a name") : "Please enter a name"), "error"); return; }

        var cloakPlatform = document.getElementById("new-cloak-platform").value;
        var fingerprintMode = document.getElementById("new-cloak-fingerprint-mode").value || "managed";
        var browserVersion = document.getElementById("new-cloak-browser-version").value || null;
        var allowThirdPartyCookies = document.getElementById("new-cloak-allow-third-party-cookies").checked;
        var seedRaw = document.getElementById("new-cloak-seed").value.trim();
        var seed = seedRaw ? Number(seedRaw) : undefined;
        if (seed !== undefined && (!Number.isInteger(seed) || seed < 1 || seed > 999999)) { toast((window.i18n ? window.i18n.t("toast.invalid-seed", "Invalid seed") : "Invalid seed"), "error"); return; }
        var tz = document.getElementById("new-cloak-timezone").value || undefined;
        var loc = document.getElementById("new-cloak-locale").value || undefined;
        var webrtcMode = document.getElementById("new-cloak-webrtc-mode").value || "auto";
        var webrtcIp = document.getElementById("new-cloak-webrtc").value.trim() || undefined;
        if (webrtcMode === "real" || webrtcMode === "disable") webrtcIp = undefined;
        var hardware, geolocation;
        try { hardware = readHardwareFields("new-cloak-"); geolocation = readGeolocationFields("new-cloak-"); }
        catch (e) { toast(e.message || String(e), "error"); return; }

        api.cloak.create(Object.assign({
          name: name,
          fingerprintMode: fingerprintMode,
          browserVersion: browserVersion,
          allowThirdPartyCookies: allowThirdPartyCookies,
          fingerprintSeed: seed,
          platform: cloakPlatform,
          timezone: tz,
          locale: loc,
          webrtcMode: webrtcMode,
          webrtcIp: webrtcIp,
          proxyMode: proxySelection.mode,
          proxyName: proxySelection.name,
        }, geolocation, hardware)).then(function(r) {
          document.getElementById("dlg-profile").close();
          toast((window.i18n ? window.i18n.t("toast.profile.created", "CloakBrowser profile created!") : "CloakBrowser profile created!"), "success");
          loadProfiles();
          cloak.switchTab("profiles");
        }).catch(function(e) { toast(e.message, "error"); });
      },

  refresh: function () { cloak.loadTab(state.currentTab); },

  refreshProfilesSoft: function () { loadProfiles(true); }
  });
  cloak.bulkImport = function() {
    api.proxy.list().then(function(proxies) {
      document.getElementById("bulk-import-proxy").innerHTML = renderProxyOptions(proxies, "default", false);
      document.getElementById("bulk-import-text").value = "";
      document.getElementById("bulk-import-status").innerHTML = "";
      document.getElementById("dlg-bulk-import").showModal();
    });
  };

  cloak.doBulkImport = function() {
    var text = document.getElementById("bulk-import-text").value.trim();
    var fallbackProxy = parseProxySelection(document.getElementById("bulk-import-proxy").value, "default");
    var statusEl = document.getElementById("bulk-import-status");
    if (!text) { statusEl.innerHTML = '<span style="color:var(--danger);">Enter profile definitions</span>'; return; }
    // Parse via the shared CSV parser (supports header + per-row proxy/tags).
    api.cloak.parseBulkCsv(text).then(function(res) {
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
          setTimeout(function() { document.getElementById("dlg-bulk-import").close(); cloak.refresh(); }, 1000);
          return;
        }
        var s = specs[idx];
        // Per-row proxy wins; else the dialog's fallback selection.
        var proxyMode = s.proxyName ? "named" : fallbackProxy.mode;
        var proxyName = s.proxyName || fallbackProxy.name;
        api.cloak.create({
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

  cloak.bulkStart = function() {
    api.cloak.list().then(function(profiles) {
      var stopped = (profiles || []).filter(function(p) { return !p.running; });
      if (stopped.length === 0) { toast((window.i18n ? window.i18n.t("toast.bulk.all-running", "All profiles already running") : "All profiles already running"), "success"); return; }
      toast("Starting " + stopped.length + " profiles...", "success");
      stopped.forEach(function(p, i) {
        setTimeout(function() {
          cloak.launch(p.dirId);
          if (i === stopped.length - 1) { toast(stopped.length + " profiles started", "success"); setTimeout(cloak.refresh, 2000); }
        }, i * 500);
      });
    }).catch(function(){});
  };

  cloak.bulkStop = function() {
    api.cloak.list().then(function(profiles) {
      var running = (profiles || []).filter(function(p) { return p.running; });
      if (running.length === 0) { toast((window.i18n ? window.i18n.t("toast.bulk.none-running", "No profiles running") : "No profiles running"), "success"); return; }
      toast("Stopping " + running.length + " profiles...", "success");
      running.forEach(function(r) { cloak.stop(r.dirId); });
      setTimeout(cloak.refresh, 2000);
    }).catch(function(){});
  };

  cloak.openRiskCheck = function(dirId) {
    var t = function(k, fb) { return window.i18n ? window.i18n.t(k, fb) : fb; };
    api.cloak.status(dirId).then(function(s) {
      var wasRunning = s && s.running;
      if (!wasRunning) {
        toast(t('toast.fp.launching', 'Launching profile and opening risk check…'), 'info');
      } else {
        toast(t('toast.fp.opening', 'Opening risk check…'), 'info');
      }
      return api.cloak.openRiskCheck(dirId).then(function(r) {
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

  cloak.addNote = function(dirId) {
    api.cloak.list().then(function(profiles) {
      var p = (profiles || []).find(function(x) { return x.dirId === dirId; });
      var note = (p && p.note) || "";
      document.getElementById("note-dir-id").value = dirId;
      document.getElementById("note-text").value = note;
      document.getElementById("dlg-note").showModal();
    });
  };

  cloak.saveNote = function() {
    var dirId = document.getElementById("note-dir-id").value;
    var note = document.getElementById("note-text").value.trim();
    document.getElementById("dlg-note").close();
    api.cloak.setMeta(dirId, { note: note }).then(function(r) {
      if (r.success) { toast((window.i18n ? window.i18n.t("toast.note.saved", "Note saved") : "Note saved"), "success"); cloak.refresh(); }
      else toast((window.i18n ? window.i18n.t("toast.note.save-failed", "Failed to save note") : "Failed to save note"), "error");
    });
  };
  cloak.saveCloakMeta = function() {
    var dirId = document.getElementById("cloak-meta-dir-id").value;
    var name = document.getElementById("cloak-meta-name").value.trim();
    var fingerprintMode = document.getElementById("cloak-meta-fingerprint-mode").value || "managed";
    var browserVersion = document.getElementById("cloak-meta-browser-version").value || null;
    var allowThirdPartyCookies = document.getElementById("cloak-meta-allow-third-party-cookies").checked;
    var seed = Number(document.getElementById("cloak-meta-seed").value);
    var platform = document.getElementById("cloak-meta-platform").value;
    var timezone = document.getElementById("cloak-meta-timezone").value || null;
    var locale = document.getElementById("cloak-meta-locale").value || null;
    var webrtcMode = document.getElementById("cloak-meta-webrtc-mode").value || "auto";
    var webrtcIp = document.getElementById("cloak-meta-webrtc").value.trim() || null;
    if (webrtcMode === "real" || webrtcMode === "disable") webrtcIp = null;
    var proxySelection = parseProxySelection(document.getElementById("cloak-meta-proxy").value, "none");
    var hardware, geolocation;
    try { hardware = readHardwareFields("cloak-meta-"); geolocation = readGeolocationFields("cloak-meta-"); }
    catch (e) { toast(e.message || String(e), "error"); return; }
    document.getElementById("dlg-cloak-seed").close();
    if (!Number.isInteger(seed) || seed < 1 || seed > 999999) { toast((window.i18n ? window.i18n.t("toast.invalid-seed", "Invalid seed") : "Invalid seed"), "error"); return; }
    if (!name) { toast((window.i18n ? window.i18n.t("toast.name-required", "Name required") : "Name required"), "error"); return; }
    var promises = [];
    promises.push(api.cloak.setMeta(dirId, Object.assign({
      name: name, fingerprintMode: fingerprintMode, browserVersion: browserVersion,
      allowThirdPartyCookies: allowThirdPartyCookies,
      fingerprintSeed: seed, platform: platform,
      timezone: timezone, locale: locale, webrtcMode: webrtcMode, webrtcIp: webrtcIp,
      proxyMode: proxySelection.mode, proxyName: proxySelection.name
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
      api.cloak.list().catch(function () { return []; }),
      api.proxy.list(),
    ]).then(function (results) {
      var cloakProfiles = results[0] || [];
      var proxies = results[1];

      // Build a proxy lookup map for legacy renderer-side fallback.
      var proxyMap = {};
      var defaultProxyName = null;
      (proxies || []).forEach(function(p) { proxyMap[p.name] = p.config; if (p.isDefault) defaultProxyName = p.name; });

      var profiles = cloakProfiles.map(function(cp) {
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
          fingerprint: { browser: "cloak", version: cp.version, mode: cp.fingerprintMode || "managed", browserVersion: cp.browserVersion || null, platform: cp.platform || "windows", seed: cp.fingerprintSeed, timezone: cp.timezone, locale: cp.locale, webrtcMode: cp.webrtcMode || (cp.webrtcIp ? "altered" : "auto"), webrtcIp: cp.webrtcIp },
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

      if (!profiles || profiles.length === 0) {
        container.innerHTML = '<div class="empty-state">No profiles.<br>Click "+ New Profile" to get started.</div>';
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

        var browserIcon = "🥷", browserName = "CloakBrowser";
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
        var tagHtml = (p.tags || []).map(function(tag) {
          return '<span class="status-badge status-done" style="font-size:9px;margin-right:4px;">' + esc(tag) + '</span>';
        }).join('');

        var proxyOptsHtml = renderProxyOptions(proxies, profileProxySelectionValue(p, "none"), true);

        return '<div class="profile-card' + (isRunning ? ' running' : '') + '" data-dir-id="' + escAttr(p.dirId) + '">' +
          '<div class="card-header">' +
            '<span class="name" title="Click to rename" data-action="rename">' + esc(p.name) + '</span>' +
            '<span class="status-badge ' + (isRunning ? 'status-running' : 'status-stopped') + '">' + (isRunning ? 'Running' : 'Stopped') + '</span>' +
          '</div>' +
          '<div class="info-row"><span>Browser</span><span>' + browserIcon + ' ' + esc(browserName) + '</span></div>' +
          '<div class="info-row"><span>Modified</span><span>' + date + '</span></div>' +
          '<div class="info-row"><span>Fingerprint</span><span title="' + escAttr(fingerprintTitle) + '">' + esc(fingerprintLabel) + '</span></div>' +
          '<div class="info-row"><span>Identity</span><span title="' + escAttr(identityStr) + '">' + esc(identityStr) + '</span></div>' +
          '<div class="info-row"><span>Hardware</span><span title="' + escAttr(hardwareSummary(hardware)) + '">' + esc(hardwareSummary(hardware)) + ' ' + checkRiskAction + '</span></div>' +
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
            '<button class="btn btn-danger btn-sm" data-action="delete">🗑</button>' +
          '</div>' +
          '<div style="margin-top:4px;">' +
            '<select class="proxy-select" data-action="proxy" style="width:100%;font-size:10px;padding:4px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);">' + proxyOptsHtml + '</select>' +
          '</div>' +
        '</div>';
      }).join("");
      attachProfileCardHandlers(container);
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
      if (action === "rename") cloak.renameProfile(dirId, card.querySelector(".name")?.textContent || "");
      else if (action === "note") cloak.addNote(dirId);
      else if (action === "stop") cloak.stop(dirId);
      else if (action === "launch") cloak.launch(dirId);
      else if (action === "edit") cloak.editProfile(dirId);
      else if (action === "cookies") cloak.showCookies(dirId);
      else if (action === "extensions") cloak.showExtensions(dirId);
      else if (action === "delete") cloak.delProfile(dirId);
      else if (action === "risk-check") cloak.openRiskCheck(dirId);
    };
    container.onchange = function (event) {
      var target = event.target;
      if (!target || target.dataset.action !== "proxy") return;
      var card = target.closest(".profile-card");
      if (card && card.dataset.dirId) cloak.proxyChanged(card.dataset.dirId, target);
    };
  }
  cloak.loadProfiles = loadProfiles;

})();
