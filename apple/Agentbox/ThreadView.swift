import SwiftUI
import AgentboxKit

struct ThreadView: View {
    @Environment(InboxModel.self) private var model
    let link: ThreadLink

    @State private var snapshot: ThreadSnapshot?
    @State private var draft = ""
    @State private var fault: String?
    @State private var busy = false
    @State private var askAllow = false
    @State private var askDeny = false
    @State private var askClose = false
    @State private var askStop = false
    @State private var discard: OutboundCommand?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(question).font(.title3.weight(.semibold))
                if let context, !context.isEmpty {
                    Text(context).font(.subheadline).foregroundStyle(.secondary)
                }
                if let wait = listItem?.wait ?? snapshot?.wait {
                    Text(waitLabel(wait.state)).font(.caption).foregroundStyle(.secondary)
                }
                if let doing = snapshot?.live?.doing.first?.label, !doing.isEmpty {
                    Text(doing).font(.caption).foregroundStyle(.secondary)
                }
                ForEach(options, id: \.n) { option in
                    Button { Task { await pick(option) } } label: {
                        HStack(alignment: .firstTextBaseline) {
                            Text("\(option.n)").font(.headline).frame(width: 28, alignment: .leading)
                            Text(option.text).frame(maxWidth: .infinity, alignment: .leading)
                            if option.recommended { Text("Empfohlen").font(.caption) }
                        }
                        .padding(.vertical, 4)
                    }
                    .buttonStyle(option.recommended ? .borderedProminent : .bordered)
                    .disabled(busy)
                }
                if answerable != nil {
                    HStack {
                        Button("Erlauben") { askAllow = true }.buttonStyle(.borderedProminent)
                        Button("Ablehnen") { askDeny = true }.buttonStyle(.bordered)
                    }
                    .disabled(busy)
                } else if snapshot?.approvals?.isEmpty == false {
                    Text("Am Computer").font(.subheadline)
                }
                if !history.isEmpty {
                    Text("Verlauf").font(.headline).padding(.top, 8)
                    ForEach(Array(history.enumerated()), id: \.offset) { _, line in
                        if let text = lineText(line) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(who(line.source)).font(.caption).foregroundStyle(.secondary)
                                Text(text).font(.body)
                            }
                        }
                    }
                }
                if let fault { Text(fault).foregroundStyle(.red) }
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            HStack(alignment: .bottom) {
                TextField("Antwort", text: $draft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                Button("Senden") { Task { await sendDraft() } }
                    .disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding()
            .background(.bar)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu("Mehr") {
                    Menu("Schlummern") {
                        Button("1 Stunde") { Task { await snooze(hours: 1) } }
                        Button("3 Stunden") { Task { await snooze(hours: 3) } }
                        Button("Morgen früh") { Task { await snooze(until: When.tomorrowAtEight(after: Date())) } }
                    }
                    Menu("Planen") {
                        Button("In 1 Stunde") { Task { await schedule(hours: 1) } }
                        Button("Morgen früh") { Task { await schedule(until: When.tomorrowAtEight(after: Date())) } }
                    }
                    Button("Jetzt starten") { Task { await plain(.runNow) } }
                    Button("Sofort senden") { Task { await plain(.sendNow) } }
                    Button("Wieder öffnen") { Task { await plain(.reopen) } }
                    if snapshot?.live?.movable == true {
                        Button("In die Cloud") { Task { await plain(.moveToCloud) } }
                    }
                    Button("Stoppen", role: .destructive) { askStop = true }
                    Button("Schließen", role: .destructive) { askClose = true }
                }
            }
        }
        .confirmationDialog("Erlauben?", isPresented: $askAllow, titleVisibility: .visible) {
            Button("Erlauben") { Task { await answer(true) } }
            Button("Abbrechen", role: .cancel) {}
        }
        .confirmationDialog("Ablehnen?", isPresented: $askDeny, titleVisibility: .visible) {
            Button("Ablehnen", role: .destructive) { Task { await answer(false) } }
            Button("Abbrechen", role: .cancel) {}
        }
        .confirmationDialog("Thread schließen?", isPresented: $askClose, titleVisibility: .visible) {
            Button("Schließen", role: .destructive) { Task { await plain(.close) } }
            Button("Abbrechen", role: .cancel) {}
        }
        .confirmationDialog("Thread stoppen?", isPresented: $askStop, titleVisibility: .visible) {
            Button("Stoppen", role: .destructive) { Task { await plain(.stop) } }
            Button("Abbrechen", role: .cancel) {}
        }
        .confirmationDialog("Verwerfen?", isPresented: Binding(get: { discard != nil }, set: { if !$0 { discard = nil } }), titleVisibility: .visible) {
            Button("Senden", role: .destructive) { Task { await sendDiscard() } }
            Button("Abbrechen", role: .cancel) { discard = nil }
        }
        .task(id: link) { await load() }
        .refreshable { await load() }
    }

    private var listItem: NeedsYouItem? {
        model.items.first { $0.project == link.project && $0.id == link.id }
    }

    private var title: String {
        listItem?.title ?? snapshot?.item.title ?? link.id
    }

    private var question: String {
        if let question = listItem?.question, !question.isEmpty { return question }
        guard let snapshot else { return title }
        if let tool = snapshot.approvals?.first?.tool, !(snapshot.approvals ?? []).isEmpty { return tool }
        let text = snapshot.item.result ?? snapshot.item.note ?? snapshot.item.body ?? ""
        let asked = relayQuestion(text: text, title: snapshot.item.title)
        return asked.isEmpty ? title : asked
    }

    private var context: String? {
        if let context = listItem?.context, !context.isEmpty { return context }
        return snapshot?.item.body
    }

    private var options: [ReplyOption] {
        if let options = listItem?.options, !options.isEmpty { return options }
        return parsedOptions(result: snapshot?.item.result, note: snapshot?.item.note, body: snapshot?.item.body, wrote: snapshot?.item.wrote)
    }

    private var answerable: ApprovalCard? {
        snapshot?.approvals?.first { $0.canAnswer }
    }

    private var history: [HistoryLine] {
        Array((snapshot?.history ?? []).suffix(30))
    }

    private func load() async {
        guard let client = makeClient() else {
            fault = RelayError.emptyToken.message
            return
        }
        do {
            snapshot = try await client.thread(project: link.project, item: link.id)
            fault = nil
        } catch let error as RelayError {
            fault = error.message
        } catch {
            fault = "Nicht erreichbar"
        }
    }

    private func pick(_ option: ReplyOption) async {
        let built = CommandDraft.option(project: link.project, item: link.id, n: option.n, text: option.text, source: .iphone, id: UUID().uuidString)
        switch built {
        case .ready(let command):
            await send(command)
        case .confirm(let command):
            discard = command
        case .needsWords(let words):
            draft = words
        case .refusal(let why):
            fault = why.message
        }
    }

    private func sendDraft() async {
        let built = CommandDraft.reply(project: link.project, item: link.id, text: draft, source: .iphone, id: UUID().uuidString)
        switch built {
        case .ready(let command):
            if await send(command) { draft = "" }
        case .refusal(let why):
            fault = why.message
        case .needsWords, .confirm:
            break
        }
    }

    private func snooze(hours: Int) async {
        await snooze(until: Date().addingTimeInterval(Double(hours) * 3600))
    }

    private func snooze(until date: Date) async {
        let built = CommandDraft.snooze(project: link.project, item: link.id, until: When.millis(date), source: .iphone, id: UUID().uuidString)
        if case .ready(let command) = built { await send(command) }
        else if case .refusal(let why) = built { fault = why.message }
    }

    private func schedule(hours: Int) async {
        await schedule(until: Date().addingTimeInterval(Double(hours) * 3600))
    }

    private func schedule(until date: Date) async {
        let built = CommandDraft.schedule(project: link.project, item: link.id, runAt: When.millis(date), source: .iphone, id: UUID().uuidString)
        if case .ready(let command) = built { await send(command) }
        else if case .refusal(let why) = built { fault = why.message }
    }

    private func plain(_ kind: PlainKind) async {
        let built = CommandDraft.plain(kind, project: link.project, item: link.id, source: .iphone, id: UUID().uuidString)
        if case .ready(let command) = built { await send(command) }
        else if case .refusal(let why) = built { fault = why.message }
    }

    private func answer(_ allow: Bool) async {
        guard let card = answerable else { return }
        let built = CommandDraft.approve(project: link.project, item: link.id, approval: card.id, allow: allow, card: card.card ?? "", note: nil, source: .iphone, id: UUID().uuidString)
        if case .ready(let command) = built { await send(command) }
        else if case .refusal(let why) = built { fault = why.message }
    }

    private func sendDiscard() async {
        guard let command = discard else { return }
        discard = nil
        await send(command)
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

    private func makeClient() -> RelayClient? {
        guard let url = normalizeRelayURL(model.urlText), normalizeToken(model.token) != nil else { return nil }
        return RelayClient(baseURL: url, token: model.token, deviceID: model.deviceID, source: .iphone)
    }
}

private func waitLabel(_ state: String) -> String {
    switch state {
    case "queued": return "Wartet"
    case "next": return "Als Nächstes"
    case "signin": return "Anmeldung"
    case "limit": return "Limit"
    case "paused": return "Pausiert"
    case "stalled": return "Hängt"
    case "shipping": return "Liefert"
    default: return state
    }
}

private func who(_ source: String) -> String {
    switch source {
    case "founder": return "Du"
    case "agent": return "Agent"
    default: return "System"
    }
}

private func lineText(_ line: HistoryLine) -> String? {
    for value in [line.patch.answer, line.patch.result, line.patch.note, line.patch.body, line.patch.status] {
        if let value, !value.isEmpty { return value }
    }
    return nil
}
