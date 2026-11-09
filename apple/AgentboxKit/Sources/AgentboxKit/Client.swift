import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum RelayError: Error, Equatable, Sendable, CustomStringConvertible, LocalizedError {
    case badURL
    case emptyToken
    case unauthorized
    case notFound
    case decode
    case timedOut
    case rejected(String)
    case unexpectedStatus(Int)
    case transport(String)

    public var message: String {
        switch self {
        case .badURL: return "Adresse ungültig"
        case .emptyToken: return "Token fehlt"
        case .unauthorized: return "Token abgelehnt"
        case .notFound: return "Nicht da"
        case .decode: return "Antwort unlesbar"
        case .timedOut: return "Keine Antwort"
        case .unexpectedStatus(let code): return "Antwort \(code)"
        case .transport: return "Nicht erreichbar"
        case .rejected(let why): return Self.german(why)
        }
    }

    public var description: String { message }
    public var errorDescription: String? { message }

    static func german(_ why: String) -> String {
        switch why {
        case "not something the phone may do": return "Das geht von hier nicht"
        case "that project is not on your phone": return "Projekt ist nicht auf dem Relay"
        case "that thread is not on your phone": return "Thread ist nicht auf dem Relay"
        case "an empty reply": return "Leere Antwort"
        case "a snooze needs a time", "a schedule needs a time": return "Zeit fehlt"
        case "an answer needs its card": return "Karte fehlt"
        case "a new thread needs some words": return "Text fehlt"
        case "already there": return "Schon gesendet"
        case "unauthorized": return "Token abgelehnt"
        default: return why
        }
    }
}

public struct RelayHTTPResult: Sendable, Equatable {
    public var status: Int
    public var body: Data

    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
    }
}

public protocol RelayTransport: Sendable {
    func send(_ request: URLRequest) async throws -> RelayHTTPResult
}

public struct URLSessionTransport: RelayTransport {
    public init() {}

    public func send(_ request: URLRequest) async throws -> RelayHTTPResult {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw RelayError.transport("") }
        return RelayHTTPResult(status: http.statusCode, body: data)
    }
}

public struct RelayClient: Sendable {
    public var baseURL: URL
    public var token: String
    public var deviceID: String
    public var source: ClientSource
    public var transport: any RelayTransport

    public init(baseURL: URL, token: String, deviceID: String, source: ClientSource, transport: any RelayTransport = URLSessionTransport()) {
        self.baseURL = baseURL
        self.token = token
        self.deviceID = deviceID
        self.source = source
        self.transport = transport
    }

    public func needsYou() async throws -> [NeedsYouItem] {
        try decode(NeedsYouList.self, from: try await load(.needsYou)).items
    }

    public func status() async throws -> ClientStatus {
        try decode(ClientStatus.self, from: try await load(.status))
    }

    public func projects() async throws -> [ProjectRow] {
        try decode(ProjectList.self, from: try await load(.projects)).projects
    }

    public func thread(project: String, item: String) async throws -> ThreadSnapshot {
        try decode(ThreadEnvelope.self, from: try await load(.thread(project: project, item: item))).snapshot
    }

    public func health() async throws {
        _ = try await load(.health)
    }

    public func send(_ command: OutboundCommand) async throws -> String {
        struct Ack: Decodable { var ok: Bool; var id: String }
        let ack = try decode(Ack.self, from: try await load(.commands, body: commandBody(command)))
        guard ack.ok, !ack.id.isEmpty else { throw RelayError.decode }
        return ack.id
    }

    private func load(_ endpoint: RelayEndpoint, body: Data? = nil) async throws -> Data {
        let request = try makeRelayRequest(base: baseURL, token: token, deviceID: deviceID, endpoint: endpoint, body: body)
        let result: RelayHTTPResult
        do {
            result = try await transport.send(request)
        } catch let error as RelayError {
            throw error
        } catch let error as URLError where error.code == .timedOut {
            throw RelayError.timedOut
        } catch {
            throw RelayError.transport("")
        }
        switch result.status {
        case 200:
            return result.body
        case 401:
            throw RelayError.unauthorized
        case 404:
            throw RelayError.notFound
        case 400:
            struct Err: Decodable { var error: String }
            if let err = try? JSONDecoder().decode(Err.self, from: result.body), !err.error.isEmpty {
                throw RelayError.rejected(err.error)
            }
            throw RelayError.rejected("abgelehnt")
        default:
            throw RelayError.unexpectedStatus(result.status)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw RelayError.decode
        }
    }
}
