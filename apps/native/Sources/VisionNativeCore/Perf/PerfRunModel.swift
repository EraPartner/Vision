import Foundation

// The pure half of the in-app perf run (`VisionPerfRun`): settings, the scroll plan, frame
// statistics and the results.json shape. The AppKit driver is `apps/native/VisionNative/PerfRun.swift`.
//
// results.json (schemaVersion 1; times in epoch milliseconds unless the name says otherwise):
//
//     {
//       "schemaVersion": 1,
//       "app": { "name", "bundleIdentifier", "variant", "version", "pid" },
//       "machine": { "maximumFramesPerSecond", "backingScale", "windowPixelsWide", "windowPixelsHigh",
//                    "lowPowerMode", "thermalState" },
//       "options": { "idleSeconds", "sustainedSeconds" },
//       "processStartEpochMs", "readyEpochMs", "launchToReadyMs",   // launch is measured from process start
//       "afterLaunch": { "cpuSeconds", "footprintMb" },             // after the 10 s settle, process totals
//       "phases": [ {                                               // idle, scroll, pageSwitch, sustained
//           "name", "startEpochMs", "endEpochMs", "wallMs",
//           "cpuSeconds", "cpuUserSeconds", "cpuSystemSeconds",     // this process, over the phase
//           "footprintStartMb", "footprintEndMb",                   // phys_footprint (proc_pid_rusage)
//           "framesTracked",                                        // false for idle: no display link runs
//           "frameStampsMs",                                        // display-link timestamps, monotonic ms
//           "frames": { "frames", "refreshMs", "hitches", "maxIntervalMs" } | null,
//           "steps": [ { "path", "settleMs", "timedOut" } ],        // page switches, in order
//           "scroll": { "found", "distancePx", "durationMs" } | null,
//           "cycles": Int | null,                                   // sustained loop passes
//           "windowVisibleAtEnd", "appActiveAtEnd"
//       } ],
//       "error": String | null
//     }
//
// `frameStampsMs` has the shape of the Electron harness's `RawFrames.stamps`, so
// `computeFrameStats` and `fpsBuckets` in scripts/lib/mac-baseline/frames.ts apply to it.

/// What a perf run reads from `UserDefaults`: `defaults write <bundle id> VisionPerfRun <dir>` or
/// the launch argument `-VisionPerfRun <dir>`.
public struct PerfRunSettings: Equatable, Sendable {
    public static let directoryKey = "VisionPerfRun"
    public static let idleSecondsKey = "VisionPerfIdleSeconds"
    public static let sustainedSecondsKey = "VisionPerfSustainedSeconds"
    public static let defaultIdleSeconds = 30.0
    public static let defaultSustainedSeconds = 60.0

    public let directory: String
    public let idleSeconds: Double
    public let sustainedSeconds: Double

    public init(directory: String, idleSeconds: Double, sustainedSeconds: Double) {
        self.directory = directory
        self.idleSeconds = idleSeconds
        self.sustainedSeconds = sustainedSeconds
    }

    /// `nil` unless the directory key holds an absolute path (after `~` expansion). A malformed
    /// duration falls back to its default instead of cancelling the run.
    public init?(reading read: (String) -> String?) {
        guard let raw = read(Self.directoryKey)?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else {
            return nil
        }
        let directory = (raw as NSString).expandingTildeInPath
        guard directory.hasPrefix("/") else { return nil }
        self.init(
            directory: directory,
            idleSeconds: Self.seconds(read(Self.idleSecondsKey), fallback: Self.defaultIdleSeconds),
            sustainedSeconds: Self.seconds(read(Self.sustainedSecondsKey), fallback: Self.defaultSustainedSeconds))
    }

    private static func seconds(_ raw: String?, fallback: Double) -> Double {
        guard let raw, let value = Double(raw.trimmingCharacters(in: .whitespaces)), value.isFinite, value >= 0
        else { return fallback }
        return value
    }
}

/// The pages and dwell times of scripts/mac-baseline.ts (`DEFAULT_PAGES`).
public enum PerfRunScript {
    public static let pages: [NativeRoute.Destination] = [
        .home, .transactions, .accounts, .statistics, .plannedPayments, .portfolio,
    ]
    /// Passes over `pages` in the page-switch phase.
    public static let pageSwitchPasses = 2
    /// The wait after a page switch before the next step (the harness waits for 400 ms of quiet).
    public static let dwellSeconds = 0.45
    /// The harness settles 10 s after launch, then idles on Home.
    public static let settleSeconds = 10.0
    /// A sustained cycle visits the ledger, then at most this many of the other pages.
    public static let sustainedOtherPages = 3

