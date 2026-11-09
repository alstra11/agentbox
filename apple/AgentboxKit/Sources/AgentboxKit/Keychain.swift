#if canImport(Security)
import Foundation
import Security

public struct KeychainError: Error, Equatable, Sendable {
    public var status: OSStatus
    public init(_ status: OSStatus) { self.status = status }
}

public enum KeychainStore {
    public static let service = "dev.agentbox.relay"

    public static func set(_ secret: String, account: String) throws {
        let query = base(account)
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = Data(secret.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status) }
    }

    public static func get(account: String) -> String? {
        var query = base(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public static func remove(account: String) {
        SecItemDelete(base(account) as CFDictionary)
    }

    private static func base(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
#endif
