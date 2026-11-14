import AppKit
import ApplicationServices
import CoreGraphics

// Clicks the native Codex composer microphone for one hardware key press.
// It never calls Codex's private commands. Invoke it as
//   dictation-helper --toggle --workspace <name> [--await-control]
// Without --toggle it does nothing. It requires an identified workspace window.
//
// What is read: accessibility roles, the enabled flag and geometry of buttons,
// button labels (kept only when they are one of the fixed dictation labels), and
// the vscode-webview URL and title of webview documents, which identify the
// extension that owns a webview. Neither mode reads AXValue, text areas,
// transcripts, source code, or audio. It never captures audio itself.

let codexExtension = "openai.chatgpt"

let dictationLabels: Set<String> = [
    "Dictate", "Stop dictation", "Starting dictation; click to cancel",
    "Finishing dictation", "Retry dictation", "Cancel dictation"
]

func stateForLabel(_ label: String) -> String {
    switch label {
    case "Dictate": return "idle"
    case "Stop dictation": return "recording"
    case "Starting dictation; click to cancel": return "starting"
    case "Finishing dictation": return "transcribing"
    case "Retry dictation": return "retry-available"
    default: return "unknown"
    }
}

/// While Codex transcribes, it keeps the stop control on screen but disables it.
/// A stop control that cannot be pressed is therefore finishing, not recording.
func controlState(_ label: String, enabled: Bool) -> String {
    let state = stateForLabel(label)
    return state == "recording" && !enabled ? "transcribing" : state
}

// MARK: - Decisions (pure; covered by --self-test)

struct Candidate {
    let label: String
    let state: String
    let enabled: Bool
    let pressSupported: Bool
    /// How the hosting webview was identified as Codex: "url", "name" or "none".
    let scope: String
    /// The webview is a sidebar view rather than an editor tab.
    var sidebar = false
    /// Keyboard focus is inside the hosting webview.
    var focused = false
    /// A hit test at the control's centre reaches the control.
    var exposed = false
    /// Identifies the hosting webview within one scan.
    var webview = -1

    var codexScope: Bool { scope != "none" }
    var actionable: Bool { enabled && pressSupported && codexScope }
}

struct Decision: Equatable {
    var index: Int? = nil
    var action: String? = nil
    var outcome: String
    var via = "none"
}

/// Chooses the one control a key press should act on. A recording is always
/// stopped before anything new is started, and a start that is already under
/// way is left alone so a second press cannot cancel it.
func decide(_ all: [Candidate]) -> Decision {
    let scoped = all.indices.filter { all[$0].codexScope }
    guard !scoped.isEmpty else { return Decision(outcome: "native-control-unavailable") }

    func narrow(_ pool: [Int]) -> (Int?, String) {
        if pool.count == 1 { return (pool[0], "only") }
        var remaining = pool
        let tests: [(String, (Candidate) -> Bool)] = [
            ("focus", { $0.focused }), ("exposed", { $0.exposed }), ("sidebar", { $0.sidebar }),
        ]
        for (name, test) in tests {
            let subset = remaining.filter { test(all[$0]) }
            if subset.count == 1 { return (subset[0], name) }
            if !subset.isEmpty { remaining = subset }
        }
        // Several controls of one webview act on the same composer.
        if all[remaining[0]].webview >= 0, Set(remaining.map { all[$0].webview }).count == 1 {
            return (remaining[0], "same-view")
        }
        return (nil, "ambiguous")
    }

    let recording = scoped.filter { all[$0].state == "recording" && all[$0].actionable }
    if !recording.isEmpty {
        let (pick, via) = narrow(recording)
        guard let pick else { return Decision(outcome: "ambiguous-native-controls", via: via) }
        return Decision(index: pick, action: "stop", outcome: "ready", via: via)
    }
    let states = Set(scoped.map { all[$0].state })
    if states.contains("recording") { return Decision(outcome: "native-control-disabled") }
    if states.contains("starting") { return Decision(outcome: "dictation-starting") }
    if states.contains("transcribing") { return Decision(outcome: "dictation-finishing") }
    let idle = scoped.filter { all[$0].state == "idle" && all[$0].actionable }
    if idle.isEmpty {
        return Decision(outcome: states.contains("retry-available") ? "dictation-retry-available" : "native-control-disabled")
    }
    let (pick, via) = narrow(idle)
    guard let pick else { return Decision(outcome: "ambiguous-native-controls", via: via) }
    return Decision(index: pick, action: "start", outcome: "ready", via: via)
}

