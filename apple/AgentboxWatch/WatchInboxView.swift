import SwiftUI
import AgentboxKit

struct WatchInboxView: View {
    @Environment(WatchModel.self) private var model

    var body: some View {
        NavigationStack {
            Group {
                if model.items.isEmpty {
                    VStack(spacing: 6) {
                        Text(model.error ?? "Nichts offen")
                            .font(.headline)
                            .multilineTextAlignment(.center)
                        if let banner = model.banner { Text(banner).font(.caption2) }
                    }
                } else {
                    List(model.items, id: \.rowID) { item in
                        NavigationLink {
                            WatchThreadView(link: ThreadLink(project: item.project, id: item.id))
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title).font(.headline)
                                if let badge = executionBadge(target: item.target, provider: item.provider) {
                                    Text(badge).font(.caption2)
                                }
                                Text(item.question).font(.caption).lineLimit(2)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Braucht dich")
            .toolbar {
                NavigationLink {
                    WatchComposeView()
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                NavigationLink {
                    WatchSettingsView()
                } label: {
                    Image(systemName: "gear")
                }
            }
            .refreshable { await model.refresh() }
        }
    }
}

private extension NeedsYouItem {
    var rowID: String { "\(project)/\(id)" }
}

struct WatchComposeView: View {
    @Environment(WatchModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var prompt = ""
    @State private var repo = ""
    @State private var project = ""
    @State private var target = "cloud"
    @State private var fault: String?

    private var macOffline: Bool { model.status?.macOnline != true }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                TextField("Auftrag", text: $prompt)
                TextField("Repository", text: $repo)
                Button(target == "cloud" ? "Cloud" : "Lokal") {
                    if macOffline { target = "cloud" }
                    else { target = target == "cloud" ? "local" : "cloud" }
                }
                .disabled(macOffline && target == "cloud")
                if macOffline { Text("Der Mac ist aus.").font(.caption2) }
                if target == "local" { TextField("Projekt", text: $project) }
                Button("Senden") { Task { await send() } }
                    .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if let fault { Text(fault).font(.caption2).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Neue Anfrage")
    }

    private func send() async {
        let built = CommandDraft.newRequest(
            prompt: prompt,
            repo: repo,
            target: target,
            provider: "cursor",
            project: target == "local" ? project : projectSlug(fromRepo: repo),
            source: .watch,
            id: UUID().uuidString
        )
        switch built {
        case .ready(let command):
            if let fault = await model.post(command) { self.fault = fault }
            else { dismiss() }
        case .refusal(let why):
            fault = why.message
        case .needsWords, .confirm:
            break
        }
    }
}
