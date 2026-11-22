import Foundation
import UIKit
import WebKit
import Network

/// Builds per-profile `WKWebView` plumbing: persistent isolated data store,
/// profile-scoped proxy, persona scripts, declared UA. All WKWebsiteDataStore
/// APIs used here are iOS 17+ (`dataStore(forIdentifier:)`,
/// `proxyConfigurations`).
@MainActor
final class ProfileRuntime {
    private let credentials: CredentialStore

    init(credentials: CredentialStore = CredentialStore()) {
        self.credentials = credentials
    }

    // MARK: - Data store

    /// Persistent per-profile store: cookies, localStorage, IndexedDB and
    /// cache are isolated per profile and survive cold starts.
    func dataStore(for profile: ProfileSpec) -> WKWebsiteDataStore {
        WKWebsiteDataStore(forIdentifier: profile.id)
    }

    func applyProxy(to store: WKWebsiteDataStore, profile: ProfileSpec) {
        store.proxyConfigurations = proxyConfigurations(for: profile)
    }

    /// Maps the spec onto `Network.ProxyConfiguration`. A `nil` proxy is an
    /// explicit direct connection (empty list), never a stale configuration.
    func proxyConfigurations(for profile: ProfileSpec) -> [ProxyConfiguration] {
        guard let proxy = profile.proxy else { return [] }
        var configuration: ProxyConfiguration
        switch proxy.scheme {
        case .socks5:
            configuration = ProxyConfiguration(socksv5Proxy: proxy.endpoint)
        case .http:
            configuration = ProxyConfiguration(httpCONNECTProxy: proxy.endpoint)
        case .https:
            configuration = ProxyConfiguration(httpCONNECTProxy: proxy.endpoint, tlsOptions: NWProtocolTLS.Options())
        }
        if let credentials = credentials(for: profile.id) {
            configuration.applyCredential(username: credentials.username, password: credentials.password)
        }
        return [configuration]
    }

    private func credentials(for profileId: UUID) -> ProxyCredentials? {
        credentials.credentials(for: profileId)
    }

    // MARK: - Configuration

    func makeConfiguration(for profile: ProfileSpec) -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        let store = dataStore(for: profile)
        applyProxy(to: store, profile: profile)
        configuration.websiteDataStore = store

        // One combined persona script at documentStart, main world.
        let script = WKUserScript(
            source: PersonaScripts.personaScript(profile: profile),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        configuration.userContentController.addUserScript(script)

        return configuration
    }

    /// The webview-level UA override. This changes `navigator.userAgent` only;
    /// Accept-Language and Client Hint request headers are system chosen and
    /// are documented leaks in the diagnostics page.
    func userAgent(for profile: ProfileSpec) -> String? {
        guard let declared = profile.userAgentOverride?.trimmingCharacters(in: .whitespacesAndNewlines),
              !declared.isEmpty else { return nil }
        return declared
    }

    func preferredUserInterfaceStyle(for profile: ProfileSpec) -> UIUserInterfaceStyle {
        switch profile.theme {
        case .system: return .unspecified
        case .light: return .light
        case .dark: return .dark
        }
    }

    /// Deletes the profile's whole WebKit data store (cookies, storage,
    /// cache). The webviews bound to it must be released first — callers
    /// invoke this from the profile-list context after closing the session.
    func deleteDataStore(profileId: UUID) {
        WKWebsiteDataStore.remove(forIdentifier: profileId) { _ in
            // Best-effort; a failure leaves an orphan store on disk but
            // never affects other profiles.
        }
    }
}
