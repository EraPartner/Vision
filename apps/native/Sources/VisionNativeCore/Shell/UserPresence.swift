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
    /// `USER_IDLE_POLL_MS`.
    public static let checkInterval: Duration = .seconds(60)
    /// Decorative motion (aurora, ticker, shimmer) holds after about 30 s without input, much
    /// sooner than polls pause. The monitor arms one check for this moment instead of polling.
    public static let decorativeIdleAfter: TimeInterval = 30

    public private(set) var isAway = false
    public private(set) var isDecorativelyIdle = false
    public private(set) var conservesPower = false
    /// Thermal state `.fair`: decoration runs at half its rate (list item 1.9).
    public private(set) var throttlesDecoration = false
    @ObservationIgnored private var screenLocked = false

    public init() {}

    /// A periodic or wake check with the seconds since the last input event.
    public func update(idleSeconds: TimeInterval) {
        set(screenLocked || idleSeconds >= Self.awayAfter)
        let idle = screenLocked || idleSeconds >= Self.decorativeIdleAfter
        if isDecorativelyIdle != idle { isDecorativelyIdle = idle }
    }

    /// Input inside the app: decoration resumes at once. Away keeps its 60 s poll, as main.ts.
    public func noteLocalInput() {
        if isDecorativelyIdle && !screenLocked { isDecorativelyIdle = false }
    }

    /// Low Power Mode or thermal `.serious`/`.critical` hold decoration on a still frame;
    /// thermal `.fair` halves its rate.
    public func updatePower(lowPower: Bool, thermalPressure: Bool, thermalFair: Bool = false) {
        let conserve = lowPower || thermalPressure
        if conservesPower != conserve { conservesPower = conserve }
        let throttle = thermalFair && !conserve
        if throttlesDecoration != throttle { throttlesDecoration = throttle }
    }

    /// Seconds until the next check is due: the decorative idle moment while decoration runs,
    /// otherwise the away poll.
    public func nextCheck(idleSeconds: TimeInterval) -> TimeInterval {
        let poll = TimeInterval(Self.checkInterval.components.seconds)
        guard !isDecorativelyIdle else { return poll }
        return min(poll, max(1, Self.decorativeIdleAfter - idleSeconds))
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
