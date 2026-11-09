import AppIntents
import AgentboxKit
import SwiftUI
import WidgetKit

struct CountIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Braucht dich"
    static var description = IntentDescription("Offene Entscheidungen")

    @Parameter(title: "Token")
    var token: String?
}

struct CountEntry: TimelineEntry {
    let date: Date
    let count: Int?
}

struct CountProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> CountEntry {
        CountEntry(date: .now, count: 1)
    }

    func snapshot(for configuration: CountIntent, in context: Context) async -> CountEntry {
        if context.isPreview { return CountEntry(date: .now, count: 1) }
        return CountEntry(date: .now, count: await load(configuration))
    }

    func timeline(for configuration: CountIntent, in context: Context) async -> Timeline<CountEntry> {
        let entry = CountEntry(date: .now, count: await load(configuration))
        return Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60)))
    }

    private func load(_ configuration: CountIntent) async -> Int? {
        let shared = AppGroupRelay.read()
        let token = shared?.token ?? normalizeToken(configuration.token ?? "")
        guard let token else { return nil }
        let url = normalizeRelayURL(shared?.url ?? RelayDefaults.url.absoluteString) ?? RelayDefaults.url
        let device = shared?.deviceID ?? storedDevice()
        let client = RelayClient(baseURL: url, token: token, deviceID: device, source: .watch)
        return try? await client.needsYou().count
    }

    private func storedDevice() -> String {
        if let stored = UserDefaults.standard.string(forKey: "deviceID"), stored.count == 12 { return stored }
        let made = DeviceID.make()
        UserDefaults.standard.set(made, forKey: "deviceID")
        return made
    }
}

struct CountWidgetView: View {
    @Environment(\.widgetFamily) private var family
    var entry: CountEntry

    var body: some View {
        let text = entry.count.map(String.init) ?? "–"
        switch family {
        case .accessoryInline:
            Text(entry.count.map { "\($0) offen" } ?? "–")
        case .accessoryCircular, .accessoryCorner:
            Text(text).font(.headline).widgetAccentable()
        default:
            VStack(alignment: .leading) {
                Text("Braucht dich").font(.headline)
                Text(text).font(.title2).widgetAccentable()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct NeedsYouWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: WidgetKind.needsYou, intent: CountIntent.self, provider: CountProvider()) { entry in
            CountWidgetView(entry: entry)
                .containerBackground(for: .widget) { AccessoryWidgetBackground() }
        }
        .configurationDisplayName("Braucht dich")
        .description("Offene Entscheidungen")
        .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryInline, .accessoryRectangular])
    }
}

@main
struct AgentboxWidgets: WidgetBundle {
    var body: some Widget { NeedsYouWidget() }
}
