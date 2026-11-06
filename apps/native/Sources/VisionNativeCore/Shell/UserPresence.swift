import Foundation
import Observation

/// `app:user-idle` (packaging/electron/main.ts, ADR-256 F5): after 5 minutes without keyboard or
/// mouse input, or while the screen is locked, the user is away and interval polls pause until
/// they are back, as the renderer's `focusManager` goes unfocused. The app checks every minute
/// and on lock, unlock and wake (`UserPresenceMonitor`).
@MainActor @Observable public final class UserPresence {
    public static let shared = UserPresence()
    /// `USER_IDLE_THRESHOLD_S`.
    public static let awayAfter: TimeInterval = 5 * 60
    /// `USER_IDLE_POLL_MS`.
    public static let checkInterval: Duration = .seconds(60)

    public private(set) var isAway = false
    @ObservationIgnored private var screenLocked = false

    public init() {}

    /// A periodic or wake check with the seconds since the last input event.
    public func update(idleSeconds: TimeInterval) {
        set(screenLocked || idleSeconds >= Self.awayAfter)
    }

    /// Lock is away at once; unlock re-checks with the input idle time.
    public func setScreenLocked(_ locked: Bool, idleSeconds: TimeInterval) {
        screenLocked = locked
        update(idleSeconds: idleSeconds)
    }

    private func set(_ away: Bool) {
        if isAway != away { isAway = away }
    }
}
