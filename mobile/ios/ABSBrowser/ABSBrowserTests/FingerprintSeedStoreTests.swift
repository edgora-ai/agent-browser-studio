import XCTest
@testable import ABSBrowser

@MainActor
final class FingerprintSeedStoreTests: XCTestCase {

    private func tempDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("abs-seeds-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    func testSeedMintedOnceAndStable() throws {
        let dir = tempDirectory()
        let store = FingerprintSeedStore(directory: dir)
        let id = UUID()
        let first = try store.loadOrCreateSeed(profileId: id)
        let second = try store.loadSeed(profileId: id)
        XCTAssertEqual(first, second, "已铸造的种子必须保持不变")
        XCTAssertNotEqual(first, 0)
        // Reload through a fresh store instance: file-backed, not memory-backed.
        let reopened = try FingerprintSeedStore(directory: dir).loadSeed(profileId: id)
        XCTAssertEqual(reopened, first)
    }

    func testSeedFileLayoutIsBareBigEndian8Bytes() throws {
        let dir = tempDirectory()
        let store = FingerprintSeedStore(directory: dir)
        let id = UUID()
        _ = try store.loadOrCreateSeed(profileId: id)
        let file = dir.appendingPathComponent("\(id.uuidString).seed")
        let data = try Data(contentsOf: file)
        XCTAssertEqual(data.count, 8, "裸 8 字节，无 JSON/版本头")
        let value = data.withUnsafeBytes { UInt64(bigEndian: $0.load(as: UInt64.self)) }
        XCTAssertEqual(value, try store.loadSeed(profileId: id))
    }

    func testMissingSeedFailsClosed() {
        let store = FingerprintSeedStore(directory: tempDirectory())
        XCTAssertThrowsError(try store.loadSeed(profileId: UUID())) { error in
            XCTAssertEqual(error as? FingerprintSeedStore.SeedError, .missing)
        }
    }

    func testCorruptSeedFailsClosed() throws {
        let dir = tempDirectory()
        let id = UUID()
        try Data([0x01, 0x02]).write(to: dir.appendingPathComponent("\(id.uuidString).seed"))
        let store = FingerprintSeedStore(directory: dir)
        XCTAssertThrowsError(try store.loadSeed(profileId: id))
    }

    func testDeterministicProviderIsHonored() throws {
        let store = FingerprintSeedStore(directory: tempDirectory(), randomProvider: { 0x7FFF_FFFF_FFFF_FFFF })
        let seed = try store.loadOrCreateSeed(profileId: UUID())
        XCTAssertEqual(seed, 0x7FFF_FFFF_FFFF_FFFF, "掩码后仍为正 int64 最大值")
    }

    func testDeleteRemovesSeed() throws {
        let dir = tempDirectory()
        let store = FingerprintSeedStore(directory: dir)
        let id = UUID()
        _ = try store.loadOrCreateSeed(profileId: id)
        store.deleteSeed(profileId: id)
        XCTAssertThrowsError(try store.loadSeed(profileId: id))
    }
}
