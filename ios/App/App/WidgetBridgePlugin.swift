import Capacitor
import Foundation
import WidgetKit

/// The page's side of the Home Screen widget and of Siri (src/widgetbridge.ts).
///
/// `setSnapshot` writes the day the web view worked out — by Today's own rules,
/// and counts only when the lock-screen privacy switch is on — into the App
/// Group, and asks WidgetKit to draw it again. The page writes only a day that
/// changed, or one close to going stale: WidgetKit allows so many redraws.
/// `drainCaptures` hands the page what Siri queued (CaptureQueue.swift) and
/// empties the queue; the page drains at launch and on resume, and on
/// `capturesQueued`, which this sends when Siri adds something while Drafter
/// is already open. Registered by DrafterBridgeViewController in
/// SceneDelegate.swift, because `cap sync` lists only the plugins that come
/// from node_modules.
@objc(WidgetBridgePlugin)
public class WidgetBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WidgetBridgePlugin"
    public let jsName = "WidgetBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drainCaptures", returnType: CAPPluginReturnPromise)
    ]

    /// Two days of three lines each is a few hundred bytes; anything near this is not a snapshot.
    static let maxSnapshotBytes = 64 * 1024

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(captureQueued), name: CaptureQueue.queued, object: nil)
    }

    /// CaptureQueue posts on whatever thread Siri's intent ran on; the page is
    /// told on the main one, where the bridge's calls into the web view belong.
    @objc private func captureQueued() {
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners("capturesQueued", data: [:])
        }
    }

    @objc func setSnapshot(_ call: CAPPluginCall) {
        guard let json = call.getString("json"), !json.isEmpty else {
            call.reject("No snapshot was sent", "BAD_SNAPSHOT")
            return
        }
        let data = Data(json.utf8)
        guard data.count <= Self.maxSnapshotBytes else {
            call.reject("The snapshot is too large", "TOO_LARGE")
            return
        }
        guard (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else {
            call.reject("The snapshot is not a JSON object", "BAD_SNAPSHOT")
            return
        }
        guard let url = SharedContainer.url(SharedContainer.snapshotName) else {
            call.unavailable("This build was signed without the App Group")
            return
        }
        do {
            // readable after the first unlock since boot: the Lock Screen widget draws while locked
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            call.reject("The snapshot could not be written", "WRITE_FAILED", error)
            return
        }
        // this app's one widget, by its kind: not every timeline the app has
        WidgetCenter.shared.reloadTimelines(ofKind: SharedContainer.widgetKind)
        call.resolve()
    }

    @objc func drainCaptures(_ call: CAPPluginCall) {
        let captures = CaptureQueue.drain().map { capture -> [String: Any] in
            ["id": capture.id, "kind": capture.kind.rawValue, "text": capture.text, "at": capture.at]
        }
        call.resolve(["captures": captures])
    }
}
