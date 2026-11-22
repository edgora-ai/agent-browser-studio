import XCTest
@testable import ABSBrowser

final class ProfileSpecTests: XCTestCase {

    func makeProxy(scheme: ProxySpec.Scheme = .http, host: String = "192.168.4.100", port: Int = 7890) throws -> ProxySpec {
        try ProxySpec(scheme: scheme, host: host, port: port)
    }

    func testValidProfileCreation() throws {
        let spec = try ProfileSpec(
            name: "  HK 日常  ",
            timeZoneId: "Asia/Hong_Kong",
            languageTags: ["zh-HK", "en-US", "zh-HK"],
            countryCode: "hk",
            proxy: try makeProxy()
        )
        XCTAssertEqual(spec.name, "HK 日常")
        XCTAssertEqual(spec.languageTags, ["zh-HK", "en-US"], "重复标签去重、顺序保留")
        XCTAssertEqual(spec.countryCode, "HK", "地区码规范化为大写")
    }

    func testNameValidation() {
        XCTAssertThrowsError(try ProfileSpec(name: "   ", timeZoneId: "Asia/Hong_Kong", languageTags: ["en"]))
        XCTAssertThrowsError(try ProfileSpec(name: String(repeating: "a", count: 81), timeZoneId: "Asia/Hong_Kong", languageTags: ["en"]))
    }

    func testTimeZoneValidation() {
        XCTAssertThrowsError(try ProfileSpec(name: "bad-tz", timeZoneId: "Not/AZone", languageTags: ["en"]))
        XCTAssertThrowsError(try ProfileSpec(name: "bad-tz", timeZoneId: "GMT+8", languageTags: ["en"]), "offset 形式不是 IANA 标识，拒绝")
    }

    func testLanguageTagCap() {
        let tags = ProfileSpec.canonicalLanguageTags(["en", "zh-HK", "ja", "de", "fr", "es", "it", "ko", "ru", "pt"])
        XCTAssertEqual(tags.count, 8, "最多 8 个语言标签")
        XCTAssertEqual(tags.first, "en")
    }

    func testLanguageTagsRejectInvalid() {
        let tags = ProfileSpec.canonicalLanguageTags(["  ", "en<script>", "en US"])
        XCTAssertEqual(tags, [], "含非法字符的标签整条剔除")
    }

    func testCountryValidation() {
        XCTAssertThrowsError(try ProfileSpec(name: "x", timeZoneId: "Asia/Hong_Kong", languageTags: ["en"], countryCode: "usa"))
        XCTAssertThrowsError(try ProfileSpec(name: "x", timeZoneId: "Asia/Hong_Kong", languageTags: ["en"], countryCode: "1"))
        XCTAssertNoThrow(try ProfileSpec(name: "x", timeZoneId: "Asia/Hong_Kong", languageTags: ["en"], countryCode: nil))
    }

    func testUserAgentValidation() {
        XCTAssertThrowsError(try ProfileSpec(
            name: "x", timeZoneId: "UTC", languageTags: ["en"],
            userAgentOverride: "Mozilla/5.0\ninjected-header: 1"
        ))
    }

    func testCustomGeolocationRequiresCoordinates() {
        XCTAssertThrowsError(try ProfileSpec(
            name: "geo", timeZoneId: "UTC", languageTags: ["en"], geolocationMode: .custom
        ))
        XCTAssertNoThrow(try ProfileSpec(
            name: "geo", timeZoneId: "UTC", languageTags: ["en"],
            geolocationMode: .custom,
            geolocationLatitude: 22.3, geolocationLongitude: 114.2
        ))
        XCTAssertThrowsError(try ProfileSpec(
            name: "geo", timeZoneId: "UTC", languageTags: ["en"],
            geolocationMode: .custom, geolocationLatitude: 999, geolocationLongitude: 0
        ))
    }

    func testCodableRoundtripRevalidates() throws {
        let spec = try ProfileSpec(
            name: "US 工作",
            timeZoneId: "America/Los_Angeles",
            languageTags: ["en-US"],
            proxy: try makeProxy(scheme: .socks5, host: "[2001:db8::1]", port: 1080)
        )
        let data = try JSONEncoder().encode(spec)
        let decoded = try JSONDecoder().decode(ProfileSpec.self, from: data)
        XCTAssertEqual(decoded, spec)
    }

    func testFingerprintExcludesCredentialsDomainAndReflectsProxy() throws {
        let direct = try ProfileSpec(name: "direct", timeZoneId: "UTC", languageTags: ["en"])
        let proxied = try ProfileSpec(name: "direct", timeZoneId: "UTC", languageTags: ["en"], proxy: try makeProxy())
        XCTAssertNotEqual(direct.fingerprint(), proxied.fingerprint())
        XCTAssertEqual(direct.fingerprint().count, 64)
    }
}
