import SwiftUI

@main
struct AgentboxApp: App {
    @State private var model = InboxModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onOpenURL { model.open($0) }
        }
    }
}

struct RootView: View {
    @Environment(InboxModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab = 0

    var body: some View {
        TabView(selection: $tab) {
            InboxView()
                .tabItem { Label("Braucht dich", systemImage: "tray") }
                .tag(0)
            StatusView()
                .tabItem { Label("Status", systemImage: "desktopcomputer") }
                .tag(1)
            SettingsView()
                .tabItem { Label("Einstellungen", systemImage: "gear") }
                .tag(2)
        }
        .onChange(of: model.opened) { _, link in
            if link != nil { tab = 0 }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.startPolling() } else { model.stopPolling() }
        }
        .task { model.startPolling() }
    }
}
