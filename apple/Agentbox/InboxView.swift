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
                                if let badge = executionBadge(target: item.target, provider: item.provider) {
                                    Text(badge).font(.caption).foregroundStyle(.secondary)
                                }
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
    @State private var prompt = ""
    @State private var repo = ""
    @State private var target = "cloud"
    @State private var slug = ""
    @State private var fault: String?

    private var macOffline: Bool { model.status?.macOnline != true }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Auftrag", text: $prompt, axis: .vertical)
                TextField("Repository", text: $repo)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Section("Ziel") {
                    Button { target = "cloud" } label: {
                        choice("Cloud", on: target == "cloud")
                    }
                    Button { target = "local" } label: {
                        choice("Lokal", on: target == "local")
                    }
                    .disabled(macOffline)
                    if macOffline {
                        Text("Der Mac ist aus.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else if let names = harnessLine {
                        Text(names).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if target == "local" {
                    Picker("Projekt", selection: $slug) {
                        Text("Projekt").tag("")
                        ForEach(choices, id: \.slug) { row in
                            Text(row.name).tag(row.slug)
                        }
                    }
                }
                if let fault { Text(fault).foregroundStyle(.red) }
            }
            .navigationTitle("Neue Anfrage")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Senden") { Task { await send() } }
                }
            }
            .task {
                await model.loadProjects()
                if model.status == nil { await model.refresh() }
            }
        }
    }

    private var harnessLine: String? {
        let names = (model.status?.harnesses ?? []).filter(\.available).map(\.label)
        return names.isEmpty ? nil : names.joined(separator: ", ")
    }

    private func choice(_ title: String, on: Bool) -> some View {
        HStack {
            Text(title)
            Spacer()
            if on { Image(systemName: "checkmark") }
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
        let built = CommandDraft.newRequest(
            prompt: prompt,
            repo: repo,
            target: target,
            provider: "cursor",
            project: target == "local" ? slug : projectSlug(fromRepo: repo),
            source: .iphone,
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
