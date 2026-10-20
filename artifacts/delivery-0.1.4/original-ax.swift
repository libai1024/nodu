import Foundation
import AppKit
import ApplicationServices

func attribute(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, name as CFString, &value) == .success ? value : nil
}
func text(_ e: AXUIElement, _ name: String) -> String {
    return attribute(e, name) as? String ?? ""
}
func walk(_ e: AXUIElement, depth: Int = 0) -> [AXUIElement] {
    if depth > 15 { return [] }
    let children = attribute(e, kAXChildrenAttribute) as? [AXUIElement] ?? []
    return [e] + children.flatMap { walk($0, depth: depth + 1) }
}
func bounds(_ e: AXUIElement) -> CGRect? {
    guard let rawPosition = attribute(e, kAXPositionAttribute),
          let rawSize = attribute(e, kAXSizeAttribute),
          CFGetTypeID(rawPosition) == AXValueGetTypeID(),
          CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(rawPosition as! AXValue, .cgPoint, &point),
          AXValueGetValue(rawSize as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}
func row(_ e: AXUIElement) -> [String: Any] {
    var result: [String: Any] = [
        "role": text(e, kAXRoleAttribute), "title": text(e, kAXTitleAttribute),
        "description": text(e, kAXDescriptionAttribute),
    ]
    if let value = attribute(e, kAXValueAttribute) as? String { result["value"] = value }
    else if let value = attribute(e, kAXValueAttribute) as? NSNumber { result["value"] = value }
    if let enabled = attribute(e, kAXEnabledAttribute) as? NSNumber { result["enabled"] = enabled }
    if let r = bounds(e) {
        result["bounds"] = ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height]
    }
    return result
}
func emit(_ value: Any) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}
func stop(_ message: String) -> Never {
    emit(["error": message]); exit(1)
}
let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2, let pid = Int32(args[0]) else { stop("Usage: original-ax PID state|click|checkbox|histogram|port [argument]") }
guard let application = NSRunningApplication(processIdentifier: pid),
      (application.localizedName ?? "").contains("MaixPy") else { stop("PID is not MaixPy IDE") }
let app = AXUIElementCreateApplication(pid)
let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
guard !windows.isEmpty else { stop("Original IDE has no accessible window") }
let all = windows.flatMap { walk($0) }

func activate() {
    application.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    if let window = windows.first { AXUIElementPerformAction(window, kAXRaiseAction as CFString) }
    Thread.sleep(forTimeInterval: 0.2)
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { stop("Original IDE is not frontmost") }
}
func click(_ e: AXUIElement) {
    guard let r = bounds(e), r.width > 0, r.height > 0 else { stop("Target has no clickable bounds") }
    activate()
    let point = CGPoint(x: r.midX, y: r.midY)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}
func key(_ code: CGKeyCode, flags: CGEventFlags = []) {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { stop("Focus changed before key event") }
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    down?.flags = flags; up?.flags = flags
    down?.post(tap: .cghidEventTap); up?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.12)
}

switch args[1] {
case "state":
    let roles = ["AXButton", "AXPopUpButton", "AXTextArea", "AXTextField", "AXComboBox",
                 "AXSlider", "AXIncrementor", "AXCheckBox", "AXStaticText"]
    let views = windows.map { window -> [String: Any] in
        ["title": text(window, kAXTitleAttribute), "elements": walk(window).filter {
            roles.contains(text($0, kAXRoleAttribute))
        }.map(row)]
    }
    let quartz = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
    emit(["at": ISO8601DateFormatter().string(from: Date()), "windows": views,
          "quartz": quartz.filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) }])
case "click", "checkbox":
    guard args.count >= 3 else { stop("Missing control label") }
    let role = args[1] == "checkbox" ? "AXCheckBox" : "AXButton"
    guard let target = all.first(where: {
        text($0, kAXRoleAttribute) == role &&
        (text($0, kAXTitleAttribute) == args[2] || text($0, kAXDescriptionAttribute) == args[2])
    }) else { stop("Control not found: " + args[2]) }
    let before = row(target)
    click(target)
    Thread.sleep(forTimeInterval: 0.4)
    emit(["before": before, "after": row(target)])
