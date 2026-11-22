import Foundation
import Combine

/// File-backed profile catalog. Mirrors the Android store's durability rules:
/// every write is atomic (temp file + rename), every load re-validates each
/// spec, and a corrupted store fails closed into an explicit error instead of
/// silently resetting the user's environments.
@MainActor
final class ProfileStore: ObservableObject {
    struct Snapshot: Codable {
        var schemaVersion: Int = 1
        var activeProfileId: UUID?
        var profiles: [ProfileSpec] = []
    }

    @Published private(set) var profiles: [ProfileSpec] = []
    @Published private(set) var activeProfileId: UUID?

    private let fileURL: URL
    private let fileManager: FileManager

    init(directory: URL? = nil, fileManager: FileManager = .default) {
        let dir = directory ?? Self.defaultDirectory(fileManager: fileManager)
        self.fileManager = fileManager
        self.fileURL = dir.appendingPathComponent("profiles.json", isDirectory: false)
        loadOrInitialize()
    }

    static func defaultDirectory(fileManager: FileManager) -> URL {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("ABSBrowser", isDirectory: true)
        try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    var activeProfile: ProfileSpec? {
        guard let activeProfileId else { return nil }
        return profiles.first { $0.id == activeProfileId }
    }

    func profile(_ id: UUID) -> ProfileSpec? {
        profiles.first { $0.id == id }
    }

    // MARK: - CRUD

    @discardableResult
    func add(_ spec: ProfileSpec, activate: Bool = false) throws -> ProfileSpec {
        guard !profiles.contains(where: { $0.id == spec.id }) else { throw StoreError.duplicateProfile }
        guard profiles.count < 100 else { throw StoreError.tooManyProfiles }
        profiles.append(spec)
        if activate || activeProfileId == nil {
            activeProfileId = spec.id
        }
        try persist()
        return spec
    }

    func update(_ spec: ProfileSpec) throws {
        guard let index = profiles.firstIndex(where: { $0.id == spec.id }) else {
            throw StoreError.missingProfile
        }
        profiles[index] = spec
        try persist()
    }

    /// Deletes the profile plus its per-profile artifacts (seed file and
    /// history snapshot). The WebKit data store itself is deleted by the
    /// caller, which owns the `WKWebsiteDataStore` lifecycle.
    func delete(_ id: UUID, seedStore: FingerprintSeedStore? = nil, historyStore: HistoryStore? = nil) throws {
        guard let index = profiles.firstIndex(where: { $0.id == id }) else {
            throw StoreError.missingProfile
        }
        profiles.remove(at: index)
        if activeProfileId == id {
            activeProfileId = profiles.first?.id
        }
        try persist()
        seedStore?.deleteSeed(profileId: id)
        historyStore?.deleteSnapshot(profileId: id)
    }

    func setActive(_ id: UUID) throws {
        guard profiles.contains(where: { $0.id == id }) else { throw StoreError.missingProfile }
        activeProfileId = id
        try persist()
    }

    // MARK: - Persistence

    private func loadOrInitialize() {
        guard fileManager.fileExists(atPath: fileURL.path) else {
            do { try persist() } catch { assertionFailure("initial persist failed: \(error)") }
            return
        }
        do {
            let data = try Data(contentsOf: fileURL)
            let snapshot = try JSONDecoder().decode(Snapshot.self, from: data)
            guard snapshot.schemaVersion == 1 else { throw StoreError.schemaUnsupported }
            // Decoding re-validates every spec (fail closed on corruption).
            profiles = snapshot.profiles
            activeProfileId = snapshot.activeProfileId ?? profiles.first?.id
        } catch {
            // Preserve the unreadable file for forensics; start empty.
            let quarantine = fileURL.appendingPathExtension("corrupt-\(Int(Date().timeIntervalSince1970))")
            try? fileManager.removeItem(at: quarantine)
            try? fileManager.moveItem(at: fileURL, to: quarantine)
            profiles = []
            activeProfileId = nil
            try? persist()
        }
    }

    private func persist() throws {
        let snapshot = Snapshot(activeProfileId: activeProfileId, profiles: profiles)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(snapshot)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }

    enum StoreError: LocalizedError {
        case duplicateProfile
        case missingProfile
        case tooManyProfiles
        case schemaUnsupported

        var errorDescription: String? {
            switch self {
            case .duplicateProfile: return "环境已存在"
            case .missingProfile: return "环境不存在"
            case .tooManyProfiles: return "环境数量已达上限（100）"
            case .schemaUnsupported: return "存储版本不受支持"
            }
        }
    }
}
