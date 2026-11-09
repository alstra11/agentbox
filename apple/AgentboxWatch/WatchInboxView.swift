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
                                Text(item.question).font(.caption).lineLimit(2)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Braucht dich")
            .toolbar {
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