case "histogram":
    guard args.count >= 3, let index = Int(args[2]), (0...3).contains(index),
          let popup = all.first(where: {
              text($0, kAXRoleAttribute) == "AXPopUpButton" &&
              text($0, kAXDescriptionAttribute).contains("颜色跟踪")
          }) else { stop("Histogram popup/index unavailable") }
    click(popup)
    Thread.sleep(forTimeInterval: 0.2)
    key(115) // Home in the popup, not in the editor.
    if index > 0 { for _ in 0..<index { key(125) } }
    key(36)
    Thread.sleep(forTimeInterval: 0.4)
    emit(row(popup))
case "popup":
    guard args.count >= 4, let index = Int(args[3]), (0...15).contains(index),
          let popup = all.first(where: {
              text($0, kAXRoleAttribute) == "AXPopUpButton" && text($0, kAXTitleAttribute) == args[2]
          }) else { stop("Named popup/index unavailable") }
    click(popup); Thread.sleep(forTimeInterval: 0.2)
    key(115)
    if index > 0 { for _ in 0..<index { key(125) } }
    key(36); Thread.sleep(forTimeInterval: 0.3)
    emit(row(popup))
case "goto-file":
    guard args.count >= 3, args[2].hasPrefix("/") else { stop("Absolute file path required") }
    activate()
    key(5, flags: [.maskCommand, .maskShift]) // macOS Go To Folder sheet
    Thread.sleep(forTimeInterval: 0.5)
    guard let focused = attribute(app, kAXFocusedUIElementAttribute),
          CFGetTypeID(focused) == AXUIElementGetTypeID() else { stop("No focused file-path control") }
    let input = focused as! AXUIElement
    guard ["AXTextField", "AXComboBox"].contains(text(input, kAXRoleAttribute)) else { stop("File-path field is not focused") }
    let before = row(input)
    let board = NSPasteboard.general
    let saved = board.pasteboardItems?.map { item -> NSPasteboardItem in
        let copy = NSPasteboardItem()
        for type in item.types { if let data = item.data(forType: type) { copy.setData(data, forType: type) } }
        return copy
    } ?? []
    board.clearContents(); board.setString(args[2], forType: .string)
    key(0, flags: .maskCommand); key(9, flags: .maskCommand)
    Thread.sleep(forTimeInterval: 0.3)
    let after = row(input)
    board.clearContents(); board.writeObjects(saved)
    guard text(input, kAXValueAttribute) == args[2] else { stop("File-path paste differs") }
    key(36)
    emit(["before": before, "after": after])
case "set-control":
    guard args.count >= 5, let index = Int(args[3]) else { stop("set-control ROLE INDEX VALUE required") }
    let controls = all.filter { text($0, kAXRoleAttribute) == args[2] }
    guard controls.indices.contains(index) else { stop("Control index out of range") }
    let target = controls[index], before = row(target)
    let value: CFTypeRef = args[2] == "AXSlider" ? NSNumber(value: Double(args[4]) ?? .nan) : args[4] as CFString
    let status = AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, value)
    Thread.sleep(forTimeInterval: 0.3)
    emit(["status": status.rawValue, "before": before, "after": row(target)])
    if args.count > 5 && args[5] == "confirm" {
        guard status == .success, text(target, kAXValueAttribute) == args[4] else { stop("Input was not set exactly") }
        activate()
        AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        key(36)
    }
case "port":
    guard let dialog = windows.first(where: { text($0, kAXTitleAttribute) == "连接" }),
          let popup = walk(dialog).first(where: { text($0, kAXRoleAttribute) == "AXPopUpButton" }) else {
        stop("Connect dialog not open")
    }
    click(popup); Thread.sleep(forTimeInterval: 0.2)
    key(115); key(125); key(125); key(36)
    Thread.sleep(forTimeInterval: 0.3)
    let value = row(popup)
    emit(value)
    guard text(popup, kAXTitleAttribute) == "cu.usbserial-3110" else { stop("Selected port is not the requested board") }
    guard let ok = walk(dialog).first(where: {
        text($0, kAXRoleAttribute) == "AXButton" && text($0, kAXTitleAttribute) == "OK"
    }) else { stop("Connect OK button unavailable") }
    click(ok)
default:
    stop("Unknown action")
}
