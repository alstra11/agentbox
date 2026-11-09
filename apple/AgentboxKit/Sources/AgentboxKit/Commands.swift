import Foundation

public enum ClientSource: String, Codable, Equatable, Sendable {
    case iphone
    case watch
}

public enum CommandValue: Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
}

extension CommandValue: Codable {
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let value): try c.encode(value)
        case .number(let value): try c.encode(value)
        case .bool(let value): try c.encode(value)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let value = try? c.decode(Bool.self) {
            self = .bool(value)
            return
        }
        if let value = try? c.decode(Double.self) {
            self = .number(value)
            return
        }
        self = .string(try c.decode(String.self))
    }
}

public struct OutboundCommand: Equatable, Sendable {
    public var id: String
    public var kind: String
    public var source: ClientSource
    public var project: String?
    public var item: String?
    public var payload: [String: CommandValue]

    public init(id: String, kind: String, source: ClientSource, project: String?, item: String?, payload: [String: CommandValue]) {
        self.id = id
        self.kind = kind
        self.source = source
        self.project = project
        self.item = item
        self.payload = payload
    }
}

extension OutboundCommand: Encodable {
    enum CodingKeys: String, CodingKey {
        case id, kind, source, project, item, payload
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(kind, forKey: .kind)
        try c.encode(source, forKey: .source)
        if let project, !project.isEmpty { try c.encode(project, forKey: .project) }
        if let item, !item.isEmpty { try c.encode(item, forKey: .item) }
        try c.encode(payload, forKey: .payload)
    }
}

public enum CommandRefusal: Equatable, Sendable {
    case emptyReply
    case missingTime
    case missingProject
    case missingThread
    case missingWords
    case noteTooLong
    case badCard
    case missingRepo

    public var message: String {
        switch self {
        case .emptyReply: return "Leere Antwort"
        case .missingTime: return "Zeit fehlt"
        case .missingProject: return "Projekt fehlt"
        case .missingThread: return "Thread fehlt"
        case .missingWords: return "Text fehlt"
        case .noteTooLong: return "Notiz zu lang"
        case .badCard: return "Karte fehlt"
        case .missingRepo: return "Repository fehlt"
        }
    }
}

public enum BuiltCommand: Equatable, Sendable {
    case ready(OutboundCommand)
    case refusal(CommandRefusal)
    case needsWords(String)
    case confirm(OutboundCommand)

    public var ready: OutboundCommand? {
        if case .ready(let command) = self { return command }
        return nil
    }
}

public enum PlainKind: String, Equatable, Sendable {
    case close
    case stop
    case reopen
    case runNow = "run-now"
    case sendNow = "send-now"
    case moveToCloud = "move-to-cloud"
}

enum CommandRules {
    static func wordByte(_ byte: UInt8) -> Bool {
        (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57) || byte == 95
    }

    static func cardByte(_ byte: UInt8) -> Bool {
        wordByte(byte) || byte == UInt8(ascii: "+") || byte == UInt8(ascii: "/") || byte == UInt8(ascii: "=") || byte == UInt8(ascii: "-")
    }

    static func approvalID(_ id: String) -> Bool {
        let bytes = Array(id.utf8)
        guard (1...80).contains(bytes.count) else { return false }
        return bytes.allSatisfy { wordByte($0) || $0 == UInt8(ascii: "-") }
    }

    static func card(_ card: String?) -> Bool {
        guard let card else { return false }
        let bytes = Array(card.utf8)
        guard (8...200).contains(bytes.count) else { return false }
        return bytes.allSatisfy(cardByte)
    }
}

extension ApprovalCard {
    public var canAnswer: Bool {
        answerOnComputer != true && CommandRules.approvalID(id) && CommandRules.card(card)
    }
}

public enum CommandDraft {
    public static func reply(project: String, item: String, text: String, source: ClientSource, id: String) -> BuiltCommand {
        guard let project = trimmed(project) else { return .refusal(.missingProject) }
        guard let item = trimmed(item) else { return .refusal(.missingThread) }
        guard let text = trimmed(text) else { return .refusal(.emptyReply) }
        return .ready(OutboundCommand(id: id, kind: "reply", source: source, project: project, item: item, payload: ["text": .string(text)]))
    }

    public static func option(project: String, item: String, n: Int, text: String, source: ClientSource, id: String) -> BuiltCommand {
        if closesTheTask(text) {
            return plain(.close, project: project, item: item, source: source, id: id)
        }
        let bare = bareOption(text)
        if needsYourWords(text) {
            return .needsWords(bare)
        }
        let reply = reply(project: project, item: item, text: "Option \(n): \(bare)", source: source, id: id)
        if discardsTheChange(text), case .ready(let command) = reply {
            return .confirm(command)
        }
        return reply
    }

    public static func snooze(project: String, item: String, until: Double, source: ClientSource, id: String) -> BuiltCommand {
        guard until.isFinite, until >= 0 else { return .refusal(.missingTime) }
        return thread("snooze", project: project, item: item, payload: ["until": .number(until)], source: source, id: id)
    }

