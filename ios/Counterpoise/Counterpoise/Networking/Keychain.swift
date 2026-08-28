import Foundation
import Security

/// Minimal keychain wrapper for the one secret this app holds: the session
/// cookie. `UserDefaults` would leak it into unencrypted backups, so the token
/// lives here while the server address (not a secret) stays in defaults.
enum Keychain {
    private static let service = "net.counterpoise.ios"

    static func string(forKey key: String) -> String? {
        var query = baseQuery(for: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Passing nil removes the item.
    static func set(_ value: String?, forKey key: String) {
        guard let value, let data = value.data(using: .utf8) else {
            remove(key: key)
            return
        }

        let query = baseQuery(for: key)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            // The token is only needed while someone is using the app, and it
            // must never sync to another device.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert.merge(attributes) { current, _ in current }
            SecItemAdd(insert as CFDictionary, nil)
        }
    }

    static func remove(key: String) {
        SecItemDelete(baseQuery(for: key) as CFDictionary)
    }

    private static func baseQuery(for key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}
