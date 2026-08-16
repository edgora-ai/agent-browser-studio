(function() {
  "use strict";

  var agentBrowser = window.agentBrowser;
  var R = agentBrowser.api;
  var helpers = agentBrowser.helpers;
  var toast = helpers.toast;
  var esc = helpers.esc;
  var escAttr = helpers.escAttr;
  var t = function(key, fallback) {
    return (window.i18n && window.i18n.t) ? window.i18n.t(key, fallback) : fallback;
  };
  var CATEGORY_ICON = { ecommerce: "🛒", social: "📣", ads: "📈", crypto: "🪙", productivity: "🧰", utility: "🔧", generic: "🌐" };
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
        var icon = CATEGORY_ICON[a.category] || "🌐";
        var label = CATEGORY_LABEL[a.category] || a.category;
        html += '<div class="card adapter-card" data-adapter-id="' + escAttr(a.id) + '" style="margin-bottom:10px;padding:12px;">';
        html += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">';
        html += '<span style="font-size:16px;">' + icon + '</span>';
        html += '<strong style="font-size:13px;">' + esc(a.name) + '</strong>';
        html += '<span class="proxy-idc-badge" style="font-size:10px;">' + esc(label) + '</span>';
        if (a.regions && a.regions.length) html += '<span style="font-size:10px;color:var(--text-muted);">' + esc(a.regions.join(" / ")) + '</span>';
        html += '<span style="font-size:10px;color:var(--text-muted);margin-left:auto;">v' + esc(String(a.selectorVersion)) + ' · ' + esc(a.lastVerifiedAt) + '</span>';
        html += '</div>';
        html += '<p style="font-size:12px;color:var(--text-muted);margin:8px 0 6px;">' + esc(a.pitch || a.notes || "") + '</p>';
        if (a.capabilities && a.capabilities.length) html += '<div style="font-size:11px;color:var(--text-muted);">' + esc(formatCapabilities(a.capabilities)) + '</div>';
        html += '<p style="margin:8px 0 0;font-size:11px;">';
        html += '<code style="color:var(--primary);">' + esc(a.domains.join(", ") || "any") + '</code>';
        if (a.presets && a.presets.length) html += ' &nbsp;·&nbsp; <span style="color:var(--text-muted);">Presets: ' + esc(a.presets.join(", ")) + '</span>';
        html += '</p>';
        html += '<div class="adapter-detail" style="display:none;margin-top:10px;background:var(--surface);padding:8px;border-radius:4px;font-size:11px;line-height:1.5;">';
        html += '<div><strong>Login URL hints:</strong> ' + esc((a.loginUrlHints || []).join(", ") || "n/a") + '</div>';
        var recipeText = (a.recipes || []).map(function(r) { return r.name + ": " + r.goal + " (" + r.steps.join(" → ") + ")"; }).join("<br>");
        html += '<div style="margin-top:6px;"><strong>Recipes:</strong><br>' + recipeText + '</div>';
        html += '<div style="margin-top:6px;"><strong>Notes:</strong> ' + esc(a.notes) + '</div>';
        html += '<div style="margin-top:6px;"><button class="btn btn-secondary btn-xs" data-role="cmd" data-cmd="adapterShowDetail" data-cmd-arg="' + escAttr(a.id) + '">🔎 Load full recipe (loginCheck + selectors)</button></div>';
        html += '<div class="adapter-full-detail" style="display:none;margin-top:6px;"></div>';
        html += '</div>';
        html += '<button class="btn btn-secondary btn-xs" data-role="cmd" data-cmd="adapterToggle" data-cmd-arg="' + escAttr(a.id) + '" style="margin-top:8px;">▸ Overview</button>';
        html += '</div>';
      }
      el.innerHTML = html;
    }).catch(function(e) {
      el.innerHTML = '<div class="empty-state">Error: ' + esc(e.message || String(e)) + '</div>';
    });
  };

  agentBrowser.adapterToggle = function(id) {
    var card = document.querySelector('.adapter-card[data-adapter-id="' + id + '"]');
    if (!card) return;
    var detail = card.querySelector('.adapter-detail');
    if (!detail) return;
    var btn = card.querySelector('button[data-cmd="adapterToggle"]');
    var isOpen = detail.style.display !== "none";
    detail.style.display = isOpen ? "none" : "block";
    if (btn) btn.textContent = isOpen ? "▸ Overview" : "▾ Overview";
  };

  agentBrowser.adapterShowDetail = function(id) {
    var card = document.querySelector('.adapter-card[data-adapter-id="' + id + '"]');
    var holder = card ? card.querySelector('.adapter-full-detail') : null;
    if (!holder) return;
    holder.innerHTML = '<div class="loading">Loading full recipe...</div>';
    R.agent.platformAdapters.get(id).then(function(a) {
      if (!a) { holder.innerHTML = '<div class="empty-state">Adapter not found.</div>'; return; }
      var html = '<div class="form-row"><label>loginCheck (browser_evaluate)</label><pre style="white-space:pre-wrap;background:var(--surface);padding:6px;border-radius:4px;font-family:var(--mono);font-size:10px;margin:2px 0 8px;">' + esc(a.loginCheck) + '</pre></div>';
      html += '<div class="form-row"><label>Selectors</label><pre style="white-space:pre-wrap;background:var(--surface);padding:6px;border-radius:4px;font-family:var(--mono);font-size:10px;margin:2px 0 8px;">' + esc(JSON.stringify(a.selectors, null, 2)) + '</pre></div>';
      holder.innerHTML = html;
      holder.style.display = "block";
    }).catch(function(e) {
      holder.innerHTML = '<div class="empty-state">Error: ' + esc(e.message || String(e)) + '</div>';
    });
  };
})();