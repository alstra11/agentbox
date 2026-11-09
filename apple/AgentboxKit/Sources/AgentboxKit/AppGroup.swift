#if canImport(Darwin)
import Foundation

public enum AppGroupRelay {
    public struct Config: Equatable, Sendable {
        public var url: String
        public var token: String
        public var deviceID: String

        public init(url: String, token: String, deviceID: String) {
            self.url = url
            self.token = token
            self.deviceID = deviceID
        }
    }

    public static var shares: Bool {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: RelayDefaults.appGroupID) != nil
    }

    public static func write(_ config: Config) {
        guard shares, let defaults = UserDefaults(suiteName: RelayDefaults.appGroupID) else { return }
        defaults.set(config.url, forKey: "url")
        defaults.set(config.token, forKey: "token")
        defaults.set(config.deviceID, forKey: "device")
    }

    public static func read() -> Config? {
        guard shares, let defaults = UserDefaults(suiteName: RelayDefaults.appGroupID) else { return nil }
        guard let url = defaults.string(forKey: "url"), !url.isEmpty,
              let token = defaults.string(forKey: "token"), !token.isEmpty,
              let deviceID = defaults.string(forKey: "device"), !deviceID.isEmpty else { return nil }
        return Config(url: url, token: token, deviceID: deviceID)
    }
}
#endif