    public static func schedule(project: String, item: String, runAt: Double, source: ClientSource, id: String) -> BuiltCommand {
        guard runAt.isFinite, runAt >= 0 else { return .refusal(.missingTime) }
        return thread("schedule", project: project, item: item, payload: ["runAt": .number(runAt)], source: source, id: id)
    }

    public static func plain(_ kind: PlainKind, project: String, item: String, source: ClientSource, id: String) -> BuiltCommand {
        thread(kind.rawValue, project: project, item: item, payload: [:], source: source, id: id)
    }

    public static func approve(project: String, item: String, approval: String, allow: Bool, card: String, note: String?, source: ClientSource, id: String) -> BuiltCommand {
        guard CommandRules.approvalID(approval), CommandRules.card(card) else { return .refusal(.badCard) }
        if let note, note.count > 500 { return .refusal(.noteTooLong) }
        var payload: [String: CommandValue] = [
            "approval": .string(approval),
            "allow": .bool(allow),
            "card": .string(card),
        ]
        if let note { payload["note"] = .string(note) }
        return thread("approve", project: project, item: item, payload: payload, source: source, id: id)
    }

    public static func newRequest(prompt: String, repo: String, target: String, provider: String, project: String?, source: ClientSource, id: String) -> BuiltCommand {
        guard let prompt = trimmed(prompt) else { return .refusal(.missingWords) }
        let chosen = target.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "local" ? "local" : "cloud"
        let title = titleLine(prompt)
        if chosen == "local" {
            guard let project = trimmed(project ?? "") else { return .refusal(.missingProject) }
            var payload: [String: CommandValue] = [
                "title": .string(title),
                "body": .string(prompt),
                "target": .string("local"),
            ]
            if let repo = httpsRepo(repo) { payload["repo"] = .string(repo) }
            return .ready(OutboundCommand(id: id, kind: "new", source: source, project: project, item: nil, payload: payload))
        }
        guard let repo = httpsRepo(repo) else { return .refusal(.missingRepo) }
        let named = (provider.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "cursor" : provider.trimmingCharacters(in: .whitespacesAndNewlines)).lowercased()
        let payload: [String: CommandValue] = [
            "title": .string(title),
            "body": .string(prompt),
            "target": .string("cloud"),
            "provider": .string(named),
            "repo": .string(repo),
        ]
        return .ready(OutboundCommand(id: id, kind: "new", source: source, project: trimmed(project ?? "") ?? projectSlug(fromRepo: repo), item: nil, payload: payload))
    }

    public static func newThread(project: String, title: String, body: String, source: ClientSource, id: String) -> BuiltCommand {
        guard let project = trimmed(project) else { return .refusal(.missingProject) }
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty || !body.isEmpty else { return .refusal(.missingWords) }
        return .ready(OutboundCommand(
            id: id,
            kind: "new",
            source: source,
            project: project,
            item: nil,
            payload: ["title": .string(title), "body": .string(body)]
        ))
    }

    private static func thread(_ kind: String, project: String, item: String, payload: [String: CommandValue], source: ClientSource, id: String) -> BuiltCommand {
        guard let project = trimmed(project) else { return .refusal(.missingProject) }
        guard let item = trimmed(item) else { return .refusal(.missingThread) }
        return .ready(OutboundCommand(id: id, kind: kind, source: source, project: project, item: item, payload: payload))
    }

    private static func trimmed(_ value: String) -> String? {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    private static func titleLine(_ prompt: String) -> String {
        let line = prompt.split(whereSeparator: \.isNewline).first.map(String.init) ?? prompt
        if line.count <= 80 { return line }
        return String(line.prefix(80))
    }

    private static func httpsRepo(_ raw: String) -> String? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: text),
              parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil else { return nil }
        return text
    }
}

public func projectSlug(fromRepo repo: String) -> String? {
    let raw = repo.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let parts = URLComponents(string: raw),
          let scheme = parts.scheme?.lowercased(), scheme == "https" || scheme == "http",
          let host = parts.host, !host.isEmpty,
          parts.user == nil, parts.password == nil else { return nil }
    let segs = parts.path.split(separator: "/").map(String.init)
    guard segs.count >= 2 else { return nil }
    var last = segs[segs.count - 1]
    if last.lowercased().hasSuffix(".git") { last.removeLast(4) }
    var slug = ""
    var dash = false
    for scalar in last.lowercased().unicodeScalars {
        let ok = (scalar.value >= 97 && scalar.value <= 122) || (scalar.value >= 48 && scalar.value <= 57)
        if ok {
            slug.unicodeScalars.append(scalar)
            dash = false
        } else if !dash && !slug.isEmpty {
            slug.append("-")
            dash = true
        }
    }
    while slug.hasSuffix("-") { slug.removeLast() }
    guard !slug.isEmpty else { return nil }
    if slug.count > 80 { return String(slug.prefix(80)) }
    return slug
}

public func commandBody(_ command: OutboundCommand) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return try encoder.encode(command)
}
