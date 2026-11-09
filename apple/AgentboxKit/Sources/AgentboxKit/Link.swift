import Foundation

public struct ThreadLink: Equatable, Hashable, Sendable {
    public var project: String
    public var id: String

    public init(project: String, id: String) {
        self.project = project
        self.id = id
    }
}

public func threadLink(_ url: URL) -> ThreadLink? {
    guard url.scheme?.lowercased() == "agentbox" else { return nil }
    guard url.host?.lowercased() == "thread" else { return nil }
    let id = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard !id.isEmpty, !id.contains("/") else { return nil }
    guard let project = URLComponents(url: url, resolvingAgainstBaseURL: false)?
        .queryItems?
        .first(where: { $0.name == "project" })?
        .value?
        .trimmingCharacters(in: .whitespacesAndNewlines),
        !project.isEmpty else { return nil }
    return ThreadLink(project: project, id: id)
}

public struct WatchHandoff: Equatable, Sendable {
    public var relayURL: String
    public var watchToken: String

    public init?(relayURL: String, watchToken: String) {
        guard let url = normalizeRelayURL(relayURL), let token = normalizeToken(watchToken) else { return nil }
        self.relayURL = url.absoluteString
        self.watchToken = token
    }

    public init?(context: [String: Any]) {
        guard let url = context["relayURL"] as? String, let token = context["watchToken"] as? String else { return nil }
        self.init(relayURL: url, watchToken: token)
    }

    public func context() -> [String: String] {
        ["relayURL": relayURL, "watchToken": watchToken]
    }
}

public enum DeviceID {
    public static func make(from uuid: UUID = UUID()) -> String {
        String(uuid.uuidString.lowercased().filter { $0 != "-" }.prefix(12))
    }
}

public enum When {
    public static func tomorrowAtEight(after now: Date, calendar: Calendar = .current) -> Date {
        let start = calendar.startOfDay(for: now)
        let next = calendar.date(byAdding: .day, value: 1, to: start) ?? start
        return calendar.date(bySettingHour: 8, minute: 0, second: 0, of: next) ?? next
    }

    public static func millis(_ date: Date) -> Double {
        (date.timeIntervalSince1970 * 1000).rounded()
    }
}

public func germanAgo(ms: Double, now: Date = Date()) -> String {
    let seconds = now.timeIntervalSince1970 - ms / 1000
    if seconds < 60 { return "gerade eben" }
    let minutes = Int(seconds) / 60
    if minutes < 60 {
        return minutes == 1 ? "vor 1 Minute" : "vor \(minutes) Minuten"
    }
    let hours = Int(seconds) / 3600
    if hours < 24 {
        return hours == 1 ? "vor 1 Stunde" : "vor \(hours) Stunden"
    }
    let days = hours / 24
    return days == 1 ? "vor 1 Tag" : "vor \(days) Tagen"
}
