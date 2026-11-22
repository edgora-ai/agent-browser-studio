import Foundation

/// JavaScript persona injection, built per profile and installed as
/// `WKUserScript` at documentStart in the main world.
///
/// Honest coverage note (also shown in the in-app diagnostics page):
/// - Covered in the page context: `Date` wall-clock getters, `toString`/
///   `toDateString`/`toTimeString`, `getTimezoneOffset`, `Intl.DateTimeFormat`
///   default timeZone, default locales of the common `Intl` formatters,
///   `navigator.language(s)`, `navigator.geolocation`.
/// - Known leaks, NOT covered: Dedicated/Shared/Service Workers run their own
///   realm and see the device timezone and locale; the HTTP `Accept-Language`
///   header is chosen by the system, not by this app; canvas/WebGL/fonts are
///   real device surfaces. The diagnostics page surfaces what it can of these.
enum PersonaScripts {

    /// The single combined persona script. One script (not three) so wrappers
    /// never stack when more than one dimension is configured.
    static func personaScript(profile: ProfileSpec) -> String {
        [preamble,
         timezoneSection(timeZoneId: profile.timeZoneId),
         localeSection(languageTags: profile.languageTags),
         geolocationSection(profile: profile),
         suffix]
            .joined(separator: "\n")
    }

    // MARK: - Sections

