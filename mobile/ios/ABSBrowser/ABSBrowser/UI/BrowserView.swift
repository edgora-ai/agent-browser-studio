import SwiftUI
import WebKit
import Combine

/// The browsing screen. Structure mirrors the Android `NativeBrowserActivity`:
/// chrome bar (back / omnibox / tab counter / menu) with a constant progress
/// bar, one shared web-content container, and mutually exclusive overlays
/// (tab switcher, history, new tab page on blank contents).
///
/// Observation note: `TabManager` publishes tab add/close/select; per-tab
/// web state (URL/title/progress) is observed here through the active tab's
/// Combine publishers, so chrome controls never go stale.
struct BrowserView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var session: BrowserSession
    @ObservedObject var historyStore: HistoryStore

    @State private var omniboxText = ""
    @FocusState private var omniboxFocused: Bool
    @State private var showTabSwitcher = false
    @State private var showHistory = false
    @State private var showDiagnostics = false
    @State private var showExitConfirm = false
    @State private var activeIsBlank = true
    @State private var activeCanGoBack = false
    @State private var activeCanGoForward = false
    @State private var activeProgress: Double = 0

    private var tabs: TabManager { session.tabs }

    var body: some View {
        VStack(spacing: 0) {
            chromeBar
            progressBar
            contentArea
        }
        .background(Color(.systemBackground))
        .onAppear(perform: syncOmnibox)
        .onChange(of: tabs.activeTabID) { _ in
            syncOmnibox()
            syncActiveState()
        }
        .onReceive(urlStringPublisher) { _ in
            if !omniboxFocused { syncOmnibox() }
        }
        .onReceive(blankPublisher) { activeIsBlank = $0 }
        .onReceive(backForwardPublisher) { back, forward in
            activeCanGoBack = back
            activeCanGoForward = forward
        }
        .onReceive(progressPublisher) { activeProgress = $0 }
        .alert("退出当前环境", isPresented: $showExitConfirm) {
            Button("取消", role: .cancel) {}
            Button("退出", role: .destructive) { model.exitProfile() }
        } message: {
            Text("将结束本次浏览并返回环境列表；网站数据与历史记录保留在本地。")
        }
    }

    // MARK: - Active tab publishers

    private var urlStringPublisher: AnyPublisher<String, Never> {
        tabs.activeTab().map { $0.$urlString.eraseToAnyPublisher() }
            ?? Empty<String, Never>(completeImmediately: false).eraseToAnyPublisher()
    }

    private var blankPublisher: AnyPublisher<Bool, Never> {
        tabs.activeTab().map { $0.$isBlank.eraseToAnyPublisher() }
            ?? Empty<Bool, Never>(completeImmediately: false).eraseToAnyPublisher()
    }

    private var progressPublisher: AnyPublisher<Double, Never> {
        tabs.activeTab().map { $0.$progress.eraseToAnyPublisher() }
            ?? Empty<Double, Never>(completeImmediately: false).eraseToAnyPublisher()
    }

    private var backForwardPublisher: AnyPublisher<(Bool, Bool), Never> {
        guard let tab = tabs.activeTab() else {
            return Empty<(Bool, Bool), Never>(completeImmediately: false).eraseToAnyPublisher()
        }
        return Publishers.CombineLatest(tab.$canGoBack, tab.$canGoForward).eraseToAnyPublisher()
    }

    private func syncActiveState() {
        guard let tab = tabs.activeTab() else { return }
        activeIsBlank = tab.isBlank
        activeCanGoBack = tab.canGoBack
        activeCanGoForward = tab.canGoForward
        activeProgress = tab.progress
    }

    // MARK: - Chrome

    private var chromeBar: some View {
        HStack(spacing: 10) {
            Button {
                tabs.activeTab()?.webView.goBack()
            } label: {
                Image(systemName: "chevron.backward")
            }
            .disabled(!activeCanGoBack)

            omnibox

            Button {
                showTabSwitcher = true
            } label: {
                Text("\(tabs.tabs.count)")
                    .font(.system(.subheadline, design: .rounded).weight(.semibold))
                    .frame(width: 34, height: 30)
                    .background(.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            }
            .accessibilityIdentifier("browser.tabCounter")

            Menu {
                menuItems
            } label: {
                Image(systemName: "ellipsis")
            }
            .accessibilityIdentifier("browser.menu")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var omnibox: some View {
        TextField("搜索或输入网址", text: $omniboxText)
            .textFieldStyle(.plain)
            .font(.subheadline)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.asciiCapable)
            .submitLabel(.go)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(.quaternary, in: Capsule())
            .focused($omniboxFocused)
            .onSubmit { navigate(from: omniboxText) }
            .keyboardShortcut("l", modifiers: .command)
            .accessibilityIdentifier("browser.omnibox")
    }

    @ViewBuilder
    private var progressBar: some View {
        // Constant 3pt footprint placeholder — resizing it on the fly jolts
        // the content area (same lesson as the Android chrome bar).
        Capsule()
            .fill(Color.accentColor.opacity(activeProgress >= 1.0 || omniboxFocused ? 0 : max(0.15, activeProgress)))
            .frame(height: 3)
            .animation(.linear(duration: 0.15), value: activeProgress)
    }

    @ViewBuilder
    private var menuItems: some View {
        Section {
            Button {
                tabs.openNewTab()
                syncOmnibox()
            } label: {
                Label("新建标签页", systemImage: "plus")
            }
            .keyboardShortcut("t", modifiers: [.command])
            Button {
                showTabSwitcher = true
            } label: {
                Label("标签页总览", systemImage: "square.grid.2x2")
            }
            Button {
                showHistory = true
            } label: {
                Label("历史记录", systemImage: "clock")
            }
            Button {
                tabs.activeTab()?.webView.goForward()
            } label: {
                Label("前进", systemImage: "chevron.forward")
            }
            .disabled(!activeCanGoForward)
            Button {
                tabs.activeTab()?.webView.reload()
            } label: {
                Label("刷新", systemImage: "arrow.clockwise")
            }
            .keyboardShortcut("r", modifiers: .command)
            Button(role: .destructive) {
                tabs.closeActive()
                syncOmnibox()
            } label: {
                Label("关闭当前标签页", systemImage: "xmark")
            }
            .keyboardShortcut("w", modifiers: [.command])
        } header: {
            Text(tabs.profile.name)
        }

        Section {
            Button {
                model.showList()
            } label: {
                Label("返回环境列表", systemImage: "square.grid.2x2.fill")
            }
            Button {
                showDiagnostics = true
            } label: {
                Label("身份检查", systemImage: "stethoscope")
            }
            Button(role: .destructive) {
                showExitConfirm = true
            } label: {
                Label("退出当前环境", systemImage: "power")
            }
        }
    }

    // MARK: - Content

    private var contentArea: some View {
        ZStack {
            WebViewContainer(tabs: tabs)

            if activeIsBlank, !showTabSwitcher, !showHistory {
                NewTabPageView(
                    profile: tabs.profile,
                    history: historyStore.snapshot,
                    onOpen: { url in
                        tabs.activeTab()?.webView.load(URLRequest(url: url))
                        syncOmnibox()
                    },
                    onRemoveTile: { origin in
                        historyStore.removeSite(origin: origin)
                    },
                    onShowAll: { showHistory = true }
                )
                .transition(.opacity)
            }

            if showTabSwitcher {
                TabSwitcherOverlay(
                    tabs: tabs,
                    onClose: { tabID in
                        tabs.close(tabID)
                        syncOmnibox()
                    },
                    onNewTab: {
                        tabs.openNewTab()
                        showTabSwitcher = false
                        syncOmnibox()
                    },
                    onDismiss: { showTabSwitcher = false }
                )
                .zIndex(2)
            }

            if showHistory {
                HistoryPanelOverlay(
                    history: historyStore.snapshot,
                    onOpen: { url in
                        showHistory = false
                        tabs.activeTab()?.webView.load(URLRequest(url: url))
                        syncOmnibox()
                    },
                    onOpenNewTab: { url in
                        tabs.openNewTab(url: url)
                        showHistory = false
                        syncOmnibox()
                    },
                    onRemove: { origin in
                        historyStore.removeSite(origin: origin)
                    },
                    onClear: {
                        historyStore.clear()
                    },
                    onDismiss: { showHistory = false }
                )
                .zIndex(3)
            }
        }
        .sheet(isPresented: $showDiagnostics) {
            DiagnosticsView(profile: tabs.profile, runtime: model.runtime)
        }
    }

    // MARK: - Omnibox helpers

    private func syncOmnibox() {
        guard !omniboxFocused else { return }
        let current = tabs.activeTab()?.urlString ?? ""
        omniboxText = current.isEmpty ? "" : current
    }

    private func navigate(from input: String) {
        omniboxFocused = false
        guard let url = BrowserHistory.resolveInput(input) else { return }
        tabs.activeTab()?.webView.load(URLRequest(url: url))
        syncOmnibox()
    }
}

/// Owns the shared web-content container. Exactly the active tab's webview is
/// attached; switching tabs swaps views without tearing the web contents
/// down (the Android product's fixed-renderer lesson).
struct WebViewContainer: UIViewControllerRepresentable {
    @ObservedObject var tabs: TabManager

    func makeUIViewController(context: Context) -> HostController {
        HostController()
    }

    func updateUIViewController(_ controller: HostController, context: Context) {
        controller.attach(tabs.activeTab()?.webView)
    }

    @MainActor
    final class HostController: UIViewController {
        private var attached: WKWebView?

        func attach(_ webView: WKWebView?) {
            guard attached !== webView else { return }
            if let current = attached {
                current.removeFromSuperview()
            }
            attached = webView
            guard let webView else { return }
            webView.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(webView)
            NSLayoutConstraint.activate([
                webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                webView.topAnchor.constraint(equalTo: view.topAnchor),
                webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            ])
            view.backgroundColor = .systemBackground
        }
    }
}
