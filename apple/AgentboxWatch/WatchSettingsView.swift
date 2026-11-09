import SwiftUI

struct WatchSettingsView: View {
    @Environment(WatchModel.self) private var model
    @State private var url = ""
    @State private var token = ""
    @State private var note: String?
    @State private var loaded = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                TextField("Adresse", text: $url)
                SecureField("Token", text: $token)
                Button("Sichern") { commit() }
                if let note { Text(note).font(.caption2) }
            }
        }
        .navigationTitle("Einstellungen")
        .onAppear {
            guard !loaded else { return }
            loaded = true
            url = model.urlText
            token = model.token
        }
    }

    private func commit() {
        if let fault = model.save(url: url, token: token) {
            note = fault
        } else {
            url = model.urlText
            token = model.token
            note = "Gespeichert"
            Task { await model.refresh() }
        }
    }
}
