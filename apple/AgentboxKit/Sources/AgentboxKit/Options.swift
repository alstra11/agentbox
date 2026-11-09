import Foundation

private let askBudget = 130

private let closesPattern = #"^close (?:this|the) (?:task|thread)(?:$|\s*[,:;\p{Pd}](?!\s*(?:then|and|also)\b)|\s+(?:since|because|as|now that)\b)"#
private let keepsPattern = #"^(?:keep|leave) (?:it|this|them|that)(?: as (?:is|sent|it is))?\s*,?\s+and close (?:this|the) (?:task|thread)$"#
private let rightFirstPattern = #"^(?:(?:that|it|this|all)\s+)?(?:looks\s+|is\s+)?(?:right|good|fine|great|perfect|correct)\s*[,.;:!]?\s+(?:and\s+|so\s+)?(?=close\b)"#
private let saysNothingPattern = #"^(?:change|revise|edit|adjust|tweak|amend|rework|redo|fix)\s+(?:something|anything|it|this|that|some of it|a few things|this (?:part|bit)|parts?|bits?)(?:\s+first)?$"#
private let namesNobodyPattern = #"^commit it and ship, as the name and email below$"#
private let somethingElsePattern = #"^(?:something|anything) else$"#
private let discardsPattern = #"^(?:discard|bin|delete|drop|throw away|throw out)\s+(?:it|them|this|that|the (?:change|changes|work|edits|diff|lot))(?:\s+away)?$|^(?:discard|throw (?:it|them|the (?:change|changes|lot)) (?:all )?away)$"#

private func matches(_ pattern: String, _ text: String) -> Bool {
    guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return false }
    let range = NSRange(text.startIndex..., in: text)
    return re.firstMatch(in: text, options: [], range: range) != nil
}

private func replace(_ pattern: String, in text: String, with template: String) -> String {
    guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return text }
    let range = NSRange(text.startIndex..., in: text)
    return re.stringByReplacingMatches(in: text, options: [], range: range, withTemplate: template)
}

func bareOption(_ option: String) -> String {
    var s = replace(#"\s*\(recommended\)\s*"#, in: option, with: "")
    s = s.trimmingCharacters(in: .whitespacesAndNewlines)
    while let last = s.last, last == "." || last == "!" {
        s.removeLast()
    }
    return s
}

func closesTheTask(_ option: String) -> Bool {
    let words = replace(rightFirstPattern, in: bareOption(option), with: "")
    return matches(closesPattern, words) || matches(keepsPattern, words)
}

func needsYourWords(_ option: String) -> Bool {
    let words = bareOption(option)
    return matches(saysNothingPattern, words) || matches(namesNobodyPattern, words) || matches(somethingElsePattern, words)
}

func discardsTheChange(_ option: String) -> Bool {
    matches(discardsPattern, bareOption(option))
}

private let headingStart = try! NSRegularExpression(pattern: #"^#{1,4}\s"#)
private let optionLine = try! NSRegularExpression(pattern: #"^\s*(\d+)[.)]\s+(.*)$"#)

private func parseOptions(_ body: String?) -> [ReplyOption] {
    guard let body else { return [] }
    var inOptions = false
    var out: [ReplyOption] = []
    for raw in body.split(separator: "\n", omittingEmptySubsequences: false) {
        let line = String(raw)
        let range = NSRange(line.startIndex..., in: line)
        if headingStart.firstMatch(in: line, range: range) != nil {
            inOptions = line.range(of: "option", options: .caseInsensitive) != nil
            continue
        }
        guard inOptions, let match = optionLine.firstMatch(in: line, range: range),
              let nRange = Range(match.range(at: 1), in: line),
              let textRange = Range(match.range(at: 2), in: line),
              let n = Int(line[nRange]) else { continue }
        let rawText = String(line[textRange]).trimmingCharacters(in: .whitespaces)
        let recommended = rawText.range(of: "(recommended)", options: .caseInsensitive) != nil
        let text = replace(#"\s*\(recommended\)\s*"#, in: rawText, with: "").trimmingCharacters(in: .whitespaces)
        out.append(ReplyOption(n: n, text: text, recommended: recommended))
    }
    return out
}

public func parsedOptions(result: String?, note: String?, body: String?, wrote: [String: FieldWrite]?) -> [ReplyOption] {
    let inResult = !parseOptions(result).isEmpty
    let inNote = !parseOptions(note).isEmpty
    let text: String?
    if inResult && inNote {
        let noteTs = wrote?["note"]?.ts ?? 0
        let resultTs = wrote?["result"]?.ts ?? 0
        text = noteTs > resultTs ? note : result
    } else if inResult {
        text = result
    } else if inNote {
        text = note
    } else {
        text = body
    }
    return parseOptions(text)
}

private func isFurniture(_ line: String) -> Bool {
    matches(#"^\s*\d+[.)]\s"#, line)
        || matches(#"^\s*[-*+]\s"#, line)
        || matches(#"^!\[[^\]]*\]\([^)]*\)$"#, line)
        || line.hasPrefix(">")
        || matches(#"^([-*_]\s*){3,}$"#, line)
}

private func words(_ line: String) -> String {
    var s = replace(#"!\[[^\]]*\]\([^)]*\)"#, in: line, with: "")
    s = replace(#"\[([^\]]*)\]\([^)]*\)"#, in: s, with: "$1")
    s = replace(#"[*_`#]"#, in: s, with: "")
    s = replace(#"\s+"#, in: s, with: " ")
    return s.trimmingCharacters(in: .whitespacesAndNewlines)
}

private func isRecap(_ under: String) -> Bool {
    if under.range(of: "where we were", options: .caseInsensitive) != nil { return true }
    return under.trimmingCharacters(in: .whitespacesAndNewlines).compare("gist", options: .caseInsensitive) == .orderedSame
}

private func leadingBold(_ line: String) -> String? {
    guard let re = try? NSRegularExpression(pattern: #"^\*\*(.+?)\*\*"#) else { return nil }
    let range = NSRange(line.startIndex..., in: line)
    guard let match = re.firstMatch(in: line, range: range),
          let capture = Range(match.range(at: 1), in: line) else { return nil }
    return String(line[capture])
}

private func clipped(_ said: String) -> String {
    guard said.count > askBudget else { return said }
    return String(said.prefix(askBudget)) + "…"
}

public func relayQuestion(text: String, title: String?) -> String {
    var label = title ?? ""
    if label.hasSuffix("…") { label.removeLast() }
    label = label.trimmingCharacters(in: .whitespacesAndNewlines)
    var under = ""
    for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
        var line = String(raw).trimmingCharacters(in: .whitespaces)
        if line.isEmpty { continue }
        let range = NSRange(line.startIndex..., in: line)
        if headingStart.firstMatch(in: line, range: range) != nil {
            under = replace(#"^#{1,4}\s*"#, in: line, with: "")
            continue
        }
        if isFurniture(line) || isRecap(under) { continue }
        if !label.isEmpty, line.hasPrefix(label) {
            line = String(line.dropFirst(label.count)).trimmingCharacters(in: .whitespaces)
        }
        let said = words(leadingBold(line) ?? line)
        if said.isEmpty { continue }
        return clipped(said)
    }
    return clipped((title ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
}
