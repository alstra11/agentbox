import SwiftUI
import AgentboxKit

struct InboxView: View {
    @Environment(InboxModel.self) private var model
    @State private var composing = false

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Group {
                if model.items.isEmpty {
                    ContentUnavailableView {
                        Label("Nichts offen", systemImage: "tray")
                    } description: {
                        if let error = model.error { Text(error) }
                    }
                } else {
                    List {
                        if let error = model.error {
                            Text(error).foregroundStyle(.red).font(.footnote)
                        }
                        ForEach(model.items, id: \.rowID) { item in
                        Button {
                            model.opened = ThreadLink(project: item.project, id: item.id)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.title).font(.headline)
                                Text(item.question).font(.subheadline).foregroundStyle(.secondary)
                                HStack {
                                    Text(item.projectName)
                                    if item.hasApproval == true { Text("Erlaubnis") }
                                    if model.pending.contains(item.rowID) { Text("Unterwegs") }
                                }
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                        }
                    }
                }
            }
            .navigationTitle("Braucht dich")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { composing = true } label: { Image(systemName: "square.and.pencil") }
                }
            }
            .refreshable { await model.refresh() }
            .navigationDestination(item: $model.opened) { link in
                ThreadView(link: link)
            }
            .sheet(isPresented: $composing) {
                ComposeView()
            }
            .overlay(alignment: .bottom) {
                if let banner = model.banner, !model.items.isEmpty {
                    Text(banner).font(.footnote).padding(8)
                }
            }
        }
    }
}

private extension NeedsYouItem {
    var rowID: String { "\(project)/\(id)" }
}

struct ComposeView: View {
    @Environment(InboxModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var slug = ""
    @State private var title = ""
    @State private var bodyText = ""
    @State private var fault: String?

    var body: some View {
        NavigationStack {
            Form {
                Picker("Projekt", selection: $slug) {
                    Text("Projekt").tag("")
                    ForEach(choices, id: \.slug) { row in
                        Text(row.name).tag(row.slug)
                    }
                }
                TextField("Titel", text: $title)
                TextField("Text", text: $bodyText, axis: .vertical)
                if let fault { Text(fault).foregroundStyle(.red) }
            }
            .navigationTitle("Neu")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Senden") { Task { await send() } }
                }
            }
            .task { await model.loadProjects() }
        }
    }

    private var choices: [ProjectRow] {
        if !model.projects.isEmpty { return model.projects }
        var seen = Set<String>()
        return model.items.compactMap { item in
            guard seen.insert(item.project).inserted else { return nil }
            return ProjectRow(slug: item.project, name: item.projectName, cloud: nil, updatedAt: nil)
        }
    }

    private func send() async {
        let built = CommandDraft.newThread(project: slug, title: title, body: bodyText, source: .iphone, id: UUID().uuidString)
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
