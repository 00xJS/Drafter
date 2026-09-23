import Foundation

/// What Siri was asked to add, kept in a file until the app is open to save it.
///
/// The intents (DrafterIntents.swift) run with no web view and no network, so
/// all they do is append here. The page drains the file through
/// WidgetBridgePlugin.drainCaptures and saves each capture with the app's own
/// builders (captureRecords in src/widgetbridge.ts): a task the way the
/// palette's Capture makes one, a grocery line the way Kitchen adds one. The
/// intents run in the app's process too, and NSFileCoordinator keeps an append
/// and a drain from interleaving.
enum CaptureQueue {
    enum Kind: String, Codable {
        case task
        case grocery
    }

    /// One thing said to Siri. The keys are the ones parseCaptures in src/widgetbridge.ts reads.
    struct Capture: Codable, Equatable {
        /// A UUID. The task a capture becomes takes it as its id, so one seen twice is saved once.
        let id: String
        let kind: Kind
        let text: String
        /// When it was said, ISO 8601 with milliseconds, which JavaScript's Date reads as it is.
        let at: String
    }

    enum Failure: Error {
        case empty
        case noContainer
    }

    /// Longer than any task title the app keeps (140) or any grocery line said aloud.
    static let maxText = 500
    /// A queue nobody drains for months stops growing here; the oldest go first.
    static let maxQueued = 200
    /// Posted in the app's process after each append. With Drafter already open
    /// there is no resume to drain on, so WidgetBridgePlugin tells the page now.
    static let queued = Notification.Name("app.drafter.capture-queued")

    /// Queue one capture. Throws when there is nothing to add, or nowhere to write it.
    @discardableResult
    static func append(_ kind: Kind, text: String, at date: Date = Date()) throws -> Capture {
        let clean = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxText))
        guard !clean.isEmpty else { throw Failure.empty }
        guard let url = SharedContainer.url(SharedContainer.capturesName) ?? appOwnURL else { throw Failure.noContainer }
        let capture = Capture(id: UUID().uuidString.lowercased(), kind: kind, text: clean, at: timestamp(date))
        try coordinate(url) { url in
            var queue = read(url)
            queue.append(capture)
            if queue.count > maxQueued { queue.removeFirst(queue.count - maxQueued) }
            try write(queue, to: url)
        }
        NotificationCenter.default.post(name: queued, object: nil)
        return capture
    }

    /// Everything queued, oldest first, and the queue emptied.
    static func drain() -> [Capture] {
        var drained: [Capture] = []
        // the App Group's file, then the app's own: a build signed without the
        // group still queued its captures, in the one place the app can reach
        for url in [SharedContainer.url(SharedContainer.capturesName), appOwnURL].compactMap({ $0 }) {
            try? coordinate(url) { url in
                drained += read(url)
                if FileManager.default.fileExists(atPath: url.path) {
                    try FileManager.default.removeItem(at: url)
                }
            }
        }
        return drained
    }

    private static var appOwnURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent(SharedContainer.capturesName, isDirectory: false)
    }

    private static func timestamp(_ date: Date) -> String {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format.string(from: date)
    }

    private static func read(_ url: URL) -> [Capture] {
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { return [] }
        return (try? JSONDecoder().decode([Capture].self, from: data)) ?? []
    }

    private static func write(_ queue: [Capture], to url: URL) throws {
        let data = try JSONEncoder().encode(queue)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        // readable after the first unlock since boot: Siri can be asked with the phone locked
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// A read-modify-write that no other append or drain can interleave with.
    private static func coordinate(_ url: URL, _ body: (URL) throws -> Void) throws {
        var coordinationError: NSError?
        var bodyError: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: .forMerging, error: &coordinationError) { url in
            do {
                try body(url)
            } catch {
                bodyError = error
            }
        }
        if let error = coordinationError { throw error }
        if let error = bodyError { throw error }
    }
}
