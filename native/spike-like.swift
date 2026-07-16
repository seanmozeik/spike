import AppKit
import ApplicationServices
import Foundation

private let likeAction = "Thumbs up"
private let maximumDepth = 40
private let maximumNodes = 6_000

private func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [])
    print(String(data: data, encoding: .utf8)!)
}

private func sessionLocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
    return session["CGSSessionScreenIsLocked"] as? Bool ?? false
}

private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

private func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

private func actions(_ element: AXUIElement) -> [String] {
    var value: CFArray?
    guard AXUIElementCopyActionNames(element, &value) == .success else { return [] }
    return value as? [String] ?? []
}

private func normalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func elementText(_ element: AXUIElement) -> [String] {
    [kAXValueAttribute, kAXDescriptionAttribute, kAXTitleAttribute]
        .compactMap { attribute(element, $0) as? String }
        .map(normalized)
}

private struct Candidate {
    let actionElement: AXUIElement
}

private func candidates(in root: AXUIElement, matching expected: String) -> [Candidate] {
    var result: [Candidate] = []
    var seenActions: [AXUIElement] = []
    var visited = 0

    func visit(_ element: AXUIElement, ancestors: [AXUIElement], depth: Int) {
        guard depth <= maximumDepth, visited < maximumNodes else { return }
        visited += 1
        if elementText(element).contains(expected) {
            let actionElement = ([element] + ancestors.prefix(6)).first {
                actions($0).contains(likeAction)
            }
            if let actionElement {
                if !seenActions.contains(where: { CFEqual($0, actionElement) }) {
                    seenActions.append(actionElement)
                    result.append(Candidate(actionElement: actionElement))
                }
            }
        }
        let nextAncestors = [element] + ancestors.prefix(6)
        for child in children(element) {
            visit(child, ancestors: Array(nextAncestors), depth: depth + 1)
        }
    }

    visit(root, ancestors: [], depth: 0)
    return result
}

private func messagesApplication(handle: String) -> NSRunningApplication? {
    if let url = URL(string: "imessage://\(handle)"), NSWorkspace.shared.open(url) {
        Thread.sleep(forTimeInterval: 0.4)
    }
    return NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.MobileSMS").first
}

if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--status" {
    let locked = sessionLocked()
    emit([
        "accessibilityTrusted": AXIsProcessTrusted(),
        "locked": locked,
        "messagesRunning": !NSRunningApplication.runningApplications(
            withBundleIdentifier: "com.apple.MobileSMS"
        ).isEmpty,
    ])
    exit(0)
}

guard CommandLine.arguments.count == 3 else {
    emit(["kind": "failed", "reason": "usage"])
    exit(2)
}

let handle = CommandLine.arguments[1]
let expected = normalized(CommandLine.arguments[2])

if sessionLocked() {
    emit(["kind": "skipped", "reason": "locked"])
    exit(0)
}
if !AXIsProcessTrusted() {
    emit(["kind": "skipped", "reason": "accessibility_unavailable"])
    exit(0)
}
guard let app = messagesApplication(handle: handle) else {
    emit(["kind": "skipped", "reason": "messages_unavailable"])
    exit(0)
}

let root = AXUIElementCreateApplication(app.processIdentifier)
guard let window = (attribute(root, kAXWindowsAttribute) as? [AXUIElement])?.first else {
    emit(["kind": "skipped", "reason": "messages_window_unavailable"])
    exit(0)
}

private let matches = candidates(in: window, matching: expected)
guard matches.count == 1, let target = matches.first else {
    emit(["kind": "skipped", "reason": matches.isEmpty ? "target_not_found" : "target_ambiguous"])
    exit(0)
}

let result = AXUIElementPerformAction(target.actionElement, likeAction as CFString)
if result == .success {
    emit(["kind": "liked"])
} else {
    emit(["kind": "failed", "reason": "ax_action_\(result.rawValue)"])
}
