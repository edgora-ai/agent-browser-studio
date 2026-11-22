import Foundation
import CryptoKit

/// One isolated browsing environment. Field-for-field mirror of
/// `mobile/android/core/.../ProfileSpec.java` adapted for the iPad app:
/// identity inputs are timezone, language tags, country, proxy and an optional
/// declared user-agent. Surfaces WebKit cannot control (canvas, fonts, screen)
/// are intentionally absent — the app never claims to manage them.
struct ProfileSpec: Identifiable, Equatable, Hashable, Codable {
    enum ProfileTheme: String, Codable, CaseIterable {
        case system
        case light
        case dark
    }

    enum GeolocationMode: String, Codable, CaseIterable {
        case real
        case off
        case custom
    }

    let id: UUID
    private(set) var revision: UUID
    var name: String
    /// IANA timezone identifier (e.g. `Asia/Hong_Kong`).
    var timeZoneId: String
    /// BCP-47 tags, at least one, at most 8, order preserved, deduplicated.
    var languageTags: [String]
    /// ISO 3166-1 alpha-2, optional.
    var countryCode: String?
    /// `nil` is an explicit direct connection.
    var proxy: ProxySpec?
    /// Optional full UA override; `nil` keeps the native iPad Safari identity.
    var userAgentOverride: String?
    var theme: ProfileTheme
    var geolocationMode: GeolocationMode
    /// Only meaningful with `.custom`.
    var geolocationLatitude: Double?
    var geolocationLongitude: Double?
    var geolocationAccuracy: Double?

    init(
        id: UUID = UUID(),
        revision: UUID = UUID(),
        name: String,
        timeZoneId: String,
        languageTags: [String],
        countryCode: String? = nil,
        proxy: ProxySpec? = nil,
        userAgentOverride: String? = nil,
        theme: ProfileTheme = .system,
        geolocationMode: GeolocationMode = .real,
        geolocationLatitude: Double? = nil,
        geolocationLongitude: Double? = nil,
        geolocationAccuracy: Double? = nil
    ) throws {
        try Self.validateName(name)
        try Self.validateTimeZone(timeZoneId)
        let tags = Self.canonicalLanguageTags(languageTags)
        guard !tags.isEmpty else { throw SpecError.languageRequired }
        // Normalize the country code before validating so "hk" and "HK" are
        // the same declared region.
        let normalizedCountry = countryCode?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        try Self.validateCountryCode(normalizedCountry)
        try Self.validateUserAgent(userAgentOverride)
        if geolocationMode == .custom {
            try Self.validateCoordinate(geolocationLatitude, field: .latitude)
            try Self.validateCoordinate(geolocationLongitude, field: .longitude)
        }

        self.id = id
        self.revision = revision
        self.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        self.timeZoneId = timeZoneId
        self.languageTags = tags
        self.countryCode = normalizedCountry
        self.proxy = proxy
        self.userAgentOverride = userAgentOverride
        self.theme = theme
        self.geolocationMode = geolocationMode
        self.geolocationLatitude = geolocationLatitude
        self.geolocationLongitude = geolocationLongitude
        self.geolocationAccuracy = geolocationAccuracy
    }