func confirms(_ action: String, _ state: String?) -> Bool {
    switch action {
    case "start": return state == "recording" || state == "starting"
    case "stop": return state == "idle" || state == "transcribing" || state == "retry-available"
    default: return false
    }
}

/// The state the Codex controls show for a requested action, or nil when they
/// do not show that the action took effect.
func observe(_ all: [Candidate], _ action: String) -> String? {
    let states = all.filter { $0.codexScope }.map { $0.state }
    if action == "start" {
        return states.first(where: { $0 == "recording" }) ?? states.first(where: { $0 == "starting" })
    }
    if states.contains("recording") { return nil }
    return states.first(where: { $0 == "transcribing" }) ?? states.first(where: { confirms("stop", $0) })
}

func matchesWorkspace(_ title: String, _ workspace: String) -> Bool {
    !workspace.isEmpty && title.components(separatedBy: " — ").contains(workspace)
}

/// The extension that owns a VS Code webview document, from its vscode-webview
/// URL. Nil when the URL is not a webview host document that names its owner.
func webviewOwner(_ url: String) -> String? {
    let lower = url.lowercased()
    guard lower.hasPrefix("vscode-webview://") else { return nil }
    let parts = lower.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
    guard parts.count == 2 else { return nil }
    let query = parts[1].split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)[0]
    for pair in query.split(separator: "&") where pair.hasPrefix("extensionid=") {
        return String(pair.dropFirst("extensionid=".count)).removingPercentEncoding ?? ""
    }
    return nil
}

func isSidebarView(_ url: String) -> Bool { url.lowercased().contains("purpose=webviewview") }

// MARK: - Accessibility access

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func axElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}

func axValue(_ value: CFTypeRef?) -> AXValue? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXValue.self)
}

/// Several attributes in one round trip. Missing attributes are nil.
func values(_ element: AXUIElement, _ names: [String]) -> [CFTypeRef?] {
    var batch: CFArray?
    if AXUIElementCopyMultipleAttributeValues(element, names as CFArray, [], &batch) == .success,
       let list = batch as? [AnyObject], list.count == names.count {
        return list.map { value -> CFTypeRef? in
            if let wrapped = axValue(value), AXValueGetType(wrapped) == .axError { return nil }
            if value is NSNull { return nil }
            return value
        }
    }
    return names.map { attribute(element, $0) }
}

func elements(_ value: CFTypeRef?) -> [AXUIElement] { value as? [AXUIElement] ?? [] }

func urlString(_ value: CFTypeRef?) -> String {
    (value as? URL)?.absoluteString ?? (value as? String) ?? ""
}

func dictationLabel(_ element: AXUIElement) -> String? {
    values(element, [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute])
        .compactMap { $0 as? String }
        .first(where: dictationLabels.contains)
}

/// The dictation state a control shows right now, or nil once it is gone.
func liveState(_ element: AXUIElement) -> String? {
    let info = values(element, [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXEnabledAttribute])
    guard let label = info.prefix(3).compactMap({ $0 as? String }).first(where: dictationLabels.contains) else { return nil }
    return controlState(label, enabled: info[3] as? Bool ?? true)
}

func controlCenter(_ control: AXUIElement) -> CGPoint? {
    var point = CGPoint.zero
    var size = CGSize.zero
    guard let position = axValue(attribute(control, kAXPositionAttribute)),
          let dimensions = axValue(attribute(control, kAXSizeAttribute)),
          AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(dimensions, .cgSize, &size),
          point.x.isFinite, point.y.isFinite, size.width.isFinite, size.height.isFinite,
          size.width > 0, size.height > 0 else { return nil }
    return CGPoint(x: point.x + size.width / 2, y: point.y + size.height / 2)
}

