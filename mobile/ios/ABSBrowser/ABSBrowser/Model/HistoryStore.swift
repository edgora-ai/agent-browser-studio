import Foundation

/// Durable, per-profile history persistence. Mirrors `BrowserHistoryStore`
/// durability semantics from the Android kernel: one snapshot file per profile
/// with a stored isolation key that must match on load (mismatch = discard,
/// never cross-contaminate), debounced background writes with a read-back
/// verification, and a usable empty model even when loading fails.
@MainActor
final class HistoryStore: ObservableObject {
    private let rootDirectory: URL
    private let fileManager: FileManager
    private let ioQueue = DispatchQueue(label: "com.ahoo.abs.browser.history-io", qos: .background)
    private let debounceInterval: TimeInterval

    private var live = BrowserHistory()
    private var liveProfileId: UUID?
    private var debounceWork: DispatchWorkItem?

    /// Bumped whenever the visible model changes; views observe this instead
    /// of copying mutable state.
    @Published private(set) var revision = 0

    /// Last load/verify outcome, surfaced to UI for the honest empty states.
    @Published private(set) var loadState: LoadState = .idle

    enum LoadState: Equatable {
        case idle
        case loaded
        case failed
    }

    init(directory: URL? = nil, fileManager: FileManager = .default, debounceInterval: TimeInterval = 2.0) {
        let base = directory ?? Self.defaultDirectory(fileManager: fileManager)
        self.rootDirectory = base
        self.fileManager = fileManager
        self.debounceInterval = debounceInterval
        try? fileManager.createDirectory(at: base, withIntermediateDirectories: true)
        try? (base as NSURL).setResourceValue(true, forKey: .isExcludedFromBackupKey)
    }

    static func defaultDirectory(fileManager: FileManager) -> URL {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("ABSBrowser/native-history", isDirectory: true)
    }

    var snapshot: BrowserHistory { live }

    // MARK: - Profile binding

    /// Switches the live model to a profile. Loading is synchronous from an
    /// already-verified snapshot or from disk; a load failure leaves an empty
    /// but usable model.
    func bind(profileId: UUID) {
        if liveProfileId == profileId { return }
        flushSync()
        liveProfileId = profileId
        let (model, state) = load(profileId: profileId)
        live = model
        loadState = state
        revision += 1
    }

    // MARK: - Mutations (live model + debounced persistence)

    func recordVisit(url: String, title: String, nowMillis: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) {
        guard liveProfileId != nil else { return }
        if live.recordVisit(url: url, title: title, nowMillis: nowMillis) {
            schedulePersist()
            revision += 1
        }
    }

    func updateTitle(url: String, title: String, nowMillis: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) {
        guard liveProfileId != nil,
              let origin = BrowserHistory.resolveOrigin(url) else { return }
        if live.updateTitle(origin: origin, title: title, nowMillis: nowMillis) {
            schedulePersist()
            revision += 1
        }
    }

    func removeSite(origin: String) {
        guard liveProfileId != nil else { return }
        if live.removeSite(origin: origin) {
            schedulePersist()
            revision += 1
        }
    }

    func clear() {
        guard liveProfileId != nil else { return }
        live.clear()
        schedulePersist()
        revision += 1
    }

    // MARK: - Persistence

    private func schedulePersist() {
        debounceWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.persistNow()
        }
        debounceWork = work
        ioQueue.asyncAfter(deadline: .now() + debounceInterval, execute: work)
    }

    /// Blocks the caller until the current state is durably on disk.
    /// Used on profile switch and app backgrounding.
    func flushSync() {
        debounceWork?.cancel()
        debounceWork = nil
        guard let profileId = liveProfileId else { return }
        let model = live
        let url = Self.snapshotURL(profileId: profileId, in: rootDirectory)
        let fm = fileManager
        ioQueue.sync {
            Self.writeSnapshot(model, isolationKey: profileId, to: url, in: rootDirectory, fileManager: fm)
        }
    }

    private func persistNow() {
        guard let profileId = liveProfileId else { return }
        let model = live
        let url = Self.snapshotURL(profileId: profileId, in: rootDirectory)
        let fm = fileManager
        let root = rootDirectory
        ioQueue.async {
            Self.writeSnapshot(model, isolationKey: profileId, to: url, in: root, fileManager: fm)
        }
    }

    private struct Snapshot: Codable {
        var schemaVersion: Int
        var isolationKey: String
        var sites: [BrowserHistory.SiteVisit]
    }

    /// Write-then-read-back, mirroring Android's AtomicFile silent-failure
    /// guard: if the file cannot be read back byte-identically, keep the
    /// previous good snapshot. Runs on the IO queue only.
    nonisolated private static func writeSnapshot(_ model: BrowserHistory, isolationKey: UUID, to url: URL, in root: URL, fileManager: FileManager) {
        let snapshot = Snapshot(
            schemaVersion: 1,
            isolationKey: isolationKey.uuidString,
            sites: model.ranked()
        )
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        let temp = root.appendingPathComponent(".tmp-\(UUID().uuidString)")
        guard (try? data.write(to: temp, options: .atomic)) != nil else { return }
        // Read back before promoting.
        guard let readBack = try? Data(contentsOf: temp), readBack == data else {
            try? fileManager.removeItem(at: temp)
            return
        }
        if fileManager.fileExists(atPath: url.path) {
            // Keep the previous good file as .bak until promotion succeeds.
            let bak = url.appendingPathExtension("bak")
            try? fileManager.removeItem(at: bak)
            try? fileManager.moveItem(at: url, to: bak)
        }
        do {
            try fileManager.moveItem(at: temp, to: url)
            try fileManager.removeItem(at: url.appendingPathExtension("bak"))
        } catch {
            // Restore .bak if promotion failed.
            let bak = url.appendingPathExtension("bak")
            if fileManager.fileExists(atPath: bak.path) {
                try? fileManager.removeItem(at: url)
                try? fileManager.moveItem(at: bak, to: url)
            }
            try? fileManager.removeItem(at: temp)
        }
    }

    private func load(profileId: UUID) -> (BrowserHistory, LoadState) {
        let url = Self.snapshotURL(profileId: profileId, in: rootDirectory)
        guard fileManager.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) else {
            return (BrowserHistory(), .failed) // load failure stays usable (empty)
        }
        guard snapshot.schemaVersion == 1, snapshot.isolationKey == profileId.uuidString else {
            // Isolation mismatch: discard rather than cross-contaminate.
            return (BrowserHistory(), .failed)
        }
        return (BrowserHistory(sites: snapshot.sites), .loaded)
    }

    func deleteSnapshot(profileId: UUID) {
        if liveProfileId == profileId {
            live = BrowserHistory()
            loadState = .idle
            liveProfileId = nil
        }
        let url = Self.snapshotURL(profileId: profileId, in: rootDirectory)
        try? fileManager.removeItem(at: url)
        try? fileManager.removeItem(at: url.appendingPathExtension("bak"))
    }

    nonisolated private static func snapshotURL(profileId: UUID, in root: URL) -> URL {
        root.appendingPathComponent("native_history_\(profileId.uuidString).v1.json", isDirectory: false)
    }
}