    /// The pages a sustained cycle visits after the ledger scroll.
    public static func sustainedPages() -> [NativeRoute.Destination] {
        Array(pages.filter { $0 != .transactions }.prefix(sustainedOtherPages))
    }
}

/// A steady scroll down and back up, like the harness's programmatic fallback (1500 px/s).
public struct PerfScrollPlan: Equatable, Sendable {
    public static let speed = 1500.0
    /// One leg of the ledger phase: 5 s down and 5 s up, about 10 s in all.
    public static let ledgerLeg = 7500.0
    /// One leg inside the sustained loop (the harness uses 6000 px).
    public static let sustainedLeg = 6000.0
    /// Shorter scrollers are not worth measuring.
    public static let minimumTravel = 50.0

    /// One way, in points.
    public let distance: Double

    public init?(maxOffset: Double, legLimit: Double) {
        let leg = min(maxOffset, legLimit)
        guard leg.isFinite, leg >= Self.minimumTravel else { return nil }
        distance = leg
    }

    public var duration: Double { 2 * distance / Self.speed }

    /// The distance from the top at `elapsed` seconds: down, then back; 0 outside the run.
    public func offset(at elapsed: Double) -> Double {
        guard elapsed > 0, elapsed < duration else { return 0 }
        let travelled = elapsed * Self.speed
        return travelled <= distance ? travelled : 2 * distance - travelled
    }

    public func isFinished(at elapsed: Double) -> Bool { elapsed >= duration }
}

public struct PerfFrameStats: Codable, Equatable, Sendable {
    public var frames: Int
    /// The 10th percentile frame interval, like `computeFrameStats` in the Electron harness.
    public var refreshMs: Double
    /// Frames whose interval exceeds `PerfFrameAnalysis.hitchFactor` refresh intervals.
    public var hitches: Int
    public var maxIntervalMs: Double
}

public enum PerfFrameAnalysis {
    public static let hitchFactor = 1.5

    public static func intervalsMs(_ stampsMs: [Double]) -> [Double] {
        guard stampsMs.count > 1 else { return [] }
        return zip(stampsMs.dropFirst(), stampsMs).map { $0 - $1 }
    }

    public static func percentile(_ sorted: [Double], _ percent: Double) -> Double? {
        guard !sorted.isEmpty else { return nil }
        let rank = Int((percent / 100 * Double(sorted.count)).rounded(.up)) - 1
        return sorted[min(sorted.count - 1, max(0, rank))]
    }

    /// `nil` when fewer than two frames were recorded.
    public static func stats(stampsMs: [Double]) -> PerfFrameStats? {
        let intervals = intervalsMs(stampsMs)
        guard let refresh = percentile(intervals.sorted(), 10) else { return nil }
        let limit = refresh * hitchFactor
        return PerfFrameStats(
            frames: stampsMs.count, refreshMs: refresh, hitches: intervals.filter { $0 > limit }.count,
            maxIntervalMs: intervals.max() ?? 0)
    }
}

public enum PerfPhaseName: String, Codable, Sendable {
    case idle, scroll, pageSwitch, sustained
}

public struct PerfStep: Codable, Equatable, Sendable {
    public var path: String
    public var settleMs: Double
    public var timedOut: Bool

    public init(path: String, settleMs: Double, timedOut: Bool) {
        self.path = path
        self.settleMs = settleMs
        self.timedOut = timedOut
    }
}

public struct PerfScrollDetail: Codable, Equatable, Sendable {
    public var found: Bool
    public var distancePx: Double
    public var durationMs: Double

    public init(found: Bool, distancePx: Double, durationMs: Double) {
        self.found = found
        self.distancePx = distancePx
        self.durationMs = durationMs
    }
}

public struct PerfPhaseResult: Codable, Equatable, Sendable {
    public var name: PerfPhaseName
    public var startEpochMs: Double
    public var endEpochMs: Double
    public var wallMs: Double
    public var cpuSeconds: Double
    public var cpuUserSeconds: Double
    public var cpuSystemSeconds: Double
    public var footprintStartMb: Double
    public var footprintEndMb: Double
    public var framesTracked: Bool
    public var frameStampsMs: [Double]
    public var frames: PerfFrameStats?
    public var steps: [PerfStep]
    public var scroll: PerfScrollDetail?
    public var cycles: Int?
    public var windowVisibleAtEnd: Bool
    public var appActiveAtEnd: Bool