func hitsControl(_ control: AXUIElement, at point: CGPoint, in root: AXUIElement) -> Bool {
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(root, Float(point.x), Float(point.y), &hit) == .success else { return false }
    for _ in 0..<12 {
        guard let current = hit else { break }
        if CFEqual(current, control) { return true }
        hit = axElement(attribute(current, kAXParentAttribute))
    }
    return false
}

func isExposed(_ control: AXUIElement, in application: AXUIElement) -> Bool {
    guard let point = controlCenter(control) else { return false }
    return hitsControl(control, at: point, in: application)
}

func focusChain(_ application: AXUIElement) -> [AXUIElement] {
    var chain: [AXUIElement] = []
    var current = axElement(attribute(application, kAXFocusedUIElementAttribute))
    while let element = current, chain.count < 80 {
        chain.append(element)
        current = axElement(attribute(element, kAXParentAttribute))
    }
    return chain
}

// MARK: - Scan

/// Where a node sits relative to webview documents. Inherited by its children.
struct View {
    var areas = 0
    var boundary = -1
    var scope = "none"
    var foreign = false
    var sidebar = false
}

struct Located {
    let element: AXUIElement
    var candidate: Candidate
}

struct Snapshot {
    var nodes = 0
    var limited = false
    var views = 0
    var milliseconds = 0
    var controls: [Located] = []
    var candidates: [Candidate] { controls.map { $0.candidate } }
}

let textRoles: Set<String> = ["AXStaticText", "AXTextArea", "AXTextField", "AXImage"]
// Workbench collections (file trees, terminals, problem lists) never host a webview.
let workbenchCollections: Set<String> = ["AXOutline", "AXList", "AXTable", "AXMenuBar", "AXMenu"]
let sparseRoles: Set<String> = ["AXWindow", "AXScrollArea", "AXWebArea", "AXSplitGroup", "unknown"]

