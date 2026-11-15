import Foundation
import Observation

/// `app:user-idle` (packaging/electron/main.ts, ADR-256 F5): after 5 minutes without keyboard or
/// mouse input, or while the screen is locked, the user is away and interval polls pause until
/// they are back, as the renderer's `focusManager` goes unfocused. The monitor also feeds the
/// separate short decorative idle policy and power/thermal state.
@MainActor @Observable public final class UserPresence {
    public static let shared = UserPresence()
    /// `USER_IDLE_THRESHOLD_S`.
    public static let awayAfter: TimeInterval = 5 * 60
    /// Coarse polling detects input outside the app; local input resumes decoration immediately.
    public static let checkInterval: Duration = .seconds(1)
    /// Decorative motion stops much sooner than background data polling.
    public static let decorativeIdleAfter: TimeInterval = 15

    public private(set) var isAway = false
    public private(set) var isDecorativelyIdle = false
    public private(set) var conservesPower = false
    @ObservationIgnored private var screenLocked = false

    public init() {}

    /// A periodic or wake check with the seconds since the last input event.
    public func update(idleSeconds: TimeInterval) {
        set(screenLocked || idleSeconds >= Self.awayAfter)
        let idle = screenLocked || idleSeconds >= Self.decorativeIdleAfter
        if isDecorativelyIdle != idle { isDecorativelyIdle = idle }
    }

    public func updatePower(lowPower: Bool, thermalPressure: Bool) {
        let conserve = lowPower || thermalPressure
        if conservesPower != conserve { conservesPower = conserve }
    }

    /// Shared by decorative renderers; essential data and input remain independent.
    public func permitsDecorativeMotion(windowIsLive: Bool, modalIsOpen: Bool) -> Bool {
        windowIsLive && !modalIsOpen && !isDecorativelyIdle && !conservesPower
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
