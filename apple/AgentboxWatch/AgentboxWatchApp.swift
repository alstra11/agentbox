import SwiftUI

@main
struct AgentboxWatchApp: App {
    @State private var model = WatchModel()

    var body: some Scene {
        WindowGroup {
            WatchRoot()
                .environment(model)
        }
    }
}

struct WatchRoot: View {
    @Environment(WatchModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        WatchInboxView()
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { model.startPolling() } else { model.stopPolling() }
            }
            .task { model.startPolling() }
    }
}
