import AppIntents
import Capacitor
import UIKit

// Siri and Shortcuts: add a task, add to the grocery list, open Today.
//
// The two that add run without opening the app and without the network: they
// queue what was said in the App Group (CaptureQueue.swift), and the app saves
// it the next time it opens, with the same builders the palette's Capture and
// Kitchen's add box use (src/widgetbridge.ts). So the answer says it will sync
// then, not that it has.

struct AddTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Add a Task"
    static let description: IntentDescription? = IntentDescription("Adds a task to Drafter's Inbox. It syncs the next time Drafter opens.")
    static let openAppWhenRun = false

    @Parameter(title: "Task", requestValueDialog: "What's the task?")
    var task: String

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$task) to Drafter")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = task.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw $task.needsValueError("What's the task?") }
        try CaptureQueue.append(.task, text: text)
        return .result(dialog: "Added to Drafter — it'll sync when Drafter next opens.")
    }
}

struct AddGroceryIntent: AppIntent {
    static let title: LocalizedStringResource = "Add to Groceries"
    static let description: IntentDescription? = IntentDescription("Adds an item to this week's grocery list in Drafter. It syncs the next time Drafter opens.")
    static let openAppWhenRun = false

    @Parameter(title: "Item", requestValueDialog: "What should I add to the grocery list?")
    var item: String

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$item) to the grocery list")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = item.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw $item.needsValueError("What should I add to the grocery list?") }
        try CaptureQueue.append(.grocery, text: text)
        return .result(dialog: "Added to your grocery list in Drafter — it'll sync when Drafter next opens.")
    }
}

struct OpenTodayIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Today"
    static let description: IntentDescription? = IntentDescription("Opens Drafter on Today.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        TodayLink.open()
        return .result()
    }
}

/// The phrases Siri knows without any setup. Each names the app, as Siri requires.
struct DrafterShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddTaskIntent(),
            phrases: [
                "Add a task to \(.applicationName)",
                "Add a task in \(.applicationName)",
                "New \(.applicationName) task",
                "Capture in \(.applicationName)"
            ],
            shortTitle: "Add a Task",
            systemImageName: "plus.circle"
        )
        AppShortcut(
            intent: AddGroceryIntent(),
            phrases: [
                "Add to my \(.applicationName) grocery list",
                "Add to the grocery list in \(.applicationName)",
                "Add groceries in \(.applicationName)"
            ],
            shortTitle: "Add to Groceries",
            systemImageName: "cart.badge.plus"
        )
        AppShortcut(
            intent: OpenTodayIntent(),
            phrases: [
                "Open Today in \(.applicationName)",
                "Show my day in \(.applicationName)",
                "What's on today in \(.applicationName)"
            ],
            shortTitle: "Today",
            systemImageName: "sun.max"
        )
    }
}

/// drafter://open?view=today, handed to the page the way a Home Screen quick
/// action is (SceneDelegate.deliver): AppPlugin turns the notification into
/// the `appUrlOpen` native.ts routes, and holds it until a listener takes it.
/// AppPlugin exists once the bridge does, so on a cold start the link waits
/// for the bridge's view to appear, as a cold-start quick action does.
@MainActor
final class TodayLink: NSObject {
    static let url = URL(string: "drafter://open?view=today")!
    private static let shared = TodayLink()
    private var waiting = false

    static func open() {
        shared.open()
    }

    private func open() {
        if Self.bridgeIsUp {
            post()
        } else if !waiting {
            waiting = true
            NotificationCenter.default.addObserver(self, selector: #selector(bridgeAppeared), name: .capacitorViewDidAppear, object: nil)
        }
    }

    @objc private func bridgeAppeared() {
        NotificationCenter.default.removeObserver(self, name: .capacitorViewDidAppear, object: nil)
        waiting = false
        post()
    }

    private func post() {
        NotificationCenter.default.post(name: .capacitorOpenURL, object: ["url": Self.url, "options": [String: Any]()])
    }

    private static var bridgeIsUp: Bool {
        UIApplication.shared.connectedScenes.contains { scene in
            ((scene as? UIWindowScene)?.windows.first?.rootViewController as? CAPBridgeViewController)?.bridge != nil
        }
    }
}