    /// Decode path re-validates, mirroring Android's fail-closed store.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            id: try container.decode(UUID.self, forKey: .id),
            revision: try container.decode(UUID.self, forKey: .revision),
            name: try container.decode(String.self, forKey: .name),
            timeZoneId: try container.decode(String.self, forKey: .timeZoneId),
            languageTags: try container.decode([String].self, forKey: .languageTags),
            countryCode: try container.decodeIfPresent(String.self, forKey: .countryCode),
            proxy: try container.decodeIfPresent(ProxySpec.self, forKey: .proxy),
            userAgentOverride: try container.decodeIfPresent(String.self, forKey: .userAgentOverride),
            theme: try container.decodeIfPresent(ProfileTheme.self, forKey: .theme) ?? .system,
            geolocationMode: try container.decodeIfPresent(GeolocationMode.self, forKey: .geolocationMode) ?? .real,
            geolocationLatitude: try container.decodeIfPresent(Double.self, forKey: .geolocationLatitude),
            geolocationLongitude: try container.decodeIfPresent(Double.self, forKey: .geolocationLongitude),
            geolocationAccuracy: try container.decodeIfPresent(Double.self, forKey: .geolocationAccuracy)
        )
    }

    /// Call after any field mutation so stored revisions advance.
    mutating func bumpRevision() {
        revision = UUID()
    }

    /// Canonical identity hash mirroring Android's `abs.profile.v1` /
    /// `abs.profile.direct.v1` domains. Credentials never participate.
    func fingerprint() -> String {
        let domain = proxy == nil ? "abs.profile.direct.v1" : "abs.profile.v1"
        var parts: [String] = [domain, id.uuidString, name, timeZoneId, languageTags.joined(separator: ",")]
        parts.append(countryCode ?? "")
        parts.append(userAgentOverride ?? "")
        if let proxy {
            parts.append("\(proxy.scheme.rawValue)://\(proxy.host):\(proxy.port)")
        }
        let digest = SHA256.hash(data: Data(parts.joined(separator: "\n").utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Short digest safe for logs (raw seed and credentials never logged).
    var fingerprintDigest: String {
        String(fingerprint().prefix(16))
    }

    // MARK: - Validation

    static func validateName(_ raw: String) throws {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw SpecError.nameRequired }
        guard trimmed.count <= 80 else { throw SpecError.nameTooLong }
    }

    static func validateTimeZone(_ identifier: String) throws {
        guard !identifier.isEmpty, identifier.count <= 128,
              TimeZone(identifier: identifier) != nil,
              // Foundation accepts offset spellings ("GMT+8"); the Android
              // core's IANA validation rejects them, so mirror that.
              !Self.offsetStyleTimeZone(identifier) else {
            throw SpecError.timeZoneInvalid
        }
    }

    private static func offsetStyleTimeZone(_ identifier: String) -> Bool {
        // Reject GMT/UTC/UT with numeric offsets; keep real IANA names
        // (including "Etc/GMT+8") untouched.
        guard let regex = try? NSRegularExpression(pattern: "^(GMT|UTC|UT)[+-]?\\d{1,2}(:\\d{2})?$") else {
            return false
        }
        let range = NSRange(identifier.startIndex..., in: identifier)
        return regex.firstMatch(in: identifier, range: range) != nil
    }

    /// Trim, validate BCP-47-ish tags, dedupe preserving order. Android caps
    /// the list at 8; an empty result means the caller must reject.
    static func canonicalLanguageTags(_ raw: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for element in raw {
            let tag = element.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !tag.isEmpty, tag.count <= 35, tag.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else { continue }
            let key = tag.lowercased()
            guard seen.insert(key).inserted else { continue }
            out.append(tag)
            if out.count == 8 { break }
        }
        return out
    }

    static func validateCountryCode(_ code: String?) throws {
        guard let code, !code.isEmpty else { return }
        guard code.count == 2, code.allSatisfy({ $0.isLetter && $0.isASCII && $0.isUppercase }) else {
            throw SpecError.countryInvalid
        }
    }

    static func validateUserAgent(_ ua: String?) throws {
        guard let ua, !ua.isEmpty else { return }
        guard ua.count <= 300 else { throw SpecError.userAgentTooLong }
        guard !ua.contains("\n"), !ua.contains("\r") else { throw SpecError.userAgentInvalid }
    }

    static func validateCoordinate(_ value: Double?, field: CoordinateField) throws {
        guard let value else { throw field == .latitude ? SpecError.latitudeRequired : SpecError.longitudeRequired }
        switch field {
        case .latitude:
            guard (-90.0...90.0).contains(value) else { throw SpecError.latitudeRange }
        case .longitude:
            guard (-180.0...180.0).contains(value) else { throw SpecError.longitudeRange }
        }
    }

    enum CoordinateField {
        case latitude
        case longitude
    }

    enum SpecError: LocalizedError {
        case nameRequired
        case nameTooLong
        case timeZoneInvalid
        case languageRequired
        case countryInvalid
        case userAgentTooLong
        case userAgentInvalid
        case latitudeRequired
        case longitudeRequired
        case latitudeRange
        case longitudeRange

        var errorDescription: String? {
            switch self {
            case .nameRequired: return "环境名称不能为空"
            case .nameTooLong: return "环境名称最长 80 字"
            case .timeZoneInvalid: return "时区必须是有效的 IANA 标识"
            case .languageRequired: return "至少需要一个语言标签"
            case .countryInvalid: return "地区代码必须是两位大写字母"
            case .userAgentTooLong: return "UA 最长 300 字符"
            case .userAgentInvalid: return "UA 不能包含换行"
            case .latitudeRequired: return "自定义位置需要纬度"
            case .longitudeRequired: return "自定义位置需要经度"
            case .latitudeRange: return "纬度范围 -90 ~ 90"
            case .longitudeRange: return "经度范围 -180 ~ 180"
            }
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, revision, name
        case timeZoneId
        case languageTags
        case countryCode
        case proxy
        case userAgentOverride
        case theme
        case geolocationMode
        case geolocationLatitude
        case geolocationLongitude
        case geolocationAccuracy
    }
}