    public init(
        name: PerfPhaseName, startEpochMs: Double, endEpochMs: Double, wallMs: Double, cpuSeconds: Double,
        cpuUserSeconds: Double, cpuSystemSeconds: Double, footprintStartMb: Double, footprintEndMb: Double,
        framesTracked: Bool, frameStampsMs: [Double], steps: [PerfStep], scroll: PerfScrollDetail?, cycles: Int?,
        windowVisibleAtEnd: Bool, appActiveAtEnd: Bool
    ) {
        self.name = name
        self.startEpochMs = startEpochMs
        self.endEpochMs = endEpochMs
        self.wallMs = wallMs
        self.cpuSeconds = cpuSeconds
        self.cpuUserSeconds = cpuUserSeconds
        self.cpuSystemSeconds = cpuSystemSeconds
        self.footprintStartMb = footprintStartMb
        self.footprintEndMb = footprintEndMb
        self.framesTracked = framesTracked
        self.frameStampsMs = frameStampsMs
        self.frames = PerfFrameAnalysis.stats(stampsMs: frameStampsMs)
        self.steps = steps
        self.scroll = scroll
        self.cycles = cycles
        self.windowVisibleAtEnd = windowVisibleAtEnd
        self.appActiveAtEnd = appActiveAtEnd
    }
}

public struct PerfAppInfo: Codable, Equatable, Sendable {
    public var name: String
    public var bundleIdentifier: String
    public var variant: String
    public var version: String
    public var pid: Int

    public init(name: String, bundleIdentifier: String, variant: String, version: String, pid: Int) {
        self.name = name
        self.bundleIdentifier = bundleIdentifier
        self.variant = variant
        self.version = version
        self.pid = pid
    }
}

public struct PerfMachineInfo: Codable, Equatable, Sendable {
    public var maximumFramesPerSecond: Int
    public var backingScale: Double
    public var windowPixelsWide: Double
    public var windowPixelsHigh: Double
    public var lowPowerMode: Bool
    public var thermalState: Int

    public init(
        maximumFramesPerSecond: Int, backingScale: Double, windowPixelsWide: Double, windowPixelsHigh: Double,
        lowPowerMode: Bool, thermalState: Int
    ) {
        self.maximumFramesPerSecond = maximumFramesPerSecond
        self.backingScale = backingScale
        self.windowPixelsWide = windowPixelsWide
        self.windowPixelsHigh = windowPixelsHigh
        self.lowPowerMode = lowPowerMode
        self.thermalState = thermalState
    }
}

public struct PerfOptionsInfo: Codable, Equatable, Sendable {
    public var idleSeconds: Double
    public var sustainedSeconds: Double

    public init(idleSeconds: Double, sustainedSeconds: Double) {
        self.idleSeconds = idleSeconds
        self.sustainedSeconds = sustainedSeconds
    }
}

public struct PerfProcessSnapshot: Codable, Equatable, Sendable {
    public var cpuSeconds: Double
    public var footprintMb: Double

    public init(cpuSeconds: Double, footprintMb: Double) {
        self.cpuSeconds = cpuSeconds
        self.footprintMb = footprintMb
    }
}

public struct PerfRunResults: Codable, Equatable, Sendable {
    public static let fileName = "results.json"

    public var schemaVersion = 1
    public var app: PerfAppInfo
    public var machine: PerfMachineInfo?
    public var options: PerfOptionsInfo
    public var processStartEpochMs: Double
    public var readyEpochMs: Double?
    public var launchToReadyMs: Double?
    public var afterLaunch: PerfProcessSnapshot?
    public var phases: [PerfPhaseResult]
    public var error: String?

    public init(
        app: PerfAppInfo, machine: PerfMachineInfo?, options: PerfOptionsInfo, processStartEpochMs: Double,
        readyEpochMs: Double?, afterLaunch: PerfProcessSnapshot?, phases: [PerfPhaseResult], error: String?
    ) {
        self.app = app
        self.machine = machine
        self.options = options
        self.processStartEpochMs = processStartEpochMs
        self.readyEpochMs = readyEpochMs
        self.launchToReadyMs = readyEpochMs.map { $0 - processStartEpochMs }
        self.afterLaunch = afterLaunch
        self.phases = phases
        self.error = error
    }

    public func jsonData() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(self)
    }
}
