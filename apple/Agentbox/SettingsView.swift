import SwiftUI

struct SettingsView: View {
    @Environment(InboxModel.self) private var model
    @State private var url = ""
    @State private var token = ""
    @State private var watch = ""
    @State private var fault: String?
    @State private var note: String?
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("Relay-Adresse", text: $url)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                SecureField("iPhone-Token", text: $token)
                SecureField("Watch-Token", text: $watch)
                Button("Sichern") { commit() }
                Button("Verbindung prüfen") { Task { note = await model.check(url) } }
                if !watch.isEmpty, !model.watchPaired {
                    Text("Uhr nicht gekoppelt")
                }
                if let fault { Text(fault).foregroundStyle(.red) }
                if let note { Text(note) }
            }
            .navigationTitle("Einstellungen")
            .onAppear {
                guard !loaded else { return }
                loaded = true
                url = model.urlText
                token = model.token
                watch = model.watchToken
            }
        }
    }

    private func commit() {
        fault = model.save(url: url, token: token, watch: watch)
        if fault == nil {
            url = model.urlText
            token = model.token
            watch = model.watchToken
            note = "Gespeichert"
            Task { await model.refresh() }
        }
    }
}