func scan(_ window: AXUIElement, application: AXUIElement, until deadline: Date) -> Snapshot {
    let began = Date()
    var snapshot = Snapshot()
    let focus = focusChain(application)
    var queue: [(element: AXUIElement, parent: Int, depth: Int, view: View)] = [(window, -1, 0, View())]
    var seen: [CFHashCode: [AXUIElement]] = [:]
    var cursor = 0
    while cursor < queue.count {
        guard cursor < 20000, Date() < deadline else {
            snapshot.limited = true
            break
        }
        let index = cursor
        let (element, parent, depth, inherited) = queue[index]
        cursor += 1
        let hash = CFHash(element)
        if seen[hash, default: []].contains(where: { CFEqual($0, element) }) { continue }
        seen[hash, default: []].append(element)
        snapshot.nodes += 1
        guard depth < 80 else { snapshot.limited = true; continue }
        let base = values(element, [kAXRoleAttribute, kAXChildrenAttribute])
        let role = base[0] as? String ?? "unknown"
        var view = inherited

        // The first web area is the VS Code workbench. Webviews are documents nested
        // inside it, and only those can be Codex. The workbench title contains the
        // workspace name, so it must never count as a Codex container.
        if role == "AXWebArea" {
            view.areas += 1
            if view.areas >= 2 {
                if view.boundary < 0 { view.boundary = index }
                let info = values(element, [kAXURLAttribute, kAXTitleAttribute, kAXDescriptionAttribute])
                let url = urlString(info[0])
                if let owner = webviewOwner(url) {
                    if owner == codexExtension {
                        if view.scope == "none" { snapshot.views += 1 }
                        view.scope = "url"
                        view.sidebar = isSidebarView(url)
                    } else {
                        view.foreign = true
                    }
                } else if view.scope == "none" {
                    // No owner in the URL: fall back to the names of this document and
                    // the frames that host it, all below the workbench document.
                    var names = [info[1], info[2]].compactMap { $0 as? String }
                    var ancestor = parent
                    var steps = 0
                    while ancestor >= 0, steps < 3, queue[ancestor].view.areas >= 1 {
                        names += values(queue[ancestor].element, [kAXTitleAttribute, kAXDescriptionAttribute])
                            .compactMap { $0 as? String }
                        ancestor = queue[ancestor].parent
                        steps += 1
                    }
                    if names.contains(where: { $0.lowercased().contains("codex") }) {
                        view.scope = "name"
                        snapshot.views += 1
                    }
                }
            }
        }

        if role == "AXButton", view.areas >= 2, !view.foreign {
            let info = values(element, [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXEnabledAttribute])
            if let label = info.prefix(3).compactMap({ $0 as? String }).first(where: dictationLabels.contains) {
                var actions: CFArray?
                _ = AXUIElementCopyActionNames(element, &actions)
                var candidate = Candidate(label: label, state: controlState(label, enabled: info[3] as? Bool ?? true),
                    enabled: info[3] as? Bool ?? false,
                    pressSupported: (actions as? [String] ?? []).contains(kAXPressAction as String),
                    scope: view.scope, sidebar: view.sidebar, webview: view.boundary)
                if candidate.codexScope, view.boundary >= 0 {
                    let host = queue[view.boundary].element
                    var frames: [AXUIElement] = []
                    var ancestor = queue[view.boundary].parent
                    while ancestor >= 0, frames.count < 3 {
                        frames.append(queue[ancestor].element)
                        ancestor = queue[ancestor].parent
                    }
                    candidate.focused = focus.contains(where: { CFEqual($0, host) })
                        || (focus.first.map { focused in frames.contains(where: { CFEqual($0, focused) }) } ?? false)
                    candidate.exposed = isExposed(element, in: application)
                }
                snapshot.controls.append(Located(element: element, candidate: candidate))
            }
        }

        // Never descend into text content, another extension's webview, or lists
        // that belong to the workbench itself.
        if textRoles.contains(role) || view.foreign { continue }
        if view.areas <= 1 && workbenchCollections.contains(role) { continue }
        var children = elements(base[1])
        if children.isEmpty, sparseRoles.contains(role) || (role == "AXGroup" && (view.areas == 2 || depth <= 6)) {
            children = elements(attribute(element, "AXChildrenInNavigationOrder"))
                + elements(attribute(element, kAXContentsAttribute))
        }
        for child in children { queue.append((child, index, depth + 1, view)) }
    }
    snapshot.milliseconds = Int(Date().timeIntervalSince(began) * 1000)
    return snapshot
}

// MARK: - Window and pointer

func windowTitle(_ window: AXUIElement) -> String { attribute(window, kAXTitleAttribute) as? String ?? "" }

/// The window of the connected workspace: the focused window when it matches,
/// otherwise the only other window of that workspace.
func workspaceWindow(_ application: AXUIElement, workspace: String) -> (AXUIElement?, String) {
    let focused = axElement(attribute(application, kAXFocusedWindowAttribute))
    if let focused, matchesWorkspace(windowTitle(focused), workspace) { return (focused, "focused") }
    let matching = elements(attribute(application, kAXWindowsAttribute))
        .filter { matchesWorkspace(windowTitle($0), workspace) }
    if matching.count == 1 { return (matching[0], "other") }
    if matching.count > 1 { return (nil, "several") }
    return (nil, focused == nil ? "missing" : "mismatch")
}

func isFrontmost(_ application: AXUIElement) -> Bool {
    (attribute(application, kAXFrontmostAttribute) as? Bool) == true
}

