import Foundation
import AgentboxKit

@MainActor
@Observable
final class InboxModel {
    var urlText: String
    var token: String
    var watchToken: String
    private(set) var deviceID: String
    var items: [NeedsYouItem] = []
    var status: ClientStatus?
    var projects: [ProjectRow] = []
    var error: String?
    var banner: String?
    var pending: Set<String> = []
    var opened: ThreadLink?
    var watchPaired = false

    private var poll: Task<Void, Never>?
    private var inFlight: Task<Void, Never>?
    private let link = PhoneLink()

    init() {
        let defaults = UserDefaults.standard
        urlText = defaults.string(forKey: "relayURL") ?? RelayDefaults.url.absoluteString
        if let stored = defaults.string(forKey: "deviceID"), stored.count == 12 {
            deviceID = stored
        } else {
            let made = DeviceID.make()
            defaults.set(made, forKey: "deviceID")
            deviceID = made
        }
        token = KeychainStore.get(account: "token") ?? ""
        watchToken = KeychainStore.get(account: "watch-token") ?? ""
        link.onActive = { [weak self] in
            self?.watchPaired = self?.link.paired ?? false
            self?.pushWatch()
        }
        link.activate()
    }

    func open(_ url: URL) {
        opened = threadLink(url)
    }

    func startPolling() {
        guard poll == nil else { return }
        poll = Task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(nanoseconds: UInt64(RelayDefaults.pollSeconds * 1_000_000_000))
            }
        }
    }

    func stopPolling() {
        poll?.cancel()
        poll = nil
    }

    func refresh() async {
        if let inFlight {
            await inFlight.value
            return
        }
        let task = Task { await self.load() }
        inFlight = task
        await task.value
        inFlight = nil
    }

    func save(url rawURL: String, token rawToken: String, watch rawWatch: String) -> String? {
        guard let url = normalizeRelayURL(rawURL) else { return RelayError.badURL.message }
        let token = normalizeToken(rawToken) ?? ""
        let watch = normalizeToken(rawWatch) ?? ""
        do {
            if token.isEmpty { KeychainStore.remove(account: "token") }
            else { try KeychainStore.set(token, account: "token") }
            if watch.isEmpty { KeychainStore.remove(account: "watch-token") }
            else { try KeychainStore.set(watch, account: "watch-token") }
        } catch {
            return "Keychain nicht beschreibbar"
        }
        urlText = url.absoluteString
        self.token = token
        watchToken = watch
        UserDefaults.standard.set(urlText, forKey: "relayURL")
        pushWatch()
        return nil
    }

    func check(_ rawURL: String) async -> String {
        guard let url = normalizeRelayURL(rawURL) else { return RelayError.badURL.message }
        let client = RelayClient(baseURL: url, token: "health", deviceID: deviceID, source: .iphone)
        do {
            try await client.health()
            return "Erreichbar"
        } catch let error as RelayError {
            return error.message
        } catch {
            return "Nicht erreichbar"
        }
    }

    func loadProjects() async {
        guard let client = client() else { return }
        if let rows = try? await client.projects() {
            projects = rows
        }
    }

    func post(_ command: OutboundCommand) async -> String? {
        guard let client = client() else { return RelayError.emptyToken.message }
        do {
            _ = try await client.send(command)
            if let project = command.project, let item = command.item {
                pending.insert("\(project)/\(item)")
            }
            let cloud = command.payload["target"] == .string("cloud")
                || items.contains { $0.project == command.project && $0.id == command.item && $0.target == "cloud" }
            if cloud { banner = "Läuft in der Cloud." }
            else { banner = status?.macOnline == false ? "Wartet auf den Mac." : "Gesendet." }
            return nil
        } catch let error as RelayError {
            return error.message
        } catch {
            return "Nicht erreichbar"
        }
    }

    func pushWatch() {
        watchPaired = link.paired
        guard let handoff = WatchHandoff(relayURL: urlText, watchToken: watchToken) else { return }
        link.push(handoff)
    }

    private func load() async {
        guard let client = client() else {
            error = normalizeToken(token) == nil ? RelayError.emptyToken.message : RelayError.badURL.message
            return
        }
        do {
            async let nextItems = client.needsYou()
            async let nextStatus = client.status()
            let loaded = try await nextItems
            status = try await nextStatus
            items = loaded
            error = nil
            banner = nil
            let alive = Set(loaded.map { "\($0.project)/\($0.id)" })
            pending = pending.intersection(alive)
        } catch let failure as RelayError {
            error = failure.message
        } catch {
            error = "Nicht erreichbar"
        }
    }

    private func client() -> RelayClient? {
        guard let url = normalizeRelayURL(urlText), normalizeToken(token) != nil else { return nil }
        return RelayClient(baseURL: url, token: token, deviceID: deviceID, source: .iphone)
    }
}
