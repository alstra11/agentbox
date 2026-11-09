import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum RelayDefaults {
    public static let url = URL(string: "https://agents.alstra11.workers.dev")!
    public static let appGroupID = "group.dev.agentbox.relay"
    public static let deadline: TimeInterval = 15
    public static let pollSeconds: TimeInterval = 20
}

public enum WidgetKind {
    public static let needsYou = "needs-you"
}

public enum RelayEndpoint: Equatable, Sendable {
    case needsYou
    case status
    case projects
    case targets
    case thread(project: String, item: String)
    case commands
    case health
}

public func normalizeRelayURL(_ raw: String) -> URL? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard var parts = URLComponents(string: trimmed) else { return nil }
    guard let scheme = parts.scheme?.lowercased(), scheme == "https" else { return nil }
    guard let host = parts.host, !host.isEmpty else { return nil }
    if parts.user != nil || parts.password != nil { return nil }
    parts.scheme = scheme
    parts.user = nil
    parts.password = nil
    parts.path = ""
    parts.query = nil
    parts.fragment = nil
    guard let url = parts.url else { return nil }
    let absolute = url.absoluteString.hasSuffix("/") ? String(url.absoluteString.dropLast()) : url.absoluteString
    return URL(string: absolute)
}

public func normalizeToken(_ raw: String) -> String? {
    var token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if token.lowercased() == "bearer" { return nil }
    if token.lowercased().hasPrefix("bearer ") {
        token = String(token.dropFirst("bearer ".count)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return token.isEmpty ? nil : token
}

public func makeRelayRequest(base: URL, token: String?, deviceID: String, endpoint: RelayEndpoint, body: Data? = nil) throws -> URLRequest {
    guard var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else { throw RelayError.badURL }
    parts.path = path(for: endpoint)
    parts.query = nil
    parts.fragment = nil
    guard let url = parts.url else { throw RelayError.badURL }
    var request = URLRequest(url: url)
    request.httpMethod = endpoint == .commands ? "POST" : "GET"
    request.timeoutInterval = RelayDefaults.deadline
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if endpoint != .health {
        guard let token = normalizeToken(token ?? "") else { throw RelayError.emptyToken }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(deviceID, forHTTPHeaderField: "X-Agentbox-Device")
    }
    if endpoint == .commands {
        request.httpBody = body
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
    }
    return request
}

private func path(for endpoint: RelayEndpoint) -> String {
    switch endpoint {
    case .needsYou: return "/client/needs-you"
    case .status: return "/client/status"
    case .projects: return "/client/projects"
    case .targets: return "/client/targets"
    case .commands: return "/client/commands"
    case .health: return "/health"
    case .thread(let project, let item):
        return "/client/threads/\(pathComponent(project))/\(pathComponent(item))"
    }
}

private func pathComponent(_ value: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
}