    private static let preamble = #"""
    (function () {
      "use strict";
      if (window.__absPersonaInstalled) { return; }
      try {
        Object.defineProperty(window, "__absPersonaInstalled", {
          value: true, writable: false, enumerable: false, configurable: false
        });
      } catch (e) { /* proceed best-effort */ }
      var ABS = { real: {} };
      try { ABS.real.systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
      try { ABS.real.navigatorLanguage = navigator.language; } catch (e) {}
      try { ABS.real.navigatorLanguages = navigator.languages; } catch (e) {}

      ABS.isoNoOffset = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
      ABS.pad2 = function (n) { return String(n).padStart(2, "0"); };
    """#

    /// Overrides `Date` wall-clock behavior and `Intl.DateTimeFormat`'s
    /// default timeZone for the configured IANA identifier.
    private static func timezoneSection(timeZoneId: String) -> String {
        let target = jsonString(timeZoneId)
        return #"""
      // ---- Timezone ----
      (function () {
        var TARGET = \#(target);
        var NativeDate = Date;
        var OrigDTF = Intl.DateTimeFormat;

        // Formatters are captured before Intl is patched so the conversion
        // helpers below cannot recurse through the patched wrapper.
        var partsFmt = new OrigDTF("en-US", {
          timeZone: TARGET, hour12: false,
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit"
        });
        var nameFmt = new OrigDTF("en-US", { timeZone: TARGET, timeZoneName: "long" });

        ABS.targetParts = function (ts) {
          var p = {};
          var parts = partsFmt.formatToParts(new NativeDate(ts));
          for (var i = 0; i < parts.length; i++) { p[parts[i].type] = parts[i].value; }
          return p;
        };
        var offsetMemo = new Map();
        // Minutes EAST of UTC at a timestamp (Hong Kong = +480).
        ABS.offsetMinutesEast = function (ts) {
          var bucket = Math.floor(ts / 600000);
          var cached = offsetMemo.get(bucket);
          if (cached !== undefined) { return cached; }
          var p = ABS.targetParts(ts);
          var asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second, ((ts % 1000) + 1000) % 1000);
          var minutes = Math.round((asUTC - Math.floor(ts)) / 60000);
          offsetMemo.set(bucket, minutes);
          if (offsetMemo.size > 512) {
            offsetMemo.delete(offsetMemo.keys().next().value);
          }
          return minutes;
        };
        ABS.wallTime = function (ts) {
          var p = ABS.targetParts(ts);
          var y = +p.year, mo = +p.month - 1, da = +p.day, ho = (+p.hour) % 24, mi = +p.minute, se = +p.second;
          var dow = new NativeDate(Date.UTC(y, mo, da)).getUTCDay();
          return { y: y, mo: mo, da: da, ho: ho, mi: mi, se: se, dow: dow, ms: ((ts % 1000) + 1000) % 1000 };
        };

        var tzLong = TARGET;
        try {
          var np = {};
          nameFmt.formatToParts(new NativeDate()).forEach(function (x) { np[x.type] = x.value; });
          if (np.timeZoneName) { tzLong = np.timeZoneName; }
        } catch (e) {}
        var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        ABS.offsetString = function (minEast) {
          var sign = minEast >= 0 ? "+" : "-";
          var a = Math.abs(minEast);
          var h = Math.floor(a / 60), m = a % 60;
          return "GMT" + sign + ABS.pad2(h) + ABS.pad2(m);
        };
        var tzOffsetString = function (ts) { return ABS.offsetString(ABS.offsetMinutesEast(ts)); };

        var proto = NativeDate.prototype;
        var def = function (name, value) {
          try {
            Object.defineProperty(proto, name, { value: value, writable: true, configurable: true });
          } catch (e) {}
        };

        def("getTimezoneOffset", function () { return -ABS.offsetMinutesEast(this.getTime()); });
        def("getFullYear", function () { return ABS.wallTime(this.getTime()).y; });
        def("getMonth", function () { return ABS.wallTime(this.getTime()).mo; });
        def("getDate", function () { return ABS.wallTime(this.getTime()).da; });
        def("getDay", function () { return ABS.wallTime(this.getTime()).dow; });
        def("getHours", function () { return ABS.wallTime(this.getTime()).ho; });
        def("getMinutes", function () { return ABS.wallTime(this.getTime()).mi; });
        def("getSeconds", function () { return ABS.wallTime(this.getTime()).se; });
        def("getYear", function () { return ABS.wallTime(this.getTime()).y - 1900; });

        def("toString", function () {
          var w = ABS.wallTime(this.getTime());
          return DAYS[w.dow] + " " + MONTHS[w.mo] + " " + ABS.pad2(w.da) + " " + w.y + " " +
            ABS.pad2(w.ho) + ":" + ABS.pad2(w.mi) + ":" + ABS.pad2(w.se) + " " +
            tzOffsetString(this.getTime()) + " (" + tzLong + ")";
        });
        def("toDateString", function () {
          var w = ABS.wallTime(this.getTime());
          return DAYS[w.dow] + " " + MONTHS[w.mo] + " " + ABS.pad2(w.da) + " " + w.y;
        });
        def("toTimeString", function () {
          var w = ABS.wallTime(this.getTime());
          return ABS.pad2(w.ho) + ":" + ABS.pad2(w.mi) + ":" + ABS.pad2(w.se) + " " +
            tzOffsetString(this.getTime()) + " (" + tzLong + ")";
        });
        def("toLocaleString", function (loc, opts) {
          return new OrigDTF(loc === undefined ? undefined : loc, Object.assign({}, opts, { timeZone: TARGET })).format(this);
        });
        def("toLocaleDateString", function (loc, opts) {
          return new OrigDTF(loc === undefined ? undefined : loc, Object.assign({}, opts, { timeZone: TARGET, year: "numeric", month: "numeric", day: "numeric" })).format(this);
        });
        def("toLocaleTimeString", function (loc, opts) {
          return new OrigDTF(loc === undefined ? undefined : loc, Object.assign({}, opts, { timeZone: TARGET, hour: "numeric", minute: "numeric", second: "numeric" })).format(this);
        });

        // Local-time multi-arg constructor and offset-less ISO strings are
        // interpreted against the TARGET timezone.
        ABS.wallToEpoch = function (args) {
          var y = +args[0], mo = +args[1], da = args.length > 2 ? +args[2] : 1;
          var ho = args.length > 3 ? +args[3] : 0, mi = args.length > 4 ? +args[4] : 0;
          var se = args.length > 5 ? +args[5] : 0, ms = args.length > 6 ? +args[6] : 0;
          var asUTC = Date.UTC(y, mo, da, ho, mi, se, ms);
          var ts = asUTC - ABS.offsetMinutesEast(asUTC) * 60000;
          var off2 = ABS.offsetMinutesEast(ts);
          if (off2 !== ABS.offsetMinutesEast(asUTC)) {
            ts = asUTC - off2 * 60000;
          }
          return ts;
        };
        ABS.epochFromOffsetlessISO = function (s) {
          var m = ABS.isoNoOffset.exec(s);
          if (!m) { return null; }
          var normalized = m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":" + (m[6] || "00") + "." + (m[7] || "000") + "Z";
          var utcWall = Date.parse(normalized);
          if (isNaN(utcWall)) { return null; }
          var ts = utcWall - ABS.offsetMinutesEast(utcWall) * 60000;
          var off2 = ABS.offsetMinutesEast(ts);
          if (off2 !== ABS.offsetMinutesEast(utcWall)) {
            ts = utcWall - off2 * 60000;
          }
          return ts;
        };

        var PatchedDate = new Proxy(NativeDate, {
          construct: function (target, args) {
            if (args.length >= 2) {
              return Reflect.construct(target, [ABS.wallToEpoch(args)]);
            }
            if (args.length === 1 && typeof args[0] === "string") {
              var epoch = ABS.epochFromOffsetlessISO(args[0]);
              if (epoch !== null) { return Reflect.construct(target, [epoch]); }
            }
            return Reflect.construct(target, args);
          },
          apply: function (target, thisArg, args) {
            // Bare Date() returns a string; route through the patched
            // toString so the system timezone cannot leak here.
            return Reflect.construct(target, []).toString();
          }
        });
        window.Date = PatchedDate;

        // Default timeZone: inject TARGET when the caller left it unset, and
        // rewrite resolvedOptions that would report the device zone.
        function PatchedDTF(loc, opts) {
          var nextOpts = opts;
          if (nextOpts === undefined || nextOpts === null || typeof nextOpts !== "object" ||
              (nextOpts.timeZone === undefined && !Object.prototype.hasOwnProperty.call(nextOpts, "timeZone"))) {
            nextOpts = Object.assign({}, nextOpts, { timeZone: TARGET });
          }
          return Reflect.construct(OrigDTF, [loc, nextOpts]);
        }
        PatchedDTF.prototype = OrigDTF.prototype;
        PatchedDTF.supportedLocalesOf = OrigDTF.supportedLocalesOf;
        window.Intl.DateTimeFormat = PatchedDTF;

        var origResolved = OrigDTF.prototype.resolvedOptions;
        OrigDTF.prototype.resolvedOptions = function () {
          var resolved = origResolved.call(this);
          if (resolved && resolved.timeZone === ABS.real.systemTimeZone) {
            resolved.timeZone = TARGET;
          }
          return resolved;
        };
      })();
    """#
    }

    /// Injects the declared language list into `navigator` and the default
    /// locale of the common `Intl` formatters.
    private static func localeSection(languageTags: [String]) -> String {
        let langsJSON = jsonString(languageTags)
        let primary = jsonString(languageTags.first ?? "en-US")
        return #"""
      // ---- Language / locale ----
      (function () {
        var LANGS = \#(langsJSON);
        var PRIMARY = \#(primary);
        try {
          Object.defineProperty(Navigator.prototype, "language", {
            get: function () { return PRIMARY; },
            set: function () {}, configurable: true, enumerable: true
          });
          Object.defineProperty(Navigator.prototype, "languages", {
            get: function () { return Object.freeze(LANGS.slice()); },
            set: function () {}, configurable: true, enumerable: true
          });
        } catch (e) {}

        var formatters = ["DateTimeFormat", "NumberFormat", "Collator", "RelativeTimeFormat",
          "PluralRules", "ListFormat", "DisplayNames", "Segmenter"];
        formatters.forEach(function (name) {
          var Original = Intl[name];
          if (typeof Original !== "function") { return; }
          function Patched(loc, opts) {
            var nextLoc = loc;
            if (nextLoc === undefined || nextLoc === null) { nextLoc = PRIMARY; }
            return Reflect.construct(Original, [nextLoc, opts]);
          }
          Patched.prototype = Original.prototype;
          Patched.supportedLocalesOf = Original.supportedLocalesOf;
          Intl[name] = Patched;
        });

        // Instances created through the original constructor (e.g. via
        // subclassing) still resolve the device language; rewrite that.
        var origNumResolved = Intl.NumberFormat.prototype.resolvedOptions;
        Intl.NumberFormat.prototype.resolvedOptions = function () {
          var resolved = origNumResolved.call(this);
          if (resolved && resolved.locale === ABS.real.navigatorLanguage) { resolved.locale = PRIMARY; }
          return resolved;
        };
      })();
    """#
    }

    /// `off` answers every request with a permission denial, `custom` answers
    /// with the configured coordinates, `real` stays native.
    ///
    /// WebKit marks `navigator.geolocation` `[LegacyUnforgeable]`: the live
    /// instance carries a non-configurable own property, so a prototype-level
    /// definition is shadowed. Installation therefore falls back to swapping
    /// the methods on the live Geolocation object.
    private static func geolocationSection(profile: ProfileSpec) -> String {
        switch profile.geolocationMode {
        case .real:
            return ""
        case .off:
            return #"""
      // ---- Geolocation: disabled ----
      (function () {
        var denied = function (success, error) {
          if (typeof error === "function") {
            setTimeout(function () {
              error({ code: 1, PERMISSION_DENIED: 1, message: "User denied Geolocation" });
            }, 0);
          }
        };
        install({
          getCurrentPosition: denied,
          watchPosition: function (success, error) { denied(success, error); return -1; },
          clearWatch: function () {}
        });
        function install(stub) {
          var live = navigator.geolocation;
          if (live) {
            try {
              live.getCurrentPosition = stub.getCurrentPosition;
              live.watchPosition = stub.watchPosition;
              live.clearWatch = stub.clearWatch;
              return;
            } catch (e) {}
          }
          try {
            Object.defineProperty(navigator, "geolocation", {
              get: function () { return stub; }, configurable: true, enumerable: true
            });
          } catch (e) {}
        }
      })();
    """#
        case .custom:
            let lat = profile.geolocationLatitude ?? 0
            let lon = profile.geolocationLongitude ?? 0
            let acc = profile.geolocationAccuracy ?? 30
            return #"""
      // ---- Geolocation: custom coordinates ----
      (function () {
        var COORDS = {
          latitude: \#(jsonNumber(lat)),
          longitude: \#(jsonNumber(lon)),
          accuracy: \#(jsonNumber(acc)),
          altitude: null, altitudeAccuracy: null, heading: null, speed: null
        };
        var answer = function (success) {
          if (typeof success === "function") {
            setTimeout(function () {
              // Real API shape: Position { coords: Coordinates, timestamp }.
              success({ coords: Object.assign({}, COORDS), timestamp: Date.now() });
            }, 0);
          }
        };
        install({
          getCurrentPosition: answer,
          watchPosition: function (success) { answer(success); return -1; },
          clearWatch: function () {}
        });
        function install(stub) {
          var live = navigator.geolocation;
          if (live) {
            try {
              live.getCurrentPosition = stub.getCurrentPosition;
              live.watchPosition = stub.watchPosition;
              live.clearWatch = stub.clearWatch;
              return;
            } catch (e) {}
          }
          try {
            Object.defineProperty(navigator, "geolocation", {
              get: function () { return stub; }, configurable: true, enumerable: true
            });
          } catch (e) {}
        }
      })();
    """#
        }
    }

    private static let suffix = "})();"

    // MARK: - Diagnostics

    /// Runs in the profile context, renders results into the diagnostics page
    /// via `window.absRenderReport`, and posts the same report to the
    /// `absProbe` message handler. Includes a Worker probe so the page shows
    /// the honest Worker-timezone leak instead of hiding it.
    static let probeScript = #"""
    (function () {
      var report = {};
      try { report.intlTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { report.intlTimeZone = "error: " + e; }
      try { report.dateOffsetMinutes = new Date().getTimezoneOffset(); } catch (e) { report.dateOffsetMinutes = null; }
      try { report.dateString = new Date().toString(); } catch (e) { report.dateString = "error: " + e; }
      try { report.intlLocale = Intl.NumberFormat().resolvedOptions().locale; } catch (e) {}
      try { report.navigatorLanguage = navigator.language; } catch (e) {}
      try { report.navigatorLanguages = navigator.languages; } catch (e) {}
      try { report.userAgent = navigator.userAgent; } catch (e) {}
      try {
        report.screen = {
          width: screen.width, height: screen.height,
          colorDepth: screen.colorDepth,
          devicePixelRatio: window.devicePixelRatio
        };
      } catch (e) {}
      try { report.hardwareConcurrency = navigator.hardwareConcurrency; } catch (e) {}
      try { report.deviceMemory = navigator.deviceMemory; } catch (e) {}
      try {
        var c = document.createElement("canvas");
        c.width = 220; c.height = 40;
        var ctx = c.getContext("2d");
        ctx.font = "16px 'Arial'";
        ctx.fillText("ABS probe 1234", 4, 24);
        report.canvasSample = c.toDataURL().slice(-48);
      } catch (e) { report.canvasSample = "error: " + e; }
      try {
        var gl = document.createElement("canvas").getContext("webgl");
        var dbg = gl.getExtension("WEBGL_debug_renderer_info");
        report.webglVendor = gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR);
        report.webglRenderer = gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
      } catch (e) { report.webglVendor = "error: " + e; }
      try {
        var workerSource = "onmessage = function(){ postMessage({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: navigator.language }); };";
        var blob = new Blob([workerSource], { type: "application/javascript" });
        var worker = new Worker(URL.createObjectURL(blob));
        worker.onmessage = function (event) {
          report.worker = event.data;
          render(report);
        };
        worker.postMessage({});
        setTimeout(function () {
          if (!report.worker) { report.worker = { tz: "unavailable" }; render(report); }
        }, 1500);
      } catch (e) { report.worker = { tz: "error: " + e }; render(report); }

      render(report);

      function render(r) {
        if (typeof window.absRenderReport === "function") { window.absRenderReport(r); }
        try { window.webkit.messageHandlers.absProbe.postMessage(r); } catch (e) {}
      }
    })();
    """#

    /// The diagnostics page markup. Shows effective identity and states the
    /// coverage boundary explicitly — nothing here fabricates coverage.
    static func diagnosticsHTML() -> String {
        """
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>身份检查</title>
        <style>
          body { font-family: -apple-system, sans-serif; margin: 24px; background: #f5f5f7; color: #1d1d1f; }
          h1 { font-size: 22px; } h2 { font-size: 17px; margin-top: 28px; }
          .kv { display: flex; gap: 12px; padding: 6px 0; border-bottom: 1px solid #e5e5ea; }
          .k { min-width: 190px; color: #6e6e73; } .v { word-break: break-all; }
          .tag { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 12px; margin: 2px 6px 2px 0; }
          .covered { background: #d6f5d6; color: #1d6f2b; }
          .partial { background: #fff3cd; color: #8a6d00; }
          .leak { background: #fde0df; color: #a1201b; }
          .note { color: #6e6e73; font-size: 13px; line-height: 1.5; }
        </style>
        </head>
        <body>
        <h1>身份检查</h1>
        <p class="note">以下为当前环境在页面里被观察到的实际值，由浏览器引擎真实返回。本页不会伪造任何覆盖声明。</p>
        <h2>覆盖状态</h2>
        <p>
          <span class="tag covered">时区（页面主上下文）</span>
          <span class="tag covered">语言（页面主上下文）</span>
          <span class="tag partial">UA（仅 navigator.userAgent，请求头不变）</span>
          <span class="tag leak">Worker 时区/语言</span>
          <span class="tag leak">Accept-Language 请求头</span>
          <span class="tag leak">Canvas / WebGL / 字体 / 屏幕（真实设备值）</span>
        </p>
        <h2>实际观察值</h2>
        <div id="report">收集中…</div>
        <h2>Worker 泄漏探针</h2>
        <div id="worker" class="note">收集中…</div>
        <script>
        function esc(s) {
          return String(s === undefined || s === null ? "—" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        }
        function row(k, v) {
          return '<div class="kv"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
        }
        window.absRenderReport = function (r) {
          document.getElementById("report").innerHTML =
            row("Intl 时区", r.intlTimeZone) + row("Date getTimezoneOffset", r.dateOffsetMinutes) +
            row("Date.toString()", r.dateString) + row("Intl 默认 locale", r.intlLocale) +
            row("navigator.language", r.navigatorLanguage) + row("navigator.languages", r.navigatorLanguages) +
            row("navigator.userAgent", r.userAgent) +
            row("screen", r.screen ? r.screen.width + "×" + r.screen.height + " @" + r.screen.devicePixelRatio : "—") +
            row("hardwareConcurrency", r.hardwareConcurrency) + row("deviceMemory", r.deviceMemory) +
            row("Canvas 采样尾部", r.canvasSample) + row("WebGL vendor", r.webglVendor) + row("WebGL renderer", r.webglRenderer);
          var w = r.worker || {};
          document.getElementById("worker").textContent =
            "Worker 内 Intl 时区: " + (w.tz || "—") + (w.lang ? "，language: " + w.lang : "") +
            "。Worker 使用独立 JS 环境，本应用无法注入，因此显示设备真实值。";
        };
        </script>
        </body>
        </html>
        """
    }

    // MARK: - JSON helpers

    private static func jsonString(_ value: String) -> String {
        guard let data = try? JSONEncoder().encode(value), let encoded = String(data: data, encoding: .utf8) else {
            return "\"\""
        }
        return encoded
    }

    private static func jsonString(_ value: [String]) -> String {
        guard let data = try? JSONEncoder().encode(value), let encoded = String(data: data, encoding: .utf8) else {
            return "[]"
        }
        return encoded
    }

    private static func jsonNumber(_ value: Double) -> String {
        String(format: "%.7f", value)
    }
}
