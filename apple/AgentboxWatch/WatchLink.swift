import AgentboxKit
import WatchConnectivity

final class WatchLink: NSObject, WCSessionDelegate {
    var onHandoff: ((WatchHandoff) -> Void)?

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func pending() -> WatchHandoff? {
        guard WCSession.isSupported() else { return nil }
        return WatchHandoff(context: WCSession.default.receivedApplicationContext)
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        guard activationState == .activated else { return }
        let handoff = WatchHandoff(context: session.receivedApplicationContext)
        DispatchQueue.main.async { if let handoff { self.onHandoff?(handoff) } }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let handoff = WatchHandoff(context: applicationContext) else { return }
        DispatchQueue.main.async { self.onHandoff?(handoff) }
    }
}
