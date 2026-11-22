import Foundation
import WebKit
import Combine

/// One retained tab: a live `WKWebView` plus its UI-facing state. Mirrors the
/// Android kernel's retained-tab model (web contents stay alive; only the
/// active one is attached to the visible container).
@MainActor
final class BrowserTab: NSObject, ObservableObject, Identifiable {
    let id: UUID
    let webView: WKWebView
    @Published var title: String = ""
    @Published var urlString: String = ""
    @Published var progress: Double = 0
    @Published var canGoBack: Bool = false
    @Published var canGoForward: Bool = false
    @Published var isBlank: Bool = true

    init(webView: WKWebView) {
        self.id = UUID()
        self.webView = webView
        super.init()
        for keyPath in Self.observedKeyPaths {
            webView.addObserver(self, forKeyPath: keyPath, options: [.new], context: nil)
        }
    }

    deinit {
        // KVO observers must be removed before the webview deallocates.
        guard !observersDetached else { return }
        for keyPath in Self.observedKeyPaths {
            webView.removeObserver(self, forKeyPath: keyPath)
        }
    }

    nonisolated(unsafe) private var observersDetached = false

    nonisolated static let observedKeyPaths = ["title", "URL", "estimatedProgress", "canGoBack", "canGoForward"]

    override func observeValue(forKeyPath keyPath: String?, of object: Any?, change: [NSKeyValueChangeKey: Any]?, context: UnsafeMutableRawPointer?) {
        guard let webView = object as? WKWebView, webView === self.webView else { return }
        switch keyPath {
        case "title":
            title = webView.title ?? ""
        case "URL":
            urlString = webView.url?.absoluteString ?? ""
            isBlank = webView.url == nil || webView.url?.absoluteString == "about:blank"
        case "estimatedProgress":
            progress = webView.estimatedProgress
        case "canGoBack":
            canGoBack = webView.canGoBack
        case "canGoForward":
            canGoForward = webView.canGoForward
        default:
            break
        }
    }

    func detachObservers() {
        guard !observersDetached else { return }
        observersDetached = true
        for keyPath in Self.observedKeyPaths {
            webView.removeObserver(self, forKeyPath: keyPath)
        }
    }
}

/// Per-profile tab pool. Mirrors the Android product rules: max 10 retained
/// tabs, closing the last card materializes a fresh blank tab first so the
/// browser always has an active tab, and native/scripted closure of the
/// active tab always selects a retained replacement.
@MainActor
final class TabManager: NSObject, ObservableObject {
    static let maxTabs = 10

    struct TabDisplayModel: Identifiable, Equatable {
        let id: UUID
        var title: String
        var urlString: String
        var isBlank: Bool
        var isActive: Bool
    }

    var profile: ProfileSpec
    private let runtime: ProfileRuntime
    private(set) var tabs: [BrowserTab] = []
    @Published private(set) var activeTabID: UUID?
    @Published private(set) var tabsRevision: Int = 0

    /// Called on completed main-frame http(s) loads.
    var onVisit: ((String, String) -> Void)?
    /// Called when a page title changed after load (history title refresh).
    var onTitleChange: ((String, String) -> Void)?

    init(profile: ProfileSpec, runtime: ProfileRuntime) {
        self.profile = profile
        self.runtime = runtime
    }

    // MARK: - Tab lifecycle

    func openNewTab(url: URL? = nil) -> BrowserTab {
        let tab = makeTab()
        tabs.append(tab)
        if tabs.count > Self.maxTabs {
            // Oldest non-active tab is evicted, mirroring the 10-tab cap.
            if let victim = tabs.first(where: { $0.id != tab.id }) {
                closeQuietly(victim)
            }
        }
        activeTabID = tab.id
        if let url {
            tab.webView.load(URLRequest(url: url))
        }
        tabsRevision += 1
        return tab
    }

    func select(_ tabID: UUID) {
        guard tabs.contains(where: { $0.id == tabID }) else { return }
        activeTabID = tabID
        tabsRevision += 1
    }

    func activeTab() -> BrowserTab? {
        tabs.first { $0.id == activeTabID }
    }

    /// Closes a tab. If it was the last one, a blank replacement is created
    /// first so there is always exactly one active tab.
    func close(_ tabID: UUID) {
        guard let index = tabs.firstIndex(where: { $0.id == tabID }) else { return }
        let wasActive = tabID == activeTabID

        if tabs.count == 1 {
            // Materialize the replacement before tearing down the last tab.
            let replacement = makeTab()
            tabs.append(replacement)
            activeTabID = replacement.id
        }

        let tab = tabs[index]
        tabs.remove(at: index)
        tab.detachObservers()

        if wasActive, activeTabID == tabID || tabs.first(where: { $0.id == activeTabID }) == nil {
            // Pick a retained replacement: prefer the neighbour to the right.
            let nextIndex = min(index, tabs.count - 1)
            activeTabID = tabs[max(0, nextIndex)].id
        }
        tabsRevision += 1
    }

    /// Closes the active tab (menu action), keeping one active tab alive.
    func closeActive() {
        guard let active = activeTab() else { return }
        close(active.id)
    }

    /// Detaches every tab's observers and releases the webviews. Called only
    /// when the whole session is being shut down.
    func detachAll() {
        for tab in tabs {
            tab.detachObservers()
        }
        tabs.removeAll()
        activeTabID = nil
        tabsRevision += 1
    }

    private func closeQuietly(_ tab: BrowserTab) {
        tab.detachObservers()
        tabs.removeAll { $0.id == tab.id }
        if activeTabID == tab.id {
            activeTabID = tabs.first?.id
        }
    }

    private func makeTab() -> BrowserTab {
        let configuration = runtime.makeConfiguration(for: profile)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.customUserAgent = runtime.userAgent(for: profile)
        webView.overrideUserInterfaceStyle = runtime.preferredUserInterfaceStyle(for: profile)
        webView.allowsBackForwardNavigationGestures = true
        webView.navigationDelegate = self
        let tab = BrowserTab(webView: webView)
        return tab
    }

    var displayModels: [TabDisplayModel] {
        tabs.map { tab in
            TabDisplayModel(
                id: tab.id,
                title: tab.title,
                urlString: tab.urlString,
                isBlank: tab.isBlank,
                isActive: tab.id == activeTabID
            )
        }
    }
}

extension TabManager: WKNavigationDelegate {
    nonisolated func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Scheme guard mirroring the Android adapter: the product browses the
        // ordinary web; nothing else is admitted.
        if navigationAction.navigationType == .linkActivated,
           let scheme = navigationAction.request.url?.scheme?.lowercased(),
           scheme != "http", scheme != "https", scheme != "about" {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in
            guard tabs.contains(where: { $0.webView === webView }),
                  let url = webView.url,
                  BrowserHistory.resolveOrigin(url.absoluteString) != nil else { return }
            onVisit?(url.absoluteString, webView.title ?? "")
        }
    }
}
