import Foundation

public struct ReplyOption: Codable, Equatable, Sendable {
    public var n: Int
    public var text: String
    public var recommended: Bool

    public init(n: Int, text: String, recommended: Bool) {
        self.n = n
        self.text = text
        self.recommended = recommended
    }
}

public struct WaitState: Codable, Equatable, Sendable {
    public var state: String
    public var tool: String?
    public var until: Double?
}

public struct NeedsYouItem: Codable, Equatable, Sendable {
    public var project: String
    public var projectName: String
    public var id: String
    public var title: String
    public var status: String
    public var kind: String?
    public var updatedAt: Double
    public var context: String
    public var question: String
    public var options: [ReplyOption]
    public var hasApproval: Bool?
    public var wait: WaitState?
}

public struct NeedsYouList: Codable, Equatable, Sendable {
    public var items: [NeedsYouItem]
}

public struct StatusQueue: Codable, Equatable, Sendable {
    public var runNow: [String]
    public var queued: [String]
}

public struct ClientStatus: Codable, Equatable, Sendable {
    public var macLastSeen: Double?
    public var macOnline: Bool
    public var paused: Bool
    public var stalled: [String]
    public var queue: StatusQueue
    public var version: String?
    public var computerName: String?
}

public struct ProjectRow: Codable, Equatable, Sendable {
    public var slug: String
    public var name: String
    public var cloud: Bool?
    public var updatedAt: Double?

    public init(slug: String, name: String, cloud: Bool?, updatedAt: Double?) {
        self.slug = slug
        self.name = name
        self.cloud = cloud
        self.updatedAt = updatedAt
    }
}

public struct ProjectList: Codable, Equatable, Sendable {
    public var projects: [ProjectRow]
}

public struct FieldWrite: Codable, Equatable, Sendable {
    public var ts: Double
    public var source: String

    public init(ts: Double, source: String) {
        self.ts = ts
        self.source = source
    }
}

public struct SnapshotItem: Codable, Equatable, Sendable {
    public var id: String?
    public var title: String?
    public var body: String?
    public var result: String?
    public var note: String?
    public var status: String?
    public var kind: String?
    public var answer: String?
    public var updatedAt: Double?
    public var wrote: [String: FieldWrite]?
}

public struct HistoryPatch: Codable, Equatable, Sendable {
    public var title: String?
    public var body: String?
    public var result: String?
    public var note: String?
    public var answer: String?
    public var status: String?
}

public struct HistoryLine: Codable, Equatable, Sendable {
    public var id: String
    public var ts: Double
    public var source: String
    public var patch: HistoryPatch
}

public struct LiveStep: Codable, Equatable, Sendable {
    public var label: String
    public var startedAt: Double
}

public struct LiveRun: Decodable, Equatable, Sendable {
    public var since: Double
    public var whereRun: String
    public var doing: [LiveStep]
    public var at: Double
    public var movable: Bool?
    public var runId: String?

    enum CodingKeys: String, CodingKey {
        case since, doing, at, movable, runId
        case whereRun = "where"
    }
}

public struct ApprovalCard: Decodable, Equatable, Sendable {
    public var id: String
    public var at: Double
    public var tool: String
    public var card: String?
    public var answerOnComputer: Bool?

    enum CodingKeys: String, CodingKey {
        case id, at, tool, card, answerOnComputer
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        at = try c.decode(Double.self, forKey: .at)
        tool = try c.decode(String.self, forKey: .tool)
        card = try? c.decode(String.self, forKey: .card)
        answerOnComputer = try c.decodeIfPresent(Bool.self, forKey: .answerOnComputer)
    }
}

public struct ThreadSnapshot: Decodable, Equatable, Sendable {
    public var v: Int
    public var item: SnapshotItem
    public var history: [HistoryLine]
    public var olderLines: Int
    public var live: LiveRun?
    public var approvals: [ApprovalCard]?
    public var wait: WaitState?

    enum CodingKeys: String, CodingKey {
        case v, item, history, olderLines, live, approvals, wait
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try c.decodeIfPresent(Int.self, forKey: .v) ?? 0
        item = try c.decode(SnapshotItem.self, forKey: .item)
        history = try c.decodeIfPresent([HistoryLine].self, forKey: .history) ?? []
        olderLines = try c.decodeIfPresent(Int.self, forKey: .olderLines) ?? 0
        live = try c.decodeIfPresent(LiveRun.self, forKey: .live)
        approvals = try c.decodeIfPresent([ApprovalCard].self, forKey: .approvals)
        wait = try c.decodeIfPresent(WaitState.self, forKey: .wait)
    }
}

public struct ThreadEnvelope: Decodable, Equatable, Sendable {
    public var snapshot: ThreadSnapshot
}