func bringForward(_ editor: NSRunningApplication, _ application: AXUIElement, _ window: AXUIElement) {
    _ = editor.activate(options: [])
    _ = AXUIElementSetAttributeValue(application, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
}

/// One ordinary click on the verified control, exactly as a person would click
/// it, with the pointer returned to where it was. Refuses unless the control
/// itself is what a click at that point would reach in the frontmost VS Code
/// window, so a dialog, another window or another app can never be the target.
func clickControl(_ control: AXUIElement, label: String, application: AXUIElement, window: AXUIElement) -> String? {
    guard isFrontmost(application) else { return "editor-not-frontmost" }
    guard let focused = axElement(attribute(application, kAXFocusedWindowAttribute)), CFEqual(focused, window) else {
        return "window-changed"
    }
    guard dictationLabel(control) == label, (attribute(control, kAXEnabledAttribute) as? Bool) == true else {
        return "control-changed"
    }
    guard let point = controlCenter(control) else { return "no-position" }
    guard hitsControl(control, at: point, in: AXUIElementCreateSystemWide()) else { return "obscured" }
    for button in [CGMouseButton.left, .right, .center]
    where CGEventSource.buttonState(.combinedSessionState, button: button) { return "pointer-in-use" }
    let origin = CGEvent(source: nil)?.location
    let source = CGEventSource(stateID: .hidSystemState)
    let steps: [(CGEventType, UInt32)] = [(.mouseMoved, 40_000), (.leftMouseDown, 30_000), (.leftMouseUp, 30_000)]
    for (type, pause) in steps {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point,
                                  mouseButton: .left) else { return "unavailable" }
        event.flags = []
        if type != .mouseMoved { event.setIntegerValueField(.mouseEventClickState, value: 1) }
        event.post(tap: .cghidEventTap)
        usleep(pause)
    }
    // Put the pointer back and tell VS Code it left, so no hover tooltip lingers.
    if let origin {
        CGWarpMouseCursorPosition(origin)
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: origin, mouseButton: .left)?
            .post(tap: .cghidEventTap)
    }
    return nil
}

// MARK: - Report

/// What the plugin reads from the helper's one line of JSON output.
struct Report: Encodable {
    var outcome: String
    var workspaceMatched: Bool?
    var actionRequested: String?
    var nativeState: String?
    var nativeControlPressed = false
    /// Bounded machine status for the plugin log: enumerations and counts only.
    var detail = ""
}

let arguments = CommandLine.arguments
func argument(_ name: String) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return nil }
    return arguments[index + 1]
}

