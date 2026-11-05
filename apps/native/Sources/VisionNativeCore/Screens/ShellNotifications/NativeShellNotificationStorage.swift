import Foundation

/// The original localStorage values; SDK callers supply the retained web-storage bridge.
@MainActor public struct NativeShellNotificationStorage {
    public enum Key: String, Sendable {
        case fxDismissedAt = "fx-status-banner-dismissed-at"
        case upcomingDismissals = "dismissed_upcoming_planned_payments"
    }

    public let read: @MainActor (Key) async throws -> String?
    public let write: @MainActor (Key, String) async throws -> Void

    public init(
        read: @escaping @MainActor (Key) async throws -> String?,
        write: @escaping @MainActor (Key, String) async throws -> Void
    ) {
        self.read = read
        self.write = write
    }

    public static var unavailable: Self {
        Self(read: { _ in throw APIError.backendUnavailable }, write: { _, _ in throw APIError.backendUnavailable })
    }
}

enum ShellNotificationDate {
    static func day(_ instant: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: instant)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    static func window(_ instant: Date, timeZone: TimeZone) -> (start: String, end: String) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let next = calendar.date(byAdding: .day, value: 7, to: calendar.startOfDay(for: instant)) ?? instant
        return (day(instant, timeZone: timeZone), day(next, timeZone: timeZone))
    }
}
