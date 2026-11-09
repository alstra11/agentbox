import SwiftUI
import AgentboxKit

struct WatchThreadView: View {
    @Environment(WatchModel.self) private var model
    let link: ThreadLink
    @State private var snapshot: ThreadSnapshot?
    @State private var draft = ""
    @State private var fault: String?
    @State private var busy = false
    @State private var discard: OutboundCommand?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(question).font(.headline)
                ForEach(options, id: \.n) { option in
                    Button { Task { await pick(option) } } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.text).frame(maxWidth: .infinity, alignment: .leading)
                            if option.recommended { Text("Empfohlen").font(.caption2) }
                        }
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(option.recommended ? .borderedProminent : .bordered)
                    .disabled(busy)
                }
                if let card = answerable {
                    Button("Erlauben") { Task { await answer(card, true) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(busy)
                    Button("Ablehnen") { Task { await answer(card, false) } }
                        .disabled(busy)
                }
                TextField("Antwort", text: $draft)
                Button("Senden") { Task { await sendDraft() } }
                    .disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if let fault { Text(fault).font(.caption2).foregroundStyle(.red) }
                if let banner = model.banner { Text(banner).font(.caption2) }
            }
        }
        .navigationTitle(title)
        .confirmationDialog("Verwerfen?", isPresented: Binding(get: { discard != nil }, set: { if !$0 { discard = nil } }), titleVisibility: .visible) {
            Button("Senden") {
                guard let command = discard else { return }
                discard = nil
                Task { await send(command) }
            }
            Button("Abbrechen", role: .cancel) { discard = nil }
        }
        .task(id: link) { await load() }
    }

    private var listItem: NeedsYouItem? {
        model.items.first { $0.project == link.project && $0.id == link.id }
    }

    private var title: String { listItem?.title ?? snapshot?.item.title ?? link.id }

    private var question: String {
        if let question = listItem?.question, !question.isEmpty { return question }
        guard let snapshot else { return title }
        let text = snapshot.item.result ?? snapshot.item.note ?? snapshot.item.body ?? ""
        let asked = relayQuestion(text: text, title: snapshot.item.title)
        return asked.isEmpty ? title : asked
    }

    private var options: [ReplyOption] {
        if let options = listItem?.options, !options.isEmpty { return options }
        return parsedOptions(result: snapshot?.item.result, note: snapshot?.item.note, body: snapshot?.item.body, wrote: snapshot?.item.wrote)
    }

    private var answerable: ApprovalCard? {
        snapshot?.approvals?.first { $0.canAnswer }
    }

    private func load() async {
        guard let client = model.client() else {
            fault = RelayError.emptyToken.message
            return
        }
        snapshot = try? await client.thread(project: link.project, item: link.id)
    }

    private func pick(_ option: ReplyOption) async {
        let built = CommandDraft.option(project: link.project, item: link.id, n: option.n, text: option.text, source: .watch, id: UUID().uuidString)
        switch built {
        case .ready(let command):
            await send(command)
        case .needsWords(let words):
            draft = words
        case .confirm(let command):
            discard = command
        case .refusal(let why):
            fault = why.message
        }
    }

    private func sendDraft() async {
        let built = CommandDraft.reply(project: link.project, item: link.id, text: draft, source: .watch, id: UUID().uuidString)
        if case .ready(let command) = built {
            if await send(command) { draft = "" }
        } else if case .refusal(let why) = built {
            fault = why.message
        }
    }

    private func answer(_ card: ApprovalCard, _ allow: Bool) async {
        let built = CommandDraft.approve(project: link.project, item: link.id, approval: card.id, allow: allow, card: card.card ?? "", note: nil, source: .watch, id: UUID().uuidString)
        if case .ready(let command) = built { await send(command) }
        else if case .refusal(let why) = built { fault = why.message }
    }

    @discardableResult
    private func send(_ command: OutboundCommand) async -> Bool {
        busy = true
        defer { busy = false }
        if let fault = await model.post(command) {
            self.fault = fault
            return false
        }
        fault = nil
        return true
    }
}
