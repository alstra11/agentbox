// The iPhone and the Watch only speak the relay's JSON. A field the worker
// stopped sending, a command body it would refuse, or a path that splits a
// project slug on a slash stays invisible until a tap does nothing. These
// decode the payloads in relay/README.md and build the requests the worker
// accepts, with the boundary on either side: an empty reply, a snooze at 0,
// a card one character too short, a heading that is not an options list.
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import AgentboxKit

final class ARelayPayloadDecodesAndACommandRequestMatchesTheWorker: XCTestCase {
    func testNeedsYouDecodesTheDocumentedItemAndIgnoresUnknownFields() throws {
        let list = try JSONDecoder().decode(NeedsYouList.self, from: Data("""
        {"items":[{
          "project":"my-app","projectName":"My App","id":"w-abc1234567",
          "title":"Ship","status":"open","kind":"question","updatedAt":1710000000000,
          "context":"body","question":"Ship it?","future":true,
          "options":[{"n":1,"text":"Ship it","recommended":true},{"n":2,"text":"Wait","recommended":false}],
          "hasApproval":false,
          "wait":{"state":"queued","until":1710000001000}
        }]}
        """.utf8))
        let item = try XCTUnwrap(list.items.first)
        XCTAssertEqual(item.project, "my-app")
        XCTAssertEqual(item.projectName, "My App")
        XCTAssertEqual(item.id, "w-abc1234567")
        XCTAssertEqual(item.kind, "question")
        XCTAssertEqual(item.updatedAt, 1_710_000_000_000)
        XCTAssertEqual(item.options.count, 2)
        XCTAssertTrue(item.options[0].recommended)
        XCTAssertFalse(item.options[1].recommended)
        XCTAssertEqual(item.hasApproval, false)
        XCTAssertEqual(item.wait?.state, "queued")
        XCTAssertNil(item.wait?.tool)
        XCTAssertEqual(item.wait?.until, 1_710_000_001_000)
    }

