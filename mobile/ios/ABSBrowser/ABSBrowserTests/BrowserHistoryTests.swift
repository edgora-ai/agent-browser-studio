import XCTest
@testable import ABSBrowser

final class BrowserHistoryTests: XCTestCase {

    // MARK: - Origin canonicalization (mirrors Android resolveOrigin cases)

    func testResolveOriginCanonicalization() {
        XCTAssertEqual(BrowserHistory.resolveOrigin("https://example.com/a/b?x=1#frag"), "https://example.com")
        XCTAssertEqual(BrowserHistory.resolveOrigin("http://Example.COM:80/path"), "http://example.com", "默认端口剥离")
        XCTAssertEqual(BrowserHistory.resolveOrigin("https://example.com:443/"), "https://example.com")
        XCTAssertEqual(BrowserHistory.resolveOrigin("http://example.com:8080/x"), "http://example.com:8080", "非默认端口保留")
        XCTAssertEqual(BrowserHistory.resolveOrigin("https://user:pass@example.com/x"), "https://example.com", "userinfo 丢弃")
        XCTAssertEqual(BrowserHistory.resolveOrigin("ftp://example.com"), nil, "非 http(s) 拒绝")
        XCTAssertEqual(BrowserHistory.resolveOrigin("not a url"), nil)
        XCTAssertEqual(BrowserHistory.resolveOrigin("https://EXAMPLE.com."), "https://example.com", "尾部点剥离")
    }

    // MARK: - Recording, merge window, LRU

    func testRecordVisitAndRanking() {
        var history = BrowserHistory()
        XCTAssertTrue(history.recordVisit(url: "https://a.example.com/x", title: "A", nowMillis: 1_000))
        XCTAssertTrue(history.recordVisit(url: "https://b.example.com/", title: "B", nowMillis: 2_000))
        XCTAssertEqual(history.size, 2)
        XCTAssertEqual(history.ranked().map(\.origin), ["https://b.example.com", "https://a.example.com"])
    }

    func testMergeWindowDoesNotInflateCounts() {
        var history = BrowserHistory()
        history.recordVisit(url: "https://a.example.com/", title: "A", nowMillis: 1_000)
        history.recordVisit(url: "https://a.example.com/", title: "A refreshed", nowMillis: 2_500)
        let visit = history.ranked().first!
        XCTAssertEqual(visit.visitCount, 1, "3 秒合并窗口内的刷新不计数")
        XCTAssertEqual(visit.title, "A refreshed")
        XCTAssertEqual(visit.lastVisitMillis, 2_500)
        history.recordVisit(url: "https://a.example.com/", title: "A", nowMillis: 10_000)
        XCTAssertEqual(history.ranked().first!.visitCount, 2, "窗口外的再次访问计数")
    }

    func testLRUEviction() {
        var history = BrowserHistory()
        for i in 0..<BrowserHistory.maxSites {
            history.recordVisit(url: "https://site\(i).example.com/", title: "S\(i)", nowMillis: Int64(i) * 10)
        }
        XCTAssertEqual(history.size, BrowserHistory.maxSites)
        history.recordVisit(url: "https://new.example.com/", title: "New", nowMillis: 1_000_000)
        XCTAssertEqual(history.size, BrowserHistory.maxSites, "插入新站点后挤出最旧的")
        XCTAssertFalse(history.ranked().contains { $0.origin == "https://site0.example.com" }, "最旧者先被驱逐")
        XCTAssertTrue(history.ranked().contains { $0.origin == "https://new.example.com" })
    }

    func testTitleLengthCap() {
        XCTAssertEqual(BrowserHistory.cleanTitle(String(repeating: "t", count: 500)).count, BrowserHistory.maxTitleLength)
        XCTAssertEqual(BrowserHistory.cleanTitle("   "), "")
    }

    func testRemoveAndClear() {
        var history = BrowserHistory()
        history.recordVisit(url: "https://a.example.com/", title: "A", nowMillis: 1)
        XCTAssertTrue(history.removeSite(origin: "https://a.example.com"))
        XCTAssertFalse(history.removeSite(origin: "https://a.example.com"), "重复删除返回 false")
        history.recordVisit(url: "https://b.example.com/", title: "B", nowMillis: 2)
        history.clear()
        XCTAssertEqual(history.size, 0)
    }

    // MARK: - Input resolution (mirrors resolveInput)

    func testResolveInput() {
        XCTAssertEqual(BrowserHistory.resolveInput("https://example.com/path")?.absoluteString, "https://example.com/path")
        XCTAssertEqual(BrowserHistory.resolveInput("example.com")?.absoluteString, "https://example.com", "裸 host 补 https")
        XCTAssertEqual(BrowserHistory.resolveInput("localhost:8080")?.host, "localhost")
        XCTAssertEqual(BrowserHistory.resolveInput("javascript:alert(1)"), nil, "非 http(s) scheme 拒绝")
        XCTAssertEqual(BrowserHistory.resolveInput("file:///etc/passwd"), nil)
        XCTAssertEqual(BrowserHistory.resolveInput("随便搜一搜")?.host, "www.bing.com", "其它输入走搜索")
        XCTAssertEqual(BrowserHistory.resolveInput("   "), nil)
    }

    func testTopTilesLimit() {
        var history = BrowserHistory()
        for i in 0..<12 {
            history.recordVisit(url: "https://t\(i).example.com/", title: "T\(i)", nowMillis: Int64(i))
        }
        XCTAssertEqual(history.topTiles().count, 9)
    }
}
