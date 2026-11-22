import XCTest
@testable import ABSBrowser

@MainActor
final class HistoryStoreTests: XCTestCase {

    private func tempRoot() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("abs-history-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    func testRecordAndPersistAcrossInstances() async throws {
        let root = tempRoot()
        let id = UUID()
        let store = HistoryStore(directory: root, debounceInterval: 0.05)
        store.bind(profileId: id)
        store.recordVisit(url: "https://example.com/a", title: "Example", nowMillis: 100)
        store.recordVisit(url: "https://other.example.org/", title: "Other", nowMillis: 200)
        // Debounce is 50ms in tests; wait past it, then force flush.
        try await Task.sleep(nanoseconds: 150_000_000)
        store.flushSync()

        let reopened = HistoryStore(directory: root, debounceInterval: 0.05)
        reopened.bind(profileId: id)
        XCTAssertEqual(reopened.snapshot.size, 2)
        XCTAssertEqual(reopened.snapshot.ranked().first?.origin, "https://other.example.org")
        XCTAssertEqual(reopened.snapshot.ranked().first?.title, "Other")
    }

    func testIsolationKeyMismatchDiscardsSnapshot() throws {
        let root = tempRoot()
        let id = UUID()
        let store = HistoryStore(directory: root, debounceInterval: 0.01)
        store.bind(profileId: id)
        store.recordVisit(url: "https://example.com/", title: "X", nowMillis: 1)
        store.flushSync()

        // Rewrite the isolation key to a foreign profile id: loading must
        // discard the file instead of cross-contaminating environments.
        let file = root.appendingPathComponent("native_history_\(id.uuidString).v1.json")
        var content = try String(contentsOf: file, encoding: .utf8)
        content = content.replacingOccurrences(of: id.uuidString, with: UUID().uuidString)
        try content.write(to: file, atomically: true, encoding: .utf8)

        let reopened = HistoryStore(directory: root, debounceInterval: 0.01)
        reopened.bind(profileId: id)
        XCTAssertEqual(reopened.snapshot.size, 0, "隔离键不匹配 → 丢弃，绝不串环境")
        XCTAssertEqual(reopened.loadState, .failed)
    }

    func testPerProfileIsolation() async throws {
        let root = tempRoot()
        let hk = UUID(), us = UUID()
        let store = HistoryStore(directory: root, debounceInterval: 0.01)
        store.bind(profileId: hk)
        store.recordVisit(url: "https://hk.example.com/", title: "HK", nowMillis: 1)
        store.bind(profileId: us)
        XCTAssertEqual(store.snapshot.size, 0, "切换环境后看到的是空历史")
        store.recordVisit(url: "https://us.example.com/", title: "US", nowMillis: 2)
        store.flushSync()

        let reopened = HistoryStore(directory: root, debounceInterval: 0.01)
        reopened.bind(profileId: hk)
        XCTAssertEqual(reopened.snapshot.size, 1)
        XCTAssertEqual(reopened.snapshot.ranked().first?.origin, "https://hk.example.com")
    }

    func testRemoveSiteAndClear() async throws {
        let root = tempRoot()
        let id = UUID()
        let store = HistoryStore(directory: root, debounceInterval: 0.01)
        store.bind(profileId: id)
        store.recordVisit(url: "https://a.example.com/", title: "A", nowMillis: 1)
        store.recordVisit(url: "https://b.example.com/", title: "B", nowMillis: 2)
        store.removeSite(origin: "https://a.example.com")
        store.flushSync()
        XCTAssertEqual(store.snapshot.size, 1)
        store.clear()
        store.flushSync()
        XCTAssertEqual(store.snapshot.size, 0)

        let reopened = HistoryStore(directory: root, debounceInterval: 0.01)
        reopened.bind(profileId: id)
        XCTAssertEqual(reopened.snapshot.size, 0)
    }

    func testDeleteSnapshot() throws {
        let root = tempRoot()
        let id = UUID()
        let store = HistoryStore(directory: root, debounceInterval: 0.01)
        store.bind(profileId: id)
        store.recordVisit(url: "https://example.com/", title: "X", nowMillis: 1)
        store.flushSync()
        store.deleteSnapshot(profileId: id)
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: root.appendingPathComponent("native_history_\(id.uuidString).v1.json").path
        ))
    }
}
