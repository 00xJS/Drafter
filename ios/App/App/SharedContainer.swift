import Foundation

/// The App Group the app and its widget share. Compiled into both targets
/// (App and DrafterWidgets), so the names below are written once.
///
/// The web view leaves the day's snapshot here for the widget to draw
/// (WidgetBridgePlugin.swift writes it, src/widgetbridge.ts builds it), and
/// Siri's "Add to Drafter" leaves what it heard here for the app to save
/// (CaptureQueue.swift). Both targets' entitlements name the group; without it
/// in the signed build, `directory` is nil.
enum SharedContainer {
    static let groupIdentifier = "group.app.drafter.ios"

    /// The web view's snapshot of today and tomorrow (WidgetSnapshot.swift reads it).
    static let snapshotName = "widget-snapshot.json"

    /// Siri's captures, waiting for the app to open.
    static let capturesName = "siri-captures.json"

    /// The widget's kind: its timelines are reloaded by this name.
    static let widgetKind = "DrafterToday"

    static var directory: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupIdentifier)
    }

    static func url(_ name: String) -> URL? {
        directory?.appendingPathComponent(name, isDirectory: false)
    }
}
