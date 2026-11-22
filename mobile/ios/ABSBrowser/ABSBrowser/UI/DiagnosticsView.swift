import SwiftUI
import WebKit

/// In-app identity check. Renders the bundled diagnostics page inside a
/// one-off webview built from the profile's live configuration, then collects
/// the probe report. The page itself renders the honest coverage matrix; the
/// native footer repeats only what the probe actually observed.
struct DiagnosticsView: View {
    let profile: ProfileSpec
    let runtime: ProfileRuntime

    @Environment(\.dismiss) private var dismiss
    @State private var report: ProbeReport?
    @State private var reloadToken = 0

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ProbeWebView(
                    profile: profile,
                    runtime: runtime,
                    html: PersonaScripts.diagnosticsHTML(),
                    probe: PersonaScripts.probeScript,
                    onReport: { report = $0 },
                    reloadToken: reloadToken
                )
                summaryFooter
            }
            .navigationTitle("身份检查")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("重新检查") { reloadToken += 1 }
                }
            }
        }
    }

    private var summaryFooter: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(footerLine)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .background(Color(.systemGroupedBackground))
    }

    private var footerLine: String {
        guard let report else {
            return "环境：\(profile.name) · 时区声明 \(profile.timeZoneId) · 语言声明 \(profile.languageTags.joined(separator: ","))"
        }
        return "观察到时区 \(report.intlTimeZone) · 语言 \(report.navigatorLanguage ?? "—") · Worker 时区 \(report.worker?.tz ?? "收集中…")"
    }
}

struct ProbeReport: Codable {
    var intlTimeZone: String?
    var dateOffsetMinutes: Int?
    var dateString: String?
    var intlLocale: String?
    var navigatorLanguage: String?
    var navigatorLanguages: [String]?
    var userAgent: String?
    var hardwareConcurrency: Int?
    var deviceMemory: Int?
    var canvasSample: String?
    var webglVendor: String?
    var webglRenderer: String?
    var worker: WorkerProbe?
    var screen: ScreenProbe?

    struct WorkerProbe: Codable {
        var tz: String?
        var lang: String?
    }

    struct ScreenProbe: Codable {
        var width: Int?
        var height: Int?
        var colorDepth: Int?
        var devicePixelRatio: Double?
    }
}

private struct ProbeWebView: UIViewRepresentable {
    let profile: ProfileSpec
    let runtime: ProfileRuntime
    let html: String
    let probe: String
    let onReport: (ProbeReport) -> Void
    let reloadToken: Int

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: runtime.makeConfiguration(for: profile))
        webView.customUserAgent = runtime.userAgent(for: profile)
        webView.overrideUserInterfaceStyle = runtime.preferredUserInterfaceStyle(for: profile)
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.navigationDelegate = context.coordinator
        webView.configuration.userContentController.add(context.coordinator, name: "absProbe")
        // Probe at documentEnd (persona script itself stays documentStart).
        webView.configuration.userContentController.addUserScript(
            WKUserScript(source: probe, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )
        webView.loadHTMLString(html, baseURL: nil)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // Reload re-runs both scripts; never stack duplicate script entries.
        if context.coordinator.lastToken != reloadToken {
            context.coordinator.lastToken = reloadToken
            webView.reload()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onReport: onReport)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let onReport: (ProbeReport) -> Void
        var lastToken = 0

        init(onReport: @escaping (ProbeReport) -> Void) {
            self.onReport = onReport
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "absProbe",
                  let body = message.body as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: body),
                  let report = try? JSONDecoder().decode(ProbeReport.self, from: data) else { return }
            onReport(report)
        }
    }
}
