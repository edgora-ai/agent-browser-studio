import XCTest
import WebKit
@testable import ABSBrowser

/// Persona injection coverage matrix, asserted against a real WKWebView in
/// the simulator. These tests are the machine-checked half of the honest
/// capability table: what is patched must hold, and what is NOT patched
/// (worker realm) must leak as documented.
@MainActor
final class PersonaScriptTests: XCTestCase {

    func makeProfile(timeZone: String, languages: [String]) -> ProfileSpec {
        try! ProfileSpec(name: "probe", timeZoneId: timeZone, languageTags: languages)
    }

    /// Evaluates an expression that may return a plain value or a Promise:
    /// the expression is awaited in the page, JSON-serialized into
    /// `window.__absResult`, and polled from the test side.
    private func evaluate(_ profile: ProfileSpec, _ script: String) async throws -> [String: Any] {
        let runtime = ProfileRuntime()
        let configuration = runtime.makeConfiguration(for: profile)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        let expectation = expectation(description: "load")
        let delegate = LoadDelegate { webView in
            webView.evaluateJavaScript(
                """
                window.__absResult = null;
                window.__absDone = false;
                (async function () {
                  try {
                    var value = await (\(script));
                    window.__absResult = JSON.stringify(value === undefined ? null : value);
                  } catch (e) {
                    window.__absResult = JSON.stringify({ __absError: String(e) });
                  }
                  window.__absDone = true;
                })();
                """,
                completionHandler: { _, _ in }
            )
            expectation.fulfill()
        }
        webView.navigationDelegate = delegate
        webView.loadHTMLString("<html><body>probe</body></html>", baseURL: nil)
        await fulfillment(of: [expectation], timeout: 15)

        // Poll until the in-page promise settles.
        for _ in 0..<100 {
            let payload = try await evaluateSync(webView, "window.__absDone ? window.__absResult : null")
            if let json = payload as? String, let data = json.data(using: .utf8),
               let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if dict["__absError"] != nil {
                    XCTFail("probe script threw: \(dict["__absError"] ?? "")")
                }
                webView.stopLoading()
                return dict
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("probe script never settled")
        return [:]
    }

    private func evaluateSync(_ webView: WKWebView, _ script: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            webView.evaluateJavaScript(script) { value, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: value)
                }
            }
        }
    }

    func testTimezonePersonaApplies() async throws {
        let profile = makeProfile(timeZone: "Asia/Hong_Kong", languages: ["zh-HK", "en-US"])
        let result = try await evaluate(profile, """
        ({
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          offset: new Date().getTimezoneOffset(),
          hoursUTCConsistent: (function () {
            // 22:30 HK wall time must read back 22:30 in getHours.
            var d = new Date(2026, 0, 15, 22, 30, 0);
            return d.getHours() === 22 && d.getMinutes() === 30;
          })(),
          utcWallRoundtrip: (function () {
            var d = new Date(Date.UTC(2026, 0, 15, 14, 30, 0)); // 22:30 HK
            return d.getHours() === 22;
          })(),
          offsetlessParse: new Date("2026-01-15T22:30:00").getTime() ===
            Date.parse("2026-01-15T14:30:00Z"),
          tzNameInString: new Date().toString().indexOf("Hong Kong") !== -1,
          gmtOffsetInString: new Date().toString().indexOf("GMT+0800") !== -1,
          toLocaleUsesTarget: (new Date(Date.UTC(2026, 0, 15, 14, 30, 0))).toLocaleString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }).indexOf("22") !== -1,
          dateNowUnaffected: Date.now() > 0
        })
        """)
        XCTAssertEqual(result["tz"] as? String, "Asia/Hong_Kong")
        XCTAssertEqual(result["offset"] as? Int, -480)
        XCTAssertEqual(result["hoursUTCConsistent"] as? Bool, true)
        XCTAssertEqual(result["utcWallRoundtrip"] as? Bool, true)
        XCTAssertEqual(result["offsetlessParse"] as? Bool, true)
        XCTAssertEqual(result["tzNameInString"] as? Bool, true)
        XCTAssertEqual(result["gmtOffsetInString"] as? Bool, true)
        XCTAssertEqual(result["toLocaleUsesTarget"] as? Bool, true)
        XCTAssertEqual(result["dateNowUnaffected"] as? Bool, true)
    }

    func testLanguagePersonaApplies() async throws {
        let profile = makeProfile(timeZone: "America/Los_Angeles", languages: ["en-US", "zh-HK"])
        let result = try await evaluate(profile, """
        ({
          language: navigator.language,
          languages: navigator.languages,
          intlLocale: Intl.NumberFormat().resolvedOptions().locale
        })
        """)
        XCTAssertEqual(result["language"] as? String, "en-US")
        let langs = result["languages"] as? [Any]
        XCTAssertEqual(langs?.first as? String, "en-US")
        XCTAssertEqual(result["intlLocale"] as? String, "en-US")
    }

    func testTimezonePersonaIsPerProfile() async throws {
        let hk = try await evaluate(
            makeProfile(timeZone: "Asia/Hong_Kong", languages: ["zh-HK"]),
            "({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, offset: new Date().getTimezoneOffset() })"
        )
        let la = try await evaluate(
            makeProfile(timeZone: "America/Los_Angeles", languages: ["en-US"]),
            "({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, offset: new Date().getTimezoneOffset() })"
        )
        XCTAssertEqual(hk["tz"] as? String, "Asia/Hong_Kong")
        XCTAssertEqual(la["tz"] as? String, "America/Los_Angeles")
        XCTAssertEqual(hk["offset"] as? Int, -480)
        XCTAssertEqual(la["offset"] as? Int, 480)
    }

    func testGeolocationCustomApplies() async throws {
        let profile = try ProfileSpec(
            name: "geo", timeZoneId: "UTC", languageTags: ["en"],
            geolocationMode: .custom, geolocationLatitude: 22.3, geolocationLongitude: 114.2
        )
        let result = try await evaluate(profile, """
        new Promise(function (resolve) {
          navigator.geolocation.getCurrentPosition(function (pos) {
            resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude });
          }, function () { resolve({ failed: true }); });
        })
        """)
        XCTAssertEqual(result["lat"] as? Double ?? 0, 22.3, accuracy: 0.0001)
        XCTAssertEqual(result["lon"] as? Double ?? 0, 114.2, accuracy: 0.0001)
    }

    func testGeolocationOffDenies() async throws {
        let profile = try ProfileSpec(name: "geo-off", timeZoneId: "UTC", languageTags: ["en"], geolocationMode: .off)
        let result = try await evaluate(profile, """
        new Promise(function (resolve) {
          navigator.geolocation.getCurrentPosition(function () {
            resolve({ denied: false });
          }, function (err) { resolve({ denied: err.code === 1 }); });
        })
        """)
        XCTAssertEqual(result["denied"] as? Bool, true)
    }

    /// Documented leak: Worker realms are not injected — they must still see
    /// the device timezone. If this assertion ever flips, coverage claims in
    /// the diagnostics page must be revisited.
    func testWorkerRealmLeakIsDocumented() async throws {
        let profile = makeProfile(timeZone: "Asia/Hong_Kong", languages: ["zh-HK"])
        let deviceTZ = TimeZone.current.identifier
        let result = try await evaluate(profile, """
        new Promise(function (resolve) {
          try {
            var src = "onmessage = function(){ postMessage(Intl.DateTimeFormat().resolvedOptions().timeZone); };";
            var worker = new Worker(URL.createObjectURL(new Blob([src], { type: "application/javascript" })));
            worker.onmessage = function (event) { resolve({ workerTZ: event.data, pageTZ: Intl.DateTimeFormat().resolvedOptions().timeZone }); };
            worker.postMessage({});
          } catch (e) { resolve({ workerTZ: "unavailable: " + e, pageTZ: Intl.DateTimeFormat().resolvedOptions().timeZone }); }
        })
        """)
        let pageTZ = result["pageTZ"] as? String
        XCTAssertEqual(pageTZ, "Asia/Hong_Kong")
        let workerTZ = result["workerTZ"] as? String
        if workerTZ != "unavailable: unreachable" {
            XCTAssertEqual(workerTZ, deviceTZ, "Worker 必须暴露设备真实时区（文档化泄漏）")
            XCTAssertNotEqual(workerTZ, "Asia/Hong_Kong")
        }
    }

    func testBareDateCallDoesNotLeakSystemTimezone() async throws {
        let profile = makeProfile(timeZone: "Asia/Hong_Kong", languages: ["zh-HK"])
        let deviceTZName = TimeZone.current.identifier.replacingOccurrences(of: "_", with: " ")
        let result = try await evaluate(profile, "({ s: (new Date()).toString() })")
        let string = result["s"] as? String ?? ""
        XCTAssertTrue(string.contains("Hong Kong"), "裸 Date() 应输出声明时区名，实际：\(string)")
        XCTAssertFalse(string.contains(deviceTZName), "裸 Date() 字符串不得暴露设备时区名")
    }
}

private final class LoadDelegate: NSObject, WKNavigationDelegate {
    private let onLoaded: (WKWebView) -> Void
    private var fired = false

    init(onLoaded: @escaping (WKWebView) -> Void) {
        self.onLoaded = onLoaded
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !fired else { return }
        fired = true
        onLoaded(webView)
    }
}
