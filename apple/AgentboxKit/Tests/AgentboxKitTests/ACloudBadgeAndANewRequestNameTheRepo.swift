// A cloud row needs a badge the phone can draw without asking again, and a new
// request has to name a repository before it can leave the phone. Measured by
// decoding the relay JSON and building the command body.
import XCTest
@testable import AgentboxKit

final class ACloudBadgeAndANewRequestNameTheRepo: XCTestCase {
    func testBadgeNamesCloudCursorAndTheLocalMachine() {
        XCTAssertEqual(executionBadge(target: "cloud", provider: "cursor"), "Cloud · Cursor")
        XCTAssertEqual(executionBadge(target: "local", provider: "MacBook"), "Lokal · MacBook")
        XCTAssertEqual(executionBadge(target: "local", provider: "mac"), "Lokal · Mac")
        XCTAssertEqual(executionBadge(target: "local", provider: nil), "Lokal · Mac")
        XCTAssertNil(executionBadge(target: nil, provider: "cursor"))
        XCTAssertEqual(executionBadge(target: "cloud", provider: nil), "Cloud")
        XCTAssertEqual(executionBadge(target: "cloud", provider: "openai-agents"), "Cloud · Codex")
    }

    func testNeedsYouAndTheThreadCarryTarget() throws {
        let list = try JSONDecoder().decode(NeedsYouList.self, from: Data("""
        {"items":[{
          "project":"agentbox","projectName":"agentbox","id":"c-abc1234567",
          "title":"Health","status":"needs-you","kind":"review","updatedAt":1,
          "context":"","question":"Fertig.","options":[],
          "target":"cloud","provider":"cursor"
        }]}
        """.utf8))
        XCTAssertEqual(list.items[0].target, "cloud")
        XCTAssertEqual(list.items[0].provider, "cursor")
        XCTAssertEqual(executionBadge(target: list.items[0].target, provider: list.items[0].provider), "Cloud · Cursor")

        let older = try JSONDecoder().decode(NeedsYouList.self, from: Data("""
        {"items":[{
          "project":"p","projectName":"P","id":"w-1","title":"T","status":"blocked",
          "updatedAt":0,"context":"","question":"Q","options":[]
        }]}
        """.utf8))
        XCTAssertNil(older.items[0].target)
        XCTAssertNil(executionBadge(target: older.items[0].target, provider: older.items[0].provider))

        let snap = try JSONDecoder().decode(ThreadEnvelope.self, from: Data("""
        {"snapshot":{"v":3,"item":{"id":"c-abc1234567","title":"Health"},"history":[],"olderLines":0,"target":"cloud","provider":"cursor"}}
        """.utf8))
        XCTAssertEqual(snap.snapshot.target, "cloud")
        XCTAssertEqual(snap.snapshot.provider, "cursor")
    }

    func testTargetsDecodeAndALocalMacThatIsOffIsUnavailable() throws {
        let decoded = try JSONDecoder().decode(ClientTargets.self, from: Data("""
        {"macOnline":false,"computerName":"MacBook","defaultTarget":"cloud",
         "harnesses":[{"id":"claude","label":"Claude Code","available":false}],
         "targets":[
           {"target":"cloud","provider":"cursor","label":"Cloud · Cursor","available":true},
           {"target":"local","provider":"mac","label":"Lokal · MacBook","available":false}
         ]}
        """.utf8))
        XCTAssertFalse(decoded.macOnline)
        XCTAssertEqual(decoded.defaultTarget, "cloud")
        XCTAssertEqual(decoded.harnesses.first?.available, false)
        XCTAssertEqual(decoded.targets.map(\.available), [true, false])
        XCTAssertThrowsError(try JSONDecoder().decode(ClientTargets.self, from: Data(#"{"macOnline":true,"targets":[]}"#.utf8)))
    }

    func testANewCloudRequestNamesTheRepoAndALocalOneNamesTheProject() throws {
        let cloud = try ready(CommandDraft.newRequest(
            prompt: " Add a health check ",
            repo: "https://github.com/acme/Agentbox.git",
            target: "cloud",
            provider: "cursor",
            project: nil,
            source: .iphone,
            id: "cmd-1"
        ))
        let json = try jsonObject(commandBody(cloud))
        XCTAssertEqual(json["kind"] as? String, "new")
        XCTAssertEqual(json["project"] as? String, "agentbox")
        let payload = try XCTUnwrap(json["payload"] as? [String: Any])
        XCTAssertEqual(payload["target"] as? String, "cloud")
        XCTAssertEqual(payload["provider"] as? String, "cursor")
        XCTAssertEqual(payload["repo"] as? String, "https://github.com/acme/Agentbox.git")
        XCTAssertEqual(payload["body"] as? String, "Add a health check")

        let local = try ready(CommandDraft.newRequest(
            prompt: "Fix the tray", repo: "", target: "local", provider: "cursor", project: "alpha", source: .watch, id: "cmd-2"
        ))
        let localPayload = try XCTUnwrap(try jsonObject(commandBody(local))["payload"] as? [String: Any])
        XCTAssertEqual(localPayload["target"] as? String, "local")
        XCTAssertNil(localPayload["repo"])

        XCTAssertEqual(CommandDraft.newRequest(prompt: "  ", repo: "https://github.com/acme/agentbox", target: "cloud", provider: "cursor", project: nil, source: .iphone, id: "i"), .refusal(.missingWords))
        XCTAssertEqual(CommandDraft.newRequest(prompt: "Go", repo: "not a url", target: "cloud", provider: "cursor", project: nil, source: .iphone, id: "i"), .refusal(.missingRepo))
        XCTAssertEqual(CommandDraft.newRequest(prompt: "Go", repo: "http://github.com/acme/agentbox", target: "cloud", provider: "cursor", project: nil, source: .iphone, id: "i"), .refusal(.missingRepo))
        XCTAssertEqual(CommandDraft.newRequest(prompt: "Go", repo: "https://user:token@github.com/acme/agentbox", target: "cloud", provider: "cursor", project: nil, source: .iphone, id: "i"), .refusal(.missingRepo))
        XCTAssertEqual(CommandDraft.newRequest(prompt: "Go", repo: "https://github.com/acme/agentbox", target: "local", provider: "cursor", project: " ", source: .iphone, id: "i"), .refusal(.missingProject))
        XCTAssertEqual(projectSlug(fromRepo: "https://github.com/acme/my_app"), "my-app")
        XCTAssertNil(projectSlug(fromRepo: "https://github.com/acme/"))
    }

    func testMacOfflineIsGerman() {
        XCTAssertEqual(RelayError.rejected("mac_offline").message, "Der Mac ist aus.")
        XCTAssertEqual(RelayError.rejected("cursor_unconfigured").message, "Cloud ist nicht eingerichtet.")
    }

    private func ready(_ built: BuiltCommand) throws -> OutboundCommand {
        guard case .ready(let command) = built else {
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
