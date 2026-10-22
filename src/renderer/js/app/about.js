/**
 * About / build identity dialog.
 *
 * The dialog answers "which build am I running, and when was it made?" from
 * facts the main process observed on this binary — never from the source tree
 * or a guessed release date. Missing values render as "unavailable" rather than
 * being omitted, so a blank row can't be mistaken for a healthy one.
 */
(function () {
  "use strict";

  var agentBrowser = window.agentBrowser;
  var api = agentBrowser.api;
  var helpers = agentBrowser.helpers;
  var esc = helpers.esc;
  var toast = helpers.toast;
  var t = function (k, fb) { return window.i18n ? window.i18n.t(k, fb) : fb; };

  var lastInfo = null;
  var lastRequest = 0;

  function row(label, value, opts) {
    var mono = opts && opts.mono;
    var shown = (value === null || value === undefined || value === "") ? t("about.unavailable", "unavailable") : String(value);
    var missing = shown === t("about.unavailable", "unavailable");
    return '<div class="about-row' + (missing ? " is-missing" : "") + '">' +
      '<span class="about-label">' + esc(label) + '</span>' +
      '<span class="about-value' + (mono ? " mono" : "") + '">' + esc(shown) + '</span>' +
      '</div>';
  }

  function engineLabel(kind) {
    return kind === "chromium"
      ? t("about.engine.chromium", "Chromium")
      : t("about.engine.firefox", "Firefox");
  }

  function engineRows(kind, info) {
    var bundled = info.engines && info.engines[kind] ? info.engines[kind] : {};
    var installed = info.engineInstalled ? info.engineInstalled[kind] : null;
    var source = bundled.bundledSource === "manifest"
      ? t("about.source.manifest", "shipped manifest")
      : bundled.bundledSource === "archive"
        ? t("about.source.archive", "archive name")
        : null;
    var bundledText = bundled.bundledVersion
      ? bundled.bundledVersion + (source ? " · " + source : "")
      : null;
    return row(engineLabel(kind) + " · " + t("about.engine.bundled", "bundled"), bundledText) +
      row(engineLabel(kind) + " · " + t("about.engine.installed", "installed on this host"), installed);
  }

  function render(info) {
    var body = document.getElementById("about-body");
    if (!body) return;
    if (!info) {
      body.innerHTML = '<div class="hint-line">' + esc(t("about.unavailable", "unavailable")) + "</div>";
      return;
    }
    var stamps = t("about.group.stamps", "Build");
    var runtime = t("about.group.runtime", "Runtime");
    var host = t("about.group.host", "This host");
    body.innerHTML =
      '<div class="about-group"><h4>' + esc(stamps) + "</h4>" +
      row(t("about.version", "Version"), info.version) +
      row(t("about.appId", "Application ID"), info.appId, { mono: true }) +
      row(t("about.mode", "Mode"), info.packaged ? t("about.mode.packaged", "Packaged build") : t("about.mode.dev", "Development run")) +
      row(t("about.bundleMtime", "App bundle mtime"), info.bundle && info.bundle.mtime) +
      row(t("about.asarMtime", "app.asar mtime"), info.appArchive && info.appArchive.mtime) +
      row(t("about.mainMtime", "main entry compiled"), info.mainEntry && info.mainEntry.mtime) +
      row(t("about.appPath", "App path"), info.appPath, { mono: true }) +
      "</div>" +
      '<div class="about-group"><h4>' + esc(t("about.group.engines", "Browser engines")) + "</h4>" +
      engineRows("chromium", info) + engineRows("firefox", info) +
      "</div>" +
      '<div class="about-group"><h4>' + esc(runtime) + "</h4>" +
      row("Electron", info.runtime && info.runtime.electron) +
      row("Chromium", info.runtime && info.runtime.chrome) +
      row("Node.js", info.runtime && info.runtime.node) +
      row("V8", info.runtime && info.runtime.v8) +
      row(t("about.modules", "ABI (node modules)"), info.runtime && info.runtime.modules) +
      "</div>" +
      '<div class="about-group"><h4>' + esc(host) + "</h4>" +
      row(t("about.platform", "Platform"), info.host ? info.host.platform + " / " + info.host.arch : null) +
      row(t("about.osVersion", "OS version"), info.host ? (info.host.osName && info.host.osVersion ? info.host.osName + " " + info.host.osVersion : info.host.release) : null) +
      row(t("about.kernel", "Kernel"), info.host && info.host.release) +
      row(t("about.locale", "Locale"), info.locale ? info.locale.app + " / " + info.locale.system : null) +
      "</div>" +
      '<p class="hint-line">' + esc(t("about.mtime-caveat", "File times show when these files were written on this machine. A copy, unzip or signature step can change them; they do not prove when a release was published.")) + "</p>";
  }

  function load() {
    var body = document.getElementById("about-body");
    if (body) body.innerHTML = '<div class="hint-line">' + esc(t("common.loading", "Loading...")) + "</div>";
    lastInfo = null;
    if (!(api && api.app && typeof api.app.buildInfo === "function")) {
      render(null);
      return Promise.resolve(null);
    }
    var request = ++lastRequest;
    return Promise.resolve().then(function () { return api.app.buildInfo(); }).then(function (info) {
      if (request !== lastRequest) return lastInfo;
      lastInfo = info || null;
      render(lastInfo);
      return lastInfo;
    }).catch(function (error) {
      if (request !== lastRequest) return null;
      render(null);
      var status = document.getElementById("about-body");
      if (status) {
        status.innerHTML = '<div class="hint-line">' +
          esc(t("about.load-failed", "Build details could not be read from this app.")) +
          "</div>";
      }
      console.error("[about] build info unavailable:", error);
      return null;
    });
  }

  function showAbout() {
    var dlg = document.getElementById("dlg-about");
    if (!dlg) return;
    load();
    if (!dlg.open) dlg.showModal();
    if (typeof agentBrowser.focusDialogPrimary === "function") agentBrowser.focusDialogPrimary(dlg);
  }

  /** Clipboard text: one "label: value" line per fact, English labels so a
   *  pasted report is readable regardless of the UI language at copy time. */
  function buildInfoText(info) {
    if (!info) return "";
    var lines = [
      "Agent Browser Studio " + info.version,
      "appId: " + info.appId,
      "mode: " + (info.packaged ? "packaged" : "development"),
      "app: " + info.appPath,
      "bundle mtime: " + ((info.bundle && info.bundle.mtime) || "unavailable"),
      "app.asar mtime: " + ((info.appArchive && info.appArchive.mtime) || "unavailable"),
      "main entry mtime: " + ((info.mainEntry && info.mainEntry.mtime) || "unavailable"),
      "chromium bundled: " + (info.engines.chromium.bundledVersion || "unavailable"),
      "chromium installed: " + (info.engineInstalled.chromium || "unavailable"),
      "firefox bundled: " + (info.engines.firefox.bundledVersion || "unavailable"),
      "firefox installed: " + (info.engineInstalled.firefox || "unavailable"),
      "electron: " + info.runtime.electron,
      "chrome: " + info.runtime.chrome,
      "node: " + info.runtime.node,
      "v8: " + info.runtime.v8,
      "abi: " + info.runtime.modules,
      "host: " + info.host.platform + " " + info.host.arch + " " + info.host.release,
      "os: " + [info.host.osName, info.host.osVersion].filter(Boolean).join(" "),
      "locale: " + info.locale.app + " / " + info.locale.system,
    ];
    return lines.join("\n");
  }

  function copyBuildInfo() {
    var text = buildInfoText(lastInfo);
    if (!text) {
      toast(t("about.load-failed", "Build details could not be read from this app."), "error");
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(t("about.copied", "Build details copied"), "success");
      }, function () {
        toast(t("about.copy-failed", "Clipboard is unavailable"), "error");
      });
    } else {
      toast(t("about.copy-failed", "Clipboard is unavailable"), "error");
    }
  }

  agentBrowser.showAbout = showAbout;
  agentBrowser.copyAboutBuildInfo = copyBuildInfo;
  agentBrowser.refreshAbout = load;
})();
