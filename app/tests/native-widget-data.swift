import Foundation

@main
struct DataTests {
    static func main() throws {
        let now = Date(timeIntervalSince1970: 1790906400)
        let formatter = ISO8601DateFormatter()
        func assignment(_ id: Int, _ delta: TimeInterval) -> Assignment {
            Assignment(courseId: 1, id: id, name: "Test", course: "COMP5000", dueAt: formatter.string(from: now.addingTimeInterval(delta)))
        }
        let data = AssignmentSnapshot(schemaVersion: 1, enabled: true, syncedAt: nil, hasCourses: true,
            assignments: [assignment(1, 0), assignment(2, 7 * 86400), assignment(3, 7 * 86400 + 1), assignment(4, -1)])
        precondition(data.upcoming(at: now).map(\.id) == [1, 2])
        precondition(data.upcoming(at: now.addingTimeInterval(2)).map(\.id) == [2, 3])
        precondition(AssignmentSnapshot.disabled.upcoming(at: now).isEmpty)
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        try JSONEncoder().encode(data).write(to: url)
        precondition(WidgetData.read(from: url).assignments.count == 4)
        try Data("{broken".utf8).write(to: url)
        precondition(!WidgetData.read(from: url).enabled)
        precondition(WidgetData.read(from: URL(fileURLWithPath: "/does-not-exist")).assignments.isEmpty)
        print("PASS native Swift data: rolling seven-day boundaries, cached future deadlines, decode and corruption fallback")
    }
}
