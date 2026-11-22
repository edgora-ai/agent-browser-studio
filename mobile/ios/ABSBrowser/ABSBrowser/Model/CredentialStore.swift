import Foundation
import Security

/// Proxy credentials, isolated from the profile JSON and never serialized into
/// it (the Android product keeps them in AES/GCM envelopes; on iOS the
/// platform-native equivalent is the Keychain with device-only protection).
struct ProxyCredentials: Equatable {
    var username: String
    var password: String
}

struct CredentialStore {
    static let service = "com.ahoo.abs.browser.ipad.proxy"

    private struct Envelope: Codable {
        var username: String
        var password: String
    }

    func credentials(for profileId: UUID) -> ProxyCredentials? {
        var query = baseQuery(profileId: profileId)
        query[kSecReturnData as String] = kCFBooleanTrue
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else { return nil }
        return ProxyCredentials(username: envelope.username, password: envelope.password)
    }

    /// Add or replace credentials for a profile. Writes are device-bound
    /// (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`) so iCloud/backup sync
    /// never leaks a proxy password.
    func set(_ credentials: ProxyCredentials, for profileId: UUID) throws {
        let trimmedUser = credentials.username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedUser.isEmpty else { throw CredentialError.emptyUsername }
        let envelope = Envelope(username: trimmedUser, password: credentials.password)
        let data = try JSONEncoder().encode(envelope)

        var query = baseQuery(profileId: profileId)
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw CredentialError.keychainStatus(status) }
    }

    func remove(for profileId: UUID) {
        SecItemDelete(baseQuery(profileId: profileId) as CFDictionary)
    }

    private func baseQuery(profileId: UUID) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: profileId.uuidString,
        ]
    }

    enum CredentialError: LocalizedError {
        case emptyUsername
        case keychainStatus(OSStatus)

        var errorDescription: String? {
            switch self {
            case .emptyUsername: return "代理用户名不能为空"
            case .keychainStatus(let status): return "Keychain 写入失败（\(status)）"
            }
        }
    }
}
