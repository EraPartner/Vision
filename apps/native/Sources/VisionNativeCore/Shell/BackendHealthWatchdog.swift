import Foundation

/// `startHealthWatchdog` in packaging/electron/main.ts: a `/health` probe every 10 seconds
/// (3-second timeout); three consecutive failures report the backend lost once, and the
/// next healthy probe reports it restored.
public struct BackendHealthWatchdog: Sendable {
    public static let interval: Duration = .seconds(10)
    public static let probeTimeout: TimeInterval = 3
    public static let failureThreshold = 3

    public enum Event: Equatable, Sendable {
        case lost
        case restored
    }

    private var failures = 0
    public private(set) var reportedLost = false

    public init() {}

    /// `pingHealth` counts any 2xx or 3xx answer as healthy.
    public static func isHealthy(status: Int?) -> Bool {
        guard let status else { return false }
        return (200..<400).contains(status)
    }

    public mutating func record(healthy: Bool) -> Event? {
        if healthy {
            let event: Event? = reportedLost ? .restored : nil
            failures = 0
            reportedLost = false
            return event
        }
        failures += 1
        guard !reportedLost, failures >= Self.failureThreshold else { return nil }
        reportedLost = true
        return .lost
    }
}
