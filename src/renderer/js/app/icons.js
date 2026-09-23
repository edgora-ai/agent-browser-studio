// ── Icon set (R127) ──
// Monochrome line icons, drawn on a 24px grid with a 1.8px stroke and
// currentColor fill — the single visual vocabulary for navigation, toolbars and
// status. Replaces the per-tab emoji (📦 🔌 💾 …) that rendered in the platform
// colour emoji font: those glyphs carry their own hue, ignore --text, and read
// as consumer-app stickers rather than a product surface.
//
// Usage:  icons.svg("profiles")                 → inline <svg> string
//         icons.svg("profiles", {size: 20})     → custom box size
//         icons.apply(root)                     → hydrate [data-icon] elements
//
// HTML markup stays text-free so i18n keys no longer carry the glyph:
//   <li class="nav-item" data-icon="profiles" data-i18n="tab.profiles">Profiles</li>
(function () {
  "use strict";

  // Each entry is the inner markup of a 24×24 viewBox. Stroke geometry only —
  // no per-path colors, so the icon inherits whatever color the host sets.
  var PATHS = {
    profiles: '<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h3.2l1.6 2H18.5A1.5 1.5 0 0 1 20 9.5v8A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5Z"/><path d="M4 11h16"/>',
    proxy: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    storage: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6"/><path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3"/>',
    sync: '<path d="M20 12a8 8 0 0 1-13.66 5.66"/><path d="M4 12a8 8 0 0 1 13.66-5.66"/><path d="M17.5 3.2v3.4h-3.4"/><path d="M6.5 20.8v-3.4h3.4"/>',
    browser: '<path d="M12 3.2 4.5 6v5.6c0 4.3 3.1 8.3 7.5 9.2 4.4-.9 7.5-4.9 7.5-9.2V6Z"/><path d="M9.5 11.6 11.4 13.5l3.6-3.8"/>',
    extensions: '<path d="M9 4.5h2.2a1.8 1.8 0 1 1 3.6 0H17A1.5 1.5 0 0 1 18.5 6v2.2a1.8 1.8 0 1 1 0 3.6V17A1.5 1.5 0 0 1 17 18.5h-2.2a1.8 1.8 0 1 1-3.6 0H9A1.5 1.5 0 0 1 7.5 17v-2.2a1.8 1.8 0 1 1 0-3.6V6A1.5 1.5 0 0 1 9 4.5Z"/>',
    accounts: '<circle cx="9" cy="10" r="3.2"/><path d="M3.8 19c0-2.9 2.3-5.2 5.2-5.2s5.2 2.3 5.2 5.2"/><path d="M16.5 9.2a2.6 2.6 0 0 0 0 5.2"/><path d="M20.5 19c0-2.2-1.3-4-3.2-4.7"/>',
    agent: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4.5v3.5"/><circle cx="12" cy="4" r="1.2"/><path d="M9.2 12.5h.01M14.8 12.5h.01"/><path d="M9.8 15.6h4.4"/>',
    automation: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3.1 1.9"/>',
    runs: '<path d="M5 4.5h9.5L19 9v10.5A1.5 1.5 0 0 1 17.5 21h-12A1.5 1.5 0 0 1 4 19.5v-14A1.5 1.5 0 0 1 5.5 4Z"/><path d="M14 4.5V9h4.5"/><path d="M8.5 13h7M8.5 16.5h4.5"/>',
    activity: '<path d="M3.5 12.5h4l2.2-6 3.6 12 2.4-6h4.8"/>',
    db: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6"/><path d="M4.5 12v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6"/>',

    // Status + action glyphs used by banners, badges and toolbars.
    check: '<path d="M5 12.5 10 17.5 19 7"/>',
    alert: '<path d="M12 4.8 3.6 19h16.8Z"/><path d="M12 10.2v4"/><path d="M12 16.9h.01"/>',
    info: '<circle cx="12" cy="12" r="8.4"/><path d="M12 11v5.4"/><path d="M12 7.9h.01"/>',
    trash: '<path d="M4.8 7h14.4"/><path d="M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7"/><path d="M6.5 7l.9 12.1A1.5 1.5 0 0 0 8.9 20.5h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4.5V10h-5.5"/>',
    download: '<path d="M12 4v10"/><path d="M7.8 9.8 12 14l4.2-4.2"/><path d="M4.5 17.5v1A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-1"/>',
    upload: '<path d="M12 14V4"/><path d="M7.8 8.2 12 4l4.2 4.2"/><path d="M4.5 17.5v1A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    search: '<circle cx="11" cy="11" r="6.4"/><path d="M15.8 15.8 20.5 20.5"/>',
    edit: '<path d="M16.4 4.6a2.1 2.1 0 0 1 3 3L8.6 18.4 4.5 19.5l1.1-4.1Z"/>',
    play: '<path d="M8 5.4 18.5 12 8 18.6Z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    menu: '<circle cx="12" cy="5.5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="18.5" r="1.4"/>',
    lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5"/>',
    unlock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0"/>',
    key: '<circle cx="8" cy="12" r="3.4"/><path d="M11.4 12H20"/><path d="M17 12v3.2M14.2 12v2.2"/>',
    cookie: '<circle cx="12" cy="12" r="8.4"/><path d="M9 9.5h.01M14.5 9h.01M9.5 14.5h.01M14 14h.01M12 12h.01"/>',
    heart: '<path d="M12 19.5s-7-4.3-7-9a3.9 3.9 0 0 1 7-2.4A3.9 3.9 0 0 1 19 10.5c0 4.7-7 9-7 9Z"/>',
    shield: '<path d="M12 3.2 4.5 6v5.6c0 4.3 3.1 8.3 7.5 9.2 4.4-.9 7.5-4.9 7.5-9.2V6Z"/>',
    globe: '<circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8"/><path d="M12 3.6c2.2 2.4 3.4 5.4 3.4 8.4s-1.2 6-3.4 8.4c-2.2-2.4-3.4-5.4-3.4-8.4s1.2-6 3.4-8.4Z"/>',
    arrowLeft: '<path d="M19 12H5"/><path d="M11 6 5 12l6 6"/>',
    arrowUp: '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',
    loader: '<path d="M12 3.6a8.4 8.4 0 1 1-8.4 8.4"/>',
    arrowDown: '<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>',
    arrowRight: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
    sparkle: '<path d="M12 4.5 13.6 9.4 18.5 11 13.6 12.6 12 17.5 10.4 12.6 5.5 11 10.4 9.4Z"/><path d="M18 4.2v2.4M16.8 5.4h2.4"/>',
    clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3.1 1.9"/>',
    // M3: the completion-alert settings card. Distinct from `alert` (a warning
    // triangle) — this is the notification bell, not a problem.
    bell: '<path d="M6.5 10.2a5.5 5.5 0 0 1 11 0c0 4.2 1.5 5.6 1.5 5.6H5s1.5-1.4 1.5-5.6Z"/><path d="M10.2 18.6a2 2 0 0 0 3.6 0"/>',
    zap: '<path d="M13.2 3.5 6 13.4h5l-.9 7.1 7.5-10.2h-5.1Z"/>',
    box: '<path d="M4.5 8 12 4.2 19.5 8v8L12 19.8 4.5 16Z"/><path d="M4.5 8 12 11.8 19.5 8"/><path d="M12 11.8v8"/>',
    doc: '<path d="M6.5 3.5h7L18.5 8.5v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z"/><path d="M13 3.5v5h5.5"/><path d="M9 13h6M9 16.5h4"/>',
    robot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4.5v3.5"/><circle cx="12" cy="4" r="1.2"/><path d="M9.2 12.5h.01M14.8 12.5h.01"/><path d="M9.8 15.6h4.4"/>',
    eye: '<path d="M2.8 12S6.4 6.2 12 6.2 21.2 12 21.2 12 17.6 17.8 12 17.8 2.8 12 2.8 12Z"/><circle cx="12" cy="12" r="2.9"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-3a1.5 1.5 0 0 0-1.5-1.5H6a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 6 15h2.5"/>',
    qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2.5v2.5H14zM18.5 18.5H20V20h-1.5z"/>',
    link: '<path d="M10 13.8a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1 1"/><path d="M14 10.2a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1-1"/>',
    folder: '<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h3.2l1.6 2H18.5A1.5 1.5 0 0 1 20 9.5v8A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5Z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 14.6a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7h-.2a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.1Z"/>',
    firefox: '<circle cx="12" cy="12" r="8.4"/><path d="M15.8 7.6a4.6 4.6 0 0 0-7 1.2"/><path d="M8.2 16.4a4.6 4.6 0 0 0 7-1.2"/>',
    monitor: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/>',
    terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7.5 10 10 12.5 7.5 15"/><path d="M12.5 15h4"/>',
    table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M9.5 9.5v10"/>',
    chart: '<path d="M4 20V10M10 20V4.5M16 20v-7M22 20H2"/>',
    book: '<path d="M4.5 5.5A1.5 1.5 0 0 1 6 4h5v15H6a1.5 1.5 0 0 0-1.5 1.5Z"/><path d="M19.5 5.5A1.5 1.5 0 0 0 18 4h-5v15h5a1.5 1.5 0 0 1 1.5 1.5Z"/>',
    star: '<path d="M12 4.2 14.4 9.3l5.6.8-4 4 1 5.6-5-2.7-5 2.7 1-5.6-4-4 5.6-.8Z"/>',
    pin: '<path d="M9.5 3.5h5l-.7 5.2 3.2 3.1h-10l3.2-3.1Z"/><path d="M12 11.8V20.5"/>',
    filter: '<path d="M4.5 6h15l-5.8 6.8v5.4l-3.4 1.8v-7.2Z"/>',
    list: '<path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12"/><path d="M4 6.5h.01M4 12h.01M4 17.5h.01"/>',
    history: '<path d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8"/><path d="M3.5 4.8V10h5.2"/><path d="M12 8v4.4l2.9 1.7"/>',
    wand: '<path d="M14.5 6.5 4.5 16.5l3 3 10-10Z"/><path d="M17 4v3M15.5 5.5h3M20 8.5v2M19 9.5h2"/>',
    beaker: '<path d="M9.5 3.5v6L5 18a1.8 1.8 0 0 0 1.6 2.7h10.8A1.8 1.8 0 0 0 19 18l-4.5-8.5v-6"/><path d="M8 3.5h8"/><path d="M7 14h10"/>',
    users: '<circle cx="9" cy="10" r="3.2"/><path d="M3.8 19c0-2.9 2.3-5.2 5.2-5.2s5.2 2.3 5.2 5.2"/><path d="M16.5 9.2a2.6 2.6 0 0 0 0 5.2"/><path d="M20.5 19c0-2.2-1.3-4-3.2-4.7"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
    target: '<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="4.4"/><circle cx="12" cy="12" r="1"/>',
    chat: '<path d="M20 12.5a7 7 0 0 1-7 7H8.2L4 22.2V12.5a7 7 0 0 1 7-7h2a7 7 0 0 1 7 7Z"/>',
    upload2: '<path d="M12 4v10"/><path d="M7.8 9.8 12 14l4.2-4.2"/><path d="M4.5 17.5v1A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-1"/>',
    // R130: hardware/fingerprint chip — the advanced-hardware <details> summary.
    chip: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 10h4v4h-4z"/><path d="M10 3.5v3.5M14 3.5v3.5M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5"/>'
  };

  var ALIAS = {
    shieldCheck: "browser",
    run: "play",
    times: "close",
    cross: "close",
    pencil: "edit",
    gear: "settings",
    cog: "settings",
    database: "db",
    listChecks: "list",
    activityPulse: "activity",
    profile: "profiles"
  };

  function svg(name, opts) {
    var key = ALIAS[name] || name;
    var body = PATHS[key];
    if (!body) return "";
    var o = opts || {};
    var size = o.size || 18;
    var cls = o.className ? ' class="' + o.className + '"' : "";
    var sw = o.strokeWidth || 1.8;
    return '<svg' + cls + ' viewBox="0 0 24 24" width="' + size + '" height="' + size +
      '" fill="none" stroke="currentColor" stroke-width="' + sw +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      body + "</svg>";
  }

  // Hydrate [data-icon] hosts. Idempotent: a host that already carries a child
  // <svg> is skipped, so re-running after a language switch costs nothing.
  function apply(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll("[data-icon]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.querySelector("svg")) continue;
      var markup = svg(el.getAttribute("data-icon"), {
        size: parseInt(el.getAttribute("data-icon-size"), 10) || 18
      });
      if (!markup) continue;
      el.insertAdjacentHTML("afterbegin", markup);
    }
  }

  window.icons = { svg: svg, apply: apply, names: Object.keys(PATHS) };

  // Hydrate the static markup. Registered after i18n.js, so its applyDom() has
  // already written the localized labels by the time this runs — the two touch
  // different elements (label span vs. host), so neither clobbers the other.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { apply(); });
  } else {
    apply();
  }
})();