    func testNeedsYouOptionalsCanBeAbsentAndAnEmptyListIsEmpty() throws {
        let one = try JSONDecoder().decode(NeedsYouList.self, from: Data("""
        {"items":[{
          "project":"p","projectName":"P","id":"w-1","title":"T","status":"blocked",
          "updatedAt":0,"context":"","question":"Q","options":[]
        }]}
        """.utf8))
        XCTAssertNil(one.items[0].kind)
        XCTAssertNil(one.items[0].hasApproval)
        XCTAssertNil(one.items[0].wait)
        XCTAssertEqual(one.items[0].options, [])
        let none = try JSONDecoder().decode(NeedsYouList.self, from: Data(#"{"items":[]}"#.utf8))
        XCTAssertEqual(none.items, [])
    }

    func testNeedsYouRejectsAMissingQuestionAndAStringOptionNumber() {
        XCTAssertThrowsError(try JSONDecoder().decode(NeedsYouList.self, from: Data("""
        {"items":[{"project":"p","projectName":"P","id":"w","title":"T","status":"open","updatedAt":1,"context":"","options":[]}]}
        """.utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(NeedsYouList.self, from: Data("""
        {"items":[{"project":"p","projectName":"P","id":"w","title":"T","status":"open","updatedAt":1,"context":"","question":"Q","options":[{"n":"1","text":"A","recommended":false}]}]}
        """.utf8)))
    }

    func testStatusDecodesNullLastSeenAndOmitsVersion() throws {
        let offline = try JSONDecoder().decode(ClientStatus.self, from: Data("""
        {"macLastSeen":null,"macOnline":false,"paused":true,"stalled":["w-1"],"queue":{"runNow":[],"queued":["w-2"]}}
        """.utf8))
        XCTAssertNil(offline.macLastSeen)
        XCTAssertFalse(offline.macOnline)
        XCTAssertTrue(offline.paused)
        XCTAssertEqual(offline.stalled, ["w-1"])
        XCTAssertEqual(offline.queue.queued, ["w-2"])
        XCTAssertNil(offline.version)
        XCTAssertNil(offline.computerName)

        let online = try JSONDecoder().decode(ClientStatus.self, from: Data("""
        {"macLastSeen":1710000000000,"macOnline":true,"paused":false,"stalled":[],"queue":{"runNow":["w-3"],"queued":[]},"version":"0.1.22","computerName":"MacBook"}
        """.utf8))
        XCTAssertEqual(online.macLastSeen, 1_710_000_000_000)
        XCTAssertEqual(online.computerName, "MacBook")
        XCTAssertEqual(online.queue.runNow, ["w-3"])
    }

    func testStatusRejectsAQueueMissingRunNow() {
        XCTAssertThrowsError(try JSONDecoder().decode(ClientStatus.self, from: Data("""
        {"macLastSeen":1,"macOnline":true,"paused":false,"stalled":[],"queue":{"queued":[]}}
        """.utf8)))
    }

    func testThreadSnapshotDecodesHistoryApprovalsAndLive() throws {
        let snap = try JSONDecoder().decode(ThreadEnvelope.self, from: Data("""
        {"snapshot":{
          "v":3,
          "item":{"id":"w-abc","title":"Ship","body":"b","status":"open","result":"# Options\\n1. Ship it (recommended)","wrote":{"result":{"ts":5,"source":"agent"}}},
          "history":[{"id":"w-abc","ts":4,"source":"founder","patch":{"answer":"ok","status":"open"}}],
          "olderLines":2,
          "live":{"since":1,"where":"mac","doing":[{"label":"editing","startedAt":2}],"at":3,"movable":true},
          "approvals":[{"id":"card-1","at":9,"tool":"Bash","input":{"cmd":"ls"},"card":null,"answerOnComputer":true}],
          "wait":{"state":"paused"},
          "attached":{"dir":"~/x"}
        }}
        """.utf8))
        XCTAssertEqual(snap.snapshot.v, 3)
        XCTAssertEqual(snap.snapshot.olderLines, 2)
        XCTAssertEqual(snap.snapshot.item.title, "Ship")
        XCTAssertEqual(snap.snapshot.history[0].patch.answer, "ok")
        XCTAssertEqual(snap.snapshot.live?.whereRun, "mac")
        XCTAssertEqual(snap.snapshot.live?.movable, true)
        XCTAssertEqual(snap.snapshot.live?.doing.first?.label, "editing")
        XCTAssertNil(snap.snapshot.approvals?.first?.card)
        XCTAssertEqual(snap.snapshot.approvals?.first?.answerOnComputer, true)
        XCTAssertEqual(snap.snapshot.wait?.state, "paused")
        XCTAssertFalse(snap.snapshot.approvals?.first?.canAnswer ?? true)
    }

    func testThreadSnapshotDefaultsMissingHistoryAndKeepsASignableCard() throws {
        let snap = try JSONDecoder().decode(ThreadSnapshot.self, from: Data("""
        {"v":3,"item":{"id":"w-1","title":"T"},"approvals":[{"id":"abcd","at":1,"tool":"Bash","card":"abcd+/=-","answerOnComputer":false}]}
        """.utf8))
        XCTAssertEqual(snap.history, [])
        XCTAssertEqual(snap.olderLines, 0)
        XCTAssertEqual(snap.approvals?.first?.canAnswer, true)
        let weird = try JSONDecoder().decode(ThreadSnapshot.self, from: Data("""
        {"v":3,"item":{"id":"w-1"},"approvals":[{"id":"abcd","at":1,"tool":"Bash","card":{"digest":"nope"}}]}
        """.utf8))
        XCTAssertNil(weird.approvals?.first?.card)
        XCTAssertEqual(weird.approvals?.first?.canAnswer, false)
    }

    func testProjectsDecode() throws {
        let list = try JSONDecoder().decode(ProjectList.self, from: Data("""
        {"projects":[{"slug":"my-app","name":"My App","cloud":true,"updatedAt":10}]}
        """.utf8))
        XCTAssertEqual(list.projects[0].slug, "my-app")
        XCTAssertEqual(list.projects[0].cloud, true)
    }

    func testRequestsUseBearerDeviceAndEncodedPaths() throws {
        let base = try XCTUnwrap(normalizeRelayURL("https://agents.alstra11.workers.dev/"))
        let needs = try makeRelayRequest(base: base, token: "iphone-secret", deviceID: "aabbccddeeff", endpoint: .needsYou)
        XCTAssertEqual(needs.url?.absoluteString, "https://agents.alstra11.workers.dev/client/needs-you")
        XCTAssertEqual(needs.httpMethod, "GET")
        XCTAssertEqual(needs.value(forHTTPHeaderField: "Authorization"), "Bearer iphone-secret")
        XCTAssertEqual(needs.value(forHTTPHeaderField: "X-Agentbox-Device"), "aabbccddeeff")
        XCTAssertNil(needs.httpBody)
        XCTAssertEqual(needs.timeoutInterval, 15)

        let slashed = try makeRelayRequest(base: base, token: "t", deviceID: "d", endpoint: .thread(project: "a/b", item: "w x"))
        XCTAssertEqual(slashed.url?.path, "/client/threads/a%2Fb/w%20x")

        let health = try makeRelayRequest(base: base, token: "secret", deviceID: "d", endpoint: .health)
        XCTAssertEqual(health.url?.path, "/health")
        XCTAssertNil(health.value(forHTTPHeaderField: "Authorization"))
        XCTAssertFalse(health.url?.absoluteString.contains("secret") ?? true)
    }

    func testURLAndTokenBoundaries() {
        XCTAssertEqual(normalizeRelayURL("  https://agents.alstra11.workers.dev/client/needs-you?x=1  ")?.absoluteString, "https://agents.alstra11.workers.dev")
        XCTAssertEqual(normalizeRelayURL("https://example.com:8443/a")?.absoluteString, "https://example.com:8443")
        XCTAssertNil(normalizeRelayURL("http://agents.alstra11.workers.dev"))
        XCTAssertNil(normalizeRelayURL("ftp://agents.alstra11.workers.dev"))
        XCTAssertNil(normalizeRelayURL(""))
        XCTAssertNil(normalizeRelayURL("https://"))
        XCTAssertNil(normalizeRelayURL("https://tok@agents.alstra11.workers.dev"))
        XCTAssertEqual(RelayDefaults.url.absoluteString, "https://agents.alstra11.workers.dev")

        XCTAssertEqual(normalizeToken("  abc  "), "abc")
        XCTAssertEqual(normalizeToken("Bearer abc"), "abc")
        XCTAssertEqual(normalizeToken("bearer  abc"), "abc")
        XCTAssertEqual(normalizeToken("Bearerabc"), "Bearerabc")
        XCTAssertNil(normalizeToken("Bearer"))
        XCTAssertNil(normalizeToken("   "))
    }

    func testCommandBodyCarriesSourceAndThePayloadShapes() throws {
        let reply = try built(CommandDraft.reply(project: "my-app", item: "w-abc1234567", text: " Ship it ", source: .iphone, id: "cmd-1"))
        let replyJSON = try jsonObject(commandBody(reply))
        XCTAssertEqual(replyJSON["id"] as? String, "cmd-1")
        XCTAssertEqual(replyJSON["kind"] as? String, "reply")
        XCTAssertEqual(replyJSON["source"] as? String, "iphone")
        XCTAssertEqual(replyJSON["project"] as? String, "my-app")
        XCTAssertEqual(replyJSON["item"] as? String, "w-abc1234567")
        let payload = try XCTUnwrap(replyJSON["payload"] as? [String: Any])
        XCTAssertEqual(payload["text"] as? String, "Ship it")

        let watch = try built(CommandDraft.reply(project: "my-app", item: "w-abc1234567", text: "ok", source: .watch, id: "cmd-2"))
        XCTAssertEqual(try jsonObject(commandBody(watch))["source"] as? String, "watch")

        let snooze = try built(CommandDraft.snooze(project: "p", item: "w", until: 0, source: .iphone, id: "s"))
        let until = try XCTUnwrap((try jsonObject(commandBody(snooze))["payload"] as? [String: Any])?["until"] as? Double)
        XCTAssertEqual(until, 0)

        let approve = try built(CommandDraft.approve(project: "p", item: "w", approval: "card-1", allow: false, card: "abcd+/=-", note: nil, source: .watch, id: "a"))
        let ap = try XCTUnwrap(try jsonObject(commandBody(approve))["payload"] as? [String: Any])
        XCTAssertEqual(ap["approval"] as? String, "card-1")
        XCTAssertEqual(ap["allow"] as? Bool, false)
        XCTAssertEqual(ap["card"] as? String, "abcd+/=-")
        XCTAssertNil(ap["note"])

        let created = try built(CommandDraft.newThread(project: "p", title: "Fix", body: "", source: .iphone, id: "n"))
        let createdJSON = try jsonObject(commandBody(created))
        XCTAssertEqual(createdJSON["kind"] as? String, "new")
        XCTAssertNil(createdJSON["item"])
        XCTAssertEqual((createdJSON["payload"] as? [String: Any])?["title"] as? String, "Fix")

        let base = try XCTUnwrap(normalizeRelayURL(RelayDefaults.url.absoluteString))
        let request = try makeRelayRequest(base: base, token: " watch-secret ", deviceID: "aabbccddeeff", endpoint: .commands, body: commandBody(watch))
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/client/commands")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer watch-secret")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json; charset=utf-8")
        XCTAssertFalse(request.url?.absoluteString.contains("watch-secret") ?? true)
    }

    func testCommandRefusalsSitOnEitherSideOfTheWorkersRules() throws {
        XCTAssertEqual(CommandDraft.reply(project: "p", item: "w", text: "  ", source: .iphone, id: "i"), .refusal(.emptyReply))
        XCTAssertEqual(CommandDraft.reply(project: " ", item: "w", text: "a", source: .iphone, id: "i"), .refusal(.missingProject))
        XCTAssertEqual(CommandDraft.reply(project: "p", item: " ", text: "a", source: .iphone, id: "i"), .refusal(.missingThread))
        XCTAssertEqual(CommandDraft.snooze(project: "p", item: "w", until: -1, source: .iphone, id: "i"), .refusal(.missingTime))
        XCTAssertEqual(CommandDraft.snooze(project: "p", item: "w", until: .nan, source: .iphone, id: "i"), .refusal(.missingTime))
        XCTAssertEqual(CommandDraft.snooze(project: "p", item: "w", until: 0, source: .iphone, id: "i").ready?.kind, "snooze")
        XCTAssertEqual(CommandDraft.schedule(project: "p", item: "w", runAt: -0.1, source: .watch, id: "i"), .refusal(.missingTime))
        XCTAssertEqual(CommandDraft.plain(.stop, project: "p", item: "w", source: .iphone, id: "i").ready?.payload, [:])
        XCTAssertEqual(CommandDraft.plain(.close, project: "p", item: "", source: .iphone, id: "i"), .refusal(.missingThread))
        XCTAssertEqual(CommandDraft.newThread(project: "p", title: " ", body: " ", source: .iphone, id: "i"), .refusal(.missingWords))
        XCTAssertEqual(CommandDraft.newThread(project: "p", title: "", body: "go", source: .iphone, id: "i").ready?.kind, "new")
        XCTAssertEqual(CommandDraft.approve(project: "p", item: "w", approval: "id", allow: true, card: "1234567", note: nil, source: .iphone, id: "i"), .refusal(.badCard))
        XCTAssertEqual(CommandDraft.approve(project: "p", item: "w", approval: "id", allow: true, card: String(repeating: "a", count: 8), note: nil, source: .iphone, id: "i").ready?.kind, "approve")
        XCTAssertEqual(CommandDraft.approve(project: "p", item: "w", approval: "id", allow: true, card: String(repeating: "a", count: 201), note: nil, source: .iphone, id: "i"), .refusal(.badCard))
        XCTAssertEqual(CommandDraft.approve(project: "p", item: "w", approval: "id", allow: true, card: "abcd efgh", note: nil, source: .iphone, id: "i"), .refusal(.badCard))
        XCTAssertEqual(CommandDraft.approve(project: "p", item: "w", approval: "id", allow: true, card: "abcdefghü", note: nil, source: .iphone, id: "i"), .refusal(.badCard))
        XCTAssertEqual(CommandDraft.approve(project: "p", item: "w", approval: "bad id", allow: true, card: "abcdefgh", note: nil, source: .iphone, id: "i"), .refusal(.badCard))
        let longNote = String(repeating: "n", count: 501)
        XCTAssertEqual(CommandDraft.approve(project: "p", item: "w", approval: "id", allow: true, card: "abcdefgh", note: longNote, source: .iphone, id: "i"), .refusal(.noteTooLong))
        XCTAssertEqual(CommandDraft.approve(project: "p", item: "w", approval: "id", allow: true, card: "abcdefgh", note: String(repeating: "n", count: 500), source: .iphone, id: "i").ready?.kind, "approve")
    }

    func testAnOptionPickMatchesTheDesktopAndACloseIsNotAReply() {
        XCTAssertEqual(CommandDraft.option(project: "p", item: "w", n: 1, text: "Ship it", source: .iphone, id: "i").ready?.payload["text"], .string("Option 1: Ship it"))
        XCTAssertEqual(CommandDraft.option(project: "p", item: "w", n: 2, text: "Close this task", source: .watch, id: "i").ready?.kind, "close")
        XCTAssertEqual(CommandDraft.option(project: "p", item: "w", n: 2, text: "Close this task (recommended)", source: .iphone, id: "i").ready?.kind, "close")
        XCTAssertEqual(CommandDraft.option(project: "p", item: "w", n: 2, text: "Close the thread, since it shipped", source: .iphone, id: "i").ready?.kind, "close")
        XCTAssertEqual(CommandDraft.option(project: "p", item: "w", n: 1, text: "Ship it, then close the task", source: .iphone, id: "i").ready?.kind, "reply")
        XCTAssertEqual(CommandDraft.option(project: "p", item: "w", n: 1, text: "Close this task, then file the follow-up", source: .iphone, id: "i").ready?.kind, "reply")
        XCTAssertEqual(CommandDraft.option(project: "p", item: "w", n: 3, text: "Keep it and close this task", source: .iphone, id: "i").ready?.kind, "close")
        XCTAssertEqual(CommandDraft.option(project: "p", item: "w", n: 3, text: "Looks right, close this task", source: .iphone, id: "i").ready?.kind, "close")
        XCTAssertEqual(CommandDraft.option(project: "p", item: "w", n: 2, text: "Change something first", source: .iphone, id: "i"), .needsWords("Change something first"))
        XCTAssertEqual(CommandDraft.option(project: "p", item: "w", n: 2, text: "Change the empty state copy first", source: .iphone, id: "i").ready?.kind, "reply")
        XCTAssertEqual(CommandDraft.option(project: "p", item: "w", n: 4, text: "Something else", source: .watch, id: "i"), .needsWords("Something else"))
        if case .confirm(let command) = CommandDraft.option(project: "p", item: "w", n: 3, text: "Discard it", source: .iphone, id: "i") {
            XCTAssertEqual(command.kind, "reply")
            XCTAssertEqual(command.payload["text"], .string("Option 3: Discard it"))
        } else {
            XCTFail("discard must ask before it sends")
        }
        XCTAssertEqual(CommandDraft.option(project: "p", item: "w", n: 1, text: "Discard the first layout and ship the second", source: .iphone, id: "i").ready?.kind, "reply")
        XCTAssertEqual(CommandDraft.option(project: "p", item: "w", n: 1, text: "Keep it on the branch", source: .iphone, id: "i").ready?.kind, "reply")
    }

    func testOptionsComeFromTheNewestFieldAndSkipAHeadingThatIsNotAList() {
        let fromResult = parsedOptions(
            result: "# Options\n1. Ship it (recommended)\n2. Wait",
            note: "# Options\n1. Older",
            body: "1. Not a list",
            wrote: ["note": FieldWrite(ts: 1, source: "agent"), "result": FieldWrite(ts: 2, source: "agent")]
        )
        XCTAssertEqual(fromResult, [
            ReplyOption(n: 1, text: "Ship it", recommended: true),
            ReplyOption(n: 2, text: "Wait", recommended: false),
        ])
        let fromNote = parsedOptions(
            result: "# Options\n1. Older",
            note: "# Options\n9) Newer",
            body: nil,
            wrote: ["note": FieldWrite(ts: 5, source: "agent"), "result": FieldWrite(ts: 4, source: "agent")]
        )
        XCTAssertEqual(fromNote, [ReplyOption(n: 9, text: "Newer", recommended: false)])
        let tie = parsedOptions(
            result: "# Options\n1. Result",
            note: "# Options\n1. Note",
            body: nil,
            wrote: ["note": FieldWrite(ts: 5, source: "agent"), "result": FieldWrite(ts: 5, source: "agent")]
        )
        XCTAssertEqual(tie.first?.text, "Result")
        let noWrote = parsedOptions(result: "# Options\n1. Result", note: "# Options\n1. Note", body: nil, wrote: nil)
        XCTAssertEqual(noWrote.first?.text, "Result")
        let bodyOnly = parsedOptions(result: "no list", note: nil, body: "# Options\n1. From body\nSummary line", wrote: nil)
        XCTAssertEqual(bodyOnly, [ReplyOption(n: 1, text: "From body", recommended: false)])
        let notAList = parsedOptions(result: "# Summary\n1. Not offered\n# Options\n1. Offered", note: nil, body: nil, wrote: nil)
        XCTAssertEqual(notAList, [ReplyOption(n: 1, text: "Offered", recommended: false)])
        let optionalHeading = parsedOptions(result: "# Optional extras\n1. Counted", note: nil, body: nil, wrote: nil)
        XCTAssertEqual(optionalHeading.first?.text, "Counted")
        XCTAssertEqual(parsedOptions(result: "1. Before\n# Plan\n2. Still before", note: nil, body: nil, wrote: nil), [])
    }

    func testTheQuestionLineSkipsFurnitureAndRecap() {
        let recap = """
        # Where we were
        we talked
        # Next
        Should we ship it?
        """
        XCTAssertEqual(relayQuestion(text: recap, title: "Ship"), "Should we ship it?")
        let gist = "# gist\nburied\n# Next\nGo on"
        XCTAssertEqual(relayQuestion(text: gist, title: nil), "Go on")
        XCTAssertEqual(relayQuestion(text: "# Gist of it\nVisible", title: nil), "Visible")
        XCTAssertEqual(relayQuestion(text: "# Options\n1. Ship it\n- bullet\n> quote\n\nDo the thing?", title: nil), "Do the thing?")
        XCTAssertEqual(relayQuestion(text: "**Ship it now**\nand more", title: nil), "Ship it now")
        XCTAssertEqual(relayQuestion(text: "Rename the button", title: "Rename"), "the button")
        XCTAssertEqual(relayQuestion(text: "[ship](http://x)", title: nil), "ship")
        XCTAssertEqual(relayQuestion(text: "![pic](http://x)", title: "Title"), "Title")
        let long = String(repeating: "a", count: 131)
        XCTAssertEqual(relayQuestion(text: long, title: nil), String(repeating: "a", count: 130) + "…")
        XCTAssertEqual(relayQuestion(text: String(repeating: "b", count: 130), title: nil), String(repeating: "b", count: 130))
        XCTAssertEqual(relayQuestion(text: "", title: String(repeating: "c", count: 131)), String(repeating: "c", count: 130) + "…")
        XCTAssertEqual(relayQuestion(text: "", title: ""), "")
    }

    func testDeepLinksAndTheWatchHandoff() {
        let link = threadLink(URL(string: "agentbox://thread/w-abc1234567?project=my-app")!)
        XCTAssertEqual(link, ThreadLink(project: "my-app", id: "w-abc1234567"))
        XCTAssertEqual(threadLink(URL(string: "AGENTBOX://Thread/w-abc1234567?project=my%20app")!), ThreadLink(project: "my app", id: "w-abc1234567"))
        XCTAssertNil(threadLink(URL(string: "https://agents.alstra11.workers.dev/thread/w?project=p")!))
        XCTAssertNil(threadLink(URL(string: "agentbox://thread/w-abc")!))
        XCTAssertNil(threadLink(URL(string: "agentbox://thread/?project=p")!))
        XCTAssertNil(threadLink(URL(string: "agentbox://thread/a/b?project=p")!))
        XCTAssertNil(threadLink(URL(string: "agentbox://inbox/w?project=p")!))
        XCTAssertNil(threadLink(URL(string: "agentbox://thread/w?project=")!))
        XCTAssertNil(threadLink(URL(string: "agentbox://thread/w?project=%20")!))

        let handoff = WatchHandoff(relayURL: "https://agents.alstra11.workers.dev/", watchToken: "  watch-secret  ")
        XCTAssertEqual(handoff?.context()["relayURL"], "https://agents.alstra11.workers.dev")
        XCTAssertEqual(handoff?.context()["watchToken"], "watch-secret")
        XCTAssertNil(handoff?.context()["iphoneToken"])
        XCTAssertNil(WatchHandoff(relayURL: "https://agents.alstra11.workers.dev", watchToken: "  "))
        XCTAssertNil(WatchHandoff(context: ["relayURL": "https://agents.alstra11.workers.dev"]))
        let back = WatchHandoff(context: ["relayURL": "https://agents.alstra11.workers.dev", "watchToken": "t", "iphoneToken": "nope"])
        XCTAssertEqual(back?.watchToken, "t")
        XCTAssertNotEqual(back?.watchToken, "nope")
    }

    func testDeviceIDIsTwelveHexAndTimesAreMilliseconds() {
        let id = DeviceID.make(from: UUID(uuidString: "AABBCCDD-EEFF-0011-2233-445566778899")!)
        XCTAssertEqual(id, "aabbccddeeff")
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let afternoon = calendar.date(from: DateComponents(year: 2026, month: 11, day: 9, hour: 15, minute: 0))!
        let morning = calendar.date(from: DateComponents(year: 2026, month: 11, day: 10, hour: 8, minute: 0))!
        XCTAssertEqual(When.tomorrowAtEight(after: afternoon, calendar: calendar), morning)
        let eight = calendar.date(from: DateComponents(year: 2026, month: 11, day: 9, hour: 8, minute: 0))!
        XCTAssertEqual(When.tomorrowAtEight(after: eight, calendar: calendar), morning)
        let before = calendar.date(from: DateComponents(year: 2026, month: 11, day: 9, hour: 7, minute: 59))!
        XCTAssertEqual(When.tomorrowAtEight(after: before, calendar: calendar), morning)
        XCTAssertEqual(When.millis(Date(timeIntervalSince1970: 1_710)), 1_710_000)

        let now = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(germanAgo(ms: now.timeIntervalSince1970 * 1000, now: now), "gerade eben")
        XCTAssertEqual(germanAgo(ms: (now.timeIntervalSince1970 - 44) * 1000, now: now), "gerade eben")
        XCTAssertEqual(germanAgo(ms: (now.timeIntervalSince1970 - 60) * 1000, now: now), "vor 1 Minute")
        XCTAssertEqual(germanAgo(ms: (now.timeIntervalSince1970 - 119) * 1000, now: now), "vor 1 Minute")
        XCTAssertEqual(germanAgo(ms: (now.timeIntervalSince1970 - 120) * 1000, now: now), "vor 2 Minuten")
        XCTAssertEqual(germanAgo(ms: (now.timeIntervalSince1970 - 119 * 60) * 1000, now: now), "vor 1 Stunde")
        XCTAssertEqual(germanAgo(ms: (now.timeIntervalSince1970 - 120 * 60) * 1000, now: now), "vor 2 Stunden")
        XCTAssertEqual(germanAgo(ms: (now.timeIntervalSince1970 - 23 * 3600) * 1000, now: now), "vor 23 Stunden")
        XCTAssertEqual(germanAgo(ms: (now.timeIntervalSince1970 - 24 * 3600) * 1000, now: now), "vor 1 Tag")
        XCTAssertEqual(germanAgo(ms: (now.timeIntervalSince1970 - 48 * 3600) * 1000, now: now), "vor 2 Tagen")
        XCTAssertEqual(germanAgo(ms: (now.timeIntervalSince1970 + 10) * 1000, now: now), "gerade eben")
    }

    func testTheClientDecodesAnswersAndDoesNotSendAnEmptyToken() async throws {
        let fake = FakeTransport()
        fake.next = .success(RelayHTTPResult(status: 200, body: Data(#"{"items":[]}"#.utf8)))
        let base = try XCTUnwrap(normalizeRelayURL(RelayDefaults.url.absoluteString))
        let client = RelayClient(baseURL: base, token: "iphone-secret", deviceID: "aabbccddeeff", source: .iphone, transport: fake)
        let items = try await client.needsYou()
        XCTAssertEqual(items, [])
        XCTAssertEqual(fake.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer iphone-secret")

        fake.next = .success(RelayHTTPResult(status: 401, body: Data(#"{"error":"unauthorized"}"#.utf8)))
        do {
            _ = try await client.status()
            XCTFail("401")
        } catch let error as RelayError {
            XCTAssertEqual(error, .unauthorized)
        }

        fake.next = .success(RelayHTTPResult(status: 400, body: Data(#"{"error":"an empty reply"}"#.utf8)))
        let command = try built(CommandDraft.reply(project: "p", item: "w", text: "ok", source: .iphone, id: "i"))
        do {
            _ = try await client.send(command)
            XCTFail("400")
        } catch let error as RelayError {
            XCTAssertEqual(error, .rejected("an empty reply"))
            XCTAssertEqual(error.message, "Leere Antwort")
        }

        fake.next = .success(RelayHTTPResult(status: 404, body: Data(#"{"error":"not found"}"#.utf8)))
        do {
            _ = try await client.thread(project: "p", item: "missing")
            XCTFail("404")
        } catch let error as RelayError {
            XCTAssertEqual(error, .notFound)
        }

        fake.next = .success(RelayHTTPResult(status: 500, body: Data()))
        do {
            _ = try await client.projects()
            XCTFail("500")
        } catch let error as RelayError {
            XCTAssertEqual(error, .unexpectedStatus(500))
        }

        fake.next = .failure(URLError(.timedOut))
        do {
            _ = try await client.needsYou()
            XCTFail("timeout")
        } catch let error as RelayError {
            XCTAssertEqual(error, .timedOut)
        }

        fake.next = .success(RelayHTTPResult(status: 200, body: Data(#"{"ok":true,"id":"cmd-9"}"#.utf8)))
        let id = try await client.send(command)
        XCTAssertEqual(id, "cmd-9")

        let empty = RelayClient(baseURL: base, token: "  ", deviceID: "d", source: .watch, transport: fake)
        let before = fake.requests.count
        do {
            _ = try await empty.needsYou()
            XCTFail("empty token")
        } catch let error as RelayError {
            XCTAssertEqual(error, .emptyToken)
        }
        XCTAssertEqual(fake.requests.count, before)
        XCTAssertFalse(RelayError.transport("Bearer secret-token").message.contains("secret-token"))
        XCTAssertFalse(String(describing: RelayError.transport("Bearer secret-token")).contains("secret-token"))
    }

    private func built(_ command: BuiltCommand) throws -> OutboundCommand {
        guard let command = command.ready else {
            XCTFail("expected a command")
            throw RelayError.decode
        }
        return command
    }

    private func jsonObject(_ data: Data) throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: data)
        return try XCTUnwrap(object as? [String: Any])
    }
}

private final class FakeTransport: RelayTransport, @unchecked Sendable {
    var next: Result<RelayHTTPResult, Error> = .success(RelayHTTPResult(status: 200, body: Data()))
    var requests: [URLRequest] = []

    func send(_ request: URLRequest) async throws -> RelayHTTPResult {
        requests.append(request)
        return try next.get()
    }
}
