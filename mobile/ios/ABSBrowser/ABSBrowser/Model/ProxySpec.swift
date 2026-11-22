import Foundation
import Network

/// Proxy endpoint attached to a profile. `nil` proxy on `ProfileSpec` means an
/// explicit direct connection, not a malformed proxy.
///
/// Mirrors `mobile/android/core/.../ProxySpec.java`: the spec deliberately
/// carries no credential material; username/password live in the Keychain
/// (`CredentialStore`), keyed by profile id.
struct ProxySpec: Equatable, Codable, Hashable {
    enum Scheme: String, Codable, CaseIterable, Hashable {
        case http
        case https
        case socks5
    }

    var scheme: Scheme
    var host: String
    var port: Int

    init(scheme: Scheme, host: String, port: Int) throws {
        try Self.validate(host: host, port: port)
        self.scheme = scheme
        self.host = Self.normalizeHost(host)
        self.port = port
    }

    /// Constructor used by Codable decoding; re-runs validation so a corrupted
    /// or hand-edited store never resurrects an invalid spec.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let scheme = try container.decode(Scheme.self, forKey: .scheme)
        let host = try container.decode(String.self, forKey: .host)
        let port = try container.decode(Int.self, forKey: .port)
        try Self.validate(host: host, port: port)
        self.scheme = scheme
        self.host = Self.normalizeHost(host)
        self.port = port
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(scheme, forKey: .scheme)
        try container.encode(host, forKey: .host)
        try container.encode(port, forKey: .port)
    }

    /// Lowercased, trimmed host; brackets retained for IPv6 literals.
    static func normalizeHost(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// Endpoint for `Network.ProxyConfiguration`.
    var endpoint: NWEndpoint {
        // IPv6 literals must arrive bracket-free for NWEndpoint host parsing.
        let bareHost = host.hasPrefix("[") && host.hasSuffix("]")
            ? String(host.dropFirst().dropLast())
            : host
        let hostValue = NWEndpoint.Host(stringLiteral: bareHost)
        let portValue = NWEndpoint.Port(rawValue: UInt16(clamping: port)) ?? 0
        return .hostPort(host: hostValue, port: portValue)
    }

    /// Stable description for UI lists; credentials are never included.
    var display: String { "\(scheme.rawValue)://\(host):\(port)" }

    private static func validate(host: String, port: Int) throws {
        let normalized = normalizeHost(host)
        guard !normalized.isEmpty else { throw SpecError.hostRequired }
        guard normalized.count <= 253 else { throw SpecError.hostTooLong }
        let bare = normalized.hasPrefix("[") && normalized.hasSuffix("]")
            ? String(normalized.dropFirst().dropLast())
            : normalized
        guard bare.allSatisfy({ !$0.isWhitespace }) else { throw SpecError.hostInvalid }
        // DNS names, IPv4 and IPv6 literals: allowed charset check.
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789.-:[]")
        guard bare.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { throw SpecError.hostInvalid }
        guard (1...65535).contains(port) else { throw SpecError.portRange }
    }

    enum SpecError: LocalizedError {
        case hostRequired
        case hostTooLong
        case hostInvalid
        case portRange

        var errorDescription: String? {
            switch self {
            case .hostRequired: return "代理主机不能为空"
            case .hostTooLong: return "代理主机过长"
            case .hostInvalid: return "代理主机格式无效"
            case .portRange: return "端口必须在 1–65535"
            }
        }
    }

    private enum CodingKeys: String, CodingKey {
        case scheme, host, port
    }
}
