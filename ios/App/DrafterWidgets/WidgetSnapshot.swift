import Foundation
import WidgetKit

/// The day the web view worked out, as buildWidgetSnapshot in
/// src/widgetbridge.ts writes it: today and tomorrow, each by Today's own
/// rules, with counts only while the lock-screen privacy switch is on. The
/// widget decides nothing about tasks itself; it only picks the day to draw.
struct WidgetSnapshot: Decodable {
    let v: Int
    let generatedAt: Date
    /// From here on the widget asks for Drafter to be opened.
    let staleAt: Date
    /// Settings → Reminders → Hide details on the lock screen: no titles came.
    let generic: Bool
    let days: [WidgetDay]

    /// The only version this build reads; the app and its widget ship together.
    static let version = 1

    static func load() -> WidgetSnapshot? {
        guard let url = SharedContainer.url(SharedContainer.snapshotName), let data = try? Data(contentsOf: url) else { return nil }
        return decode(data)
    }

    static func decode(_ data: Data) -> WidgetSnapshot? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = instant(text) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not an ISO 8601 instant"))
            }
            return date
        }
        guard let snapshot = try? decoder.decode(WidgetSnapshot.self, from: data), snapshot.v == version else { return nil }
        return snapshot
    }

    /// JavaScript's toISOString, which carries milliseconds; and without them, to be safe.
    private static func instant(_ text: String) -> Date? {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = format.date(from: text) { return date }
        format.formatOptions = [.withInternetDateTime]
        return format.date(from: text)
    }
}

/// One day: WidgetDay in src/widgetbridge.ts.
struct WidgetDay: Decodable, Equatable {
    /// YYYY-MM-DD on the phone's calendar, which the web view and the widget share.
    let day: String
    /// Open focus plus the rest due that day: what is left.
    let count: Int
    let overdue: Int
    /// Up to three, focus first; none while details are hidden.
    let items: [WidgetItem]
    let more: Int
    let dinner: WidgetDinner?
}

struct WidgetItem: Decodable, Equatable {
    let title: String
    /// "9am–10:30am" for a time block, "3pm" for a due time.
    let time: String?
    let focus: Bool
}

struct WidgetDinner: Decodable, Equatable {
    let title: String
    /// "Tonight", or the slot's name on a day with no dinner planned.
    let when: String
    /// Bought rather than cooked.
    let out: Bool
}

/// What an entry draws: a day, or the note that the snapshot is too old to trust.
enum TodayContent {
    case day(WidgetDay, generic: Bool)
    case stale
}

struct TodayEntry: TimelineEntry {
    let date: Date
    let content: TodayContent
}

enum TodayTimeline {
    /// Midnights carried ahead, so the date on the widget stays right while the app is not opened.
    static let midnights = 3

    /// The phone's day, in the form the web view writes (dateKey in src/utils.ts).
    static func dayKey(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// The snapshot's view of the day `date` falls on, while it is fresh; otherwise stale.
    static func content(_ snapshot: WidgetSnapshot?, at date: Date, calendar: Calendar) -> TodayContent {
        guard let snapshot, date < snapshot.staleAt,
              let day = snapshot.days.first(where: { $0.day == dayKey(date, calendar: calendar) })
        else { return .stale }
        return .day(day, generic: snapshot.generic)
    }

    /// Now, each coming midnight (tomorrow is in the snapshot too), and the moment it goes stale.
    static func entries(_ snapshot: WidgetSnapshot?, from now: Date, calendar: Calendar = .current) -> [TodayEntry] {
        var dates = [now]
        var midnight = calendar.startOfDay(for: now)
        for _ in 0..<midnights {
            guard let next = calendar.date(byAdding: .day, value: 1, to: midnight) else { break }
            dates.append(next)
            midnight = next
        }
        if let staleAt = snapshot?.staleAt, staleAt > now { dates.append(staleAt) }
        return dates.sorted().map { TodayEntry(date: $0, content: content(snapshot, at: $0, calendar: calendar)) }
    }
}

extension WidgetDay {
    /// The widget gallery's preview: nobody's real day.
    static let sample = WidgetDay(
        day: "",
        count: 4,
        overdue: 1,
        items: [
            WidgetItem(title: "Call the plumber", time: "9am–10am", focus: true),
            WidgetItem(title: "Pay the water bill", time: nil, focus: true),
            WidgetItem(title: "Bins out", time: "6pm", focus: false),
        ],
        more: 1,
        dinner: WidgetDinner(title: "Chicken curry with rice", when: "Tonight", out: false)
    )
}
