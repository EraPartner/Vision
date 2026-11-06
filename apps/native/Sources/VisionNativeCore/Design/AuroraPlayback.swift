import Foundation
import Observation

/// What the aurora layers should be doing (`resolveAuroraMode`, shaderAuroraMode.ts).
public enum AuroraPlayback: Sendable, Equatable {
    /// Animate at the capped frame rate.
    case loop
    /// One held frame: Reduce Motion and static atmosphere (a large display).
    case held
    /// Paused on the last rendered frame: the window is not key, occluded, minimised or the
    /// app is hidden (`fx-idle-atmosphere`), or a modal covers it (`fx-modal-open`; the caller
    /// folds `VisionModalRegistry.isOpen` into `windowIsLive`).
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

/// `fx-modal-open` (VisualEffectsController.tsx): an in-window dialog, alert or sheet is up.
/// The aurora, the ticker tape and loading shimmers hold behind it, so the frosted overlay and
/// the glass under it blur once instead of on every drift step (ADR-255). The presenters count
/// themselves in and out; the system sheets and alerts take key status from the window, which
/// the window-liveness pause already covers.
@MainActor @Observable public final class VisionModalRegistry {
    public static let shared = VisionModalRegistry()

    public private(set) var openCount = 0

    public init() {}

    public var isOpen: Bool { openCount > 0 }

    public func opened() { openCount += 1 }

    public func closed() { openCount = max(0, openCount - 1) }
}

/// The shader aurora's clock (ShaderAurora.tsx): it advances only while the loop runs, so a
/// pause (window idle, modal open) resumes where it stopped instead of jumping ahead, and a long
/// gap between two frames (a stalled main thread) counts as one `maxStep`.
public struct AuroraShaderClock: Sendable, Equatable {
    /// `MAX_FRAME_STEP_MS`.
    public static let maxStep = 0.1
    /// `FRAME_MIN_MS` 48: about 20 fps; every shader frame damages the whole window.
    public static let framesPerSecond = 20

    public private(set) var seconds: Double = 0
    private var lastFrameAt: Double?

    public init() {}

    /// A drawn frame at `now` (seconds on any monotonic scale); returns the shader time.
    public mutating func frame(at now: Double) -> Double {
        if let lastFrameAt { seconds += min(max(0, now - lastFrameAt), Self.maxStep) }
        lastFrameAt = now
        return seconds
    }

    /// The loop stopped: the next frame starts a new step.
    public mutating func stop() { lastFrameAt = nil }
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

/// One aurora blob (`::before` / `::after` of `.liquid-canvas`) for a canvas size: where it sits,
/// and the scale and offset its drift moves between (`aurora-drift-a-smooth` /
/// `aurora-drift-b-smooth`). Core Animation plays the drift, as the browser compositor plays the
/// CSS keyframes, so the app does no per-frame work for it.
public struct AuroraBlobDrift: Sendable, Equatable {
    public let diameter: Double
    /// The blob's centre at rest, in canvas points from the top-left corner.
    public let centerX: Double
    public let centerY: Double
    public let startScale: Double
    public let endScale: Double
    /// The offset at the far end of a leg; the drift scales it by the eased progress.
    public let offsetX: Double
    public let offsetY: Double
    /// Seconds per leg; the way back plays the same leg in reverse (CSS `alternate`).
    public let duration: Double

    /// The primary blob: 55 % of the width (at least 544 pt) from the top-left corner.
    public static func first(width: Double, height: Double) -> AuroraBlobDrift {
        let diameter = max(width * 0.55, 544)
        return AuroraBlobDrift(
            diameter: diameter, centerX: -width * 0.12 + diameter / 2, centerY: -height * 0.18 + diameter / 2,
            startScale: 1, endScale: 1.18, offsetX: width * 0.14, offsetY: height * 0.09, duration: 64)
    }

    /// The accent blob: 48 % of the width (at least 480 pt) from the bottom-right corner.
    public static func second(width: Double, height: Double) -> AuroraBlobDrift {
        let diameter = max(width * 0.48, 480)
        return AuroraBlobDrift(
            diameter: diameter, centerX: width * 1.1 - diameter / 2, centerY: height * 1.22 - diameter / 2,
            startScale: 1.12, endScale: 0.96, offsetX: -width * 0.11, offsetY: -height * 0.07, duration: 76)
    }

    /// Scale and offset at eased progress `progress` (0 at rest, 1 at the end of a leg).
    public func pose(at progress: Double) -> (scale: Double, x: Double, y: Double) {
        (startScale + (endScale - startScale) * progress, offsetX * progress, offsetY * progress)
    }

    /// `closest-side ... transparent 72%`: where the gradient fades out, as a share of the radius.
    public static let fadeEnd = 0.72

    /// The blob as the shader aurora draws it (auroraBlobs.ts): its centre, in canvas points from
    /// the top-left corner, and its fade-out radius, at eased drift `progress`. Without a drift
    /// (`nil`) the CSS blob has no transform at all, so its scale is 1, not `startScale`.
    public func circle(progress: Double?) -> (x: Double, y: Double, radius: Double) {
        guard let progress else { return (centerX, centerY, diameter / 2 * Self.fadeEnd) }
        let pose = pose(at: progress)
        return (centerX + pose.x, centerY + pose.y, diameter / 2 * Self.fadeEnd * pose.scale)
    }
}
