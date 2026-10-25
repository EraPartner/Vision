import Foundation

/// What the aurora layers should be doing (`resolveAuroraMode`, shaderAuroraMode.ts).
public enum AuroraPlayback: Sendable, Equatable {
    /// Animate at the capped frame rate.
    case loop
    /// One held frame: Reduce Motion and static atmosphere (a large display).
    case held
    /// Paused on the last rendered frame: the window is not key, occluded, minimised or the
    /// app is hidden (`fx-idle-atmosphere`).
    case paused

    /// Static outranks the idle pause, as on the web: a held frame costs nothing while the
    /// window is idle and is already correct when it is shown again.
    public static func resolve(motionAllowed: Bool, windowIsLive: Bool) -> AuroraPlayback {
        if !motionAllowed { return .held }
        return windowIsLive ? .loop : .paused
    }

    /// `document.hidden || !document.hasFocus()` for a native window: the window must be key,
    /// visible on screen (not occluded, not minimised) and its app not hidden.
    public static func windowIsLive(isKey: Bool, isOnScreen: Bool, isMiniaturized: Bool, appIsHidden: Bool) -> Bool {
        isKey && isOnScreen && !isMiniaturized && !appIsHidden
    }
}

/// The aurora blobs' drift (`aurora-drift-a-smooth` 64 s, `-b-smooth` 76 s: infinite
/// alternate on `--ease-in-out-quart`) as a pure function of the time the drift has been
/// running. The clock only counts time while it runs, so pausing holds the blobs where they
/// are and resuming continues from there, as `animation-play-state: paused` does.
public struct AuroraDriftClock: Sendable, Equatable {
    private var accumulated: Double = 0
    private var resumedAt: Double?

    public init() {}

    public var isRunning: Bool { resumedAt != nil }

    /// Starts or stops counting at `now` (seconds on any monotonic scale); repeats are no-ops.
    public mutating func setRunning(_ running: Bool, now: Double) {
        if running {
            if resumedAt == nil { resumedAt = now }
        } else if let started = resumedAt {
            accumulated += max(0, now - started)
            resumedAt = nil
        }
    }

    public func elapsed(at now: Double) -> Double {
        guard let started = resumedAt else { return accumulated }
        return accumulated + max(0, now - started)
    }

    /// The eased position, 0...1, after `elapsed` seconds of an alternating drift of `duration`
    /// seconds per leg. The way back plays the same curve in reverse time (CSS `alternate`).
    public static func progress(elapsed: Double, duration: Double, curve: BezierCurve) -> Double {
        guard duration > 0, elapsed > 0 else { return 0 }
        let cycles = elapsed / duration
        let leg = cycles.rounded(.down)
        let fraction = cycles - leg
        let forward = Int(leg.truncatingRemainder(dividingBy: 2)) == 0
        return ease(forward ? fraction : 1 - fraction, curve: curve)
    }

    /// The CSS `cubic-bezier(x1, y1, x2, y2)` output for input progress `x` (bisection on x).
    static func ease(_ x: Double, curve: BezierCurve) -> Double {
        if x <= 0 { return 0 }
        if x >= 1 { return 1 }
        func coordinate(_ t: Double, _ p1: Double, _ p2: Double) -> Double {
            let u = 1 - t
            return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t
        }
        var low = 0.0
        var high = 1.0
        for _ in 0..<28 {
            let mid = (low + high) / 2
            if coordinate(mid, curve.x1, curve.x2) < x { low = mid } else { high = mid }
        }
        return coordinate((low + high) / 2, curve.y1, curve.y2)
    }
}
