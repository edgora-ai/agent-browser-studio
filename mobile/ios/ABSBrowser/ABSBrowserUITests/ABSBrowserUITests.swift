import XCTest

/// End-to-end UI smoke on the iPad simulator. Exercises the real navigation
/// graph without any network dependency: environment list → browser (chrome
/// bar, NTP empty state) → tab switcher → history panel → back to list, and
/// the profile editor's create path. Browsing itself (persona injection,
/// storage isolation) is machine-checked in PersonaScriptTests against real
/// WKWebViews.
final class ABSBrowserUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launch()
        return app
    }

    private func openBrowser(_ app: XCUIApplication) {
        let row = app.staticTexts["HK 日常"]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "环境列表应显示预置的 HK 日常")
        row.tap()
        XCTAssertTrue(app.textFields["browser.omnibox"].waitForExistence(timeout: 10), "进入浏览界面应出现 omnibox")
    }

    func testProfileListToBrowserAndOverlays() throws {
        let app = launch()
        openBrowser(app)

        // Blank tab → new tab page with honest empty state.
        let ntpEmpty = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "还没有浏览记录")).firstMatch
        XCTAssertTrue(ntpEmpty.waitForExistence(timeout: 5), "空白标签页应显示 NTP 空态")

        // Tab switcher: one retained card, honest letter placeholder.
        app.buttons["browser.tabCounter"].tap()
        XCTAssertTrue(app.staticTexts["switcher.title"].waitForExistence(timeout: 5), "标签页总览应打开")
        XCTAssertTrue(app.staticTexts["新标签页"].exists, "切换器应显示空白标签卡片")
        app.staticTexts["新标签页"].tap()
        XCTAssertTrue(app.textFields["browser.omnibox"].waitForExistence(timeout: 5), "选卡后回到浏览界面")

        // History panel via the chrome menu, then back to browser.
        app.buttons["browser.menu"].tap()
        let historyItem = app.buttons["历史记录"]
        XCTAssertTrue(historyItem.waitForExistence(timeout: 5), "菜单应包含历史记录项")
        historyItem.tap()
        XCTAssertTrue(app.staticTexts["history.title"].waitForExistence(timeout: 5), "历史面板应打开")
        app.buttons["history.back"].tap()

        // 返回环境列表 via the menu; session stays retained.
        app.buttons["browser.menu"].tap()
        let backItem = app.buttons["返回环境列表"]
        XCTAssertTrue(backItem.waitForExistence(timeout: 5))
        backItem.tap()
        XCTAssertTrue(app.staticTexts["HK 日常"].waitForExistence(timeout: 10), "应回到环境列表")
    }

    func testDiagnosticsSheetOpens() throws {
        let app = launch()
        openBrowser(app)

        app.buttons["browser.menu"].tap()
        let item = app.buttons["身份检查"]
        XCTAssertTrue(item.waitForExistence(timeout: 5), "菜单应包含身份检查项")
        item.tap()

        XCTAssertTrue(app.staticTexts["身份检查"].waitForExistence(timeout: 10), "诊断页应打开")
        // The diagnostics page is a live WKWebView rendering observed values;
        // its coverage matrix section is web content exposed to accessibility.
        let coverage = app.staticTexts["覆盖状态"]
        XCTAssertTrue(coverage.waitForExistence(timeout: 15), "诊断页应渲染覆盖状态区块")

        app.buttons["关闭"].tap()
        XCTAssertTrue(app.textFields["browser.omnibox"].waitForExistence(timeout: 5), "关闭后回到浏览界面")
    }

    func testProfileEditorCreatesEnvironment() throws {
        let app = launch()
        // ASCII only: typeText cannot synthesize CJK keyboard events.
        let uniqueName = "Smoke\(Int(Date().timeIntervalSince1970) % 100000)"

        app.buttons["profile.create"].tap()
        let nameField = app.textFields["环境名称（如：HK 日常）"]
        XCTAssertTrue(nameField.waitForExistence(timeout: 10), "应打开新建环境表单")
        nameField.tap()
        nameField.typeText(uniqueName)
        app.buttons["保存"].tap()

        XCTAssertTrue(app.staticTexts[uniqueName].waitForExistence(timeout: 10), "保存后环境列表应出现新环境")
    }
}
