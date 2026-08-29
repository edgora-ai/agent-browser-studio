// ── Friendly error translation (review item UX-3) ──
// Every error toast and error view-state in the app funnels raw exception text
// here (toast() calls it for type "error"; renderViewState() for state.error).
// Raw messages used to surface as "Error invoking remote method browser:launch:
// Error: Profile requires proxy ..." — technical, English-only, and
// unactionable. This module strips transport wrappers, maps known failure
// classes to one-line human copy with an actionable hint (in the UI language),
// and truncates stack-like residue. Unmatched short human messages pass
// through untouched, so intentional product copy is never mangled.
(function () {
  "use strict";

  var agentBrowser = window.agentBrowser || (window.agentBrowser = {});
  var helpers = agentBrowser.helpers || (agentBrowser.helpers = {});

  var CONTEXT_BRIDGE_RE = /^Error invoking remote method [^:]+:\s*(?:Error:\s*)?/;
  var ERROR_PREFIX_RE = /^(?:TypeError|RangeError|SyntaxError|EvalError|ReferenceError|Error):\s*/;
  var STACK_LINE_RE = /\n\s+at\s|\n\s+[A-Za-z_$]+ \(|\sin <anonymous>/;

  // Ordered: first match wins. Keys resolve through i18n (zh + en bundles in
  // i18n.js); the inline fallbacks are the English copy.
  var CATALOG = [
    [/Profile requires proxy .*Refusing to launch without it/i, "err.proxy.required",
      "This profile needs a working proxy, but the proxy failed. Launch was refused to protect your real IP — check the proxy's process and health, or change the profile's proxy setting.", "open-proxies"],
    [/no default proxy is configured/i, "err.proxy.default-missing",
      "No default proxy is configured. Add one in Proxies and mark it with ★, or launch with “No proxy”.", "open-proxies"],
    [/is not configured; refusing to launch/i, "err.proxy.missing-named",
      "The profile's proxy no longer exists (it may have been renamed or deleted). Re-assign a proxy in the profile editor.", "open-proxies"],
    [/Managed Firefox is required/i, "err.engine.firefox",
      "Firefox engine is not installed on this machine. Install Firefox, or create the profile with the Managed Chromium engine.", "open-engine"],
    [/no (?:usable|installed) .{0,24}build|managed chromium.{0,20}(?:installed|missing)|failed to (?:locate|find) .{0,20}chromium/i, "err.engine.missing",
      "Managed browser engine is missing. Open Browser Engine and follow the install guide.", "open-engine"],
    [/fingerprint drift (?:blocked|check)|drift/i, "err.drift.blocked",
      "Launch blocked: the live fingerprint drifted from this profile's stored baseline. Open the 🧬 Drift check on the profile to review, then clear the baseline if the change was intended."],
    [/environment risk|env-?risk/i, "err.env.blocked",
      "Launch blocked by the environment risk gate (DNS / fonts / proxy DNS). Open 🖥 Env on the profile card to see the findings and fixes."],
    [/consistency conflict|consistencyCheck/i, "err.consistency.blocked",
      "Launch blocked by a consistency conflict (timezone / locale / WebRTC vs proxy). Adjust the profile identity or the proxy, or turn off the gate in Browser Engine.", "open-engine"],
    [/locked by another device/i, "err.sync.locked",
      "This data is checked out (locked) by another device. Ask the owner to unlock, or push with force after confirming.", "open-team"],
    [/ECONNREFUSED/i, "err.net.refused",
      "Connection refused — the target service (often the local proxy) isn't running or the port is wrong."],
    [/ECONNRESET|socket hang up/i, "err.net.reset",
      "The connection was reset mid-way — a proxy or firewall cut the link. Retry, or check the proxy."],
    [/ETIMEDOUT|timed? ?out/i, "err.net.timeout",
      "Timed out — the target is unreachable or too slow. Check the proxy and the target site."],
    [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, "err.net.dns",
      "DNS resolution failed — the host doesn't exist or DNS is broken. Check the address, or set a working DNS/proxy."],
    [/EHOSTUNREACH|ENETUNREACH/i, "err.net.unreach",
      "Network unreachable — no route to the host. Check your network or proxy."],
    [/denied by team policy|viewer|requireAccount(?:Mutation|Secret)|not permitted|permission/i, "err.rbac",
      "Permission denied: your workspace role is read-only (viewer). An admin can change your role in Team Workspace.", "open-team"],
    [/HTTP 401|Unauthorized/i, "err.auth401",
      "Authentication failed (401) — a token or key is missing or wrong."],
    [/HTTP 429|Too many requests/i, "err.ratelimit",
      "Rate limited (429) — too many requests too fast. Wait a moment and retry."],
    [/Unexpected token|is not valid JSON|Failed to parse/i, "err.badresponse",
      "The server returned something we couldn't parse — usually a transient network/proxy problem. Retry in a moment."],
    [/Payload too large/i, "err.payload",
      "The request body is too large. Trim the input and retry."],
  ];

  // Action shortcuts: some failures have an obvious destination in the UI —
  // offer a button that takes the user straight there instead of telling them
  // where to navigate.
  var ACTIONS = {
    "open-proxies": { labelKey: "err.act.open-proxies", labelFallback: "Open Proxies", go: function () { try { window.agentBrowser.switchTab("proxy"); } catch (e) {} } },
    "open-engine": { labelKey: "err.act.open-engine", labelFallback: "Open Browser Engine", go: function () { try { window.agentBrowser.switchTab("browser"); if (window.agentBrowser.loadBrowserTab) window.agentBrowser.loadBrowserTab(); } catch (e) {} } },
    "open-team": { labelKey: "err.act.open-team", labelFallback: "Open Team Workspace", go: function () { try { window.agentBrowser.switchTab("sync"); if (window.agentBrowser.loadSyncConfig) window.agentBrowser.loadSyncConfig(); } catch (e) {} } },
  };

  function pick(key, fallback) {
    if (window.i18n && window.i18n.t) {
      var v = window.i18n.t(key, fallback);
      if (v && v !== key) return v;
    }
    return fallback;
  }

  function translate(raw) {
    for (var i = 0; i < CATALOG.length; i++) {
      if (CATALOG[i][0].test(raw)) {
        return pick(CATALOG[i][1], CATALOG[i][2]);
      }
    }
    return null;
  }

  function actionFor(raw) {
    for (var i = 0; i < CATALOG.length; i++) {
      if (CATALOG[i][0].test(raw)) {
        var id = CATALOG[i][3];
        var a = id && ACTIONS[id];
        if (!a) return null;
        return { label: pick(a.labelKey, a.labelFallback), go: a.go };
      }
    }
    return null;
  }

  function stripWrappers(raw) {
    var s = String(raw == null ? "" : raw);
    // Unwrap the contextBridge envelope and chained "Error:" prefixes.
    for (var guard = 0; guard < 4; guard += 1) {
      var next = s.replace(CONTEXT_BRIDGE_RE, "").replace(ERROR_PREFIX_RE, "");
      if (next === s) break;
      s = next;
    }
    return s.trim();
  }

  function truncate(s, max) {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + "…";
  }

  /**
   * friendlyError(raw) → human-readable one-liner for the current UI language.
   * - Known failure classes get localized copy with an actionable hint.
   * - contextBridge/stack wrappers are stripped from unknown errors.
   * - Stack-like residue is cut before the first frame; long text truncated.
   * - Short human-looking messages pass through unchanged.
   */
  /**
   * friendlyErrorEx(raw) → { text, action: {label, go} | null }.
   * friendlyError() below stays the string-only convenience wrapper.
   */
  helpers.friendlyErrorEx = function (raw) {
    var rawStr = raw && typeof raw === "object" && raw.message ? String(raw.message) : String(raw == null ? "" : raw);
    var stripped = stripWrappers(rawStr);
    try { console.warn("[friendly-error] raw:", rawStr); } catch (e) { /* console unavailable */ }
    var friendly = translate(stripped);
    var action = actionFor(stripped);
    if (friendly) return { text: friendly, action: action || null };
    if (STACK_LINE_RE.test(stripped)) {
      stripped = stripped.split(/\n\s+(?:at\s|[A-Za-z_$]+ \()/)[0].trim();
    }
    stripped = stripped.replace(/\s*\n+\s*/g, " · ").trim();
    if (!stripped) return { text: pick("err.generic", "Something went wrong. Please retry — details are in the developer console."), action: null };
    return { text: truncate(stripped, 220), action: action || null };
  };

  helpers.friendlyError = function (raw) {
    var rawStr = raw && typeof raw === "object" && raw.message ? String(raw.message) : String(raw == null ? "" : raw);
    var stripped = stripWrappers(rawStr);
    try { console.warn("[friendly-error] raw:", rawStr); } catch (e) { /* console unavailable */ }
    var friendly = translate(stripped);
    if (friendly) return friendly;
    if (STACK_LINE_RE.test(stripped)) {
      stripped = stripped.split(/\n\s+(?:at\s|[A-Za-z_$]+ \()/)[0].trim();
    }
    stripped = stripped.replace(/\s*\n+\s*/g, " · ").trim();
    if (!stripped) return pick("err.generic", "Something went wrong. Please retry — details are in the developer console.");
    return truncate(stripped, 220);
  };

  helpers.friendlyError.translate = translate;
  helpers.friendlyError.catalog = CATALOG;
})();
