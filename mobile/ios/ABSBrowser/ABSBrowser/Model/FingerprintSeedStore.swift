import Foundation

/// Per-profile 8-byte identity seed. Mirrors `FingerprintSeedStore.java`
/// semantics: bare big-endian uint64 file, minted once with a secure RNG,
/// persisted via temp-file + rename so a crash never leaves a half-written
/// seed, and read failures are fail-closed rather than silently regenerated
/// (a silently rotating seed would look like an identity change).
struct FingerprintSeedStore {
    static let seedBytes = 8

    private let directory: URL
    private let fileManager: FileManager
    private let randomProvider: () throws -> UInt64

    init(directory: URL? = nil, fileManager: FileManager = .default, randomProvider: @escaping () throws -> UInt64 = Self.secureRandom) {
        let base = directory ?? Self.defaultDirectory(fileManager: fileManager)
        self.fileManager = fileManager
        self.directory = base
        self.randomProvider = randomProvider
        try? fileManager.createDirectory(at: base, withIntermediateDirectories: true, attributes: nil)
        // Keep the seed directory out of iCloud/backup: seeds are
        // device-local identity, not user documents.
        try? (base as NSURL).setResourceValue(true, forKey: .isExcludedFromBackupKey)
    }

    static func defaultDirectory(fileManager: FileManager) -> URL {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("ABSBrowser/fingerprint-seeds", isDirectory: true)
    }

    /// Loads the minted seed or fails; never fabricates a replacement.
    func loadSeed(profileId: UUID) throws -> UInt64 {
        let url = seedURL(profileId: profileId)
        guard fileManager.fileExists(atPath: url.path) else {
            throw SeedError.missing
        }
        let data = try Data(contentsOf: url)
        guard data.count == Self.seedBytes else { throw SeedError.corrupt }
        let value = data.withUnsafeBytes { $0.load(as: UInt64.self) }
        return UInt64(bigEndian: value) & 0x7FFF_FFFF_FFFF_FFFF
    }

    /// Returns the existing seed, minting and persisting it on first use.
    func loadOrCreateSeed(profileId: UUID) throws -> UInt64 {
        if fileManager.fileExists(atPath: seedURL(profileId: profileId).path) {
            return try loadSeed(profileId: profileId)
        }
        let seed = try randomProvider()
        try persistSeed(seed, profileId: profileId)
        return seed
    }

    func deleteSeed(profileId: UUID) {
        try? fileManager.removeItem(at: seedURL(profileId: profileId))
    }

    private func seedURL(profileId: UUID) -> URL {
        directory.appendingPathComponent("\(profileId.uuidString).seed", isDirectory: false)
    }

    private func persistSeed(_ seed: UInt64, profileId: UUID) throws {
        let temp = directory.appendingPathComponent(".tmp-\(UUID().uuidString)")
        var value = seed.bigEndian
        let data = withUnsafeBytes(of: &value) { Data($0) }
        guard (try? data.write(to: temp, options: .atomic)) != nil else {
            throw SeedError.writeFailed
        }
        let target = seedURL(profileId: profileId)
        if fileManager.fileExists(atPath: target.path) {
            try fileManager.removeItem(at: target)
        }
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temp.path)
        try fileManager.moveItem(at: temp, to: target)
    }

    static func secureRandom() throws -> UInt64 {
        var value: UInt64 = 0
        let status = SecRandomCopyBytes(kSecRandomDefault, MemoryLayout<UInt64>.size, &value)
        guard status == errSecSuccess else { throw SeedError.randomFailed }
        // Keep the seed in positive int64 territory, mirroring Android.
        return value & 0x7FFF_FFFF_FFFF_FFFF
    }

    enum SeedError: LocalizedError {
        case missing
        case corrupt
        case writeFailed
        case randomFailed

        var errorDescription: String? {
            switch self {
            case .missing: return "指纹种子缺失（FINGERPRINT_SEED_MISSING）"
            case .corrupt: return "指纹种子损坏（FINGERPRINT_SEED_CORRUPT）"
            case .writeFailed: return "指纹种子写入失败"
            case .randomFailed: return "安全随机源不可用"
            }
        }
    }
}