if arguments.contains("--self-test") {
    func control(_ label: String = "Dictate", enabled: Bool = true, press: Bool = true, scope: String = "url",
                 sidebar: Bool = false, focused: Bool = false, exposed: Bool = true, webview: Int = 1) -> Candidate {
        Candidate(label: label, state: controlState(label, enabled: enabled), enabled: enabled, pressSupported: press, scope: scope,
                  sidebar: sidebar, focused: focused, exposed: exposed, webview: webview)
    }
    func chosen(_ controls: [Candidate]) -> String {
        let decision = decide(controls)
        return [decision.outcome, decision.action ?? "-", decision.index.map(String.init) ?? "-", decision.via].joined(separator: " ")
    }
    precondition(chosen([control()]) == "ready start 0 only")
    precondition(chosen([control("Stop dictation")]) == "ready stop 0 only")
    precondition(chosen([]) == "native-control-unavailable - - none")
    precondition(chosen([control("Send")]) == "native-control-disabled - - none")
    // A control outside a Codex webview is never a target, whatever it is called.
    precondition(chosen([control(scope: "none")]) == "native-control-unavailable - - none")
    precondition(chosen([control(scope: "none"), control(scope: "name")]) == "ready start 1 only")
    precondition(chosen([control(enabled: false)]) == "native-control-disabled - - none")
    precondition(chosen([control(press: false)]) == "native-control-disabled - - none")
    precondition(chosen([control(enabled: false), control()]) == "ready start 1 only")
    precondition(chosen([control("Retry dictation")]) == "dictation-retry-available - - none")
    // A press while Codex is starting or finishing must not cancel or restart it.
    precondition(chosen([control("Starting dictation; click to cancel")]) == "dictation-starting - - none")
    precondition(chosen([control("Finishing dictation"), control(webview: 2)]) == "dictation-finishing - - none")
    // A recording anywhere is stopped before a second composer could start.
    precondition(chosen([control(webview: 1), control("Stop dictation", webview: 2)]) == "ready stop 1 only")
    precondition(chosen([control("Cancel dictation"), control("Stop dictation")]) == "ready stop 1 only")
    precondition(chosen([control("Stop dictation"), control("Stop dictation")]) == "ready stop 0 same-view")
    // Codex disables the stop control while it transcribes: that is finishing, and
    // it confirms a stop rather than looking like a recording that never ended.
    precondition(controlState("Stop dictation", enabled: true) == "recording")
    precondition(controlState("Stop dictation", enabled: false) == "transcribing")
    precondition(controlState("Dictate", enabled: false) == "idle")
    precondition(chosen([control("Cancel dictation"), control("Stop dictation", enabled: false)]) == "dictation-finishing - - none")
    precondition(observe([control("Cancel dictation"), control("Stop dictation", enabled: false)], "stop") == "transcribing")
    precondition(observe([control("Stop dictation", enabled: false)], "start") == nil)
    // Two visible composers: focus wins, then visibility, then the sidebar.
    precondition(chosen([control(sidebar: true, webview: 1), control(focused: true, webview: 2)]) == "ready start 1 focus")
    precondition(chosen([control(exposed: false, webview: 1), control(webview: 2)]) == "ready start 1 exposed")
    precondition(chosen([control(webview: 1), control(sidebar: true, webview: 2)]) == "ready start 1 sidebar")
    precondition(chosen([control(webview: 1), control(webview: 2)]) == "ambiguous-native-controls - - ambiguous")
    precondition(chosen([control(exposed: false, webview: 1), control(sidebar: true, exposed: false, webview: 2)])
        == "ready start 1 sidebar")

    precondition(confirms("start", "recording") && confirms("start", "starting"))
    precondition(!confirms("start", "idle") && !confirms("start", nil))
    precondition(confirms("stop", "transcribing") && confirms("stop", "idle") && !confirms("stop", "recording"))
    precondition(observe([control("Starting dictation; click to cancel")], "start") == "starting")
    precondition(observe([control(), control("Stop dictation", webview: 2)], "start") == "recording")
    precondition(observe([control()], "start") == nil)
    precondition(observe([control("Stop dictation", scope: "none")], "start") == nil)
    precondition(observe([control()], "stop") == "idle")
    precondition(observe([control("Finishing dictation")], "stop") == "transcribing")
    precondition(observe([control("Stop dictation"), control(webview: 2)], "stop") == nil)
    precondition(observe([], "stop") == nil)

    let host = "vscode-webview://0abc/index.html?id=1&extensionId=openai.chatgpt&platform=electron&purpose=webviewView"
    precondition(webviewOwner(host) == codexExtension && isSidebarView(host))
    precondition(webviewOwner("vscode-webview://0abc/index.html?id=1&extensionId=Other.Tool&purpose=customEditor") == "other.tool")
    precondition(!isSidebarView("vscode-webview://0abc/index.html?extensionId=openai.chatgpt&purpose=customEditor"))
    precondition(webviewOwner("vscode-webview://0abc/index.html?id=1&extensionId=") == "")
    precondition(webviewOwner("vscode-webview://0abc/fake.html?id=1") == nil)
    precondition(webviewOwner("vscode-file://vscode-app/workbench.html?extensionId=openai.chatgpt") == nil)
    precondition(webviewOwner("") == nil)

    precondition(matchesWorkspace("chat — my-project — Visual Studio Code", "my-project"))
    precondition(!matchesWorkspace("chat — my-project-other — Visual Studio Code", "my-project"))
    precondition(!matchesWorkspace("chat — Visual Studio Code", ""))
    print("Native-control safety checks passed")
    exit(0)
}

let awaitControl = arguments.contains("--await-control")
let launched = Date()
let hardDeadline = launched.addingTimeInterval(9)
var report = Report(outcome: "accessibility-required")
var notes: [String] = []

func describe(_ candidate: Candidate) -> String {
    var flags = ""
    if candidate.enabled { flags += "e" }
    if candidate.pressSupported { flags += "p" }
    if candidate.focused { flags += "f" }
    if candidate.exposed { flags += "x" }
    if candidate.sidebar { flags += "s" }
    return [candidate.state, candidate.scope, flags.isEmpty ? "-" : flags, "w" + String(max(candidate.webview, 0))]
        .joined(separator: ":")
}

