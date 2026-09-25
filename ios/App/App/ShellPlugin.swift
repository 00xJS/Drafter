import Capacitor
import Foundation
import UserNotifications

/// The page's word to the shell about the shell itself (src/native.ts).
///
/// `expectSystemPrompt`: the page is about to ask iOS for something — to send
/// notifications, to know where you are, Face ID — and iOS will put its own
/// alert over the app. Any such alert makes the scene inactive, and an inactive
/// scene is covered with the launch screen (SceneDelegate's privacy cover), so
/// the alert used to stand on a blank screen with nothing beside it to say what
/// it was asking about. After this, the next resign-active within a few
/// seconds leaves the page in sight. Going to the background is covered all
/// the same, every time.
///
/// `setBadge`: the Home Screen badge, set to the number the page counts — what
/// is overdue or due today, the morning digest's number — and nothing else.
/// Notification Centre is left as it is: a household message not yet read
/// stays there when the app is opened.
///
/// Registered by DrafterBridgeViewController in SceneDelegate.swift, as the
/// other plugins compiled into this target are.
@objc(ShellPlugin)
public class ShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShellPlugin"
    public let jsName = "Shell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "expectSystemPrompt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBadge", returnType: CAPPluginReturnPromise)
    ]

    /// Answered once the word is in place, so the page asks iOS only after it.
    @objc func expectSystemPrompt(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            SystemPrompt.expect()
            call.resolve()
        }
    }

    @objc func setBadge(_ call: CAPPluginCall) {
        let count = max(0, call.getInt("count") ?? 0)
        UNUserNotificationCenter.current().setBadgeCount(count) { error in
            if let error {
                call.reject("The badge could not be set", "BADGE_FAILED", error)
            } else {
                call.resolve()
            }
        }
    }
}

/// A system alert the page said is coming (ShellPlugin.expectSystemPrompt).
/// Main thread only: the plugin sets it there, SceneDelegate reads it there.
enum SystemPrompt {
    /// Long enough for iOS to put its alert up after the page has asked; short
    /// enough that a resign-active with no alert behind it is covered again soon.
    static let window: TimeInterval = 3

    private static var until: Date?

    static func expect(now: Date = Date()) {
        until = now.addingTimeInterval(window)
    }

    /// Whether this resign-active is the alert's. One word, one pass: it is used
    /// up here whatever the answer, and a word no alert followed runs out alone.
    static func consume(now: Date = Date()) -> Bool {
        defer { until = nil }
        guard let until else { return false }
        return now < until
    }
}
