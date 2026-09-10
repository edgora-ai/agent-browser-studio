(function() {
  "use strict";

  var agentBrowser = window.agentBrowser;
  var R = agentBrowser.api;
  var helpers = agentBrowser.helpers;
  var toast = helpers.toast;
  var esc = helpers.esc;
  var escAttr = helpers.escAttr;
  var icon = helpers.icon;
  var t = function(key, fallback) {
    return (window.i18n && window.i18n.t) ? window.i18n.t(key, fallback) : fallback;
  };
  var CATEGORY_ICON = { ecommerce: "box", social: "users", ads: "chart", crypto: "key", productivity: "grid", utility: "settings", generic: "globe" };
  var CATEGORY_LABEL = {
    ecommerce: t("adapters.category.ecommerce", "E-commerce"),
    social: t("adapters.category.social", "Social"),
    ads: t("adapters.category.ads", "Ads"),
    crypto: t("adapters.category.crypto", "Crypto"),
    productivity: t("adapters.category.productivity", "Productivity"),
    utility: t("adapters.category.utility", "Utility"),
    generic: t("adapters.category.generic", "Generic"),
  };

  function formatCapabilities(caps) {
    return (caps || []).map(function(c) { return c.replace(/-/g, " "); }).join(" · ");
  }

  agentBrowser.agentLoadAdapters = function() {
    var el = document.getElementById("agent-adapters-list");
    var search = document.getElementById("adapter-hub-search");
    if (!el) return;
    var filter = search ? search.value.trim() : "";
    el.innerHTML = '<div class="loading">Loading adapter hub...</div>';
    R.agent.platformAdapters.list(filter).then(function(items) {
      if (!items || items.length === 0) {
        el.innerHTML = '<div class="empty-state">No matching platform adapters in the hub.</div>';
        return;
      }
      var html = "";
      for (var i = 0; i < items.length; i++) {
        var a = items[i];
        var catIcon = CATEGORY_ICON[a.category] || "globe";
        var label = CATEGORY_LABEL[a.category] || a.category;
        /* R71: adapter card inline styles (12 sites) converged to classes. */
        html += '<div class="card adapter-card" data-adapter-id="' + escAttr(a.id) + '">';
        html += '<div class="adapter-head">';
        html += '<span class="adapter-icon">' + icon + '</span>';
        html += '<strong class="adapter-name">' + esc(a.name) + '</strong>';
        html += '<span class="proxy-idc-badge">' + esc(label) + '</span>';
        if (a.regions && a.regions.length) html += '<span class="hint-line">' + esc(a.regions.join(" / ")) + '</span>';
        html += '<span class="hint-line adapter-ver">' + esc('v' + String(a.selectorVersion)) + ' · ' + esc(a.lastVerifiedAt) + '</span>';
        html += '</div>';
        html += '<p class="hint-line-lg adapter-pitch">' + esc(a.pitch || a.notes || "") + '</p>';
        if (a.capabilities && a.capabilities.length) html += '<div class="adapter-caps">' + esc(formatCapabilities(a.capabilities)) + '</div>';
        html += '<p class="adapter-domains">';
        html += '<code>' + esc(a.domains.join(", ") || "any") + '</code>';
        if (a.presets && a.presets.length) html += ' &nbsp;·&nbsp; <span class="hint-line">Presets: ' + esc(a.presets.join(", ")) + '</span>';
        html += '</p>';
        html += '<div class="adapter-detail" style="display:none;">';
        html += '<div><strong>Login URL hints:</strong> ' + esc((a.loginUrlHints || []).join(", ") || "n/a") + '</div>';
        var recipeText = (a.recipes || []).map(function(r) { return esc(r.name) + ": " + esc(r.goal) + " (" + esc((r.steps || []).join(" → ")) + ")"; }).join("<br>");
        html += '<div class="adapter-block"><strong>Recipes:</strong><br>' + recipeText + '</div>';
        html += '<div class="adapter-block"><strong>Notes:</strong> ' + esc(a.notes) + '</div>';
        html += '<div class="adapter-block"><button class="btn btn-secondary btn-xs" data-role="cmd" data-cmd="adapterShowDetail" data-cmd-arg="' + escAttr(a.id) + '">' + icon("search", 14) + '<span>' + esc(t("agent.adapters.load-full", "Load full recipe (loginCheck + selectors)")) + '</span></button></div>';
        html += '<div class="adapter-full-detail adapter-block" style="display:none;"></div>';
        html += '</div>';
        html += '<button class="btn btn-secondary btn-xs adapter-toggle" data-role="cmd" data-cmd="adapterToggle" data-cmd-arg="' + escAttr(a.id) + '">' + icon("arrowRight", 14) + '<span>' + esc(t("agent.adapters.overview", "Overview")) + '</span></button>';
        html += '</div>';
      }
      el.innerHTML = html;
    }).catch(function(e) {
      el.innerHTML = '<div class="empty-state">Error: ' + esc(e.message || String(e)) + '</div>';
    });
  };

  function findAdapterCard(id) {
    // Dataset scan — never interpolate a catalog-controlled id into a
    // selector string (R3 #55: crafted id breaks querySelector).
    var cards = document.querySelectorAll('.adapter-card[data-adapter-id]');
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-adapter-id') === String(id)) return cards[i];
    }
    return null;
  }

  agentBrowser.adapterToggle = function(id) {
    var card = findAdapterCard(id);
    if (!card) return;
    var detail = card.querySelector('.adapter-detail');
    if (!detail) return;
    var btn = card.querySelector('button[data-cmd="adapterToggle"]');
    var isOpen = detail.style.display !== "none";
    detail.style.display = isOpen ? "none" : "block";
    if (btn) btn.innerHTML = icon(isOpen ? "arrowRight" : "arrowDown", 14) + '<span>' + esc(t("agent.adapters.overview", "Overview")) + "</span>";
  };

  agentBrowser.adapterShowDetail = function(id) {
    var card = findAdapterCard(id);
    var holder = card ? card.querySelector('.adapter-full-detail') : null;
    if (!holder) return;
    holder.innerHTML = '<div class="loading">Loading full recipe...</div>';
    R.agent.platformAdapters.get(id).then(function(a) {
      if (!a) { holder.innerHTML = '<div class="empty-state">Adapter not found.</div>'; return; }
      /* R72: recipe pre blocks converge to .code-block (were 10px inline). */
      var html = '<div class="form-row"><label>loginCheck (browser_evaluate)</label><pre class="code-block">' + esc(a.loginCheck) + '</pre></div>';
      html += '<div class="form-row"><label>Selectors</label><pre class="code-block">' + esc(JSON.stringify(a.selectors, null, 2)) + '</pre></div>';
      holder.innerHTML = html;
      holder.style.display = "block";
    }).catch(function(e) {
      holder.innerHTML = '<div class="empty-state">Error: ' + esc(e.message || String(e)) + '</div>';
    });
  };
})();