import SwiftUI
import WidgetKit

struct AssignmentEntry: TimelineEntry {
    let date: Date
    let snapshot: AssignmentSnapshot
    var items: [Assignment] { snapshot.upcoming(at: date) }
}

struct AssignmentProvider: TimelineProvider {
    func placeholder(in context: Context) -> AssignmentEntry {
        let date = Date()
        return AssignmentEntry(date: date, snapshot: AssignmentSnapshot(schemaVersion: 1, enabled: true,
            syncedAt: nil, hasCourses: true, assignments: [Assignment(courseId: 1, id: 1, name: "课程作业", course: "COMP5000", dueAt: ISO8601DateFormatter().string(from: date.addingTimeInterval(86400)))]))
    }
    func getSnapshot(in context: Context, completion: @escaping (AssignmentEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : AssignmentEntry(date: Date(), snapshot: WidgetData.read()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<AssignmentEntry>) -> Void) {
        let now = Date(), snapshot = WidgetData.read()
        // Precompute hourly entries and deadline/window-boundary transitions.
        // This continues to filter the cached data after the app has exited.
        let horizon = now.addingTimeInterval(24 * 3600)
        var dates = Set((0...24).map { now.addingTimeInterval(Double($0) * 3600) })
        for assignment in snapshot.assignments {
            guard let due = assignment.due else { continue }
            for boundary in [due.addingTimeInterval(1), due.addingTimeInterval(-7 * 86400)] {
                if boundary > now && boundary < horizon { dates.insert(boundary) }
            }
        }
        let entries = dates.sorted().map { AssignmentEntry(date: $0, snapshot: snapshot) }
        completion(Timeline(entries: entries, policy: .after(horizon)))
    }
}

struct AssignmentRow: View {
    let item: Assignment
    let compact: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(item.name).font(.system(size: compact ? 12 : 13, weight: .medium)).lineLimit(1)
            HStack(spacing: 6) {
                Text(item.course.components(separatedBy: " ").first ?? item.course).lineLimit(1)
                Spacer(minLength: 2)
                if let due = item.due {
                    Text(due, format: .dateTime.month(.twoDigits).day(.twoDigits).hour().minute())
                        .monospacedDigit().lineLimit(1)
                }
            }.font(.system(size: 10)).foregroundStyle(.secondary)
        }
    }
}

struct AssignmentsView: View {
    let entry: AssignmentEntry
    @Environment(\.widgetFamily) var family
    var limit: Int { family == .systemLarge ? 6 : 2 }
    var body: some View {
        VStack(alignment: .leading, spacing: family == .systemSmall ? 8 : 10) {
            HStack {
                Label("七天作业", systemImage: "calendar").font(.system(size: 14, weight: .semibold))
                Spacer()
                if entry.snapshot.enabled { Text("\(entry.items.count)").font(.system(size: 15, weight: .bold)).foregroundStyle(.tint) }
            }
            if !entry.snapshot.enabled {
                Text("在 Canvas 设置 → 插件中启用系统小组件")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            } else if entry.items.isEmpty {
                Spacer(minLength: 0)
                Text(entry.snapshot.hasCourses ? "七天内没有待交作业" : "请打开 Canvas 完成同步")
                    .font(.system(size: 13)).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            } else {
                ForEach(Array(entry.items.prefix(limit)), id: \.key) { item in
                    if family == .systemSmall {
                        AssignmentRow(item: item, compact: true)
                    } else if let url = item.url {
                        Link(destination: url) { AssignmentRow(item: item, compact: false) }
                    }
                }
                Spacer(minLength: 0)
                if entry.items.count > limit { Text("另有 \(entry.items.count - limit) 项 · 打开 Canvas 查看").font(.system(size: 10)).foregroundStyle(.secondary) }
            }
            HStack(spacing: 4) {
                Text("Canvas / HKUST")
                Spacer(minLength: 0)
                if let synced = entry.snapshot.syncedAt, let date = parseSyncDate(synced) {
                    Text(date, format: .dateTime.month(.twoDigits).day(.twoDigits)).prefixSync()
                }
            }.font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
        }
        .tint(Color(red: 0.23, green: 0.37, blue: 0.56))
        .containerBackground(.background, for: .widget)
        .widgetURL(family == .systemSmall ? entry.items.first?.url ?? URL(string: "canvas-manager://open") : URL(string: "canvas-manager://open"))
    }
}

private extension Text {
    func prefixSync() -> Text { Text("同步 ") + self }
}

private func parseSyncDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}

@main
struct CanvasAssignmentsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: canvasWidgetKind, provider: AssignmentProvider()) { entry in
            AssignmentsView(entry: entry)
        }
        .configurationDisplayName("七天作业")
        .description("查看未来七天截止的 Canvas 待交作业，点击打开课程详情。")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
