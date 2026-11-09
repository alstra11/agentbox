# Agentbox auf iPhone und Apple Watch

Die App spricht nur mit dem Relay aus `relay/` (`https://agents.alstra11.workers.dev`, in den Einstellungen änderbar). iPhone und Uhr haben getrennte Tokens (`IPHONE_TOKEN` und `WATCH_TOKEN` am Worker). Die App speichert sie in der Keychain. Nichts davon liegt im Repository.

Eine neue Anfrage geht an Cloud · Cursor, solange du nicht Lokal wählst. Lokal ist aus, solange der Mac seit 90 Sekunden nichts gemeldet hat, und die Zeile sagt „Der Mac ist aus.“ Jede Zeile in Braucht dich trägt ein Kennzeichen, `Cloud · Cursor` oder `Lokal · <Computername>`. Die Uhr hat dieselbe Anfrage und dasselbe Kennzeichen.

Push kommt von ntfy, nicht von APNs. Ein Tipp auf die Mitteilung öffnet `agentbox://thread/<id>?project=<slug>`.

Die Komplikation liest die Zahl offener Entscheidungen selbst. Die Uhr schreibt Adresse, Token und Geräte-ID in die App Group `group.dev.agentbox.relay`, die Komplikation liest sie von dort. Laut [Apples Liste für watchOS](https://developer.apple.com/help/account/reference/supported-capabilities-watchos/) hängen App Groups auf der Uhr nicht an einer bezahlten Mitgliedschaft. Keychain Sharing und Push bleiben draußen.

## Öffnen

1. `apple/Agentbox.xcodeproj` in Xcode öffnen.
2. Oben das Scheme **Agentbox** und dein iPhone 14 Pro wählen.

`apple/project.yml` beschreibt dasselbe Projekt. Mit [XcodeGen](https://github.com/yonaskolb/XcodeGen) im Ordner `apple`: `xcodegen generate`.

## Signieren (kostenlose Apple-ID)

1. Xcode → Settings → Accounts → Apple-ID hinzufügen. Das Team heißt Personal Team.
2. Target **Agentbox**, **AgentboxWatch** und **AgentboxWatchWidget**: Signing & Capabilities → Automatically manage signing → Personal Team.
3. Bundle-ID auf allen drei Targets auf etwas Eigenes ändern, sonst ist sie schon vergeben. Beispiel: `dev.deinname.agentbox`, `dev.deinname.agentbox.watchkitapp`, `dev.deinname.agentbox.watchkitapp.widget`.
4. Beim Watch-Target die Build-Einstellung `WKCompanionAppBundleIdentifier` auf die iPhone-Bundle-ID setzen. In `AgentboxWatchWidget/Info.plist` `WKAppBundleIdentifier` auf die Watch-Bundle-ID setzen. Dieselbe Zeichenkette an beiden Stellen.
5. Dieselbe Änderung an der App Group, an drei Stellen, dieselbe Zeichenkette: `AgentboxWatch/Watch.entitlements`, `AgentboxWatchWidget/Widget.entitlements`, `RelayDefaults.appGroupID` in `apple/AgentboxKit/Sources/AgentboxKit/Requests.swift`. Beispiel: `group.dev.deinname.agentbox`.

Wenn Xcode die App Group für das Personal Team ablehnt: die Capability auf Uhr und Komplikation entfernen und die beiden Entitlements-Dateien leeren. Die App signiert dann. Die Komplikation hat beim Hinzufügen ein Feld Token; dort dasselbe Watch-Token eintragen. Die Uhr selbst liest weiter aus der Keychain.

## Entwicklermodus

iPhone: Einstellungen → Datenschutz & Sicherheit → Entwicklermodus → ein, Neustart, bestätigen.

Apple Watch: auf der Uhr Einstellungen → Datenschutz & Sicherheit → Entwicklermodus. Fehlt der Eintrag, einmal aus Xcode installieren; die Uhr fragt danach. Uhr entsperrt lassen, iPhone und Mac im selben Netz, Uhr mit dem iPhone gekoppelt. Die SE 2 hat kein Mobilfunk; Anfragen laufen über das iPhone oder bekanntes WLAN.

## Installieren

1. Scheme Agentbox, Ziel das iPhone, Run.
2. Auf dem iPhone dem Entwickler vertrauen: Einstellungen → Allgemein → VPN & Geräteverwaltung.
3. Die Watch-App wird mit der iPhone-App installiert. Auf der Uhr Agentbox öffnen, falls sie nicht von allein erscheint.

## Tokens

Worker-Secrets, nicht die Mac-Tokens:

1. iPhone: Tab Einstellungen. Relay-Adresse (Vorbelegung `https://agents.alstra11.workers.dev`), iPhone-Token, Watch-Token, Sichern.
2. Die Uhr muss gekoppelt und die Watch-App einmal geöffnet sein. Sichern schickt Adresse und Watch-Token an die Uhr. Das iPhone-Token bleibt auf dem iPhone.
3. Steht auf dem iPhone „Uhr nicht gekoppelt“, das Watch-Token auf der Uhr unter Einstellungen eintippen (Diktat oder Scribble) und sichern.

## ntfy

1. ntfy installieren und dasselbe Topic abonnieren wie `ntfyTopic` in `zero.config.json` auf dem Mac (oder das Worker-Secret `NTFY_TOPIC`).
2. Ein Tipp öffnet den Thread in Agentbox. Dafür muss das URL-Schema `agentbox` installiert sein, das bringt das iPhone-Target mit.

## Komplikation

Zifferblatt gedrückt halten, Komplikation wählen, Agentbox. Oder Smart Stack (von der Watch-Face nach oben wischen) und die Karte hinzufügen. Die Zahl ist die Länge von `GET /client/needs-you`. Die Timeline steht auf 15 Minuten. watchOS lädt sie nach, wenn es darf. Die geöffnete Uhr-App ruft zusätzlich `reloadTimelines` auf. Die Kopie von Adresse, Watch-Token und Geräte-ID für die Komplikation liegt in der App Group.

## Sieben Tage

Ein Profil einer kostenlosen Apple-ID gilt sieben Tage. Danach öffnet die App nicht mehr. Xcode, dasselbe Projekt, Run. Dasselbe Bundle, dieselbe Apple-ID. Die Keychain bleibt, solange die App nicht vom Gerät gelöscht wird. Nach einem Löschen die Tokens neu eintragen.

iPhone-App, Uhr und Komplikation sind drei App-IDs. Eine kostenlose Apple-ID kann nur wenige davon gleichzeitig tragen.

## Tests

Auf Linux und auf dem Mac, ohne die Xcode-Targets:

```bash
cd apple/AgentboxKit
swift test
```

Die Tests prüfen das Decodieren der Relay-JSON und den Bau der Requests (Bearer, `X-Agentbox-Device`, Pfad, Kommando-Body mit `source`). Die iPhone- und Watch-Targets baut Xcode.
