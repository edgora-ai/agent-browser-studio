(function() {
  "use strict";

  var agentBrowser = window.agentBrowser;
  var api = agentBrowser.api;
  var R = agentBrowser.R;
  var state = agentBrowser.state;
  var helpers = agentBrowser.helpers;
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
  var normalizeBrowserPlatform = helpers.normalizeBrowserPlatform;
  var updateBrowserStatus = helpers.updateBrowserStatus;
  var renderBrowserBinaryCard = helpers.renderBrowserBinaryCard;
  Object.assign(agentBrowser, {
  showCookies: function (dirId) {
        document.getElementById("cookie-dir-id").value = dirId;
        document.getElementById("cookie-list").innerHTML = '<div class="loading">Loading cookies...</div>';
        document.getElementById("cookie-search").value = "";
        document.getElementById("dlg-cookies").showModal();
        agentBrowser.loadCookies(dirId, "");
      },

  loadCookies: function (dirId, filter) {
        var list = document.getElementById("cookie-list");
        api.profile.cookies(dirId, filter || "").then(function (cookies) {
          if (!cookies || cookies.length === 0) {
            list.innerHTML = '<div class="empty-state">' + esc(window.i18n ? window.i18n.t("cookies.empty", "No cookies found.") : "No cookies found.") + '</div>';
            return;
          }
          list.innerHTML = '<table class="cookie-table"><thead><tr><th>Domain</th><th>Name</th><th>Value</th><th>Expires</th><th></th></tr></thead><tbody>' +
            cookies.map(function (c, idx) {
              var val = (c.value || "").substring(0, 60);
              var exp = c.expires ? new Date(c.expires * 1000).toLocaleDateString() : "Session";
              return '<tr>' +
                '<td title="' + escAttr(c.domain) + '">' + esc(c.domain.substring(0, 25)) + '</td>' +
                '<td title="' + escAttr(c.name) + '">' + esc(c.name.substring(0, 20)) + '</td>' +
                '<td title="' + escAttr(c.value || "") + '">' + esc(val) + '</td>' +
                '<td>' + exp + '</td>' +
                '<td><button class="btn btn-danger btn-sm" data-cookie-index="' + idx + '">✕</button></td>' +
              '</tr>';
            }).join("") +
          '</tbody></table>';
          list.onclick = function (event) {
            var btn = event.target.closest("[data-cookie-index]");
            if (!btn || !list.contains(btn)) return;
            var cookie = cookies[Number(btn.dataset.cookieIndex)];
            if (cookie) agentBrowser.delCookie(dirId, cookie.domain, cookie.name);
          };
        }).catch(function (e) { list.innerHTML = '<div class="empty-state">Error: ' + esc(e.message) + '</div>'; });
      },

  cookieSearch: function () {
        var dirId = document.getElementById("cookie-dir-id").value;
        var filter = document.getElementById("cookie-search").value.trim();
        agentBrowser.loadCookies(dirId, filter);
      },

  delCookie: function (dirId, domain, name) {
        api.profile.deleteCookie(dirId, domain, name).then(function (r) {
          if (r.success) { toast((window.i18n ? window.i18n.t("toast.cookie.deleted", "Cookie deleted") : "Cookie deleted"), "success"); agentBrowser.cookieSearch(); }
          else toast(r.error || "Failed", "error");
        }).catch(function (e) { toast(e.message, "error"); });
      },

  addCookie: function () {
        var dirId = document.getElementById("cookie-dir-id").value;
        var domain = document.getElementById("cookie-new-domain").value.trim();
        var name = document.getElementById("cookie-new-name").value.trim();
        var value = document.getElementById("cookie-new-value").value.trim();

        if (!domain || !name) { toast((window.i18n ? window.i18n.t("toast.cookie.fields-required", "Domain and Name required") : "Domain and Name required"), "error"); return; }
        api.profile.setCookie(dirId, { domain: domain, name: name, value: value }).then(function (r) {
          if (r.success) {
            toast((window.i18n ? window.i18n.t("toast.cookie.saved", "Cookie saved") : "Cookie saved"), "success");
            document.getElementById("cookie-new-domain").value = "";
            document.getElementById("cookie-new-name").value = "";
            document.getElementById("cookie-new-value").value = "";
            agentBrowser.cookieSearch();
          } else toast(r.error || "Failed", "error");
        }).catch(function (e) { toast(e.message, "error"); });
      }
  });

})();
