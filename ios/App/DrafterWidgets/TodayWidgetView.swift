import SwiftUI
import UIKit
import WidgetKit

/// The drafter:// routes the widget opens; both are ones the app already parses (src/links.ts).
enum WidgetLinks {
    /// Home → Today, the route the Today quick action takes (SceneDelegate.url(for:)).
    static let today = URL(string: "drafter://open?view=today")!
    /// An empty capture sheet, the New task quick action's route.
    static let capture = URL(string: "drafter://new")!
}

/// The app's own tokens (src/styles/01-base.css), light and dark.
enum WidgetPalette {
    /// --surface: the card the widget sits on.
    static let surface = dynamic(light: 0xFFFFFF, dark: 0x15181F)
    /// --accent-text: the accent where it is text, readable on the surface in both themes.
    static let accent = dynamic(light: 0xAD3A0B, dark: 0xFCA560)
    /// --danger: overdue.
    static let overdue = dynamic(light: 0xB91C1C, dark: 0xF87171)

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { traits in rgb(traits.userInterfaceStyle == .dark ? dark : light) })
    }

    private static func rgb(_ hex: UInt32) -> UIColor {
        UIColor(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

struct TodayWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TodayEntry

    var body: some View {
        content
            .widgetURL(WidgetLinks.today)
            .widgetBackground(family.isAccessory ? nil : WidgetPalette.surface)
    }

    @ViewBuilder private var content: some View {
        switch family {
        case .accessoryInline:
            InlineTodayView(content: entry.content)
        case .accessoryRectangular:
            RectangularTodayView(content: entry.content)
        case .systemMedium:
            MediumTodayView(entry: entry)
        default:
            SmallTodayView(entry: entry)
        }
    }
}

// MARK: - Home Screen

struct SmallTodayView: View {
    let entry: TodayEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            DateLine(date: entry.date, long: false)
            switch entry.content {
            case .stale:
                Spacer(minLength: 0)
                StaleNote()
            case let .day(day, generic):
                if day.count == 0 {
                    // clear only when nothing is overdue either
                    Text(day.overdue == 0 ? "All clear" : "Nothing due today").font(.headline)
                    if day.overdue == 0 {
                        Text("Nothing due today").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    if let dinner = day.dinner { DinnerLine(dinner: dinner) }
                } else {
                    CountLine(count: day.count)
                    if !generic, let next = day.items.first {
                        Text(next.title)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(2)
                            .minimumScaleFactor(0.85)
                        if let time = next.time {
                            Text(time).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
                OverdueLine(count: day.overdue)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct MediumTodayView: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let entry: TodayEntry

    /// Three lines fit at the usual text sizes; fewer, rather than cut in half, at the large ones.
    private var rows: Int {
        typeSize >= .accessibility1 ? 1 : typeSize >= .xLarge ? 2 : 3
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .center) {
                DateLine(date: entry.date, long: true)
                Spacer(minLength: 8)
                Link(destination: WidgetLinks.capture) {
                    Image(systemName: "plus")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(WidgetPalette.accent)
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(WidgetPalette.accent.opacity(0.14)))
                }
                .accessibilityLabel("New task")
            }
            switch entry.content {
            case .stale:
                Spacer(minLength: 0)
                StaleNote()
                Spacer(minLength: 0)
            case let .day(day, generic):
                let shown = Array(day.items.prefix(rows))
                let more = day.more + day.items.count - shown.count
                if day.count == 0 {
                    Text("Nothing due today").font(.headline)
                } else if generic {
                    CountLine(count: day.count)
                } else {
                    ForEach(Array(shown.enumerated()), id: \.offset) { _, item in
                        ItemRow(item: item)
                    }
                }
                Spacer(minLength: 0)
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if !generic && more > 0 {
                        Text("+\(more) more").font(.caption).foregroundStyle(.secondary)
                    }
                    OverdueLine(count: day.overdue)
                    Spacer(minLength: 4)
                    if let dinner = day.dinner { DinnerLine(dinner: dinner) }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct ItemRow: View {
    let item: WidgetItem

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            // a focus pick is marked the way the focus card is headed; the rest are due
            Image(systemName: item.focus ? "star.fill" : "circle")
                .font(.caption2)
                .foregroundStyle(item.focus ? WidgetPalette.accent : Color.secondary)
                .accessibilityHidden(true)
            Text(item.title).font(.subheadline).lineLimit(1)
            Spacer(minLength: 4)
            if let time = item.time {
                Text(time).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Lock Screen

struct RectangularTodayView: View {
    let content: TodayContent

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            switch content {
            case .stale:
                Text("Drafter").font(.headline).widgetAccentable()
                Text("Open Drafter to refresh").font(.caption).lineLimit(2)
            case let .day(day, generic):
                Text(TodaySummary.line(day)).font(.headline).lineLimit(1).widgetAccentable()
                if !generic, let next = day.items.first {
                    Text([next.time, next.title].compactMap { $0 }.joined(separator: " · ")).font(.body).lineLimit(1)
                }
                if let dinner = day.dinner {
                    Text("\(dinner.when): \(dinner.title)").font(.caption).lineLimit(1)
                } else if !generic && day.more > 0 {
                    Text("+\(day.more) more").font(.caption)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct InlineTodayView: View {
    let content: TodayContent

    var body: some View {
        switch content {
        case .stale:
            Label("Open Drafter to refresh", systemImage: "arrow.clockwise")
        case let .day(day, _):
            Label(TodaySummary.line(day), systemImage: "checklist")
        }
    }
}

enum TodaySummary {
    /// "3 to do · 1 overdue", "1 overdue", or "Nothing due today".
    static func line(_ day: WidgetDay) -> String {
        let parts = [day.count > 0 ? "\(day.count) to do" : nil, day.overdue > 0 ? "\(day.overdue) overdue" : nil].compactMap { $0 }
        return parts.isEmpty ? "Nothing due today" : parts.joined(separator: " · ")
    }
}

// MARK: - Pieces

struct DateLine: View {
    let date: Date
    let long: Bool

    var body: some View {
        Group {
            if long {
                Text(date, format: .dateTime.weekday(.wide).month(.wide).day())
            } else {
                Text(date, format: .dateTime.weekday(.abbreviated).day())
            }
        }
        .font(.caption.weight(.bold))
        .textCase(.uppercase)
        .foregroundStyle(WidgetPalette.accent)
        .lineLimit(1)
    }
}

struct CountLine: View {
    let count: Int

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text("\(count)").font(.system(.title, design: .rounded).weight(.bold))
            Text("to do").font(.subheadline).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

struct OverdueLine: View {
    let count: Int

    var body: some View {
        if count > 0 {
            Text("\(count) overdue")
                .font(.caption.weight(.semibold))
                .foregroundStyle(WidgetPalette.overdue)
                .lineLimit(1)
        }
    }
}

struct DinnerLine: View {
    let dinner: WidgetDinner

    var body: some View {
        Label {
            Text("\(dinner.when) · \(dinner.title)").lineLimit(1)
        } icon: {
            Image(systemName: dinner.out ? "takeoutbag.and.cup.and.straw" : "fork.knife")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

struct StaleNote: View {
    var body: some View {
        Text("Open Drafter to refresh")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .lineLimit(3)
    }
}

extension WidgetFamily {
    var isAccessory: Bool {
        switch self {
        case .accessoryInline, .accessoryRectangular, .accessoryCircular: return true
        default: return false
        }
    }
}

extension View {
    /// iOS 17 draws the background from this and pads the content itself; iOS 16 needs both done here.
    /// The Lock Screen's families have no background of their own on either.
    @ViewBuilder func widgetBackground(_ color: Color?) -> some View {
        if #available(iOS 17.0, *) {
            containerBackground(for: .widget) { color ?? Color.clear }
        } else if let color {
            padding().background(color)
        } else {
            self
        }
    }
}
