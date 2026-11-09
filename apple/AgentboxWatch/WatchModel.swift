import Foundation
import AgentboxKit
import WatchKit
import WidgetKit

@MainActor
@Observable
final class WatchModel {
    var urlText: String
    var token: String
    private(set) var deviceID: String
    var items: [NeedsYouItem] = []
    var status: ClientStatus?
    var error: String?
    var banner: String?
    private var seen: Set<String>?
    private var poll: Task<Void, Never>?
    private var inFlight: Task<Void, Never>?
    private let link = WatchLink()

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
        link.onHandoff = { [weak self] handoff in
            self?.apply(handoff)
        }
        link.activate()
        if let waiting = link.pending() { apply(waiting) }
        mirror()
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

    func save(url rawURL: String, token rawToken: String) -> String? {
        guard let url = normalizeRelayURL(rawURL) else { return RelayError.badURL.message }
        let token = normalizeToken(rawToken) ?? ""
        do {
            if token.isEmpty { KeychainStore.remove(account: "token") }
            else { try KeychainStore.set(token, account: "token") }
        } catch {
            return "Keychain nicht beschreibbar"
        }
        urlText = url.absoluteString
        self.token = token
        UserDefaults.standard.set(urlText, forKey: "relayURL")
        mirror()
        return nil
    }

    func post(_ command: OutboundCommand) async -> String? {
        guard let client = client() else { return RelayError.emptyToken.message }
        do {
            _ = try await client.send(command)
            banner = "Gesendet."
            return nil
        } catch let error as RelayError {
            return error.message
        } catch {
            return "Nicht erreichbar"
        }
    }

    func client() -> RelayClient? {
        guard let url = normalizeRelayURL(urlText), normalizeToken(token) != nil else { return nil }
        return RelayClient(baseURL: url, token: token, deviceID: deviceID, source: .watch)
    }

    private func apply(_ handoff: WatchHandoff) {
        urlText = handoff.relayURL
        token = handoff.watchToken
        UserDefaults.standard.set(urlText, forKey: "relayURL")
        try? KeychainStore.set(token, account: "token")
        mirror()
        Task { await refresh() }
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
            let ids = Set(loaded.map { "\($0.project)/\($0.id)" })
            if let seen, !ids.subtracting(seen).isEmpty {
                WKInterfaceDevice.current().play(.notification)
            }
            seen = ids
            items = loaded
            error = nil
            banner = nil
            WidgetCenter.shared.reloadTimelines(ofKind: WidgetKind.needsYou)
        } catch let failure as RelayError {
            error = failure.message
        } catch {
            error = "Nicht erreichbar"
        }
    }

    private func mirror() {
        guard let url = normalizeRelayURL(urlText), let token = normalizeToken(token) else { return }
        AppGroupRelay.write(AppGroupRelay.Config(url: url.absoluteString, token: token, deviceID: deviceID))
        WidgetCenter.shared.reloadTimelines(ofKind: WidgetKind.needsYou)
    }
}
