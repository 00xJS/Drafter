import SwiftUI
import WidgetKit

// Drafter's widget: today's focus and what is due, the overdue count and
// tonight's dinner, on the Home Screen (small, medium) and the Lock Screen
// (rectangular, inline). It draws the snapshot the app leaves in the App Group
// (WidgetSnapshot.swift) and never reads anything else; tapping it opens Today.

@main
struct DrafterWidgetsBundle: WidgetBundle {
    var body: some Widget {
        TodayWidget()
    }
}

struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: SharedContainer.widgetKind, provider: TodayProvider()) { entry in
            TodayWidgetView(entry: entry)
        }
        .configurationDisplayName("Today")
        .description("Your focus, what's due, and tonight's dinner.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline])
    }
}

struct TodayProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayEntry {
        TodayEntry(date: Date(), content: .day(.sample, generic: false))
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (TodayEntry) -> Void) {
        // the gallery shows the sample rather than anyone's real day
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        let now = Date()
        completion(TodayEntry(date: now, content: TodayTimeline.content(WidgetSnapshot.load(), at: now, calendar: .current)))
    }

    // The app asks for a reload whenever it writes a snapshot, so the timeline
    // only has to carry the day over midnight and go stale on time.
    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<TodayEntry>) -> Void) {
        completion(Timeline(entries: TodayTimeline.entries(WidgetSnapshot.load(), from: Date()), policy: .atEnd))
    }
}
