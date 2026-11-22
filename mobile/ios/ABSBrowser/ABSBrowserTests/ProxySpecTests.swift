import XCTest
@testable import ABSBrowser

final class ProxySpecTests: XCTestCase {

    func testNormalization() throws {
        let spec = try ProxySpec(scheme: .http, host: "  Example.COM  ", port: 8080)
        XCTAssertEqual(spec.host, "example.com")
        XCTAssertEqual(spec.display, "http://example.com:8080")
    }

    func testIPv6Literal() throws {
        let spec = try ProxySpec(scheme: .socks5, host: "[2001:DB8::1]", port: 1080)
        XCTAssertEqual(spec.host, "[2001:db8::1]")
        let endpoint = spec.endpoint
        // NWEndpoint must receive the bracket-free literal.
        if case let .hostPort(host, port) = endpoint {
            XCTAssertEqual(host, "2001:db8::1")
            XCTAssertEqual(port.rawValue, 1080)
        } else {
            XCTFail("expected hostPort endpoint")
        }
    }

    func testValidationFailures() {
        XCTAssertThrowsError(try ProxySpec(scheme: .http, host: "", port: 8080))
        XCTAssertThrowsError(try ProxySpec(scheme: .http, host: "bad host", port: 8080))
        XCTAssertThrowsError(try ProxySpec(scheme: .http, host: "proxy.example.com", port: 0))
        XCTAssertThrowsError(try ProxySpec(scheme: .http, host: "proxy.example.com", port: 65536))
    }

    func testDecodingRejectsCorruptedEntry() throws {
        // Hand-edited store with an out-of-range port must fail closed.
        let json = """
        {"scheme":"http","host":"proxy.example.com","port":99999}
        """
        XCTAssertThrowsError(try JSONDecoder().decode(ProxySpec.self, from: Data(json.utf8)))
    }
}
