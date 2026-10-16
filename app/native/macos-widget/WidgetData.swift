import Foundation
import Darwin

let canvasWidgetKind = "CanvasSevenDayAssignments"

struct Assignment: Codable, Identifiable {
    let courseId: Int
    let id: Int
    let name: String
    let course: String
    let dueAt: String
    var key: String { "\(courseId):\(id)" }
    var due: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: dueAt) ?? ISO8601DateFormatter().date(from: dueAt)
    }
    var url: URL? { URL(string: "canvas-manager://assignment/\(courseId)/\(id)") }
}

struct AssignmentSnapshot: Codable {
    let schemaVersion: Int
    let enabled: Bool
    let syncedAt: String?
    let hasCourses: Bool
    let assignments: [Assignment]

    static let disabled = AssignmentSnapshot(schemaVersion: 1, enabled: false, syncedAt: nil, hasCourses: false, assignments: [])

    func upcoming(at date: Date) -> [Assignment] {
        guard enabled else { return [] }
        let end = date.addingTimeInterval(7 * 24 * 3600)
        return assignments.filter { item in
            guard let due = item.due else { return false }
            return due >= date && due <= end
        }.sorted { ($0.due ?? .distantFuture) < ($1.due ?? .distantFuture) }
    }
}

enum WidgetData {
    // Only the exported assignment snapshot is shared. The extension has no
    // access to Canvas cookies, AI settings, reports or other course files.
    static var snapshotURL: URL {
        let realHome = getpwuid(getuid()).map { String(cString: $0.pointee.pw_dir) } ?? NSHomeDirectory()
        return URL(fileURLWithPath: realHome).appendingPathComponent("Library/Application Support/canvas-manager/widget-data/snapshot.json")
    }
    static func read(from url: URL = snapshotURL) -> AssignmentSnapshot {
        guard let bytes = try? Data(contentsOf: url), bytes.count < 5 * 1024 * 1024,
              let snapshot = try? JSONDecoder().decode(AssignmentSnapshot.self, from: bytes),
              snapshot.schemaVersion == 1 else { return .disabled }
        return snapshot
    }
}
