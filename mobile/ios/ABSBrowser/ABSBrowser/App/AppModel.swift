import Foundation
import Combine

/// Central coordinator: owns the stores and the at most one retained browser
/// session. Mirrors the Android product's model — one profile is active at a
/// time; returning to the environment list keeps the session alive, exiting
/// the environment tears its webviews down.
@MainActor
final class AppModel: ObservableObject {
    enum Screen: Equatable {
        case list
        case browser(UUID)
    }

    let profileStore: ProfileStore
    let credentialStore: CredentialStore
    let seedStore: FingerprintSeedStore
    let historyStore: HistoryStore
    let runtime: ProfileRuntime

    @Published private(set) var screen: Screen = .list
    /// Retained session for the environment currently being browsed, if any.
    @Published private(set) var session: BrowserSession?
    @Published var lastError: String?

    private var allStoresDirectory: URL?

    init(
        profileStore: ProfileStore? = nil,
        credentialStore: CredentialStore = CredentialStore(),
        seedStore: FingerprintSeedStore? = nil,
        historyStore: HistoryStore? = nil
    ) {
        let support = ProfileStore.defaultDirectory(fileManager: .default)
        self.allStoresDirectory = support
        self.profileStore = profileStore ?? ProfileStore(directory: support)
        self.credentialStore = credentialStore
        self.seedStore = seedStore ?? FingerprintSeedStore()
        self.historyStore = historyStore ?? HistoryStore()
        self.runtime = ProfileRuntime(credentials: credentialStore)
    }

    // MARK: - Navigation

    func openProfile(_ id: UUID) {
        guard profileStore.profile(id) != nil else { return }
        do {
            try profileStore.setActive(id)
        } catch {
            lastError = error.localizedDescription
            return
        }
        if session?.profile.id != id {
            // Entering a different environment releases the previous one.
            releaseSession()
        }
        if session == nil {
            let profile = profileStore.profile(id)!
            session = BrowserSession(profile: profile, runtime: runtime, historyStore: historyStore)
        } else if let profile = profileStore.profile(id) {
            session?.updateProfile(profile)
        }
        screen = .browser(id)
    }

    /// Back to the environment list; the session stays retained so returning
    /// is instant (mirrors Android's "返回环境列表（保留运行）").
    func showList() {
        historyStore.flushSync()
        screen = .list
    }

    /// Exits the current environment completely: webviews are released.
    func exitProfile() {
        releaseSession()
        screen = .list
    }

    private func releaseSession() {
        session?.shutdown()
        session = nil
    }

    // MARK: - Profile lifecycle

    @discardableResult
    func createProfile(_ spec: ProfileSpec, credentials: ProxyCredentials?, activate: Bool = false) throws -> ProfileSpec {
        let added = try profileStore.add(spec, activate: activate)
        if let credentials, spec.proxy != nil {
            try credentialStore.set(credentials, for: spec.id)
        }
        // Mint the identity seed eagerly so a failed mint surfaces here,
        // not on first launch inside a page.
        do {
            _ = try seedStore.loadOrCreateSeed(profileId: spec.id)
        } catch {
            throw error
        }
        return added
    }

    func saveProfile(_ spec: ProfileSpec, credentials: ProxyCredentials?) throws {
        var updated = spec
        updated.bumpRevision()
        try profileStore.update(updated)
        if updated.proxy != nil {
            if let credentials {
                try credentialStore.set(credentials, for: updated.id)
            }
        } else {
            credentialStore.remove(for: updated.id)
        }
        if session?.profile.id == updated.id {
            session?.updateProfile(updated)
        }
    }

    func deleteProfile(_ id: UUID) {
        if session?.profile.id == id {
            releaseSession()
        }
        credentialStore.remove(for: id)
        runtime.deleteDataStore(profileId: id)
        do {
            try profileStore.delete(id, seedStore: seedStore, historyStore: historyStore)
        } catch {
            lastError = error.localizedDescription
        }
    }
}

/// One retained browsing session for a single environment.
@MainActor
final class BrowserSession: ObservableObject {
    let profile: ProfileSpec
    private let runtime: ProfileRuntime
    private let historyStore: HistoryStore
    let tabs: TabManager

    init(profile: ProfileSpec, runtime: ProfileRuntime, historyStore: HistoryStore) {
        self.profile = profile
        self.runtime = runtime
        self.historyStore = historyStore
        self.tabs = TabManager(profile: profile, runtime: runtime)
        historyStore.bind(profileId: profile.id)
        tabs.onVisit = { [weak historyStore] url, title in
            historyStore?.recordVisit(url: url, title: title)
        }
        tabs.onTitleChange = { [weak historyStore] url, title in
            historyStore?.updateTitle(url: url, title: title)
        }
        tabs.openNewTab()
    }

    /// Profile edits while browsing are applied live.
    func updateProfile(_ profile: ProfileSpec) {
        tabs.profile = profile
        historyStore.bind(profileId: profile.id)
    }

    /// Tears down webviews. Called when the environment is exited or the app
    /// is deleting the profile.
    func shutdown() {
        historyStore.flushSync()
        tabs.detachAll()
    }
}