func operate(on editor: NSRunningApplication) {
    let application = AXUIElementCreateApplication(editor.processIdentifier)
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.75)
    AXUIElementSetMessagingTimeout(application, 0.75)

    // Electron documents this attribute for external assistive tools. Chromium
    // builds its accessibility tree only while it is set. Restore it afterwards.
    let rendering = "AXManualAccessibility"
    let prior = attribute(application, rendering) as? Bool
    var changedRendering = false
    if prior != true {
        changedRendering = AXUIElementSetAttributeValue(application, rendering as CFString, kCFBooleanTrue) == .success
        if changedRendering { Thread.sleep(forTimeInterval: 0.12) }
    }
    notes.append("ax=" + (prior == true ? "on" : changedRendering ? "enabled" : "unset"))
    defer {
        if changedRendering {
            _ = AXUIElementSetAttributeValue(application, rendering as CFString, kCFBooleanFalse)
        }
    }

    guard let workspace = argument("--workspace") else {
        report.outcome = "workspace-required"
        return
    }
    let (located, how) = workspaceWindow(application, workspace: workspace)
    notes.append("win=" + how)
    report.workspaceMatched = located != nil
    guard let window = located else {
        report.outcome = how == "several" ? "ambiguous-workspace-windows"
            : how == "mismatch" ? "workspace-window-not-found" : "no-editor-window"
        return
    }
    bringForward(editor, application, window)

    // Chromium fills in its tree, one webview at a time, after accessibility is
    // switched on, and VS Code re-lays out in response. Act only on a choice that
    // two consecutive scans agree on, so the target is never a control that is
    // about to move or be replaced, or merely the first of two composers to appear.
    var snapshot = Snapshot()
    var decision = Decision(outcome: "native-control-unavailable")
    var previous: (decision: Decision, target: AXUIElement?, nodes: Int)?
    var scans = 0
    let settleBegan = Date()
    func examine() {
        snapshot = scan(window, application: application, until: min(hardDeadline, Date().addingTimeInterval(3)))
        decision = decide(snapshot.candidates)
        scans += 1
    }
    while true {
        examine()
        let target = decision.index.map { snapshot.controls[$0].element }
        var consistent = false
        if let previous {
            let sameTarget = (previous.target == nil && target == nil)
                || (previous.target != nil && target != nil && CFEqual(previous.target, target))
            consistent = sameTarget && previous.decision.outcome == decision.outcome
                && previous.decision.action == decision.action
                && abs(previous.nodes - snapshot.nodes) <= max(25, snapshot.nodes / 20)
        }
        let elapsed = Date().timeIntervalSince(settleBegan)
        let waiting = decision.index == nil
            && ["native-control-unavailable", "native-control-disabled"].contains(decision.outcome)
        if consistent && !waiting { break }
        if consistent && elapsed >= (awaitControl ? 4.0 : 1.5) { break }
        if elapsed >= (awaitControl ? 5.5 : 4.0) || Date() >= hardDeadline { break }
        previous = (decision, target, snapshot.nodes)
        Thread.sleep(forTimeInterval: 0.15)
    }

    func record(_ snapshot: Snapshot) {
        report.nativeState = snapshot.candidates.first(where: { $0.codexScope })?.state
    }
    record(snapshot)
    notes.append("scans=\(scans) nodes=\(snapshot.nodes) ms=\(snapshot.milliseconds) views=\(snapshot.views)")
    notes.append("cand=" + (snapshot.candidates.isEmpty ? "none"
        : snapshot.candidates.prefix(6).map(describe).joined(separator: ",")))
    notes.append("pick=" + decision.via)

    guard decision.index != nil, let action = decision.action else {
        report.outcome = decision.outcome
        return
    }
    // An incomplete scan cannot rule out a second composer.
    if snapshot.limited && action == "start" && !["focus", "sidebar"].contains(decision.via) {
        report.outcome = "incomplete-inspection"
        return
    }
    report.actionRequested = action
    notes.append("act=" + action)

    // Click, then look. Measured on the Neo: Codex acts on an ordinary click
    // every time and usually ignores an accessibility press, so the press is
    // only the fallback for when a click is refused or changes nothing. Either
    // one that Codex did not act on leaves the control as it was, and the next
    // attempt is made only if a fresh scan still asks for the same action.
    let plan = ["click", "press"]
    var tried: [String] = []
    var confirmed: String?
    for method in plan {
        guard let index = decision.index, decision.action == action, Date() < hardDeadline else { break }
        let control = snapshot.controls[index]
        if method == "click" {
            // Activation is asynchronous; a click before VS Code is in front would miss.
            var waits = 0
            while !isFrontmost(application), waits < 6 {
                Thread.sleep(forTimeInterval: 0.1)
                waits += 1
            }
            if let refusal = clickControl(control.element, label: control.candidate.label,
                                          application: application, window: window) {
                tried.append("click-" + refusal)
                continue
            }
            tried.append("click")
        } else {
            let result = AXUIElementPerformAction(control.element, kAXPressAction as CFString)
            tried.append(result == .success ? "press" : "press-error")
            if result != .success { continue }
        }
        report.nativeControlPressed = true
        var live: String?
        for _ in 0..<14 {
            Thread.sleep(forTimeInterval: 0.05)
            live = liveState(control.element)
            if live == nil || confirms(action, live) { break }
        }
        examine()
        // Codex swaps the composer controls when dictation starts or stops. Give
        // the replacement controls a moment to appear before judging the attempt.
        var looks = 0
        while snapshot.candidates.allSatisfy({ !$0.codexScope }), looks < 3, Date() < hardDeadline {
            Thread.sleep(forTimeInterval: 0.15)
            examine()
            looks += 1
        }
        if let seen = observe(snapshot.candidates, action) {
            confirmed = seen
            break
        }
        // The controls were replaced and are not readable yet; trust the pressed one.
        if snapshot.candidates.allSatisfy({ !$0.codexScope }), confirms(action, live) {
            confirmed = live
            break
        }
    }
    notes.append("try=" + (tried.isEmpty ? "none" : tried.joined(separator: ",")))

    // Starting becomes recording once the microphone is ready, so the key can
    // show that it is time to speak. If Codex settles back to idle instead, it
    // could not start and has said why in its own UI. Another composer's idle
    // microphone can be the only one readable while the controls are swapped,
    // so a failure counts only when two looks in a row agree.
    if action == "start", confirmed == "starting" {
        let limit = min(hardDeadline, Date().addingTimeInterval(1.5))
        var settledIdle = 0
        while Date() < limit {
            Thread.sleep(forTimeInterval: 0.12)
            examine()
            let states = snapshot.candidates.filter { $0.codexScope }.map { $0.state }
            if states.contains("recording") {
                confirmed = "recording"
                break
            }
            if states.isEmpty || states.contains("starting") {
                settledIdle = 0
                continue
            }
            settledIdle += 1
            if settledIdle >= 2 {
                confirmed = states.first(where: { $0 == "retry-available" }) ?? "idle"
                break
            }
        }
    }

    record(snapshot)
    if let confirmed {
        report.nativeState = confirmed
        report.outcome = confirms(action, confirmed) ? "native-state-confirmed" : "native-start-failed"
    } else {
        report.outcome = report.nativeControlPressed ? "native-state-unconfirmed" : "native-control-press-failed"
    }
    notes.append("st=" + (report.nativeState ?? "none") + " front=" + (isFrontmost(application) ? "1" : "0"))
}

// Nothing is touched unless the caller explicitly asks for a toggle.
if !arguments.contains("--toggle") {
    report.outcome = "toggle-required"
} else if AXIsProcessTrusted() {
    let editors = NSRunningApplication.runningApplications(withBundleIdentifier: "com.microsoft.VSCode")
    if let editor = editors.first {
        operate(on: editor)
    } else {
        report.outcome = "editor-not-running"
    }
}
notes.append("total=\(Int(Date().timeIntervalSince(launched) * 1000))")
let permitted = Set("abcdefghijklmnopqrstuvwxyz0123456789 =.,:+_-")
report.detail = String(notes.joined(separator: " ").lowercased().filter(permitted.contains).prefix(380))

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
print(String(decoding: try encoder.encode(report), as: UTF8.self))
