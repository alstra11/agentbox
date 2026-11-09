import SwiftUI
import AgentboxKit

struct StatusView: View {
    @Environment(InboxModel.self) private var model

    var body: some View {
        NavigationStack {
        List {
            if let status = model.status {
                Section("Mac") {
                    LabeledContent("Zustand", value: status.macOnline ? "Online" : "Offline")
                    if let name = status.computerName, !name.isEmpty {
                        LabeledContent("Computer", value: name)
                    }
                    if let version = status.version, !version.isEmpty {
                        LabeledContent("Version", value: version)
                    }
                    if let seen = status.macLastSeen {
                        LabeledContent("Zuletzt", value: germanAgo(ms: seen))
                    } else {
                        LabeledContent("Zuletzt", value: "Noch kein Mac")
                    }
                    if status.paused { Text("Pausiert") }
                    if !status.macOnline { Text("Lokal wartet auf den Mac. Cloud läuft weiter.") }
                    if let harnesses = status.harnesses, !harnesses.isEmpty {
                        Text(harnesses.map(\.label).joined(separator: ", "))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                Section("Warteschlange") {
                    LabeledContent("Läuft", value: "\(status.queue.runNow.count)")
                    LabeledContent("Wartet", value: "\(status.queue.queued.count)")
                }
                if !status.stalled.isEmpty {
                    Section("Hängt") {
                        ForEach(status.stalled, id: \.self) { id in Text(id).font(.caption) }
                    }
                }
            } else if let error = model.error {
                Text(error)
            } else {
                Text("Noch kein Status")
            }
        }
        .navigationTitle("Status")
        .refreshable { await model.refresh() }
        }
    }
}
