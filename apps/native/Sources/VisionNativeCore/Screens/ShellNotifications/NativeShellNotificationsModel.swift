import Foundation

/// App-layout lifetime. Route changes only control where the Upcoming banner is drawn.
@MainActor public final class NativeShellNotificationsModel {
    public let fx: ShellFXStatusModel
    public let upcoming: ShellUpcomingPaymentsModel
    private var active = true
    public var isOnline = true {
        didSet {
            fx.isOnline = isOnline
            upcoming.isOnline = isOnline
        }
    }
    public init(
        client: APIClient, storage: NativeShellNotificationStorage = .unavailable,
        timeZone: TimeZone = .current, now: @escaping @Sendable () -> Date = { Date() }
    ) {
        fx = ShellFXStatusModel(service: client, storage: storage, now: now)
        upcoming = ShellUpcomingPaymentsModel(service: client, storage: storage, timeZone: timeZone, now: now)
    }
    public func load() async {
        guard active else { return }
        async let fx: Void = fx.load()
        async let upcoming: Void = upcoming.load()
        _ = await (fx, upcoming)
    }
    public func refreshIfStale() async {
        guard active else { return }
        async let fx: Void = fx.refreshIfStale()
        async let upcoming: Void = upcoming.refreshIfStale()
        _ = await (fx, upcoming)
    }
    public func invalidate() {
        fx.invalidate()
        upcoming.invalidate()
    }
    /// Finish already accepted local writes before a database restore replaces frontend storage.
    public func flushStorage() async {
        async let fx: Void = fx.flushStorage()
        async let upcoming: Void = upcoming.flushStorage()
        _ = await (fx, upcoming)
    }
    public func didDisappear() {
        active = false
        fx.didDisappear()
        upcoming.didDisappear()
    }
}
